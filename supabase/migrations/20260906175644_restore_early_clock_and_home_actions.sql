begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Keep the existing permission, server-time, idempotency and punch guards.
-- A clock-in without a currently eligible shift must resolve the next assigned
-- paid shift and reach the SAME structured warning as an explicit shift ID.
do $restore_early_clock$
declare
  definition text;
  original text := $old$      if eligible_shift_count = 0 then
        raise check_violation using message = 'Clock-in opens five minutes before your scheduled shift. Open your schedule to see the start time.';
      elsif eligible_shift_count > 1 then$old$;
  replacement text := $new$      if eligible_shift_count = 0 then
        select shift.id into resolved_shift_id
        from public.shift_assignments assignment
        join public.shifts shift on shift.id = assignment.shift_id
        join public.schedules schedule on schedule.id = shift.schedule_id
        where assignment.employee_id = actor_employee_id
          and assignment.status in ('assigned', 'confirmed')
          and assignment.canceled_at is null
          and schedule.status = 'published'
          and shift.canceled_at is null
          and private.shift_assignment_type(shift.id) = 'standard'
          and shift.starts_at > server_now + interval '5 minutes'
        order by shift.starts_at, shift.id
        limit 1;
        if resolved_shift_id is null then
          raise check_violation using message = 'No active published shift is assigned for clock-in. Open your schedule or contact your supervisor.';
        end if;
      elsif eligible_shift_count > 1 then$new$;
begin
  definition := pg_get_functiondef('public.record_time_event(public.time_event_kind,uuid,timestamptz,text)'::regprocedure);
  if position(original in definition) = 0
    or position('''code'', ''EARLY_CLOCK_IN_BLOCKED''' in definition) = 0 then
    raise exception 'Clock-in contract changed; review required before applying repair.';
  end if;
  -- Never choose concurrent phone duty as a separate paid clock session.
  definition := replace(definition, 'and shift.canceled_at is null', 'and shift.canceled_at is null
        and assignment.canceled_at is null
        and private.shift_assignment_type(shift.id) = ''standard''');
  definition := replace(definition, original, replacement);
  execute definition;
end
$restore_early_clock$;

-- Retain the existing dashboard window AND the nearest later paid assignment.
-- Later shifts are informational: record_time_event still enforces eligibility.
do $restore_next_shift$
declare
  definition text;
  original text := $old$and shift.starts_at <= server_now + interval '12 hours'$old$;
  replacement text := $new$and (
        shift.starts_at <= server_now + interval '12 hours'
        or shift.id = (
          select next_shift.id
          from public.shift_assignments next_assignment
          join public.shifts next_shift on next_shift.id = next_assignment.shift_id
          join public.schedules next_schedule on next_schedule.id = next_shift.schedule_id
          where next_assignment.employee_id = viewer_employee_id
            and next_assignment.status in ('assigned', 'confirmed')
            and next_assignment.canceled_at is null
            and next_schedule.status = 'published'
            and next_shift.canceled_at is null
            and private.shift_assignment_type(next_shift.id) = 'standard'
            and next_shift.starts_at > server_now + interval '12 hours'
          order by next_shift.starts_at, next_shift.id limit 1
        )
      )$new$;
begin
  definition := pg_get_functiondef('public.get_timekeeping_dashboard(date)'::regprocedure);
  if position(original in definition) = 0 then
    raise exception 'Time dashboard window changed; review required before applying repair.';
  end if;
  definition := replace(definition, original, replacement);
  execute definition;
end
$restore_next_shift$;

notify pgrst, 'reload schema';
commit;
