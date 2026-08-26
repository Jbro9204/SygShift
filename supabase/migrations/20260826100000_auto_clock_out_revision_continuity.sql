-- Keep automatic clock-out tied to the immutable shift that the employee
-- actually clocked into, even after a later schedule revision supersedes it.
-- Draft and archived schedules remain ineligible. Missing-clock-in detection
-- intentionally remains limited to the current published schedule.

create or replace function public.service_run_timekeeping_automation(target_job_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  automatic_grace integer := private.timekeeping_setting_integer('timekeeping.automatic_clock_out_grace_minutes', 3);
  clock_in_grace integer := private.timekeeping_setting_integer('timekeeping.missing_clock_in_grace_minutes', 15);
  automatic_count integer := 0;
  missing_count integer := 0;
  created_alert_count integer := 0;
  locked boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_job_run_id is null then
    raise check_violation using message = 'A job run identifier is required.';
  end if;

  insert into private.timekeeping_job_runs (id, job_name)
  values (target_job_run_id, 'timekeeping_operations')
  on conflict (id) do nothing;

  if not found then
    return jsonb_build_object('jobRunId', target_job_run_id, 'status', 'duplicate', 'automaticClockOutCount', 0, 'missingClockInCount', 0, 'alertCount', 0);
  end if;

  select pg_try_advisory_xact_lock(hashtext('sygshift.timekeeping.operations')) into locked;
  if not locked then
    update private.timekeeping_job_runs set status = 'skipped', completed_at = clock_timestamp() where id = target_job_run_id;
    return jsonb_build_object('jobRunId', target_job_run_id, 'status', 'skipped', 'automaticClockOutCount', 0, 'missingClockInCount', 0, 'alertCount', 0);
  end if;

  with candidates as (
    select
      assignment.id as assignment_id,
      assignment.employee_id,
      shift.id as shift_id,
      shift.starts_at,
      shift.ends_at,
      coalesce(shift.time_zone, 'America/Denver') as time_zone,
      site.name as site_name,
      post.name as post_name,
      schedule_event.name as event_name,
      latest.id as latest_event_id,
      latest.kind as latest_kind,
      latest.effective_at as latest_effective_at
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    -- Punches retain their exact shift ID for audit integrity. A published
    -- schedule revision may supersede that parent while the session is open.
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status in ('published', 'superseded')
    join public.employees employee on employee.id = assignment.employee_id and employee.status = 'active'
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    left join lateral (
      select event.id, event.kind, effective.effective_at
      from public.time_events event
      cross join lateral private.current_effective_time_event(event.id) effective
      where event.employee_id = assignment.employee_id
        and event.shift_id = shift.id
        and not effective.voided
      order by effective.effective_at desc, event.recorded_at desc, event.id desc
      limit 1
    ) latest on true
    where assignment.status in ('assigned', 'confirmed')
      and shift.canceled_at is null
      and shift.ends_at + make_interval(mins => automatic_grace) <= clock_timestamp()
      and shift.ends_at >= clock_timestamp() - interval '7 days'
      and latest.kind in ('clock_in', 'break_start', 'break_end')
      and latest.effective_at <= shift.ends_at
  ), inserted_events as (
    insert into public.time_events (
      employee_id,
      shift_id,
      kind,
      recorded_at,
      client_recorded_at,
      source,
      idempotency_key,
      created_by
    )
    select
      candidate.employee_id,
      candidate.shift_id,
      'clock_out'::public.time_event_kind,
      candidate.ends_at,
      null,
      'system'::public.time_event_source,
      concat('automatic-clock-out:', candidate.assignment_id, ':', extract(epoch from candidate.ends_at)::bigint),
      null
    from candidates candidate
    where not exists (
      select 1
      from public.time_events existing
      cross join lateral private.current_effective_time_event(existing.id) effective
      where existing.employee_id = candidate.employee_id
        and existing.shift_id = candidate.shift_id
        and existing.kind = 'clock_out'
        and not effective.voided
        and effective.effective_at >= candidate.latest_effective_at
    )
    on conflict (idempotency_key) do nothing
    returning *
  ), inserted_notes as (
    insert into public.time_event_maintenance_notes (time_event_id, action, note, created_by)
    select event.id, 'automatic_clock_out', 'Automatically clocked out at the scheduled shift end because SygShift did not receive a clock-out punch.', null
    from inserted_events event
    returning time_event_id
  ), inserted_exceptions as (
    insert into public.timekeeping_operational_exceptions (
      employee_id,
      shift_id,
      exception_code,
      status,
      severity,
      scheduled_start_at,
      scheduled_end_at,
      source_time_event_id,
      job_run_id
    )
    select event.employee_id, event.shift_id, 'automatic_clock_out', 'unresolved', 'warning', shift.starts_at, shift.ends_at, event.id, target_job_run_id
    from inserted_events event
    join public.shifts shift on shift.id = event.shift_id
    on conflict (employee_id, shift_id, exception_code) do nothing
    returning *
  ), inserted_actions as (
    insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
    select exception.id, 'created', 'The scheduled automation created an automatic clock-out review item.', null, to_jsonb(exception)
    from inserted_exceptions exception
    returning exception_id
  ), inserted_outbox as (
    insert into private.notification_outbox (
      message_type,
      aggregate_type,
      aggregate_id,
      recipient_employee_id,
      payload,
      idempotency_key
    )
    select
      'automatic_clock_out_employee',
      'timekeeping_operational_exception',
      exception.id,
      exception.employee_id,
      jsonb_build_object('scheduledEndAt', exception.scheduled_end_at, 'shiftId', exception.shift_id),
      concat('automatic-clock-out-employee:', exception.id)
    from inserted_exceptions exception
    on conflict (idempotency_key) do nothing
    returning id
  )
  select count(*) into automatic_count from inserted_events;

  with missing_candidates as (
    select
      assignment.employee_id,
      shift.id as shift_id,
      shift.starts_at,
      shift.ends_at
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
    join public.employees employee on employee.id = assignment.employee_id and employee.status = 'active'
    where assignment.status in ('assigned', 'confirmed')
      and shift.canceled_at is null
      and shift.starts_at + make_interval(mins => clock_in_grace) <= clock_timestamp()
      and shift.starts_at >= clock_timestamp() - interval '7 days'
      and not exists (
        select 1
        from public.time_events event
        cross join lateral private.current_effective_time_event(event.id) effective
        where event.employee_id = assignment.employee_id
          and event.shift_id = shift.id
          and event.kind = 'clock_in'
          and not effective.voided
      )
      and not exists (
        select 1 from public.call_off_reports report
        where report.employee_id = assignment.employee_id
          and report.shift_id = shift.id
          and report.canceled_at is null
      )
  ), inserted_exceptions as (
    insert into public.timekeeping_operational_exceptions (
      employee_id,
      shift_id,
      exception_code,
      status,
      severity,
      scheduled_start_at,
      scheduled_end_at,
      job_run_id
    )
    select candidate.employee_id, candidate.shift_id, 'missing_clock_in', 'unresolved', 'blocking', candidate.starts_at, candidate.ends_at, target_job_run_id
    from missing_candidates candidate
    on conflict (employee_id, shift_id, exception_code) do nothing
    returning *
  ), inserted_actions as (
    insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
    select exception.id, 'created', 'No clock-in punch was received within the configured grace period.', null, to_jsonb(exception)
    from inserted_exceptions exception
    returning exception_id
  )
  select count(*) into missing_count from inserted_exceptions;

  with created_alerts as (
    insert into public.operational_alerts (
      alert_type,
      priority,
      title,
      summary,
      employee_id,
      shift_id,
      related_record_type,
      related_record_id,
      audience_roles,
      direct_path,
      deduplication_key
    )
    select
      exception.exception_code,
      case when exception.exception_code = 'missing_clock_in' then 'urgent' else 'high' end,
      case when exception.exception_code = 'missing_clock_in' then 'Missing clock-in' else 'Automatic clock-out recorded' end,
      concat(coalesce(employee.preferred_name, employee.first_name), ' ', employee.last_name, ' · ', coalesce(site.name, post.name, schedule_event.name, 'Scheduled shift')),
      exception.employee_id,
      exception.shift_id,
      'timekeeping_operational_exception',
      exception.id,
      array['dispatcher', 'scheduler', 'supervisor', 'admin']::public.app_role[],
      concat('/time/exceptions?operationalException=', exception.id),
      concat('timekeeping-exception:', exception.id)
    from public.timekeeping_operational_exceptions exception
    join public.employees employee on employee.id = exception.employee_id
    join public.shifts shift on shift.id = exception.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    where exception.job_run_id = target_job_run_id
    on conflict (deduplication_key) do nothing
    returning id
  )
  select count(*) into created_alert_count from created_alerts;

  with resolved as (
    update public.timekeeping_operational_exceptions exception
    set
      status = 'resolved',
      resolution_method = case
        when shift.canceled_at is not null then 'shift_canceled'
        when exists (select 1 from public.call_off_reports report where report.shift_id = exception.shift_id and report.employee_id = exception.employee_id and report.canceled_at is null) then 'call_off'
        else 'clock_in_received'
      end,
      resolution_note = 'Resolved automatically from the authoritative schedule or attendance record.',
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp()
    from public.shifts shift
    where exception.shift_id = shift.id
      and exception.exception_code = 'missing_clock_in'
      and exception.status = 'unresolved'
      and (
        shift.canceled_at is not null
        or exists (select 1 from public.call_off_reports report where report.shift_id = exception.shift_id and report.employee_id = exception.employee_id and report.canceled_at is null)
        or exists (
          select 1 from public.time_events event
          cross join lateral private.current_effective_time_event(event.id) effective
          where event.shift_id = exception.shift_id
            and event.employee_id = exception.employee_id
            and event.kind = 'clock_in'
            and not effective.voided
        )
      )
    returning exception.*
  )
  insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
  select
    resolved.id,
    case resolved.resolution_method when 'call_off' then 'resolved_call_off' when 'shift_canceled' then 'resolved_shift_canceled' else 'resolved_manual_entry' end,
    resolved.resolution_note,
    null,
    to_jsonb(resolved)
  from resolved;

  update private.timekeeping_job_runs
  set
    completed_at = clock_timestamp(),
    status = 'completed',
    automatic_clock_out_count = automatic_count,
    missing_clock_in_count = missing_count,
    alert_count = created_alert_count
  where id = target_job_run_id;

  return jsonb_build_object(
    'jobRunId', target_job_run_id,
    'status', 'completed',
    'automaticClockOutCount', automatic_count,
    'missingClockInCount', missing_count,
    'alertCount', created_alert_count
  );
exception when others then
  update private.timekeeping_job_runs
  set completed_at = clock_timestamp(), status = 'failed', error_text = left(sqlerrm, 1000)
  where id = target_job_run_id;
  raise;
end
$$;

revoke all on function public.service_run_timekeeping_automation(uuid) from public, anon, authenticated;
grant execute on function public.service_run_timekeeping_automation(uuid) to service_role;

notify pgrst, 'reload schema';
