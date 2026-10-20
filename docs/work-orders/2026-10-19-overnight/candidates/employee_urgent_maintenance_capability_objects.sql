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
