-- INACTIVE forward recovery: restores three exact original functions and leaves new capability objects sealed and empty.
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
create temporary table urgent_recovery_contract_before on commit drop as
select p.oid,p.oid::regprocedure::text as identity,to_jsonb(p)-array['prosrc','probin','prosqlbody'] as contract
from pg_proc p where p.oid in ('private.enforce_maintenance_feature_write()'::regprocedure,'public.report_attendance_accountability_event(uuid,text,date,text)'::regprocedure,'public.service_mark_attendance_accountability_dispatch_result(uuid,boolean,text)'::regprocedure);
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

  return jsonb_build_object(
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
end
$function$
;

CREATE OR REPLACE FUNCTION public.service_mark_attendance_accountability_dispatch_result(target_event_id uuid, delivered boolean, delivery_error text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  update public.attendance_accountability_events
  set
    dispatch_notified_at = case when delivered then clock_timestamp() else dispatch_notified_at end,
    dispatch_notification_error = case when delivered then null else left(coalesce(delivery_error, 'Email delivery failed.'), 500) end,
    updated_at = clock_timestamp()
  where id = target_event_id;

  return found;
end
$function$
;

do $preservation$
declare original record;
begin
  for original in select * from pg_temp.urgent_recovery_contract_before loop
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
    ('private.require_urgent_capability_cleanup()','0d95939f9a8c36811d8f419193b19ba2',array['postgres=X/postgres']::text[]),
    ('private.enforce_maintenance_feature_write()','d106be2e7bedaa79fd5b82974776c206',null::text[]),
    ('public.report_attendance_accountability_event(uuid,text,date,text)','715493f11dd929cc34ab18b7fccfcea6',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[]),
    ('public.service_mark_attendance_accountability_dispatch_result(uuid,boolean,text)','3498accbc8f4fab591a0e0ff757d622f',array['postgres=X/postgres','service_role=X/postgres']::text[])
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