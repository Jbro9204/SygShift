begin;

set local lock_timeout = '5s';

-- Approved leave is interpreted in the employee time zone captured when the
-- request was submitted. A later profile-zone correction must not move an
-- already-approved interval relative to its scheduled shift.
create or replace function private.salaried_shift_assignment_has_approved_time_off(
  target_assignment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.employees employee on employee.id = assignment.employee_id
    join public.time_off_requests request
      on request.employee_id = assignment.employee_id
     and request.status = 'approved'
    where assignment.id = target_assignment_id
      and private.time_off_window(
        request.starts_on,
        request.ends_on,
        request.partial_day_start,
        request.partial_day_end,
        coalesce(
          nullif(request.submission_snapshot ->> 'timeZone', ''),
          employee.time_zone
        )
      ) && tstzrange(shift.starts_at, shift.ends_at, '[)')
  ), false)
$$;

revoke all on function private.salaried_shift_assignment_has_approved_time_off(uuid)
  from public, anon, authenticated;

-- Schedule mutations already take the week lock before assignment triggers
-- take the employee schedule/time-off lock. Put this mutation in the same
-- order so concurrent draft creation/publication cannot form a lock cycle.
do $repair_salaried_shift_presence_lock_order$
declare
  function_definition text;
  repaired_definition text;
  employee_lock constant text := 'perform private.lock_employee_schedule_time_off(target_record.employee_id);';
  schedule_lock constant text := 'perform pg_advisory_xact_lock(hashtext(''schedule-draft:'' || target_record.week_starts_on::text));';
  employee_lock_position integer;
  schedule_lock_position integer;
  intervening_whitespace text;
begin
  select pg_get_functiondef(
    'public.record_salaried_shift_outcome(uuid,text,uuid,text)'::regprocedure
  ) into function_definition;

  employee_lock_position := position(employee_lock in function_definition);
  schedule_lock_position := position(schedule_lock in function_definition);

  if employee_lock_position = 0
    or schedule_lock_position = 0
    or schedule_lock_position < employee_lock_position
  then
    raise check_violation using
      message = 'The salaried shift presence lock-order repair could not be installed safely.';
  end if;

  intervening_whitespace := substring(
    function_definition
    from employee_lock_position + char_length(employee_lock)
    for schedule_lock_position - employee_lock_position - char_length(employee_lock)
  );
  if intervening_whitespace !~ '^[[:space:]]+$' then
    raise check_violation using
      message = 'The salaried shift presence lock sequence was not adjacent.';
  end if;

  repaired_definition := substring(function_definition from 1 for employee_lock_position - 1)
    || schedule_lock
    || intervening_whitespace
    || employee_lock
    || substring(function_definition from schedule_lock_position + char_length(schedule_lock));

  if position(schedule_lock in repaired_definition) = 0
    or position(employee_lock in repaired_definition) = 0
    or position(schedule_lock in repaired_definition) > position(employee_lock in repaired_definition)
  then
    raise check_violation using
      message = 'The salaried shift presence lock order could not be verified.';
  end if;

  execute repaired_definition;
end
$repair_salaried_shift_presence_lock_order$;

comment on function private.salaried_shift_assignment_has_approved_time_off(uuid) is
  'Checks approved leave against a scheduled assignment using the immutable request submission time zone, with the current employee zone only as a legacy fallback.';

comment on function public.record_salaried_shift_outcome(uuid, text, uuid, text) is
  'Records or voids an affirmative Worked marker for a completed, published, non-absent salaried assignment. It uses the schedule-week then employee lock order and never mutates schedule or timekeeping rows.';

notify pgrst, 'reload schema';

commit;
