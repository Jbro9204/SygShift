-- INACTIVE urgent employee access candidate. No maintenance window or feature
-- setting is changed. Combine only inside an independently reviewed transaction.
do $urgent_guard$
declare expected record;actual record;expected_owner text:='postgres';
begin
  if to_regclass('private.employee_urgent_maintenance_capabilities') is not null
    or to_regprocedure('private.employee_urgent_maintenance_write_allowed(text,text,text,jsonb,jsonb)') is not null
    or to_regprocedure('private.require_urgent_capability_cleanup()') is not null then
    raise exception 'Urgent-maintenance candidate objects already exist; do not replay.';
  end if;
  for expected in select * from (values
('private.current_employee_id()','36b8fee439d6ddf26bc5d3d8a1762291',array['postgres=X/postgres','service_role=X/postgres']::text[]),
    ('private.enforce_maintenance_feature_write()','d106be2e7bedaa79fd5b82974776c206',null::text[]),
    ('private.ensure_attendance_absence_call_off_report(uuid,uuid,text,text,uuid)','7615b45325f4a0afb885f4f92dbba4af',array['postgres=X/postgres']::text[]),
    ('private.record_accountability_event_creation()','0861e3df208cd0dd7a8bb99cdb52bc3d',null::text[]),
    ('private.resolve_published_accountability_shift(uuid,uuid)','3eff88816b89cfb394ba251c09d27c3d',array['postgres=X/postgres']::text[]),
    ('private.same_scheduled_occurrence(uuid,uuid)','cf4718a35ddeb7787a14c1c914ceff57',array['postgres=X/postgres']::text[]),
    ('public.report_attendance_accountability_event(uuid,text,date,text)','715493f11dd929cc34ab18b7fccfcea6',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[]),
    ('public.service_mark_attendance_accountability_dispatch_result(uuid,boolean,text)','3498accbc8f4fab591a0e0ff757d622f',array['postgres=X/postgres','service_role=X/postgres']::text[])
  ) as baseline(identity,hash,acl) loop
    select p.*,r.rolname as owner_name into actual from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=to_regprocedure(expected.identity);
    if actual.oid is null or md5(pg_get_functiondef(actual.oid))<>expected.hash
      or actual.owner_name<>expected_owner
      or (select array_agg(item::text order by item::text) from unnest(actual.proacl) item)
         is distinct from (select array_agg(item order by item) from unnest(expected.acl) item)
      or actual.proconfig is distinct from array['search_path=""']::text[] then
      raise exception 'Urgent-maintenance baseline drift: %',expected.identity;
    end if;
  end loop;
  if (select count(*) from pg_trigger where tgname='maintenance_write_guard'
    and tgrelid in ('public.call_off_reports'::regclass,'public.call_off_report_actions'::regclass,'public.attendance_accountability_events'::regclass,'public.attendance_accountability_event_actions'::regclass)
    and tgfoid='private.enforce_maintenance_feature_write()'::regprocedure and tgenabled='O'
    and tgtype=31 and encode(tgargs,'escape')='time_attendance\000')<>4 then
    raise exception 'The reviewed urgent table maintenance guards differ.';
  end if;
end;
$urgent_guard$;
create temporary table urgent_function_contract_before on commit drop as
select p.oid,p.oid::regprocedure::text as identity,to_jsonb(p)-array['prosrc','probin','prosqlbody'] as contract
from pg_proc p where p.oid in ('private.enforce_maintenance_feature_write()'::regprocedure,'public.report_attendance_accountability_event(uuid,text,date,text)'::regprocedure,'public.service_mark_attendance_accountability_dispatch_result(uuid,boolean,text)'::regprocedure);
-- REVIEW CANDIDATE BODY. Only validated employee urgent absence RPCs issue a
-- short-lived capability. No browser/service role can read or write this table.
create table private.employee_urgent_maintenance_capabilities (
  id uuid primary key,
  backend_pid integer not null,
  transaction_id xid8 not null,
  scope text not null check(scope in ('employee_urgent_absence','attendance_dispatch_result')),
  auth_user_id uuid,
  employee_id uuid not null,
  shift_id uuid,
  operational_date date not null,
  requested_event_type text,
  event_type text not null,
  attendance_event_id uuid,
  result_notified_at timestamptz,
  result_error text,
  created_at timestamptz not null default clock_timestamp(),
  check((scope='employee_urgent_absence' and auth_user_id is not null and requested_event_type is not null
      and requested_event_type in ('called_in_sick','call_off') and event_type in ('called_in_sick','call_off','no_call_no_show'))
    or (scope='attendance_dispatch_result' and auth_user_id is null and attendance_event_id is not null and requested_event_type is null)),
  unique(backend_pid,transaction_id,scope)
);
alter table private.employee_urgent_maintenance_capabilities enable row level security;
alter table private.employee_urgent_maintenance_capabilities force row level security;
revoke all on table private.employee_urgent_maintenance_capabilities from public,anon,authenticated,service_role;

create function private.require_urgent_capability_cleanup()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if exists(select 1 from private.employee_urgent_maintenance_capabilities capability where capability.id=new.id) then
    raise check_violation using message='An employee urgent maintenance capability cannot survive its RPC transaction.';
  end if;
  return null;
end;
$function$;
revoke all on function private.require_urgent_capability_cleanup() from public,anon,authenticated,service_role;
create constraint trigger urgent_capability_cleanup_required
after insert on private.employee_urgent_maintenance_capabilities
deferrable initially deferred for each row execute function private.require_urgent_capability_cleanup();

create function private.employee_urgent_maintenance_write_allowed(
  table_schema text,table_name text,operation text,old_record jsonb,new_record jsonb
)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare capability private.employee_urgent_maintenance_capabilities%rowtype; report public.call_off_reports%rowtype; attendance public.attendance_accountability_events%rowtype;
begin
  if table_schema<>'public' or operation not in ('INSERT','UPDATE')
    or table_name not in ('attendance_accountability_events','attendance_accountability_event_actions','call_off_reports','call_off_report_actions') then return false; end if;
  select item.* into capability from private.employee_urgent_maintenance_capabilities item
  where item.backend_pid=pg_backend_pid() and item.transaction_id=pg_current_xact_id()
    and ((item.scope='employee_urgent_absence' and item.auth_user_id=auth.uid() and item.employee_id=private.current_employee_id())
      or (item.scope='attendance_dispatch_result' and (select auth.role())='service_role' and item.auth_user_id is null));
  if capability.id is null then return false; end if;

  -- The already-authorized service marker runs AFTER email processing in a
  -- separate RPC. Its capability permits only that event's delivery evidence.
  if capability.scope='attendance_dispatch_result' then
    if not coalesce(old_record->>'source'='employee' and (old_record->>'created_by')::uuid=capability.employee_id
      and old_record->>'event_type' in ('called_in_sick','call_off'),false) then
      select item.* into report from public.call_off_reports item where item.id=(old_record->>'call_off_report_id')::uuid;
      if old_record->>'event_type' not in ('called_in_sick','call_off','no_call_no_show')
        or report.id is null or report.employee_id<>capability.employee_id
        or report.reported_by is distinct from capability.employee_id or report.received_by is distinct from capability.employee_id
        or not private.same_scheduled_occurrence(report.shift_id,(old_record->>'shift_id')::uuid) then return false; end if;
    end if;
    return table_name='attendance_accountability_events' and operation='UPDATE'
      and (new_record->>'id')::uuid=capability.attendance_event_id
      and (new_record->>'employee_id')::uuid=capability.employee_id
      and new_record-array['dispatch_notified_at','dispatch_notification_error','updated_at']
        =old_record-array['dispatch_notified_at','dispatch_notification_error','updated_at']
      and (new_record->>'dispatch_notified_at')::timestamptz is not distinct from capability.result_notified_at
      and new_record->>'dispatch_notification_error' is not distinct from capability.result_error;
  end if;

  if table_name='attendance_accountability_events' then
    if (new_record->>'employee_id')::uuid is distinct from capability.employee_id
      or new_record->>'event_type' is distinct from capability.event_type
      or (new_record->>'operational_date')::date is distinct from capability.operational_date then return false; end if;
    if operation='INSERT' then
      return capability.attendance_event_id is null
        and capability.event_type=capability.requested_event_type
        and (new_record->>'shift_id')::uuid is not distinct from capability.shift_id
        and new_record->>'source'='employee' and new_record->>'status'='reported'
        and (new_record->>'created_by')::uuid=capability.employee_id
        and new_record->>'reviewed_by' is null and new_record->>'reviewed_at' is null
        and new_record->>'decision_note' is null and new_record->>'review_outcome' is null
        and new_record->>'duplicate_of_event_id' is null and new_record->>'call_off_report_id' is null;
    end if;
    if (new_record->>'id')::uuid is distinct from capability.attendance_event_id
      or (old_record->>'employee_id')::uuid is distinct from capability.employee_id
      or new_record-array['call_off_report_id','updated_at'] is distinct from old_record-array['call_off_report_id','updated_at']
      or capability.shift_id is null then return false; end if;
    select item.* into report from public.call_off_reports item where item.id=(new_record->>'call_off_report_id')::uuid;
    return report.id is not null and report.employee_id=capability.employee_id
      and private.same_scheduled_occurrence(report.shift_id,capability.shift_id);
  elsif table_name='attendance_accountability_event_actions' then
    if operation<>'INSERT' or capability.attendance_event_id is not null
      or new_record->>'action'<>'created' or (new_record->>'actor_id')::uuid is distinct from capability.employee_id
      or new_record->>'before_record' is not null then return false; end if;
    select item.* into attendance from public.attendance_accountability_events item where item.id=(new_record->>'event_id')::uuid;
    return attendance.id is not null
      and private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','INSERT',null,to_jsonb(attendance))
      and new_record->'after_record'=to_jsonb(attendance) and new_record->>'reason'=attendance.note
      and (new_record->>'action_at')::timestamptz=attendance.created_at;
  elsif table_name='call_off_reports' then
    return operation='INSERT' and capability.shift_id is not null
      and (new_record->>'employee_id')::uuid=capability.employee_id
      and (new_record->>'shift_id')::uuid=capability.shift_id
      and (new_record->>'reported_by')::uuid=capability.employee_id
      and (new_record->>'received_by')::uuid=capability.employee_id
      and new_record->>'call_off_type'=case when capability.event_type='called_in_sick' then 'sick' else 'other' end
      and (new_record->>'replacement_needed')::boolean
      and new_record->>'acknowledged_by' is null and new_record->>'acknowledged_at' is null
      and new_record->>'announcement_id' is null and new_record->>'resolved_at' is null
      and new_record->>'canceled_at' is null and new_record->>'canceled_by' is null
      and new_record->>'duplicate_of_call_off_report_id' is null and new_record->>'resolution_outcome' is null;
  elsif table_name='call_off_report_actions' then
    if operation<>'INSERT' or capability.shift_id is null or new_record->>'action'<>'created'
      or (new_record->>'actor_id')::uuid is distinct from capability.employee_id then return false; end if;
    select item.* into report from public.call_off_reports item where item.id=(new_record->>'call_off_report_id')::uuid;
    return report.id is not null and report.employee_id=capability.employee_id and report.shift_id=capability.shift_id
      and report.reported_by=capability.employee_id and report.received_by=capability.employee_id
      and new_record->'snapshot'=to_jsonb(report) and new_record->>'reason' is not distinct from report.reason;
  end if;
  return false;
end;
$function$;
revoke all on function private.employee_urgent_maintenance_write_allowed(text,text,text,jsonb,jsonb) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.enforce_maintenance_feature_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  feature_code text := tg_argv[0];
  active_window record;
begin
  select mw.title, mw.access_mode, mw.ends_at
    into active_window
  from public.maintenance_windows mw
  where mw.status = 'scheduled'
    and mw.starts_at <= now()
    and mw.ends_at > now()
    and feature_code = any(mw.feature_codes)
    and mw.access_mode in ('read_only', 'unavailable')
  order by
    case mw.access_mode when 'unavailable' then 2 else 1 end desc,
    mw.starts_at desc
  limit 1;

  if found then
    if feature_code='time_attendance' and tg_op in ('INSERT','UPDATE')
      and private.employee_urgent_maintenance_write_allowed(tg_table_schema,tg_table_name,tg_op,to_jsonb(old),to_jsonb(new)) then
      return new;
    end if;
    raise insufficient_privilege using
      message = format('%s is temporarily read-only for scheduled maintenance. Your change was not saved.', active_window.title),
      detail = format('Feature %s is protected until %s.', feature_code, active_window.ends_at);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$
;
CREATE OR REPLACE FUNCTION public.report_attendance_accountability_event(target_shift_id uuid DEFAULT NULL::uuid, target_event_type text DEFAULT 'called_in_sick'::text, target_operational_date date DEFAULT NULL::date, target_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  reporter_id uuid := private.current_employee_id();
  reporter_record public.employees%rowtype;
  clean_event_type text := btrim(coalesce(target_event_type, ''));
  clean_note text := btrim(coalesce(target_note, ''));
  operational_today date := (clock_timestamp() at time zone 'America/Denver')::date;
  published_shift_id uuid;
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  shift_time_zone text := 'America/Denver';
  shift_post_name text;
  shift_site_name text;
  shift_site_code text;
  shift_event_name text;
  shift_event_location_name text;
  inserted_event public.attendance_accountability_events%rowtype;
  canonical_event_id uuid;
  call_off_result jsonb;
  call_off_id uuid;
  created_new boolean := true;
  urgent_capability_id uuid := gen_random_uuid();
  result_payload jsonb;
begin
  if reporter_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into reporter_record
  from public.employees employee
  where employee.id = reporter_id
    and employee.status in ('active', 'leave', 'onboarding');

  if reporter_record.id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if clean_event_type not in ('called_in_sick', 'call_off') then
    raise check_violation using message = 'Employees can report only sick or call-off attendance events.';
  end if;
  if clean_note = '' then
    raise check_violation using message = 'A short note is required.';
  end if;
  if char_length(clean_note) > 2000 then
    raise check_violation using message = 'The note exceeds 2,000 characters.';
  end if;

  if target_shift_id is not null then
    published_shift_id := private.resolve_published_accountability_shift(
      target_shift_id,
      reporter_id
    );

    select
      shift.starts_at,
      shift.ends_at,
      coalesce(shift.time_zone, 'America/Denver'),
      post.name,
      site.name,
      site.code,
      event.name,
      event.location_name
    into
      shift_starts_at,
      shift_ends_at,
      shift_time_zone,
      shift_post_name,
      shift_site_name,
      shift_site_code,
      shift_event_name,
      shift_event_location_name
    from public.shifts shift
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where shift.id = published_shift_id
      and shift.ends_at > clock_timestamp() - interval '2 hours';

    if published_shift_id is null or shift_starts_at is null then
      raise check_violation using message = 'The selected shift changed. Refresh My Time and choose the current assignment.';
    end if;

    perform private.lock_attendance_scheduled_occurrence(reporter_id, published_shift_id);
    canonical_event_id := private.canonical_attendance_accountability_event(
      reporter_id,
      published_shift_id,
      clean_event_type
    );

    if canonical_event_id is not null then
      select * into inserted_event
      from public.attendance_accountability_events event
      where event.id = canonical_event_id
      for update;
      created_new := false;
    end if;
  elsif target_operational_date is null then
    raise check_violation using message = 'Choose a shift or date for this attendance report.';
  elsif target_operational_date < operational_today then
    raise check_violation using message = 'Employees can report sick or call-off only for today or a future date.';
  end if;

  -- All existing active-account, own-assignment, event-type and date checks
  -- above have completed. The private capability is never based on a GUC.
  begin
    insert into private.employee_urgent_maintenance_capabilities(
      id,backend_pid,transaction_id,scope,auth_user_id,employee_id,shift_id,
      operational_date,requested_event_type,event_type,attendance_event_id
    ) values (
      urgent_capability_id,pg_backend_pid(),pg_current_xact_id(),'employee_urgent_absence',auth.uid(),reporter_id,published_shift_id,
      coalesce(inserted_event.operational_date,target_operational_date,(shift_starts_at at time zone shift_time_zone)::date),
      clean_event_type,coalesce(inserted_event.event_type,clean_event_type),inserted_event.id
    );

  if inserted_event.id is null then
    insert into public.attendance_accountability_events (
      employee_id,
      shift_id,
      event_type,
      status,
      operational_date,
      starts_at,
      ends_at,
      source,
      note,
      created_by
    ) values (
      reporter_id,
      published_shift_id,
      clean_event_type,
      'reported',
      coalesce(target_operational_date, (shift_starts_at at time zone shift_time_zone)::date),
      shift_starts_at,
      shift_ends_at,
      'employee',
      clean_note,
      reporter_id
    )
    returning * into inserted_event;
    update private.employee_urgent_maintenance_capabilities set attendance_event_id=inserted_event.id where id=urgent_capability_id;
  end if;

  if published_shift_id is not null then
    call_off_result := private.ensure_attendance_absence_call_off_report(
      reporter_id,
      published_shift_id,
      inserted_event.event_type,
      inserted_event.note,
      reporter_id
    );
    call_off_id := (call_off_result ->> 'id')::uuid;

    if inserted_event.call_off_report_id is distinct from call_off_id then
      update public.attendance_accountability_events
      set call_off_report_id = call_off_id,
          updated_at = clock_timestamp()
      where id = inserted_event.id
      returning * into inserted_event;
    end if;
  end if;

  if created_new then
    insert into private.audit_events (
      auth_user_id,
      employee_id,
      schema_name,
      table_name,
      operation,
      row_id,
      new_record
    ) values (
      auth.uid(),
      reporter_id,
      'public',
      'attendance_accountability_events',
      'INSERT',
      inserted_event.id::text,
      jsonb_build_object(
        'eventType', inserted_event.event_type,
        'employeeId', inserted_event.employee_id,
        'shiftId', inserted_event.shift_id,
        'operationalDate', inserted_event.operational_date,
        'callOffReportId', call_off_id
      )
    );
  end if;

  result_payload := jsonb_build_object(
    'id', inserted_event.id,
    'callOffId', coalesce(call_off_id, inserted_event.call_off_report_id),
    'employeeId', reporter_id,
    'employeeName', btrim(coalesce(reporter_record.preferred_name, reporter_record.first_name) || ' ' || reporter_record.last_name),
    'username', reporter_record.username,
    'eventType', inserted_event.event_type,
    'status', inserted_event.status,
    'operationalDate', inserted_event.operational_date,
    'shiftId', inserted_event.shift_id,
    'startsAt', inserted_event.starts_at,
    'endsAt', inserted_event.ends_at,
    'timeZone', coalesce(shift_time_zone, 'America/Denver'),
    'siteName', shift_site_name,
    'siteCode', shift_site_code,
    'postName', shift_post_name,
    'eventName', shift_event_name,
    'locationName', coalesce(shift_event_location_name, shift_site_name, shift_post_name, 'Date-only report'),
    'note', inserted_event.note,
    'createdAt', inserted_event.created_at,
    'created', created_new,
    'alreadyRecorded', not created_new,
    'dispatchAlreadyNotified', inserted_event.dispatch_notified_at is not null,
    'dispatchTo', 'dispatch@guardianshipsecurity.net'
  );
  delete from private.employee_urgent_maintenance_capabilities where id=urgent_capability_id;
  return result_payload;
  exception when others then
    -- The subtransaction already unwinds the capability and urgent writes;
    -- explicit cleanup also makes the no-surviving-capability contract clear.
    delete from private.employee_urgent_maintenance_capabilities where id=urgent_capability_id;
    raise;
  end;
end
$function$
;
CREATE OR REPLACE FUNCTION public.service_mark_attendance_accountability_dispatch_result(target_event_id uuid, delivered boolean, delivery_error text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  event public.attendance_accountability_events%rowtype;
  report public.call_off_reports%rowtype;
  urgent_self_report boolean;
  capability_id uuid:=gen_random_uuid();
  result_notified_at timestamptz;
  result_error text;
  result_found boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message='Service role is required.';
  end if;
  select * into event from public.attendance_accountability_events where id=target_event_id for update;
  if not found then return false; end if;
  result_notified_at:=case when delivered then clock_timestamp() else event.dispatch_notified_at end;
  result_error:=case when delivered then null else left(coalesce(delivery_error,'Email delivery failed.'),500) end;
  urgent_self_report:=event.source='employee' and event.created_by=event.employee_id and event.event_type in ('called_in_sick','call_off');
  if not coalesce(urgent_self_report,false) and event.event_type in ('called_in_sick','call_off','no_call_no_show') and event.call_off_report_id is not null then
    select * into report from public.call_off_reports where id=event.call_off_report_id;
    urgent_self_report:=report.id is not null and report.employee_id=event.employee_id and report.reported_by=event.employee_id
      and report.received_by=event.employee_id and private.same_scheduled_occurrence(report.shift_id,event.shift_id);
  end if;
  begin
    if coalesce(urgent_self_report,false) then
    insert into private.employee_urgent_maintenance_capabilities(
      id,backend_pid,transaction_id,scope,employee_id,shift_id,operational_date,event_type,attendance_event_id,result_notified_at,result_error
    ) values (
      capability_id,pg_backend_pid(),pg_current_xact_id(),'attendance_dispatch_result',event.employee_id,event.shift_id,
      event.operational_date,event.event_type,event.id,result_notified_at,result_error
    );
    end if;
    update public.attendance_accountability_events
    set dispatch_notified_at=result_notified_at,dispatch_notification_error=result_error,updated_at=clock_timestamp()
    where id=target_event_id;
    result_found:=found;
    delete from private.employee_urgent_maintenance_capabilities where id=capability_id;
    return result_found;
  exception when others then
    delete from private.employee_urgent_maintenance_capabilities where id=capability_id;
    raise;
  end;
end
$function$;
do $preservation$
declare original record;
begin
  for original in select * from pg_temp.urgent_function_contract_before loop
    if (select to_jsonb(p)-array['prosrc','probin','prosqlbody'] from pg_proc p where p.oid=original.oid) is distinct from original.contract then
      raise exception 'Urgent function security/signature contract changed: %',original.identity;
    end if;
  end loop;
  if exists(select 1 from private.employee_urgent_maintenance_capabilities) then raise exception 'A capability survived candidate installation.'; end if;
end;
$preservation$;
do $urgent_expected_state$
declare expected record;actual record;expected_owner text:='postgres';actual_table jsonb;
begin
  for expected in select * from (values
('private.employee_urgent_maintenance_write_allowed(text,text,text,jsonb,jsonb)','a781d8f5f2f9038596307aaa4d21e08e',array['postgres=X/postgres']::text[]),
    ('private.enforce_maintenance_feature_write()','2a893b7f73a06d69a84b0c0b080eeb44',null::text[]),
    ('private.require_urgent_capability_cleanup()','0d95939f9a8c36811d8f419193b19ba2',array['postgres=X/postgres']::text[]),
    ('public.report_attendance_accountability_event(uuid,text,date,text)','d48f2e61b1c97c996a75c6bb372f0980',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[]),
    ('public.service_mark_attendance_accountability_dispatch_result(uuid,boolean,text)','846ac90691ca7e1aee614eb99b3c8d05',array['postgres=X/postgres','service_role=X/postgres']::text[])
  ) as expected(identity,hash,acl) loop
    select p.*,r.rolname as owner_name into actual from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=to_regprocedure(expected.identity);
    if actual.oid is null or md5(pg_get_functiondef(actual.oid))<>expected.hash or actual.owner_name<>expected_owner
      or actual.proconfig is distinct from array['search_path=""']::text[]
      or (select array_agg(item::text order by item::text) from unnest(actual.proacl) item)
        is distinct from (select array_agg(item order by item) from unnest(expected.acl) item) then
      raise exception 'Urgent-maintenance expected-state drift: %',expected.identity;
    end if;
  end loop;
  select capability_table into actual_table from (select jsonb_build_object('owner',r.rolname,'acl',c.relacl,'schema_hash',md5(jsonb_build_object(
 'kind',c.relkind,'persistence',c.relpersistence,'row_security',c.relrowsecurity,'force_row_security',c.relforcerowsecurity,
 'columns',(select jsonb_agg(jsonb_build_object('number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'constraints',(select jsonb_agg(pg_get_constraintdef(item.oid) order by item.conname) from pg_constraint item where item.conrelid=c.oid and item.contype<>'n'),
 'indexes',(select jsonb_agg(pg_get_indexdef(item.indexrelid) order by item.indexrelid::regclass::text) from pg_index item where item.indrelid=c.oid),
 'triggers',(select jsonb_agg(jsonb_build_object('definition',pg_get_triggerdef(item.oid),'enabled',item.tgenabled) order by item.tgname) from pg_trigger item where item.tgrelid=c.oid and not item.tgisinternal)
)::text)) as capability_table
from pg_class c join pg_roles r on r.oid=c.relowner where c.oid='private.employee_urgent_maintenance_capabilities'::regclass) fingerprint;
  if actual_table->>'owner' is distinct from expected_owner or actual_table->>'schema_hash'<>'60c186937a0985594c121895745dbc6d'
    or (select array_agg(item order by item) from jsonb_array_elements_text(actual_table->'acl') item)
      is distinct from (select array_agg(item order by item) from unnest(array['postgres=arwdDxtm/postgres']::text[]) item)
    or exists(select 1 from private.employee_urgent_maintenance_capabilities) then
    raise exception 'Urgent-maintenance capability schema/ACL/cleanup drift.';
  end if;
end;
$urgent_expected_state$;