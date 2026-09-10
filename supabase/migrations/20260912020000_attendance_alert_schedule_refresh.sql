-- Reconcile persistent attendance alerts against the authoritative published
-- schedule whenever assignments or schedule revisions change. Source records
-- and action history remain append-only evidence; stale alerts are closed, not
-- deleted.

begin;

alter table public.timekeeping_operational_exception_actions
  drop constraint if exists timekeeping_operational_exception_action;
alter table public.timekeeping_operational_exception_actions
  add constraint timekeeping_operational_exception_action check (
    action in (
      'created',
      'resolved_manual_entry',
      'resolved_adjustment',
      'resolved_call_off',
      'resolved_shift_canceled',
      'resolved_clock_in_received',
      'resolved_assignment_changed',
      'resolved_duplicate',
      'resolved_employment_exempt',
      'resolved_dispatch_duty',
      'resolved_schedule_revised',
      'dismissed',
      'reopened'
    )
  );

create or replace function private.attendance_exception_has_current_required_assignment(
  target_exception_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.timekeeping_operational_exceptions exception
    join public.shifts source_shift on source_shift.id = exception.shift_id
    join public.schedules source_schedule on source_schedule.id = source_shift.schedule_id
    join public.schedules current_schedule
      on current_schedule.week_starts_on = source_schedule.week_starts_on
     and current_schedule.status = 'published'
    join public.shifts current_shift
      on current_shift.schedule_id = current_schedule.id
     and private.same_scheduled_occurrence(source_shift.id, current_shift.id)
    join public.shift_assignments assignment
      on assignment.shift_id = current_shift.id
     and assignment.employee_id = exception.employee_id
     and assignment.status in ('assigned', 'confirmed')
     and assignment.canceled_at is null
    join public.employees employee
      on employee.id = exception.employee_id
     and employee.status = 'active'
     and employee.employment_type <> 'salary'::public.employment_type
    where exception.id = target_exception_id
      and current_shift.canceled_at is null
      and private.shift_assignment_type(current_shift.id) <> 'dispatch_phone_duty'
  )
$$;

revoke all on function private.attendance_exception_has_current_required_assignment(uuid)
  from public, anon, authenticated;

create or replace function private.refresh_attendance_alert_schedule_state(
  target_week_starts_on date default null,
  target_employee_id uuid default null,
  target_full_reconciliation boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clock_in_grace integer := private.timekeeping_setting_integer('timekeeping.missing_clock_in_grace_minutes', 15);
  reopened_exception_count integer := 0;
  reopened_exception_ids uuid[] := array[]::uuid[];
  reactivated_alert_count integer := 0;
  resolved_exception_count integer := 0;
  resolved_exception_ids uuid[] := array[]::uuid[];
  cleared_alert_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('sygshift.attendance.alert.schedule.refresh'));

  -- An assignment can be removed and restored. Reopen only automatic
  -- eligibility resolutions when the current published occurrence once again
  -- requires a clock-in and no attendance evidence already satisfies it.
  with reopen_candidates as (
    select exception.id
    from public.timekeeping_operational_exceptions exception
    join public.shifts source_shift on source_shift.id = exception.shift_id
    join public.schedules source_schedule on source_schedule.id = source_shift.schedule_id
    where exception.exception_code = 'missing_clock_in'
      and exception.status = 'resolved'
      and exception.resolution_method in (
        'assignment_changed',
        'schedule_revised',
        'employment_exempt',
        'dispatch_phone_duty'
      )
      and (target_week_starts_on is null or source_schedule.week_starts_on = target_week_starts_on)
      and (target_employee_id is null or exception.employee_id = target_employee_id)
      and exception.scheduled_start_at + make_interval(mins => clock_in_grace) <= clock_timestamp()
      and (
        target_full_reconciliation
        or exception.scheduled_start_at >= clock_timestamp() - interval '7 days'
        or exists (
          select 1
          from public.operational_alerts alert
          where alert.related_record_type = 'timekeeping_operational_exception'
            and alert.related_record_id = exception.id
            and alert.lifecycle_state <> 'resolved'
        )
      )
      and private.attendance_exception_has_current_required_assignment(exception.id)
      and not exists (
        select 1
        from public.call_off_reports report
        where report.employee_id = exception.employee_id
          and report.canceled_at is null
          and private.same_scheduled_occurrence(report.shift_id, exception.shift_id)
      )
      and not exists (
        select 1
        from public.time_events event
        cross join lateral private.current_effective_time_event(event.id) effective
        where event.employee_id = exception.employee_id
          and private.current_effective_time_event_kind(event.id) = 'clock_in'
          and not effective.voided
          and private.same_scheduled_occurrence(event.shift_id, exception.shift_id)
      )
      and not exists (
        select 1
        from public.timekeeping_operational_exceptions other_exception
        where other_exception.id <> exception.id
          and other_exception.status = 'unresolved'
          and other_exception.occurrence_key = exception.occurrence_key
      )
  ), reopened as (
    update public.timekeeping_operational_exceptions exception
    set
      status = 'unresolved',
      resolution_method = null,
      resolution_note = null,
      resolved_by = null,
      resolved_at = null,
      updated_at = clock_timestamp()
    from reopen_candidates candidate
    where exception.id = candidate.id
      and exception.status = 'resolved'
    returning exception.*
  ), recorded as (
    insert into public.timekeeping_operational_exception_actions (
      exception_id,
      action,
      reason,
      actor_id,
      snapshot
    )
    select
      reopened.id,
      'reopened',
      'Reopened automatically because the current published schedule again requires this employee to clock in for the occurrence.',
      null,
      to_jsonb(reopened)
    from reopened
    returning exception_id
  )
  select count(*), coalesce(array_agg(exception_id), array[]::uuid[])
  into reopened_exception_count, reopened_exception_ids
  from recorded;

  with reactivated as (
    update public.operational_alerts alert
    set
      active = exception.scheduled_end_at + interval '1 hour' > clock_timestamp(),
      lifecycle_state = case
        when exception.scheduled_end_at + interval '1 hour' > clock_timestamp() then 'active_operations'
        else 'payroll_review'
      end,
      cleared_at = case
        when exception.scheduled_end_at + interval '1 hour' > clock_timestamp() then null
        else coalesce(alert.cleared_at, clock_timestamp())
      end,
      cleared_by = null,
      clear_source = case
        when exception.scheduled_end_at + interval '1 hour' > clock_timestamp() then null
        else 'payroll_handoff'
      end,
      cleared_reason = case
        when exception.scheduled_end_at + interval '1 hour' > clock_timestamp() then null
        else 'The restored assignment is outside the live response window and remains available for payroll review.'
      end,
      lifecycle_evaluated_at = clock_timestamp()
    from public.timekeeping_operational_exceptions exception
    where alert.related_record_type = 'timekeeping_operational_exception'
      and alert.related_record_id = exception.id
      and exception.status = 'unresolved'
      and exception.id = any(reopened_exception_ids)
    returning alert.id
  )
  select count(*) into reactivated_alert_count from reactivated;

  with resolution_candidates as (
    select
      exception.id,
      case
        when employee.employment_type = 'salary'::public.employment_type then 'employment_exempt'
        when private.shift_assignment_type(source_shift.id) = 'dispatch_phone_duty' then 'dispatch_phone_duty'
        when exists (
          select 1
          from public.call_off_reports report
          where report.employee_id = exception.employee_id
            and report.canceled_at is null
            and private.same_scheduled_occurrence(report.shift_id, exception.shift_id)
        ) then 'call_off'
        when exists (
          select 1
          from public.time_events event
          cross join lateral private.current_effective_time_event(event.id) effective
          where event.employee_id = exception.employee_id
            and private.current_effective_time_event_kind(event.id) = 'clock_in'
            and not effective.voided
            and private.same_scheduled_occurrence(event.shift_id, exception.shift_id)
        ) then 'clock_in_received'
        when source_schedule.status = 'published'
          and not private.attendance_exception_has_current_required_assignment(exception.id)
          and source_shift.canceled_at is not null
          then 'shift_canceled'
        when source_schedule.status = 'published'
          and not private.attendance_exception_has_current_required_assignment(exception.id)
          then 'assignment_changed'
        when source_schedule.status in ('superseded', 'archived')
          and exists (
            select 1
            from public.schedules current_schedule
            where current_schedule.week_starts_on = source_schedule.week_starts_on
              and current_schedule.status = 'published'
          )
          and not private.attendance_exception_has_current_required_assignment(exception.id)
          then 'schedule_revised'
        else null
      end as resolution_method
    from public.timekeeping_operational_exceptions exception
    join public.employees employee on employee.id = exception.employee_id
    join public.shifts source_shift on source_shift.id = exception.shift_id
    join public.schedules source_schedule on source_schedule.id = source_shift.schedule_id
    where exception.exception_code = 'missing_clock_in'
      and exception.status = 'unresolved'
      and (target_week_starts_on is null or source_schedule.week_starts_on = target_week_starts_on)
      and (target_employee_id is null or exception.employee_id = target_employee_id)
      and (
        target_full_reconciliation
        or exception.detected_at >= clock_timestamp() - interval '14 days'
        or exists (
          select 1
          from public.operational_alerts alert
          where alert.related_record_type = 'timekeeping_operational_exception'
            and alert.related_record_id = exception.id
            and (alert.active or alert.lifecycle_state <> 'resolved')
        )
      )
  ), resolved as (
    update public.timekeeping_operational_exceptions exception
    set
      status = 'resolved',
      resolution_method = candidate.resolution_method,
      resolution_note = case candidate.resolution_method
        when 'employment_exempt' then 'Resolved automatically because salaried employees are exempt from shift clock-in requirements.'
        when 'dispatch_phone_duty' then 'Resolved automatically because supplemental Dispatch phone duty does not require a separate time-clock session.'
        when 'call_off' then 'Resolved automatically because an active call-off covers this scheduled occurrence.'
        when 'clock_in_received' then 'Resolved automatically because a valid clock-in was received for this scheduled occurrence.'
        when 'shift_canceled' then 'Resolved automatically because the current published shift was canceled.'
        when 'assignment_changed' then 'Resolved automatically because the current published schedule no longer requires this employee to clock in for the occurrence.'
        when 'schedule_revised' then 'Resolved automatically because the current published schedule revision no longer requires this employee to clock in for the occurrence.'
      end,
      resolved_by = null,
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp()
    from resolution_candidates candidate
    where candidate.id = exception.id
      and candidate.resolution_method is not null
      and exception.status = 'unresolved'
    returning exception.*
  ), recorded as (
    insert into public.timekeeping_operational_exception_actions (
      exception_id,
      action,
      reason,
      actor_id,
      snapshot
    )
    select
      resolved.id,
      case resolved.resolution_method
        when 'employment_exempt' then 'resolved_employment_exempt'
        when 'dispatch_phone_duty' then 'resolved_dispatch_duty'
        when 'call_off' then 'resolved_call_off'
        when 'clock_in_received' then 'resolved_clock_in_received'
        when 'shift_canceled' then 'resolved_shift_canceled'
        when 'assignment_changed' then 'resolved_assignment_changed'
        when 'schedule_revised' then 'resolved_schedule_revised'
        else 'resolved_manual_entry'
      end,
      resolved.resolution_note,
      null,
      to_jsonb(resolved)
    from resolved
    returning exception_id
  )
  select count(*), coalesce(array_agg(exception_id), array[]::uuid[])
  into resolved_exception_count, resolved_exception_ids
  from recorded;

  with cleared as (
    update public.operational_alerts alert
    set
      active = false,
      lifecycle_state = 'resolved',
      cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
      cleared_by = null,
      clear_source = 'automatic_resolution',
      cleared_reason = exception.resolution_note,
      lifecycle_evaluated_at = clock_timestamp()
    from public.timekeeping_operational_exceptions exception
    where alert.related_record_type = 'timekeeping_operational_exception'
      and alert.related_record_id = exception.id
      and exception.status = 'resolved'
      and exception.id = any(resolved_exception_ids)
      and (alert.active or alert.lifecycle_state <> 'resolved')
    returning alert.id
  )
  select count(*) into cleared_alert_count from cleared;

  return jsonb_build_object(
    'status', 'completed',
    'weekStartsOn', target_week_starts_on,
    'employeeId', target_employee_id,
    'fullReconciliation', target_full_reconciliation,
    'reopenedExceptionCount', reopened_exception_count,
    'reactivatedAlertCount', reactivated_alert_count,
    'resolvedExceptionCount', resolved_exception_count,
    'clearedAlertCount', cleared_alert_count
  );
end
$$;

revoke all on function private.refresh_attendance_alert_schedule_state(date, uuid, boolean)
  from public, anon, authenticated;

create or replace function public.service_refresh_attendance_alert_schedule_state(
  target_full_reconciliation boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  locked boolean;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  select pg_try_advisory_xact_lock(hashtext('sygshift.attendance.alert.schedule.refresh')) into locked;
  if not locked then
    return jsonb_build_object('status', 'skipped', 'reason', 'schedule_refresh_already_running');
  end if;

  return private.refresh_attendance_alert_schedule_state(null, null, target_full_reconciliation);
end
$$;

revoke all on function public.service_refresh_attendance_alert_schedule_state(boolean)
  from public, anon, authenticated;
grant execute on function public.service_refresh_attendance_alert_schedule_state(boolean)
  to service_role;

-- Reconcile the existing inventory before change triggers begin watching new
-- schedule mutations. This updates lifecycle state only and preserves every
-- exception, alert, source schedule, and action row.
select private.refresh_attendance_alert_schedule_state(null, null, true);

do $$
begin
  if exists (
    select 1
    from public.timekeeping_operational_exceptions exception
    join public.shifts source_shift on source_shift.id = exception.shift_id
    join public.schedules source_schedule on source_schedule.id = source_shift.schedule_id
    where exception.exception_code = 'missing_clock_in'
      and exception.status = 'unresolved'
      and not private.attendance_exception_has_current_required_assignment(exception.id)
      and (
        source_schedule.status = 'published'
        or (
          source_schedule.status in ('superseded', 'archived')
          and exists (
            select 1
            from public.schedules current_schedule
            where current_schedule.week_starts_on = source_schedule.week_starts_on
              and current_schedule.status = 'published'
          )
        )
      )
  ) then
    raise exception 'Unsupported missing-clock exceptions remain unresolved after schedule refresh.';
  end if;
end
$$;

create or replace function private.refresh_attendance_alerts_after_schedule_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status in ('published', 'superseded') then
      perform private.refresh_attendance_alert_schedule_state(new.week_starts_on, null, true);
    end if;
    return new;
  end if;

  if old.status is distinct from new.status
     or old.week_starts_on is distinct from new.week_starts_on then
    if old.status in ('published', 'superseded') then
      perform private.refresh_attendance_alert_schedule_state(old.week_starts_on, null, true);
    end if;
    if new.status in ('published', 'superseded')
       and (old.status not in ('published', 'superseded')
         or new.week_starts_on is distinct from old.week_starts_on) then
      perform private.refresh_attendance_alert_schedule_state(new.week_starts_on, null, true);
    end if;
  end if;

  return new;
end
$$;

revoke all on function private.refresh_attendance_alerts_after_schedule_change()
  from public, anon, authenticated;

drop trigger if exists refresh_attendance_alerts_after_schedule_change on public.schedules;
create constraint trigger refresh_attendance_alerts_after_schedule_change
after insert or update on public.schedules
deferrable initially deferred
for each row execute function private.refresh_attendance_alerts_after_schedule_change();

create or replace function private.refresh_attendance_alerts_after_assignment_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  old_week date;
  new_week date;
begin
  if tg_op <> 'INSERT' then
    select schedule.week_starts_on into old_week
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    where shift.id = old.shift_id
      and schedule.status in ('published', 'superseded');

    if old_week is not null then
      perform private.refresh_attendance_alert_schedule_state(old_week, old.employee_id, true);
    end if;
  end if;

  if tg_op <> 'DELETE' then
    select schedule.week_starts_on into new_week
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    where shift.id = new.shift_id
      and schedule.status in ('published', 'superseded');

    if new_week is not null
       and (tg_op = 'INSERT' or new_week is distinct from old_week or new.employee_id is distinct from old.employee_id) then
      perform private.refresh_attendance_alert_schedule_state(new_week, new.employee_id, true);
    elsif new_week is not null and tg_op = 'UPDATE' then
      perform private.refresh_attendance_alert_schedule_state(new_week, new.employee_id, true);
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$$;

revoke all on function private.refresh_attendance_alerts_after_assignment_change()
  from public, anon, authenticated;

drop trigger if exists refresh_attendance_alerts_after_assignment_change on public.shift_assignments;
create constraint trigger refresh_attendance_alerts_after_assignment_change
after insert or update or delete on public.shift_assignments
deferrable initially deferred
for each row execute function private.refresh_attendance_alerts_after_assignment_change();

create or replace function private.refresh_attendance_alerts_after_shift_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  old_week date;
  new_week date;
begin
  if old.schedule_id is not distinct from new.schedule_id
     and old.post_id is not distinct from new.post_id
     and old.event_id is not distinct from new.event_id
     and old.starts_at is not distinct from new.starts_at
     and old.ends_at is not distinct from new.ends_at
     and old.canceled_at is not distinct from new.canceled_at
     and old.assignment_type is not distinct from new.assignment_type then
    return new;
  end if;

  select schedule.week_starts_on into old_week
  from public.schedules schedule
  where schedule.id = old.schedule_id
    and schedule.status in ('published', 'superseded');

  select schedule.week_starts_on into new_week
  from public.schedules schedule
  where schedule.id = new.schedule_id
    and schedule.status in ('published', 'superseded');

  if old_week is not null then
    perform private.refresh_attendance_alert_schedule_state(old_week, null, true);
  end if;
  if new_week is not null and new_week is distinct from old_week then
    perform private.refresh_attendance_alert_schedule_state(new_week, null, true);
  end if;

  return new;
end
$$;

revoke all on function private.refresh_attendance_alerts_after_shift_change()
  from public, anon, authenticated;

drop trigger if exists refresh_attendance_alerts_after_shift_change on public.shifts;
create constraint trigger refresh_attendance_alerts_after_shift_change
after update on public.shifts
deferrable initially deferred
for each row execute function private.refresh_attendance_alerts_after_shift_change();

notify pgrst, 'reload schema';

commit;
