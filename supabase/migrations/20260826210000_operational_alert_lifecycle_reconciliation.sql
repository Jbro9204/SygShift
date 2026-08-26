-- Keep live attendance alerts focused on current operational action while
-- preserving every unresolved occurrence for payroll review and audit.

begin;

alter table public.timekeeping_operational_exceptions
  add column if not exists occurrence_key text;

alter table public.operational_alerts
  add column if not exists occurrence_key text,
  add column if not exists lifecycle_state text not null default 'active_operations',
  add column if not exists live_until_at timestamptz,
  add column if not exists lifecycle_evaluated_at timestamptz,
  add column if not exists clear_source text,
  add column if not exists cleared_reason text;

alter table public.operational_alerts
  drop constraint if exists operational_alerts_lifecycle_state_check;
alter table public.operational_alerts
  add constraint operational_alerts_lifecycle_state_check
  check (lifecycle_state in ('active_operations', 'payroll_review', 'resolved'));

alter table public.operational_alerts
  drop constraint if exists operational_alerts_clear_source_check;
alter table public.operational_alerts
  add constraint operational_alerts_clear_source_check
  check (clear_source is null or clear_source in ('automatic_resolution', 'manual_resolution', 'payroll_handoff', 'superseded_duplicate'));

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
      'dismissed',
      'reopened'
    )
  );

create or replace function private.timekeeping_operational_occurrence_key(
  target_employee_id uuid,
  target_exception_code text,
  target_shift_id uuid,
  target_scheduled_start_at timestamptz,
  target_scheduled_end_at timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(concat_ws(
    '|',
    target_employee_id::text,
    target_exception_code,
    extract(epoch from target_scheduled_start_at)::bigint::text,
    extract(epoch from target_scheduled_end_at)::bigint::text,
    coalesce(shift.post_id::text, concat('event:', shift.event_id::text))
  ))
  from public.shifts shift
  where shift.id = target_shift_id
$$;

revoke all on function private.timekeeping_operational_occurrence_key(uuid, text, uuid, timestamptz, timestamptz) from public, anon, authenticated;

update public.timekeeping_operational_exceptions exception
set occurrence_key = private.timekeeping_operational_occurrence_key(
  exception.employee_id,
  exception.exception_code,
  exception.shift_id,
  exception.scheduled_start_at,
  exception.scheduled_end_at
)
where exception.occurrence_key is null;

create temporary table operational_alert_duplicate_reconciliation on commit drop as
select ranked.id as duplicate_exception_id, ranked.canonical_exception_id
from (
  select
    exception.id,
    first_value(exception.id) over (
      partition by exception.occurrence_key
      order by
        case schedule.status when 'published' then 0 when 'superseded' then 1 else 2 end,
        schedule.revision desc,
        exception.detected_at desc,
        exception.id
    ) as canonical_exception_id,
    row_number() over (
      partition by exception.occurrence_key
      order by
        case schedule.status when 'published' then 0 when 'superseded' then 1 else 2 end,
        schedule.revision desc,
        exception.detected_at desc,
        exception.id
    ) as occurrence_rank
  from public.timekeeping_operational_exceptions exception
  join public.shifts shift on shift.id = exception.shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  where exception.status = 'unresolved'
    and exception.occurrence_key is not null
) ranked
where ranked.occurrence_rank > 1;

update public.timekeeping_operational_exceptions exception
set
  status = 'resolved',
  resolution_method = 'superseded_duplicate',
  resolution_note = concat(
    'Automatically reconciled as a duplicate schedule-revision occurrence. Canonical exception: ',
    reconciliation.canonical_exception_id::text,
    '.'
  ),
  resolved_at = clock_timestamp(),
  updated_at = clock_timestamp()
from operational_alert_duplicate_reconciliation reconciliation
where exception.id = reconciliation.duplicate_exception_id;

insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
select
  exception.id,
  'resolved_duplicate',
  exception.resolution_note,
  null,
  to_jsonb(exception)
from public.timekeeping_operational_exceptions exception
join operational_alert_duplicate_reconciliation reconciliation
  on reconciliation.duplicate_exception_id = exception.id;

update public.operational_alerts alert
set
  occurrence_key = exception.occurrence_key,
  live_until_at = case
    when exception.exception_code = 'missing_clock_in' then exception.scheduled_end_at + interval '1 hour'
    else null
  end,
  lifecycle_evaluated_at = clock_timestamp()
from public.timekeeping_operational_exceptions exception
where alert.related_record_type = 'timekeeping_operational_exception'
  and alert.related_record_id = exception.id;

update public.operational_alerts alert
set
  active = false,
  lifecycle_state = 'resolved',
  cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
  clear_source = 'superseded_duplicate',
  cleared_reason = concat(
    'Duplicate schedule-revision alert reconciled to canonical exception ',
    reconciliation.canonical_exception_id::text,
    '.'
  ),
  lifecycle_evaluated_at = clock_timestamp()
from operational_alert_duplicate_reconciliation reconciliation
where alert.related_record_type = 'timekeeping_operational_exception'
  and alert.related_record_id = reconciliation.duplicate_exception_id;

update public.operational_alerts alert
set
  active = false,
  lifecycle_state = 'resolved',
  cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
  clear_source = coalesce(alert.clear_source, 'automatic_resolution'),
  cleared_reason = coalesce(alert.cleared_reason, 'The source timekeeping exception is resolved.'),
  lifecycle_evaluated_at = clock_timestamp()
from public.timekeeping_operational_exceptions exception
where alert.related_record_type = 'timekeeping_operational_exception'
  and alert.related_record_id = exception.id
  and exception.status <> 'unresolved';

update public.operational_alerts alert
set
  active = false,
  lifecycle_state = 'payroll_review',
  cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
  clear_source = 'payroll_handoff',
  cleared_reason = 'The live response window ended one hour after the scheduled shift. The unresolved occurrence remains available for payroll review.',
  lifecycle_evaluated_at = clock_timestamp()
from public.timekeeping_operational_exceptions exception
where alert.related_record_type = 'timekeeping_operational_exception'
  and alert.related_record_id = exception.id
  and alert.active
  and exception.status = 'unresolved'
  and exception.exception_code = 'missing_clock_in'
  and clock_timestamp() >= exception.scheduled_end_at + interval '1 hour';

create index if not exists timekeeping_operational_exceptions_occurrence_idx
  on public.timekeeping_operational_exceptions(occurrence_key, status, detected_at desc);

create unique index if not exists timekeeping_operational_exceptions_one_unresolved_occurrence_idx
  on public.timekeeping_operational_exceptions(occurrence_key)
  where status = 'unresolved' and occurrence_key is not null;

create index if not exists operational_alerts_lifecycle_idx
  on public.operational_alerts(lifecycle_state, active, live_until_at);

create or replace function private.prepare_timekeeping_operational_exception_occurrence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.occurrence_key := private.timekeeping_operational_occurrence_key(
    new.employee_id,
    new.exception_code,
    new.shift_id,
    new.scheduled_start_at,
    new.scheduled_end_at
  );

  if tg_op = 'INSERT' and exists (
    select 1
    from public.timekeeping_operational_exceptions existing
    where existing.status = 'unresolved'
      and existing.occurrence_key = new.occurrence_key
  ) then
    return null;
  end if;

  return new;
end
$$;

drop trigger if exists timekeeping_operational_exception_occurrence on public.timekeeping_operational_exceptions;
create trigger timekeeping_operational_exception_occurrence
before insert or update of employee_id, exception_code, shift_id, scheduled_start_at, scheduled_end_at
on public.timekeeping_operational_exceptions
for each row execute function private.prepare_timekeeping_operational_exception_occurrence();

create or replace function private.prepare_operational_alert_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_exception public.timekeeping_operational_exceptions;
begin
  if new.related_record_type = 'timekeeping_operational_exception' then
    select * into source_exception
    from public.timekeeping_operational_exceptions exception
    where exception.id = new.related_record_id;

    if source_exception.id is not null then
      new.occurrence_key := source_exception.occurrence_key;
      new.live_until_at := case
        when source_exception.exception_code = 'missing_clock_in' then source_exception.scheduled_end_at + interval '1 hour'
        else null
      end;
    end if;
  end if;

  new.lifecycle_evaluated_at := clock_timestamp();

  if new.active then
    new.lifecycle_state := 'active_operations';
    new.cleared_at := null;
    new.cleared_by := null;
    new.clear_source := null;
    new.cleared_reason := null;
  elsif source_exception.id is not null and source_exception.status = 'unresolved' then
    new.lifecycle_state := 'payroll_review';
    new.clear_source := coalesce(new.clear_source, 'payroll_handoff');
    new.cleared_reason := coalesce(new.cleared_reason, 'The live response window ended. The unresolved occurrence remains available for payroll review.');
  else
    new.lifecycle_state := 'resolved';
    new.clear_source := coalesce(new.clear_source, 'manual_resolution');
    new.cleared_reason := coalesce(new.cleared_reason, 'The alert was resolved by an authorized action.');
  end if;

  return new;
end
$$;

drop trigger if exists operational_alert_lifecycle on public.operational_alerts;
create trigger operational_alert_lifecycle
before insert or update on public.operational_alerts
for each row execute function private.prepare_operational_alert_lifecycle();

create or replace function public.service_reconcile_operational_alert_lifecycle(
  target_full_reconciliation boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  resolved_exception_count integer := 0;
  duplicate_exception_count integer := 0;
  cleared_alert_count integer := 0;
  payroll_handoff_count integer := 0;
  locked boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  select pg_try_advisory_xact_lock(hashtext('sygshift.operational.alert.lifecycle')) into locked;
  if not locked then
    return jsonb_build_object('status', 'skipped', 'reason', 'reconciliation_already_running');
  end if;

  with ranked as (
    select
      exception.id,
      first_value(exception.id) over (
        partition by exception.occurrence_key
        order by
          case schedule.status when 'published' then 0 when 'superseded' then 1 else 2 end,
          schedule.revision desc,
          exception.detected_at desc,
          exception.id
      ) as canonical_exception_id,
      row_number() over (
        partition by exception.occurrence_key
        order by
          case schedule.status when 'published' then 0 when 'superseded' then 1 else 2 end,
          schedule.revision desc,
          exception.detected_at desc,
          exception.id
      ) as occurrence_rank
    from public.timekeeping_operational_exceptions exception
    join public.shifts shift on shift.id = exception.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id
    where exception.status = 'unresolved'
      and exception.occurrence_key is not null
      and (
        target_full_reconciliation
        or exception.detected_at >= clock_timestamp() - interval '14 days'
        or exists (
          select 1 from public.operational_alerts alert
          where alert.related_record_type = 'timekeeping_operational_exception'
            and alert.related_record_id = exception.id
            and alert.active
        )
      )
  ), resolved_duplicates as (
    update public.timekeeping_operational_exceptions exception
    set
      status = 'resolved',
      resolution_method = 'superseded_duplicate',
      resolution_note = concat('Automatically reconciled as a duplicate schedule-revision occurrence. Canonical exception: ', ranked.canonical_exception_id::text, '.'),
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp()
    from ranked
    where ranked.occurrence_rank > 1
      and exception.id = ranked.id
    returning exception.*
  ), recorded_duplicate_actions as (
    insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
    select duplicate.id, 'resolved_duplicate', duplicate.resolution_note, null, to_jsonb(duplicate)
    from resolved_duplicates duplicate
    returning id
  )
  select count(*) into duplicate_exception_count from recorded_duplicate_actions;

  with resolution_candidates as (
    select
      exception.id,
      case
        when shift.canceled_at is not null then 'shift_canceled'
        when exists (
          select 1
          from public.call_off_reports report
          join public.shifts report_shift on report_shift.id = report.shift_id
          where report.employee_id = exception.employee_id
            and report.canceled_at is null
            and report_shift.starts_at = exception.scheduled_start_at
            and report_shift.ends_at = exception.scheduled_end_at
            and report_shift.post_id is not distinct from shift.post_id
            and report_shift.event_id is not distinct from shift.event_id
        ) then 'call_off'
        when exists (
          select 1
          from public.time_events event
          join public.shifts event_shift on event_shift.id = event.shift_id
          cross join lateral private.current_effective_time_event(event.id) effective
          where event.employee_id = exception.employee_id
            and private.current_effective_time_event_kind(event.id) = 'clock_in'
            and not effective.voided
            and event_shift.starts_at = exception.scheduled_start_at
            and event_shift.ends_at = exception.scheduled_end_at
            and event_shift.post_id is not distinct from shift.post_id
            and event_shift.event_id is not distinct from shift.event_id
        ) then 'clock_in_received'
        when not exists (
          select 1
          from public.shift_assignments assignment
          where assignment.shift_id = exception.shift_id
            and assignment.employee_id = exception.employee_id
            and assignment.status in ('assigned', 'confirmed')
            and assignment.canceled_at is null
        ) then 'assignment_changed'
        else null
      end as resolution_method
    from public.timekeeping_operational_exceptions exception
    join public.shifts shift on shift.id = exception.shift_id
    where exception.exception_code = 'missing_clock_in'
      and exception.status = 'unresolved'
      and (
        target_full_reconciliation
        or exception.detected_at >= clock_timestamp() - interval '14 days'
        or exists (
          select 1 from public.operational_alerts alert
          where alert.related_record_type = 'timekeeping_operational_exception'
            and alert.related_record_id = exception.id
            and alert.active
        )
      )
  ), resolved as (
    update public.timekeeping_operational_exceptions exception
    set
      status = 'resolved',
      resolution_method = candidate.resolution_method,
      resolution_note = case candidate.resolution_method
        when 'shift_canceled' then 'Resolved automatically because the scheduled shift was canceled.'
        when 'call_off' then 'Resolved automatically because an active call-off covers this scheduled occurrence.'
        when 'clock_in_received' then 'Resolved automatically because a valid clock-in was received for this scheduled occurrence.'
        when 'assignment_changed' then 'Resolved automatically because the employee is no longer assigned to this shift.'
      end,
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp()
    from resolution_candidates candidate
    where candidate.id = exception.id
      and candidate.resolution_method is not null
    returning exception.*
  ), recorded_actions as (
    insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
    select
      resolved.id,
      case resolved.resolution_method
        when 'shift_canceled' then 'resolved_shift_canceled'
        when 'call_off' then 'resolved_call_off'
        when 'clock_in_received' then 'resolved_clock_in_received'
        when 'assignment_changed' then 'resolved_assignment_changed'
        else 'resolved_manual_entry'
      end,
      resolved.resolution_note,
      null,
      to_jsonb(resolved)
    from resolved
    returning id
  )
  select count(*) into resolved_exception_count from recorded_actions;

  with cleared as (
    update public.operational_alerts alert
    set
      active = false,
      lifecycle_state = 'resolved',
      cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
      clear_source = case
        when exception.resolution_method = 'superseded_duplicate' then 'superseded_duplicate'
        else 'automatic_resolution'
      end,
      cleared_reason = coalesce(exception.resolution_note, 'The source timekeeping exception is resolved.'),
      lifecycle_evaluated_at = clock_timestamp()
    from public.timekeeping_operational_exceptions exception
    where alert.related_record_type = 'timekeeping_operational_exception'
      and alert.related_record_id = exception.id
      and exception.status <> 'unresolved'
      and (alert.active or alert.lifecycle_state <> 'resolved')
    returning alert.id
  )
  select count(*) into cleared_alert_count from cleared;

  with handed_off as (
    update public.operational_alerts alert
    set
      active = false,
      lifecycle_state = 'payroll_review',
      cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
      clear_source = 'payroll_handoff',
      cleared_reason = 'The live response window ended one hour after the scheduled shift. The unresolved occurrence remains available for payroll review.',
      lifecycle_evaluated_at = clock_timestamp()
    from public.timekeeping_operational_exceptions exception
    where alert.related_record_type = 'timekeeping_operational_exception'
      and alert.related_record_id = exception.id
      and alert.active
      and exception.status = 'unresolved'
      and exception.exception_code = 'missing_clock_in'
      and clock_timestamp() >= exception.scheduled_end_at + interval '1 hour'
    returning alert.id
  )
  select count(*) into payroll_handoff_count from handed_off;

  update public.operational_alerts alert
  set lifecycle_evaluated_at = clock_timestamp()
  where alert.related_record_type = 'timekeeping_operational_exception'
    and alert.active
    and (
      target_full_reconciliation
      or alert.lifecycle_evaluated_at is null
      or alert.lifecycle_evaluated_at < clock_timestamp() - interval '5 minutes'
    );

  return jsonb_build_object(
    'status', 'completed',
    'fullReconciliation', target_full_reconciliation,
    'resolvedExceptionCount', resolved_exception_count,
    'duplicateExceptionCount', duplicate_exception_count,
    'clearedAlertCount', cleared_alert_count,
    'payrollHandoffCount', payroll_handoff_count
  );
end
$$;

revoke all on function public.service_reconcile_operational_alert_lifecycle(boolean) from public, anon, authenticated;
grant execute on function public.service_reconcile_operational_alert_lifecycle(boolean) to service_role;

notify pgrst, 'reload schema';

commit;
