begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $scheduled_runtime_molecular_repair$
declare
  automation_signature constant regprocedure :=
    'public.service_run_timekeeping_automation(uuid)'::regprocedure;
  attendance_signature constant regprocedure :=
    'private.refresh_attendance_alert_schedule_state(date,uuid,boolean)'::regprocedure;
  automation_definition text;
  repaired_automation text;
  attendance_definition text;
  repaired_attendance text;
  automatic_header_old constant text := $old$
  with candidates as (
$old$;
  automatic_header_new constant text := $new$
  with due_shifts as materialized (
    select
      shift.id,
      shift.schedule_id,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.post_id,
      shift.event_id
    from public.shifts shift
    where shift.canceled_at is null
      and shift.ends_at >= statement_timestamp() - interval '7 days'
      and shift.ends_at <= statement_timestamp() - make_interval(mins => automatic_grace)
  ), candidates as (
$new$;
  automatic_join_old constant text := $old$
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    -- Punches retain their exact shift ID for audit integrity. A published
    -- schedule revision may supersede that parent while the session is open.
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status in ('published', 'superseded')
$old$;
  automatic_join_new constant text := $new$
    from due_shifts shift
    join public.shift_assignments assignment on assignment.shift_id = shift.id
    -- Punches retain their exact shift ID for audit integrity. A published
    -- schedule revision may supersede that parent while the session is open.
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status in ('published', 'superseded')
$new$;
  automatic_filter_old constant text := $old$
    where assignment.status in ('assigned', 'confirmed')
      and shift.canceled_at is null
      and shift.ends_at + make_interval(mins => automatic_grace) <= clock_timestamp()
      and shift.ends_at >= clock_timestamp() - interval '7 days'
      and latest.kind in ('clock_in', 'break_start', 'break_end')
$old$;
  automatic_filter_new constant text := $new$
    where assignment.status in ('assigned', 'confirmed')
      and latest.kind in ('clock_in', 'break_start', 'break_end')
$new$;
  missing_header_old constant text := $old$
  with missing_candidates as (
$old$;
  missing_header_new constant text := $new$
  with due_missing_shifts as materialized (
    select
      shift.id,
      shift.schedule_id,
      shift.starts_at,
      shift.ends_at,
      shift.post_id,
      shift.event_id
    from public.shifts shift
    where shift.canceled_at is null
      and shift.starts_at >= statement_timestamp() - interval '7 days'
      and shift.starts_at <= statement_timestamp() - make_interval(mins => clock_in_grace)
  ), missing_candidates as (
$new$;
  missing_join_old constant text := $old$
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
$old$;
  missing_join_new constant text := $new$
    from due_missing_shifts shift
    join public.shift_assignments assignment on assignment.shift_id = shift.id
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
$new$;
  missing_filter_old constant text := $old$
    where assignment.status in ('assigned', 'confirmed')
      and shift.canceled_at is null
      and shift.starts_at + make_interval(mins => clock_in_grace) <= clock_timestamp()
      and shift.starts_at >= clock_timestamp() - interval '7 days'
      and not exists (
$old$;
  missing_filter_new constant text := $new$
    where assignment.status in ('assigned', 'confirmed')
      and not exists (
$new$;
  missing_event_old constant text := $old$
        select 1
        from public.time_events event
        cross join lateral private.current_effective_time_event(event.id) effective
        where event.employee_id = assignment.employee_id
          and private.same_scheduled_occurrence(event.shift_id, shift.id)
          and private.current_effective_time_event_kind(event.id) = 'clock_in'
          and not effective.voided
$old$;
  missing_event_new constant text := $new$
        select 1
        from public.shifts occurrence_shift
        join public.schedules occurrence_schedule
          on occurrence_schedule.id = occurrence_shift.schedule_id
        join public.time_events event
          on event.employee_id = assignment.employee_id
         and event.shift_id = occurrence_shift.id
        cross join lateral private.current_effective_time_event(event.id) effective
        where (
          occurrence_shift.id = shift.id
          or (
            occurrence_shift.schedule_id <> shift.schedule_id
            and occurrence_schedule.week_starts_on = schedule.week_starts_on
            and occurrence_shift.post_id is not distinct from shift.post_id
            and occurrence_shift.event_id is not distinct from shift.event_id
            and occurrence_shift.starts_at = shift.starts_at
            and occurrence_shift.ends_at = shift.ends_at
          )
        )
          and private.current_effective_time_event_kind(event.id) = 'clock_in'
          and not effective.voided
$new$;
  resolve_event_old constant text := $old$
          select 1 from public.time_events event
          cross join lateral private.current_effective_time_event(event.id) effective
          where private.same_scheduled_occurrence(event.shift_id, exception.shift_id)
            and event.employee_id = exception.employee_id
            and event.kind = 'clock_in'
            and not effective.voided
$old$;
  resolve_event_new constant text := $new$
          select 1
          from public.schedules target_schedule
          join public.shifts occurrence_shift on true
          join public.schedules occurrence_schedule
            on occurrence_schedule.id = occurrence_shift.schedule_id
          join public.time_events event
            on event.employee_id = exception.employee_id
           and event.shift_id = occurrence_shift.id
          cross join lateral private.current_effective_time_event(event.id) effective
          where target_schedule.id = shift.schedule_id
            and (
              occurrence_shift.id = shift.id
              or (
                occurrence_shift.schedule_id <> shift.schedule_id
                and occurrence_schedule.week_starts_on = target_schedule.week_starts_on
                and occurrence_shift.post_id is not distinct from shift.post_id
                and occurrence_shift.event_id is not distinct from shift.event_id
                and occurrence_shift.starts_at = shift.starts_at
                and occurrence_shift.ends_at = shift.ends_at
              )
            )
            and event.kind = 'clock_in'
            and not effective.voided
$new$;
  attendance_anchor_old constant text := $old$
  perform pg_advisory_xact_lock(hashtext('sygshift.attendance.alert.schedule.refresh'));

  -- An assignment can be removed and restored. Reopen only automatic
$old$;
  attendance_anchor_new constant text := $new$
  perform pg_advisory_xact_lock(hashtext('sygshift.attendance.alert.schedule.refresh'));

  -- This function has two radically different cardinalities: the daily full
  -- reconciliation and the five-minute incremental safety pass. A generic
  -- cached plan preserves the parameter OR and over-scans the incremental
  -- cohort. Force a value-aware custom plan for this transaction so Postgres
  -- can eliminate the inactive branch without changing reconciliation rules.
  perform set_config('plan_cache_mode', 'force_custom_plan', true);

  -- An assignment can be removed and restored. Reopen only automatic
$new$;
begin
  if not exists (
    select 1
    from pg_catalog.pg_index index_state
    where index_state.indexrelid = to_regclass('public.shifts_timekeeping_due_end_idx')
      and index_state.indisvalid
      and index_state.indisready
      and position('(ends_at, id)' in pg_get_indexdef(index_state.indexrelid)) > 0
      and position('WHERE (canceled_at IS NULL)' in pg_get_indexdef(index_state.indexrelid)) > 0
  ) then
    raise check_violation using message =
      'The reviewed due-shift index must exist before installing the bounded automation.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index index_state
    where index_state.indexrelid = to_regclass('public.time_events_employee_shift_recorded_idx')
      and index_state.indisvalid
      and index_state.indisready
      and position('(employee_id, shift_id, recorded_at DESC, id)' in pg_get_indexdef(index_state.indexrelid)) > 0
      and position('WHERE (shift_id IS NOT NULL)' in pg_get_indexdef(index_state.indexrelid)) > 0
  ) then
    raise check_violation using message =
      'The reviewed employee-occurrence event index must exist before installing the bounded automation.';
  end if;

  select pg_get_functiondef(automation_signature) into automation_definition;
  if md5(automation_definition) <> '5f8bb3822085eb6ce7d77be0e25941c4' then
    raise check_violation using message =
      'Timekeeping automation differs from the verified production baseline.';
  end if;

  repaired_automation := automation_definition;
  repaired_automation := replace(repaired_automation, automatic_header_old, automatic_header_new);
  repaired_automation := replace(repaired_automation, automatic_join_old, automatic_join_new);
  repaired_automation := replace(repaired_automation, automatic_filter_old, automatic_filter_new);
  repaired_automation := replace(repaired_automation, missing_header_old, missing_header_new);
  repaired_automation := replace(repaired_automation, missing_join_old, missing_join_new);
  repaired_automation := replace(repaired_automation, missing_filter_old, missing_filter_new);
  repaired_automation := replace(repaired_automation, missing_event_old, missing_event_new);
  repaired_automation := replace(repaired_automation, resolve_event_old, resolve_event_new);

  if repaired_automation = automation_definition
     or position(automatic_header_old in repaired_automation) > 0
     or position(automatic_join_old in repaired_automation) > 0
     or position(automatic_filter_old in repaired_automation) > 0
     or position(missing_header_old in repaired_automation) > 0
     or position(missing_join_old in repaired_automation) > 0
     or position(missing_filter_old in repaired_automation) > 0
     or position(missing_event_old in repaired_automation) > 0
     or position(resolve_event_old in repaired_automation) > 0
     or position('with due_shifts as materialized' in repaired_automation) = 0
     or position('with due_missing_shifts as materialized' in repaired_automation) = 0
     or position($marker$shift.ends_at >= statement_timestamp() - interval '7 days'$marker$ in repaired_automation) = 0
     or position($marker$shift.starts_at >= statement_timestamp() - interval '7 days'$marker$ in repaired_automation) = 0
     or position('join public.time_events event' in repaired_automation) = 0 then
    raise check_violation using message =
      'The bounded automation rewrite was incomplete; no function was changed.';
  end if;

  execute repaired_automation;

  select pg_get_functiondef(attendance_signature) into attendance_definition;
  if md5(attendance_definition) <> '0551c29b020e668744d199a0ac736233' then
    raise check_violation using message =
      'Attendance refresh differs from the verified production baseline.';
  end if;

  repaired_attendance := replace(attendance_definition, attendance_anchor_old, attendance_anchor_new);
  if repaired_attendance = attendance_definition
     or position(attendance_anchor_old in repaired_attendance) > 0
     or position($marker$set_config('plan_cache_mode', 'force_custom_plan', true)$marker$ in repaired_attendance) = 0 then
    raise check_violation using message =
      'The attendance custom-plan boundary was not installed.';
  end if;

  execute repaired_attendance;
end
$scheduled_runtime_molecular_repair$;

revoke all on function public.service_run_timekeeping_automation(uuid)
  from public, anon, authenticated;
grant execute on function public.service_run_timekeeping_automation(uuid)
  to service_role;

revoke all on function private.refresh_attendance_alert_schedule_state(date, uuid, boolean)
  from public, anon, authenticated;

comment on function public.service_run_timekeeping_automation(uuid) is
  'Runs idempotent timekeeping automation from materialized seven-day due-shift ranges before joining assignments and effective punches.';
comment on function private.refresh_attendance_alert_schedule_state(date, uuid, boolean) is
  'Reconciles current attendance-alert schedule state with a value-aware custom plan so full and incremental cohorts do not share a generic OR plan.';

notify pgrst, 'reload schema';

commit;
