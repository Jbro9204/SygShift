-- Forward recovery for the scheduled-runtime molecular repair. It restores the
-- exact verified production function definitions and privileges; it does not
-- delete or rewrite schedules, punches, alerts, job runs, or audit records.
begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $recover_scheduled_runtime_molecular_repair$
declare
  automation_signature constant regprocedure :=
    'public.service_run_timekeeping_automation(uuid)'::regprocedure;
  attendance_signature constant regprocedure :=
    'private.refresh_attendance_alert_schedule_state(date,uuid,boolean)'::regprocedure;
  automation_definition text;
  recovered_automation text;
  attendance_definition text;
  recovered_attendance text;
  automatic_header_old constant text := $old$
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
$old$;
  automatic_header_new constant text := $new$
  with candidates as (
$new$;
  automatic_join_old constant text := $old$
    from due_shifts shift
    join public.shift_assignments assignment on assignment.shift_id = shift.id
    -- Punches retain their exact shift ID for audit integrity. A published
    -- schedule revision may supersede that parent while the session is open.
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status in ('published', 'superseded')
$old$;
  automatic_join_new constant text := $new$
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    -- Punches retain their exact shift ID for audit integrity. A published
    -- schedule revision may supersede that parent while the session is open.
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status in ('published', 'superseded')
$new$;
  automatic_filter_old constant text := $old$
    where assignment.status in ('assigned', 'confirmed')
      and latest.kind in ('clock_in', 'break_start', 'break_end')
$old$;
  automatic_filter_new constant text := $new$
    where assignment.status in ('assigned', 'confirmed')
      and shift.canceled_at is null
      and shift.ends_at + make_interval(mins => automatic_grace) <= clock_timestamp()
      and shift.ends_at >= clock_timestamp() - interval '7 days'
      and latest.kind in ('clock_in', 'break_start', 'break_end')
$new$;
  missing_header_old constant text := $old$
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
$old$;
  missing_header_new constant text := $new$
  with missing_candidates as (
$new$;
  missing_join_old constant text := $old$
    from due_missing_shifts shift
    join public.shift_assignments assignment on assignment.shift_id = shift.id
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
$old$;
  missing_join_new constant text := $new$
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
$new$;
  missing_filter_old constant text := $old$
    where assignment.status in ('assigned', 'confirmed')
      and not exists (
$old$;
  missing_filter_new constant text := $new$
    where assignment.status in ('assigned', 'confirmed')
      and shift.canceled_at is null
      and shift.starts_at + make_interval(mins => clock_in_grace) <= clock_timestamp()
      and shift.starts_at >= clock_timestamp() - interval '7 days'
      and not exists (
$new$;
  missing_event_old constant text := $old$
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
$old$;
  missing_event_new constant text := $new$
        select 1
        from public.time_events event
        cross join lateral private.current_effective_time_event(event.id) effective
        where event.employee_id = assignment.employee_id
          and private.same_scheduled_occurrence(event.shift_id, shift.id)
          and private.current_effective_time_event_kind(event.id) = 'clock_in'
          and not effective.voided
$new$;
  resolve_event_old constant text := $old$
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
$old$;
  resolve_event_new constant text := $new$
          select 1 from public.time_events event
          cross join lateral private.current_effective_time_event(event.id) effective
          where private.same_scheduled_occurrence(event.shift_id, exception.shift_id)
            and event.employee_id = exception.employee_id
            and event.kind = 'clock_in'
            and not effective.voided
$new$;
  attendance_anchor_old constant text := $old$
  perform pg_advisory_xact_lock(hashtext('sygshift.attendance.alert.schedule.refresh'));

  -- This function has two radically different cardinalities: the daily full
  -- reconciliation and the five-minute incremental safety pass. A generic
  -- cached plan preserves the parameter OR and over-scans the incremental
  -- cohort. Force a value-aware custom plan for this transaction so Postgres
  -- can eliminate the inactive branch without changing reconciliation rules.
  perform set_config('plan_cache_mode', 'force_custom_plan', true);

  -- An assignment can be removed and restored. Reopen only automatic
$old$;
  attendance_anchor_new constant text := $new$
  perform pg_advisory_xact_lock(hashtext('sygshift.attendance.alert.schedule.refresh'));

  -- An assignment can be removed and restored. Reopen only automatic
$new$;
begin
  select pg_get_functiondef(automation_signature) into automation_definition;
  if position('with due_shifts as materialized' in automation_definition) = 0
     or position('with due_missing_shifts as materialized' in automation_definition) = 0
     or position($marker$shift.ends_at >= statement_timestamp() - interval '7 days'$marker$ in automation_definition) = 0
     or position($marker$shift.starts_at >= statement_timestamp() - interval '7 days'$marker$ in automation_definition) = 0
     or pg_get_userbyid((select proowner from pg_proc where oid = automation_signature)) <> 'postgres'
     or not (select prosecdef from pg_proc where oid = automation_signature)
     or (select proconfig from pg_proc where oid = automation_signature) is distinct from array['search_path=""']::text[]
     or (select proacl::text from pg_proc where oid = automation_signature)
       is distinct from '{postgres=X/postgres,service_role=X/postgres}' then
    raise check_violation using message =
      'Scheduled automation no longer matches the reviewed repair boundary; recovery refused.';
  end if;

  recovered_automation := automation_definition;
  recovered_automation := replace(recovered_automation, automatic_header_old, automatic_header_new);
  recovered_automation := replace(recovered_automation, automatic_join_old, automatic_join_new);
  recovered_automation := replace(recovered_automation, automatic_filter_old, automatic_filter_new);
  recovered_automation := replace(recovered_automation, missing_header_old, missing_header_new);
  recovered_automation := replace(recovered_automation, missing_join_old, missing_join_new);
  recovered_automation := replace(recovered_automation, missing_filter_old, missing_filter_new);
  recovered_automation := replace(recovered_automation, missing_event_old, missing_event_new);
  recovered_automation := replace(recovered_automation, resolve_event_old, resolve_event_new);

  if md5(recovered_automation) <> '5f8bb3822085eb6ce7d77be0e25941c4' then
    raise check_violation using message =
      'Scheduled automation recovery did not reproduce the verified production definition.';
  end if;

  select pg_get_functiondef(attendance_signature) into attendance_definition;
  if position($marker$set_config('plan_cache_mode', 'force_custom_plan', true)$marker$ in attendance_definition) = 0
     or pg_get_userbyid((select proowner from pg_proc where oid = attendance_signature)) <> 'postgres'
     or not (select prosecdef from pg_proc where oid = attendance_signature)
     or (select proconfig from pg_proc where oid = attendance_signature) is distinct from array['search_path=""']::text[]
     or (select proacl::text from pg_proc where oid = attendance_signature)
       is distinct from '{postgres=X/postgres}' then
    raise check_violation using message =
      'Attendance refresh no longer matches the reviewed repair boundary; recovery refused.';
  end if;

  recovered_attendance := replace(attendance_definition, attendance_anchor_old, attendance_anchor_new);
  if md5(recovered_attendance) <> '0551c29b020e668744d199a0ac736233' then
    raise check_violation using message =
      'Attendance refresh recovery did not reproduce the verified production definition.';
  end if;

  execute recovered_automation;
  execute recovered_attendance;
end
$recover_scheduled_runtime_molecular_repair$;

revoke all on function public.service_run_timekeeping_automation(uuid)
  from public, anon, authenticated;
grant execute on function public.service_run_timekeeping_automation(uuid)
  to service_role;
revoke all on function private.refresh_attendance_alert_schedule_state(date, uuid, boolean)
  from public, anon, authenticated;

comment on function public.service_run_timekeeping_automation(uuid) is null;
comment on function private.refresh_attendance_alert_schedule_state(date, uuid, boolean) is
  'Reconciles current attendance-alert schedule state. Incremental safety passes are bounded to recent or active operations; targeted schedule changes and the daily service pass remain complete.';

notify pgrst, 'reload schema';

commit;
