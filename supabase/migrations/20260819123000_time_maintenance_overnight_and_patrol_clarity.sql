begin;

-- Group unlinked punch activity into a bounded work session instead of splitting
-- it at midnight. The original event timestamps remain authoritative and are
-- never rewritten by this helper.
create or replace function private.get_unscheduled_time_session_start(
  target_event_id uuid,
  target_employee_id uuid,
  target_effective_at timestamptz
)
returns table(session_event_id uuid, session_started_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with previous_close as (
    select max(effective.effective_at) as effective_at
    from public.time_events prior_event
    cross join lateral private.current_effective_time_event(prior_event.id) effective
    where prior_event.employee_id = target_employee_id
      and prior_event.shift_id is null
      and prior_event.kind = 'clock_out'
      and prior_event.id <> target_event_id
      and not effective.voided
      and effective.effective_at < target_effective_at
  )
  select candidate.id, effective.effective_at
  from public.time_events candidate
  cross join lateral private.current_effective_time_event(candidate.id) effective
  cross join previous_close
  where candidate.employee_id = target_employee_id
    and candidate.shift_id is null
    and candidate.kind = 'clock_in'
    and not effective.voided
    and effective.effective_at <= target_effective_at
    and effective.effective_at >= target_effective_at - interval '24 hours'
    and (previous_close.effective_at is null or effective.effective_at > previous_close.effective_at)
  order by effective.effective_at, candidate.recorded_at, candidate.id
  limit 1
$$;

create or replace function private.get_timekeeping_occurrence_key(
  target_event_id uuid,
  target_employee_id uuid,
  target_shift_id uuid,
  target_effective_at timestamptz,
  target_time_zone text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
select case
  when target_shift_id is not null then 'shift:' || target_shift_id::text || ':employee:' || target_employee_id::text
  when manual.id is not null then 'manual:' || manual.id::text || ':employee:' || target_employee_id::text
  when session.session_event_id is not null then 'unscheduled-session:' || session.session_event_id::text || ':employee:' || target_employee_id::text
  when target_effective_at is not null
    then 'unscheduled:' || target_employee_id::text || ':' || (target_effective_at at time zone target_time_zone)::date::text
  else 'unresolved-event:' || target_event_id::text || ':employee:' || target_employee_id::text
end
from (select 1) seed
left join lateral (
  select entry.id
  from public.manual_time_entries entry
  where target_event_id in (entry.clock_in_event_id, entry.clock_out_event_id)
  order by entry.created_at desc, entry.id desc
  limit 1
) manual on true
left join lateral (
  select occurrence.session_event_id
  from private.get_unscheduled_time_session_start(
    target_event_id,
    target_employee_id,
    target_effective_at
  ) occurrence
  where target_shift_id is null
    and manual.id is null
) session on true
$$;

create or replace function private.get_payroll_assignment_anchor(
  target_shift_id uuid,
  target_event_id uuid,
  fallback_clock_in timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
select coalesce(
  (select shift.starts_at from public.shifts shift where shift.id = target_shift_id),
  manual.clock_in_at,
  session.session_started_at,
  fallback_clock_in
)
from (select 1) seed
left join lateral (
  select entry.id, entry.clock_in_at
  from public.manual_time_entries entry
  where target_event_id in (entry.clock_in_event_id, entry.clock_out_event_id)
  order by entry.created_at desc, entry.id desc
  limit 1
) manual on true
left join lateral (
  select occurrence.session_started_at
  from public.time_events target_event
  cross join lateral private.get_unscheduled_time_session_start(
    target_event.id,
    target_event.employee_id,
    fallback_clock_in
  ) occurrence
  where target_event.id = target_event_id
    and target_shift_id is null
    and manual.id is null
) session on true
$$;

-- Keep the server response ordered the same way the interface is ordered:
-- preferred/first name first, with last name as the stable secondary key.
do $patch_time_maintenance_order$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef('public.get_time_maintenance(date, date, uuid)'::regprocedure)
  into function_sql;

  if position('order by coalesce(nullif(employee.preferred_name' in function_sql) = 0 then
    updated_sql := replace(
      function_sql,
      'order by employee.last_name, employee.first_name)',
      'order by coalesce(nullif(employee.preferred_name, ''''), employee.first_name), employee.last_name)'
    );

    if updated_sql = function_sql then
      raise exception 'The Time Maintenance employee-order clause could not be updated safely.';
    end if;

    execute updated_sql;
  end if;
end
$patch_time_maintenance_order$;

-- Include the site code in Site/Post choices so client-specific patrol work can
-- be selected explicitly for accounting instead of relying on similar names.
do $patch_time_operations_site_code$
declare
  function_sql text;
  updated_sql text;
  existing_fragment text := '''siteId'', site.id,' || chr(10) || '        ''siteName'', site.name,';
  replacement_fragment text := '''siteId'', site.id,' || chr(10) || '        ''siteCode'', site.code,' || chr(10) || '        ''siteName'', site.name,';
begin
  select pg_get_functiondef('public.get_timekeeping_operations_workspace(date, date)'::regprocedure)
  into function_sql;

  if position('''siteCode'', site.code' in function_sql) = 0 then
    updated_sql := replace(function_sql, existing_fragment, replacement_fragment);

    if updated_sql = function_sql then
      raise exception 'The Time Operations Site/Post payload could not be updated safely.';
    end if;

    execute updated_sql;
  end if;
end
$patch_time_operations_site_code$;

revoke all on function private.get_unscheduled_time_session_start(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.get_timekeeping_occurrence_key(uuid, uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function private.get_payroll_assignment_anchor(uuid, uuid, timestamptz) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
