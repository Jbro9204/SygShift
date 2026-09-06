begin;

-- One canonical attendance source for the tracker, payroll review, and reports.
create or replace function private.get_attendance_events(target_from_date date, target_through_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare events_payload jsonb;
begin
  if target_from_date is null or target_through_date is null or target_through_date < target_from_date or target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Choose a valid attendance range of no more than 46 days.';
  end if;
  with accountability_rows as (
    select
      account_event.id,
      'attendance_accountability_events'::text as source_table,
      account_event.event_type,
      account_event.status,
      account_event.employee_id,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.username,
      employee.role::text as role,
      employee.employment_type::text as employment_type,
      account_event.operational_date,
      account_event.starts_at,
      account_event.ends_at,
      coalesce(shift.time_zone, 'America/Denver') as time_zone,
      site.name as site_name,
      site.code as site_code,
      post.name as post_name,
      event.name as event_name,
      coalesce(event.location_name, site.name, post.name, 'Date-only report') as location_name,
      account_event.note,
      account_event.created_at
    from public.attendance_accountability_events account_event
    join public.employees employee on employee.id = account_event.employee_id
    left join public.shifts shift on shift.id = account_event.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where account_event.operational_date between target_from_date and target_through_date
      and account_event.status <> 'voided'
  ),
  legacy_call_off_rows as (
    select
      report.id,
      'call_off_reports'::text as source_table,
      case
        when report.reason ilike 'called in sick:%' then 'called_in_sick'
        when report.reason ilike '%sick%' then 'called_in_sick'
        else 'call_off'
      end as event_type,
      case when report.resolved_at is not null then 'resolved' else 'reported' end as status,
      report.employee_id,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.username,
      employee.role::text as role,
      employee.employment_type::text as employment_type,
      (shift.starts_at at time zone shift.time_zone)::date as operational_date,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      site.name as site_name,
      site.code as site_code,
      post.name as post_name,
      event.name as event_name,
      coalesce(event.location_name, site.name, post.name, 'Shift') as location_name,
      coalesce(report.reason, 'Call-off reported.') as note,
      report.reported_at as created_at
    from public.call_off_reports report
    join public.employees employee on employee.id = report.employee_id
    join public.shifts shift on shift.id = report.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where (shift.starts_at at time zone shift.time_zone)::date between target_from_date and target_through_date
      and not exists (
        select 1
        from public.attendance_accountability_events account_event
        where account_event.call_off_report_id = report.id
      )
  ),
  time_off_rows as (
    select
      request.id,
      'time_off_requests'::text as source_table,
      case
        when request.reason ilike '%sick%' then 'called_in_sick'
        when request.reason ilike '%vacation%' then 'vacation'
        else 'vacation'
      end as event_type,
      request.status::text as status,
      request.employee_id,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.username,
      employee.role::text as role,
      employee.employment_type::text as employment_type,
      greatest(request.starts_on, target_from_date) as operational_date,
      null::timestamptz as starts_at,
      null::timestamptz as ends_at,
      'America/Denver'::text as time_zone,
      null::text as site_name,
      null::text as site_code,
      null::text as post_name,
      null::text as event_name,
      'Time off'::text as location_name,
      coalesce(request.reason, 'Approved time off.') as note,
      request.created_at
    from public.time_off_requests request
    join public.employees employee on employee.id = request.employee_id
    where request.status in ('pending', 'approved')
      and daterange(request.starts_on, request.ends_on, '[]') && daterange(target_from_date, target_through_date, '[]')
  ),
  combined as (
    select * from accountability_rows
    union all
    select * from legacy_call_off_rows
    union all
    select * from time_off_rows
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', combined.id,
    'sourceTable', combined.source_table,
    'eventType', combined.event_type,
    'status', combined.status,
    'employeeId', combined.employee_id,
    'employeeName', combined.employee_name,
    'username', combined.username,
    'role', combined.role,
    'employmentType', combined.employment_type,
    'operationalDate', combined.operational_date,
    'startsAt', combined.starts_at,
    'endsAt', combined.ends_at,
    'timeZone', combined.time_zone,
    'siteName', combined.site_name,
    'siteCode', combined.site_code,
    'postName', combined.post_name,
    'eventName', combined.event_name,
    'locationName', combined.location_name,
    'note', combined.note,
    'createdAt', combined.created_at
  ) order by combined.operational_date, combined.employee_name, combined.created_at), '[]'::jsonb)
  into events_payload
  from combined;

  return events_payload;
end
$$;
revoke all on function private.get_attendance_events(date, date) from public, anon, authenticated;

-- Keep the established payroll reader's authorization unchanged.
do $canonical_reader$
declare definition text; data_start integer; data_end integer;
begin
  definition := pg_get_functiondef('public.get_payroll_accountability_events(date,date)'::regprocedure);
  data_start := position('  with accountability_rows as (' in definition);
  data_end := position('  return events_payload;' in definition);
  if data_start = 0 or data_end < data_start then raise exception 'Attendance reader structure changed; review required.'; end if;
  definition := substring(definition from 1 for data_start - 1) || '  return private.get_attendance_events(target_from_date, target_through_date);' || substring(definition from data_end + length('  return events_payload;'));
  execute definition;
end
$canonical_reader$;

create or replace function public.get_attendance_report(target_from_date date, target_through_date date, target_export boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id(); events_payload jsonb;
begin
  if actor_id is null or not public.has_mfa() or not public.has_effective_permission('time.reports.view') then
    raise insufficient_privilege using message = 'Attendance reporting permission with MFA is required.';
  end if;
  if target_export is true and not public.has_effective_permission('reports.export') then
    raise insufficient_privilege using message = 'Report export permission is required.';
  end if;
  select coalesce(jsonb_agg(item.value || jsonb_build_object(
    'shiftId', native.shift_id,
    'reviewOutcome', native.review_outcome,
    'reviewedAt', native.reviewed_at, 'reviewedByName', null, 'decisionNote', native.decision_note,
    'reviewable', false, 'actionHistory', '[]'::jsonb, 'reconciliation', null
  ) order by item.value ->> 'operationalDate' desc, item.value ->> 'employeeName', item.value ->> 'id'), '[]'::jsonb)
  into events_payload
  from jsonb_array_elements(private.get_attendance_events(target_from_date, target_through_date)) item(value)
  left join public.attendance_accountability_events native
    on item.value ->> 'sourceTable' = 'attendance_accountability_events' and native.id = (item.value ->> 'id')::uuid;
  if target_export is true then
    insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
    values (auth.uid(), actor_id, 'public', 'attendance_accountability_events', 'EXPORT', 'attendance-report',
      jsonb_build_object('fromDate', target_from_date, 'throughDate', target_through_date, 'recordCount', jsonb_array_length(events_payload)));
  end if;
  return jsonb_build_object('serverTimestamp', statement_timestamp(), 'fromDate', target_from_date, 'throughDate', target_through_date, 'events', events_payload);
end
$$;
revoke all on function public.get_attendance_report(date,date,boolean) from public, anon;
grant execute on function public.get_attendance_report(date,date,boolean) to authenticated;

-- A classification change is not a review decision and cannot affect punches.
alter table public.attendance_accountability_event_actions drop constraint attendance_accountability_action_check;
alter table public.attendance_accountability_event_actions add constraint attendance_accountability_action_check
  check (action in ('created','confirmed','excused_protected','corrected','dismissed','voided','reopened','reclassified'));
create or replace function public.reclassify_attendance_accountability_event(target_event_id uuid, target_event_type text, target_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id(); before_row public.attendance_accountability_events%rowtype; after_row public.attendance_accountability_events%rowtype;
begin
  if actor_id is null or not public.has_mfa() or not public.has_effective_permission('accountability.manage') then
    raise insufficient_privilege using message = 'Accountability management permission with MFA is required.';
  end if;
  if target_event_type is null or target_event_type not in ('called_in_sick','call_off','no_call_no_show','late_arrival','early_departure','other') then
    raise check_violation using message = 'Choose a supported factual occurrence type.';
  end if;
  if coalesce(char_length(btrim(target_reason)),0) < 8 or char_length(target_reason) > 2000 then
    raise check_violation using message = 'Explain the classification change in 8–2,000 characters.';
  end if;
  select * into before_row from public.attendance_accountability_events where id = target_event_id for update;
  if not found or before_row.status = 'voided' then raise check_violation using message = 'Choose a non-voided attendance record.'; end if;
  if before_row.event_type = target_event_type then raise check_violation using message = 'Choose a different occurrence type.'; end if;
  update public.attendance_accountability_events set event_type = target_event_type where id = target_event_id returning * into after_row;
  insert into public.attendance_accountability_event_actions(event_id,action,reason,actor_id,before_record,after_record)
  values (target_event_id,'reclassified',btrim(target_reason),actor_id,to_jsonb(before_row),to_jsonb(after_row));
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,old_record,new_record)
  values(auth.uid(),actor_id,'public','attendance_accountability_events','RECLASSIFY',target_event_id::text,to_jsonb(before_row),to_jsonb(after_row));
  return jsonb_build_object('id',after_row.id,'eventType',after_row.event_type);
end
$$;
revoke all on function public.reclassify_attendance_accountability_event(uuid,text,text) from public, anon;
grant execute on function public.reclassify_attendance_accountability_event(uuid,text,text) to authenticated;

-- Narrow repair of explicit call-off notes from the reported week. Do not infer
-- an absence from ambiguous notes or change the existing review outcome.
with candidates as materialized (
  select e.* from public.attendance_accountability_events e
  where e.operational_date between date '2026-08-30' and date '2026-09-06'
    and e.event_type = 'other' and e.status <> 'voided'
    and upper(btrim(e.note)) in ('CALL OFF','CALL OFF ON 8/31')
), repaired as (
  update public.attendance_accountability_events e set event_type = 'call_off'
  from candidates c where e.id = c.id returning e.*
)
insert into private.audit_events(schema_name,table_name,operation,row_id,old_record,new_record)
select 'public','attendance_accountability_events','RECLASSIFY',r.id::text,to_jsonb(c),
  to_jsonb(r) || jsonb_build_object('repairReason','09/06/2026: explicit call-off note was incorrectly classified as Other; original review decision preserved.')
from repaired r join candidates c on c.id = r.id;

notify pgrst, 'reload schema';
commit;
