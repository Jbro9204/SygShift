-- Retire call-off work when its live staffing window ends while preserving the
-- report, notification, coverage, and audit records that explain what happened.

begin;

set local lock_timeout = '10s';

do $preconditions$
declare
  submit_definition text;
begin
  if to_regprocedure('public.service_reconcile_operational_alert_lifecycle(boolean)') is null then
    raise exception 'Expected operational-alert lifecycle reconciler is missing.';
  end if;
  if to_regprocedure('public.get_timekeeping_operations_workspace(date,date)') is null then
    raise exception 'Expected Time Operations workspace reader is missing.';
  end if;
  if to_regprocedure('public.update_employee_call_off(uuid,text,text,text,boolean,text)') is null then
    raise exception 'Expected call-off update RPC is missing.';
  end if;
  if to_regprocedure('public.submit_shift_request(uuid,text)') is null then
    raise exception 'Expected hardened shift-request submission RPC is missing.';
  end if;
  select pg_get_functiondef('public.submit_shift_request(uuid,text)'::regprocedure)
  into submit_definition;
  if not exists (
      select 1
      from pg_proc procedure
      where procedure.oid = 'public.submit_shift_request(uuid,text)'::regprocedure
        and procedure.prosecdef
    )
    or position('target_shift.canceled_at is not null' in submit_definition) = 0
    or position('headcount_required' in submit_definition) = 0
    or position('public.has_valid_credential' in submit_definition) = 0
    or position('You already have a request for this shift.' in submit_definition) = 0
  then
    raise exception 'Hardened shift-request submission precondition did not match the reviewed definition.';
  end if;
  if to_regclass('public.call_off_reports') is null
     or to_regclass('public.operational_alerts') is null
     or to_regclass('public.employee_notifications') is null
     or to_regclass('public.shift_coverage_cases') is null
  then
    raise exception 'Required call-off lifecycle tables are missing.';
  end if;
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'call_off_reports'
      and column_name = 'duplicate_of_call_off_report_id'
  ) then
    raise exception 'Expected canonical call-off duplicate linkage is missing.';
  end if;
end
$preconditions$;

alter table public.call_off_reports
  add column if not exists resolution_outcome text;

alter table public.call_off_reports
  drop constraint if exists call_off_reports_resolution_outcome_check;
alter table public.call_off_reports
  add constraint call_off_reports_resolution_outcome_check
  check (
    resolution_outcome is null
    or resolution_outcome in (
      'covered',
      'no_replacement',
      'no_replacement_required',
      'patrol_completed',
      'canceled',
      'shift_ended_unfilled',
      'legacy_resolved'
    )
  );

comment on column public.call_off_reports.resolution_outcome is
  'Authoritative terminal outcome. Null means the call-off still requires live operational handling.';

alter table public.operational_alerts
  drop constraint if exists operational_alerts_clear_source_check;
alter table public.operational_alerts
  add constraint operational_alerts_clear_source_check
  check (
    clear_source is null
    or clear_source in (
      'automatic_resolution',
      'manual_resolution',
      'payroll_handoff',
      'superseded_duplicate',
      'orphaned_source'
    )
  );

-- Browser writes use audited RPCs. Removing direct INSERT/UPDATE also prevents
-- table grants from bypassing required alert and append-only action records.
revoke insert, update on table public.call_off_reports from authenticated;
revoke insert, update on table public.shift_requests from authenticated;

-- Automatic lifecycle work has no employee actor. Keep the same honest actor
-- model already used by timekeeping and coverage system actions.
alter table public.call_off_report_actions
  alter column actor_id drop not null;

comment on column public.call_off_report_actions.actor_id is
  'Employee actor when a person acted; null for an automatic, append-only system lifecycle action.';

alter table public.shift_coverage_cases
  drop constraint if exists shift_coverage_resolution_pair;
alter table public.shift_coverage_cases
  add constraint shift_coverage_resolution_pair check (
    (resolved_by is null and resolved_at is null)
    or (resolved_by is not null and resolved_at is not null)
    or (status = 'closed' and resolved_by is null and resolved_at is not null)
  );

-- Classify already-terminal history conservatively before automatic rules are
-- installed. Do not infer a staffing result unless the coverage record proves it.
update public.call_off_reports report
set
  resolution_outcome = case
    when report.canceled_at is not null then 'canceled'
    when not report.replacement_needed then 'no_replacement_required'
    when report.duplicate_of_call_off_report_id is not null then 'legacy_resolved'
    when exists (
      select 1
      from public.shift_coverage_cases coverage
      join public.vacancy_patrol_recovery_requests recovery
        on recovery.source_shift_id in (coverage.source_shift_id, coverage.coverage_shift_id)
      where coverage.call_off_report_id = report.id
        and recovery.status = 'completed'
    ) then 'patrol_completed'
    when exists (
      select 1
      from public.shift_coverage_cases coverage
      where coverage.call_off_report_id = report.id
        and (coverage.status = 'assigned' or coverage.coverage_mode = 'assigned_guard')
    ) then 'covered'
    when exists (
      select 1
      from public.shift_coverage_cases coverage
      where coverage.call_off_report_id = report.id
        and (coverage.status = 'no_replacement' or coverage.coverage_mode = 'no_replacement')
    ) then 'no_replacement'
    else 'legacy_resolved'
  end,
  resolved_at = case
    when report.canceled_at is null
         and (
           not report.replacement_needed
           or report.duplicate_of_call_off_report_id is not null
         )
      then coalesce(report.resolved_at, report.updated_at, report.reported_at, clock_timestamp())
    else report.resolved_at
  end
where report.resolution_outcome is null
  and (
    report.canceled_at is not null
    or report.resolved_at is not null
    or not report.replacement_needed
    or report.duplicate_of_call_off_report_id is not null
  );

create or replace function private.prepare_call_off_report_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  shift_ends_at timestamptz;
  inferred_outcome text;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.shift_id is distinct from old.shift_id
       or new.employee_id is distinct from old.employee_id
       or new.reported_at is distinct from old.reported_at
       or new.reported_by is distinct from old.reported_by
       or new.call_received_at is distinct from old.call_received_at
       or new.received_by is distinct from old.received_by
    then
      raise check_violation using message = 'A call-off source identity cannot be changed after reporting.';
    end if;

    if (
      old.canceled_at is not null
      or old.resolved_at is not null
      or old.duplicate_of_call_off_report_id is not null
      or not old.replacement_needed
    ) then
      if new.canceled_at is not null and old.canceled_at is null then
        null; -- A later, explicit cancellation may supersede another outcome.
      elsif new.canceled_at is null
            and new.resolved_at is null
            and new.duplicate_of_call_off_report_id is null
            and new.replacement_needed
            and new.resolution_outcome is null
      then
        if old.resolution_outcome is distinct from 'no_replacement_required'
           or old.canceled_at is not null
           or old.duplicate_of_call_off_report_id is not null
        then
          raise check_violation using message = 'Only a no-replacement-required call-off may return to live coverage.';
        end if;
      elsif old.resolved_at is null
            and old.canceled_at is null
            and new.resolved_at is not null
            and new.canceled_at is null
            and new.duplicate_of_call_off_report_id is not distinct from old.duplicate_of_call_off_report_id
            and new.replacement_needed is not distinct from old.replacement_needed
            and (
              (
                not old.replacement_needed
                and new.resolution_outcome = 'no_replacement_required'
              )
              or (
                old.replacement_needed
                and old.duplicate_of_call_off_report_id is not null
                and new.resolution_outcome = 'legacy_resolved'
              )
            )
      then
        null; -- Complete an exact legacy terminal shape; never reopen/rewrite it.
      elsif old.resolution_outcome in ('covered', 'no_replacement')
            and new.resolution_outcome is not distinct from old.resolution_outcome
            and new.resolved_at is not null
            and new.canceled_at is not distinct from old.canceled_at
            and new.duplicate_of_call_off_report_id is not distinct from old.duplicate_of_call_off_report_id
            and new.replacement_needed is not distinct from old.replacement_needed
            and exists (
              select 1
              from public.shift_coverage_cases coverage
              where coverage.call_off_report_id = new.id
                and (
                  (
                    old.resolution_outcome = 'covered'
                    and (
                      coverage.status = 'assigned'
                      or coverage.coverage_mode = 'assigned_guard'
                    )
                  )
                  or (
                    old.resolution_outcome = 'no_replacement'
                    and (
                      coverage.status = 'no_replacement'
                      or coverage.coverage_mode = 'no_replacement'
                    )
                  )
                )
            )
      then
        -- The preserved coverage resolver performs a duplicate terminal UPDATE
        -- for no_replacement. Treat only that evidence-backed repeat as a no-op
        -- and retain the first authoritative resolution timestamp.
        new.resolved_at := old.resolved_at;
      elsif new.resolution_outcome = 'patrol_completed'
            and new.resolved_at is not null
            and exists (
              select 1
              from public.shift_coverage_cases coverage
              join public.vacancy_patrol_recovery_requests recovery
                on recovery.source_shift_id in (coverage.source_shift_id, coverage.coverage_shift_id)
              where coverage.call_off_report_id = new.id
                and recovery.status = 'completed'
            )
      then
        null; -- Completed Patrol evidence may refine an earlier terminal outcome.
      elsif new.replacement_needed is distinct from old.replacement_needed
            or new.resolved_at is distinct from old.resolved_at
            or new.canceled_at is distinct from old.canceled_at
            or new.duplicate_of_call_off_report_id is distinct from old.duplicate_of_call_off_report_id
            or new.resolution_outcome is distinct from old.resolution_outcome
      then
        raise check_violation using message = 'A completed call-off lifecycle cannot be rewritten.';
      end if;
    end if;
  end if;

  select shift.ends_at
  into shift_ends_at
  from public.shifts shift
  where shift.id = new.shift_id;

  if shift_ends_at is null then
    raise foreign_key_violation using message = 'The call-off shift is unavailable.';
  end if;

  if tg_op = 'UPDATE'
     and old.resolution_outcome = 'no_replacement_required'
     and new.resolved_at is null
     and new.canceled_at is null
     and new.duplicate_of_call_off_report_id is null
     and new.replacement_needed
     and new.resolution_outcome is null
     and clock_timestamp() >= shift_ends_at + interval '1 hour'
  then
    raise check_violation using message = 'Replacement coverage cannot be reopened after the live response window.';
  end if;

  if new.canceled_at is not null then
    new.resolution_outcome := 'canceled';
  elsif not new.replacement_needed then
    new.resolved_at := coalesce(new.resolved_at, clock_timestamp());
    new.resolution_outcome := 'no_replacement_required';
  elsif new.duplicate_of_call_off_report_id is not null then
    new.resolved_at := coalesce(new.resolved_at, clock_timestamp());
    new.resolution_outcome := coalesce(new.resolution_outcome, 'legacy_resolved');
  elsif new.resolved_at is not null then
    if new.resolution_outcome is null then
      if exists (
        select 1
        from public.shift_coverage_cases coverage
        join public.vacancy_patrol_recovery_requests recovery
          on recovery.source_shift_id in (coverage.source_shift_id, coverage.coverage_shift_id)
        where coverage.call_off_report_id = new.id
          and recovery.status = 'completed'
      ) then
        inferred_outcome := 'patrol_completed';
      else
        select case
          when coverage.status = 'assigned' or coverage.coverage_mode = 'assigned_guard' then 'covered'
          when coverage.status = 'no_replacement' or coverage.coverage_mode = 'no_replacement' then 'no_replacement'
          else null
        end
        into inferred_outcome
        from public.shift_coverage_cases coverage
        where coverage.call_off_report_id = new.id;
      end if;

      new.resolution_outcome := coalesce(inferred_outcome, 'legacy_resolved');
    end if;
  elsif clock_timestamp() >= shift_ends_at + interval '1 hour' then
    new.resolved_at := shift_ends_at + interval '1 hour';
    new.resolution_outcome := 'shift_ended_unfilled';
  else
    new.resolution_outcome := null;
  end if;

  return new;
end
$$;

revoke all on function private.prepare_call_off_report_lifecycle()
  from public, anon, authenticated;

drop trigger if exists prepare_call_off_report_lifecycle
  on public.call_off_reports;
create trigger prepare_call_off_report_lifecycle
before insert or update
on public.call_off_reports
for each row execute function private.prepare_call_off_report_lifecycle();

-- Coverage creation can occur after a report INSERT trigger has already
-- terminalized a past or replacement-not-required report. Recheck and lock
-- the source at the coverage table boundary so old RPCs and service writers
-- cannot recreate live operational work after retirement.
create or replace function private.guard_shift_coverage_case_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  report public.call_off_reports%rowtype;
  shift_ends_at timestamptz;
begin
  if new.status not in ('draft', 'open_pool', 'patrol_review', 'assigned') then
    return new;
  end if;

  select item.*
  into report
  from public.call_off_reports item
  where item.id = new.call_off_report_id
  for update of item;

  if report.id is null then
    raise foreign_key_violation using message = 'The linked call-off report is unavailable.';
  end if;

  select shift.ends_at
  into shift_ends_at
  from public.shifts shift
  where shift.id = report.shift_id;

  if report.canceled_at is not null
     or report.resolved_at is not null
     or report.duplicate_of_call_off_report_id is not null
     or not report.replacement_needed
     or clock_timestamp() >= shift_ends_at + interval '1 hour'
  then
    raise check_violation using message = 'Live coverage cannot be created for a terminal call-off.';
  end if;

  return new;
end
$$;

revoke all on function private.guard_shift_coverage_case_lifecycle()
  from public, anon, authenticated;

drop trigger if exists guard_shift_coverage_case_lifecycle
  on public.shift_coverage_cases;
create trigger guard_shift_coverage_case_lifecycle
before insert or update of call_off_report_id, status
on public.shift_coverage_cases
for each row execute function private.guard_shift_coverage_case_lifecycle();

create or replace function private.guard_call_off_shift_request_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  report public.call_off_reports%rowtype;
  shift_ends_at timestamptz;
  coverage_status text;
begin
  if new.status <> 'pending' then
    return new;
  end if;

  select report_row.*
  into report
  from public.shift_coverage_cases coverage
  join public.call_off_reports report_row on report_row.id = coverage.call_off_report_id
  where coverage.coverage_shift_id = new.shift_id
  for update of report_row;

  if report.id is null then
    return new; -- Ordinary open-shift requests are not call-off lifecycle work.
  end if;

  select source_shift.ends_at, coverage.status
  into shift_ends_at, coverage_status
  from public.shift_coverage_cases coverage
  join public.shifts source_shift on source_shift.id = report.shift_id
  where coverage.call_off_report_id = report.id
    and coverage.coverage_shift_id = new.shift_id;

  if report.canceled_at is not null
     or report.resolved_at is not null
     or report.duplicate_of_call_off_report_id is not null
     or not report.replacement_needed
     or clock_timestamp() >= shift_ends_at + interval '1 hour'
     or coverage_status <> 'open_pool'
  then
    raise check_violation using message = 'The linked call-off no longer accepts coverage requests.';
  end if;

  return new;
end
$$;

revoke all on function private.guard_call_off_shift_request_lifecycle()
  from public, anon, authenticated;

drop trigger if exists guard_call_off_shift_request_lifecycle
  on public.shift_requests;
create trigger guard_call_off_shift_request_lifecycle
before insert or update of shift_id, status on public.shift_requests
for each row execute function private.guard_call_off_shift_request_lifecycle();

-- Raw request writes are revoked above. Preserve the already-hardened definer
-- submit RPC verbatim and convert only the legacy withdrawal path.
create or replace function public.withdraw_shift_request(target_request_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_employee_id uuid := private.current_employee_id();
begin
  if actor_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  update public.shift_requests request
  set
    status = 'withdrawn',
    updated_at = clock_timestamp()
  where request.id = target_request_id
    and request.employee_id = actor_employee_id
    and request.status = 'pending';

  if not found then
    raise check_violation using message = 'Only a pending request owned by this account can be withdrawn.';
  end if;
  return true;
end
$$;

revoke all on function public.submit_shift_request(uuid, text)
  from public, anon;
grant execute on function public.submit_shift_request(uuid, text)
  to authenticated;
revoke all on function public.withdraw_shift_request(uuid)
  from public, anon;
grant execute on function public.withdraw_shift_request(uuid)
  to authenticated;

create or replace function private.call_off_lifecycle_reason(target_outcome text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case target_outcome
    when 'covered' then 'Replacement coverage was completed.'
    when 'no_replacement' then 'Management completed the coverage plan without a replacement.'
    when 'no_replacement_required' then 'Replacement coverage is not required for this call-off.'
    when 'patrol_completed' then 'Patrol completed the linked vacancy-recovery plan.'
    when 'canceled' then 'The call-off was canceled.'
    when 'shift_ended_unfilled' then 'The live coverage window ended one hour after the scheduled shift without a recorded replacement. The call-off remains available for post-shift review.'
    when 'legacy_resolved' then 'The call-off was already resolved before lifecycle outcomes were recorded.'
    else null
  end
$$;

revoke all on function private.call_off_lifecycle_reason(text)
  from public, anon, authenticated;

create or replace function private.record_call_off_system_resolution(
  target_call_off_report_id uuid,
  target_outcome text,
  target_reason text
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  report public.call_off_reports%rowtype;
  affected integer := 0;
begin
  if target_outcome not in ('no_replacement_required', 'patrol_completed', 'shift_ended_unfilled') then
    return 0;
  end if;

  select *
  into report
  from public.call_off_reports item
  where item.id = target_call_off_report_id;

  if report.id is null or report.resolution_outcome is distinct from target_outcome then
    return 0;
  end if;

  insert into public.call_off_report_actions (
    call_off_report_id,
    action,
    reason,
    actor_id,
    snapshot
  )
  select
    report.id,
    'resolved',
    target_reason,
    null,
    to_jsonb(report) || jsonb_build_object('lifecycle_reason', target_reason)
  where not exists (
    select 1
    from public.call_off_report_actions existing
    where existing.call_off_report_id = report.id
      and existing.action = 'resolved'
      and existing.reason = target_reason
      and existing.snapshot ->> 'resolution_outcome' = target_outcome
  );
  get diagnostics affected = row_count;
  return affected;
end
$$;

revoke all on function private.record_call_off_system_resolution(uuid, text, text)
  from public, anon, authenticated;

create or replace function private.prepare_call_off_notification_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  report public.call_off_reports%rowtype;
  shift_ends_at timestamptz;
  cutoff_at timestamptz;
  terminal boolean := false;
begin
  if new.source_type <> 'call_off_request' then
    return new;
  end if;

  if new.source_id is null then
    new.action_required := false;
    new.resolved_at := coalesce(new.resolved_at, clock_timestamp());
    new.expires_at := least(
      coalesce(new.expires_at, new.resolved_at),
      new.resolved_at
    );
    return new;
  end if;

  -- Serialize fresh child creation report-first. UPDATE already owns the
  -- notification row, so locking the report there would reverse retirement's
  -- report -> notification order.
  if tg_op = 'INSERT' then
    perform 1
    from public.call_off_reports item
    where item.id = new.source_id
    for share;
  end if;

  select item.*
  into report
  from public.call_off_reports item
  where item.id = new.source_id;

  if report.id is null then
    new.action_required := false;
    new.resolved_at := coalesce(new.resolved_at, clock_timestamp());
    new.expires_at := least(
      coalesce(new.expires_at, new.resolved_at),
      new.resolved_at
    );
    return new;
  end if;

  select shift.ends_at
  into shift_ends_at
  from public.shifts shift
  where shift.id = report.shift_id;

  cutoff_at := shift_ends_at + interval '1 hour';
  new.expires_at := least(coalesce(new.expires_at, cutoff_at), cutoff_at);
  terminal :=
    report.canceled_at is not null
    or report.resolved_at is not null
    or report.duplicate_of_call_off_report_id is not null
    or not report.replacement_needed
    or clock_timestamp() >= cutoff_at;

  if terminal then
    new.action_required := false;
    new.resolved_at := coalesce(
      new.resolved_at,
      report.canceled_at,
      report.resolved_at,
      case when clock_timestamp() >= cutoff_at then cutoff_at else clock_timestamp() end
    );
    new.expires_at := least(new.expires_at, new.resolved_at);
  end if;

  return new;
end
$$;

revoke all on function private.prepare_call_off_notification_lifecycle()
  from public, anon, authenticated;

drop trigger if exists prepare_call_off_notification_lifecycle
  on public.employee_notifications;
create trigger prepare_call_off_notification_lifecycle
before insert or update of
  source_type,
  source_id,
  action_required,
  resolved_at,
  expires_at
on public.employee_notifications
for each row execute function private.prepare_call_off_notification_lifecycle();

create or replace function private.suppress_terminal_call_off_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  report public.call_off_reports%rowtype;
  shift_ends_at timestamptz;
begin
  if new.message_type <> 'call_off_supervisor_alert'
     or new.aggregate_type <> 'call_off_report'
  then
    return new;
  end if;

  -- Claim/status UPDATE paths already own the outbox row. Only INSERT needs
  -- this report-first barrier against landing after the retirement sweep.
  if tg_op = 'INSERT' then
    perform 1
    from public.call_off_reports item
    where item.id = new.aggregate_id
    for share;
  end if;

  select item.*
  into report
  from public.call_off_reports item
  where item.id = new.aggregate_id;

  if report.id is not null then
    select shift.ends_at
    into shift_ends_at
    from public.shifts shift
    where shift.id = report.shift_id;
  end if;

  if report.id is null
     or report.canceled_at is not null
     or report.resolved_at is not null
     or report.duplicate_of_call_off_report_id is not null
     or not report.replacement_needed
     or clock_timestamp() >= shift_ends_at + interval '1 hour'
  then
    new.failed_at := coalesce(new.failed_at, clock_timestamp());
    new.last_error := coalesce(
      new.last_error,
      'Suppressed by call-off lifecycle reconciliation because no live coverage action remains.'
    );
  end if;

  return new;
end
$$;

revoke all on function private.suppress_terminal_call_off_outbox()
  from public, anon, authenticated;

drop trigger if exists suppress_terminal_call_off_outbox
  on private.notification_outbox;
create trigger suppress_terminal_call_off_outbox
before insert or update of
  message_type,
  aggregate_type,
  aggregate_id,
  failed_at
on private.notification_outbox
for each row execute function private.suppress_terminal_call_off_outbox();

create or replace function private.retire_call_off_live_artifacts(
  target_call_off_report_id uuid,
  target_outcome text,
  target_reason text,
  target_retired_at timestamptz,
  target_actor_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  report public.call_off_reports%rowtype;
  shift_record public.shifts%rowtype;
  coverage_before public.shift_coverage_cases%rowtype;
  coverage_after public.shift_coverage_cases%rowtype;
  alert_count integer := 0;
  call_off_notification_count integer := 0;
  coverage_notification_count integer := 0;
  email_delivery_count integer := 0;
  push_count integer := 0;
  outbox_count integer := 0;
  coverage_case_count integer := 0;
  wave_count integer := 0;
  announcement_count integer := 0;
  request_count integer := 0;
  coverage_shift_count integer := 0;
begin
  if target_outcome not in (
    'covered', 'no_replacement', 'no_replacement_required', 'patrol_completed', 'canceled',
    'shift_ended_unfilled', 'legacy_resolved'
  ) then
    raise check_violation using message = 'Choose a valid call-off resolution outcome.';
  end if;
  if btrim(coalesce(target_reason, '')) = '' then
    raise check_violation using message = 'A call-off lifecycle reason is required.';
  end if;

  select *
  into report
  from public.call_off_reports item
  where item.id = target_call_off_report_id;
  if report.id is null then
    return jsonb_build_object();
  end if;

  select *
  into shift_record
  from public.shifts shift
  where shift.id = report.shift_id;

  update public.operational_alerts alert
  set
    active = false,
    lifecycle_state = 'resolved',
    live_until_at = shift_record.ends_at + interval '1 hour',
    lifecycle_evaluated_at = clock_timestamp(),
    cleared_at = coalesce(alert.cleared_at, target_retired_at),
    cleared_by = case
      when target_outcome in ('no_replacement_required', 'patrol_completed', 'shift_ended_unfilled')
        then null
      else coalesce(target_actor_id, alert.cleared_by)
    end,
    clear_source = case
      when report.duplicate_of_call_off_report_id is not null then 'superseded_duplicate'
      else 'automatic_resolution'
    end,
    cleared_reason = target_reason
  where alert.related_record_type = 'call_off_report'
    and alert.related_record_id = report.id
    and (
      alert.active
      or alert.lifecycle_state <> 'resolved'
      or alert.live_until_at is distinct from shift_record.ends_at + interval '1 hour'
      or alert.clear_source is null
      or alert.cleared_reason is distinct from target_reason
    );
  get diagnostics alert_count = row_count;

  update public.employee_notifications notification
  set
    action_required = false,
    resolved_at = coalesce(notification.resolved_at, target_retired_at),
    expires_at = least(coalesce(notification.expires_at, target_retired_at), target_retired_at)
  where notification.source_type = 'call_off_request'
    and notification.source_id = report.id
    and (
      notification.action_required
      or
      notification.resolved_at is null
      or notification.expires_at is null
      or notification.expires_at > target_retired_at
    );
  get diagnostics call_off_notification_count = row_count;

  select *
  into coverage_before
  from public.shift_coverage_cases coverage
  where coverage.call_off_report_id = report.id
  for update;

  if coverage_before.id is not null then
    update private.shift_coverage_notification_waves wave
    set
      status = 'canceled',
      processed_at = coalesce(wave.processed_at, target_retired_at),
      updated_at = clock_timestamp(),
      last_error = coalesce(wave.last_error, 'Canceled by call-off lifecycle reconciliation: ' || target_reason || '.')
    where wave.coverage_case_id = coverage_before.id
      and wave.status in ('pending', 'processing');
    get diagnostics wave_count = row_count;

    update public.announcements announcement
    set
      expires_at = greatest(
        least(coalesce(announcement.expires_at, target_retired_at), target_retired_at),
        coalesce(announcement.published_at, target_retired_at - interval '1 microsecond') + interval '1 microsecond'
      ),
      updated_at = clock_timestamp()
    where announcement.id in (coverage_before.announcement_id, report.announcement_id)
      and (
        announcement.expires_at is null
        or announcement.expires_at > target_retired_at
      )
      and announcement.expires_at is distinct from greatest(
        least(coalesce(announcement.expires_at, target_retired_at), target_retired_at),
        coalesce(
          announcement.published_at,
          target_retired_at - interval '1 microsecond'
        ) + interval '1 microsecond'
      );
    get diagnostics announcement_count = row_count;

    update public.shift_requests request
    set
      status = 'declined',
      decided_by = target_actor_id,
      decided_at = target_retired_at,
      decision_note = case
        when target_outcome = 'shift_ended_unfilled'
          then 'The coverage window ended before this request was approved.'
        when target_outcome = 'no_replacement_required'
          then 'The call-off no longer requires replacement coverage.'
        else 'The linked call-off is no longer open for coverage.'
      end,
      updated_at = clock_timestamp()
    where request.shift_id = coverage_before.coverage_shift_id
      and request.status = 'pending';
    get diagnostics request_count = row_count;

    update public.employee_notifications notification
    set
      action_required = false,
      resolved_at = coalesce(notification.resolved_at, target_retired_at),
      expires_at = least(coalesce(notification.expires_at, target_retired_at), target_retired_at)
    where (
      (
          notification.source_type = 'shift_coverage'
          and notification.source_id = coverage_before.id
        )
        or (
          notification.source_type = 'shift_request'
          and exists (
            select 1
            from public.shift_requests request
            where request.id = notification.source_id
              and request.shift_id = coverage_before.coverage_shift_id
          )
        )
      )
      and (
        notification.action_required
        or
        notification.resolved_at is null
        or notification.expires_at is null
        or notification.expires_at > target_retired_at
      );
    get diagnostics coverage_notification_count = row_count;

    if coverage_before.coverage_shift_id is not null then
      update public.shifts coverage_shift
      set is_open = false,
          canceled_at = coalesce(coverage_shift.canceled_at, target_retired_at),
          canceled_by = case
            when coverage_shift.canceled_at is not null then coverage_shift.canceled_by
            when target_outcome in ('covered', 'no_replacement', 'canceled')
              then target_actor_id
            else null
          end,
          cancellation_reason = case
            when coverage_shift.canceled_at is null
              then 'Call-off lifecycle retirement: ' || target_reason
            else coalesce(
              nullif(btrim(coverage_shift.cancellation_reason), ''),
              'The generated coverage shift was already canceled before lifecycle reconciliation.'
            )
          end,
          updated_at = clock_timestamp()
      where coverage_shift.id = coverage_before.coverage_shift_id
        -- Only the generated, still-unassigned vacancy shift is disposable.
        -- An assigned replacement remains part of the durable schedule history.
        and coverage_shift.coverage_source_shift_id is not null
        and coverage_before.status <> 'assigned'
        and coverage_before.coverage_mode is distinct from 'assigned_guard'
        and coverage_before.replacement_assignment_id is null
        and not exists (
          select 1
          from public.shift_assignments assignment
          where assignment.shift_id = coverage_shift.id
            and assignment.status in ('assigned', 'confirmed', 'completed')
        )
        and (
          coverage_shift.canceled_at is null
          or coverage_shift.is_open
        );
      get diagnostics coverage_shift_count = row_count;
    end if;

    if coverage_before.status in ('draft', 'open_pool', 'patrol_review') then
      update public.shift_coverage_cases coverage
      set status = 'closed',
          resolved_by = case
            when target_outcome in ('no_replacement_required', 'patrol_completed', 'shift_ended_unfilled')
              then null
            else coalesce(target_actor_id, coverage.resolved_by)
          end,
          resolved_at = coalesce(coverage.resolved_at, target_retired_at),
          updated_at = clock_timestamp()
      where coverage.id = coverage_before.id
      returning * into coverage_after;
      get diagnostics coverage_case_count = row_count;

      if coverage_case_count > 0 then
        insert into public.shift_coverage_case_actions (
          coverage_case_id,
          action,
          actor_id,
          reason,
          before_record,
          after_record
        ) values (
          coverage_after.id,
          'closed',
          target_actor_id,
          target_reason,
          to_jsonb(coverage_before) || jsonb_build_object('lifecycleReason', target_reason),
          to_jsonb(coverage_after) || jsonb_build_object(
            'lifecycleReason', target_reason,
            'resolutionOutcome', target_outcome
          )
        );
      end if;
    end if;
  end if;

  update private.employee_push_deliveries delivery
  set completed_at = coalesce(delivery.completed_at, target_retired_at),
      outcome = coalesce(delivery.outcome, 'expired')
  from public.employee_notifications notification
  where notification.id = delivery.notification_id
    and delivery.completed_at is null
    and (
      (notification.source_type = 'call_off_request' and notification.source_id = report.id)
      or (
        coverage_before.id is not null
        and notification.source_type = 'shift_coverage'
        and notification.source_id = coverage_before.id
      )
      or (
        coverage_before.coverage_shift_id is not null
        and notification.source_type = 'shift_request'
        and exists (
          select 1
          from public.shift_requests request
          where request.id = notification.source_id
            and request.shift_id = coverage_before.coverage_shift_id
        )
      )
    );
  get diagnostics push_count = row_count;

  update public.employee_notification_email_deliveries delivery
  set
    failed_at = coalesce(delivery.failed_at, target_retired_at),
    last_error = coalesce(
      delivery.last_error,
      'Suppressed by call-off lifecycle reconciliation: ' || target_reason
    )
  from public.employee_notifications notification
  where notification.id = delivery.notification_id
    and delivery.delivered_at is null
    and delivery.failed_at is null
    and (
      (notification.source_type = 'call_off_request' and notification.source_id = report.id)
      or (
        coverage_before.id is not null
        and notification.source_type = 'shift_coverage'
        and notification.source_id = coverage_before.id
      )
      or (
        coverage_before.coverage_shift_id is not null
        and notification.source_type = 'shift_request'
        and exists (
          select 1
          from public.shift_requests request
          where request.id = notification.source_id
            and request.shift_id = coverage_before.coverage_shift_id
        )
      )
    );
  get diagnostics email_delivery_count = row_count;

  update private.notification_outbox outbox
  set
    failed_at = coalesce(outbox.failed_at, target_retired_at),
    last_error = coalesce(outbox.last_error, 'Suppressed by call-off lifecycle reconciliation: ' || target_reason || '.')
  where outbox.message_type = 'call_off_supervisor_alert'
    and outbox.aggregate_type = 'call_off_report'
    and outbox.aggregate_id = report.id
    and outbox.delivered_at is null
    and outbox.failed_at is null;
  get diagnostics outbox_count = row_count;

  return jsonb_build_object(
    'callOffAlertRetiredCount', alert_count,
    'callOffNotificationResolvedCount', call_off_notification_count,
    'coverageNotificationExpiredCount', coverage_notification_count,
    'employeeNotificationEmailSuppressedCount', email_delivery_count,
    'employeePushExpiredCount', push_count,
    'callOffOutboxSuppressedCount', outbox_count,
    'staleCoverageCaseClosedCount', coverage_case_count,
    'coverageWaveCanceledCount', wave_count,
    'coverageAnnouncementExpiredCount', announcement_count,
    'coverageShiftRequestDeclinedCount', request_count,
    'coverageShiftClosedCount', coverage_shift_count
  );
end
$$;

revoke all on function private.retire_call_off_live_artifacts(uuid, text, text, timestamptz, uuid)
  from public, anon, authenticated;

create or replace function private.reactivate_call_off_operational_work(
  target_call_off_report_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  report public.call_off_reports%rowtype;
  shift_record public.shifts%rowtype;
  employee public.employees%rowtype;
  coverage_before public.shift_coverage_cases%rowtype;
  coverage_after public.shift_coverage_cases%rowtype;
  retirement_action public.shift_coverage_case_actions%rowtype;
  restored_status text;
  actor_id uuid := private.current_employee_id();
  reopened_at timestamptz := clock_timestamp();
  reopen_generation text := to_char(
    reopened_at at time zone 'UTC',
    'YYYYMMDDHH24MISSUS'
  );
  cutoff_at timestamptz;
  alert_id uuid;
begin
  select *
  into report
  from public.call_off_reports item
  where item.id = target_call_off_report_id
  for update;
  if report.id is null then
    raise no_data_found using message = 'The call-off report is unavailable.';
  end if;

  select * into shift_record from public.shifts shift where shift.id = report.shift_id;
  select * into employee from public.employees item where item.id = report.employee_id;
  cutoff_at := shift_record.ends_at + interval '1 hour';

  if report.canceled_at is not null
     or report.resolved_at is not null
     or report.duplicate_of_call_off_report_id is not null
     or not report.replacement_needed
     or reopened_at >= cutoff_at
  then
    raise check_violation using message = 'Replacement coverage can no longer be reopened for this call-off.';
  end if;

  select *
  into coverage_before
  from public.shift_coverage_cases coverage
  where coverage.call_off_report_id = report.id
  for update;

  if coverage_before.id is not null then
    if coverage_before.status <> 'closed' then
      if coverage_before.status in ('assigned', 'no_replacement', 'canceled') then
        raise check_violation using message = 'A completed coverage decision cannot be reopened.';
      end if;
    else
      select *
      into retirement_action
      from public.shift_coverage_case_actions action
      where action.coverage_case_id = coverage_before.id
        and action.action = 'closed'
        and action.after_record ->> 'resolutionOutcome' = 'no_replacement_required'
      order by action.created_at desc, action.id desc
      limit 1;

      if retirement_action.id is null then
        raise check_violation using message = 'Only a coverage case closed by the no-replacement-required lifecycle can be reopened.';
      end if;

      restored_status := coalesce(retirement_action.before_record ->> 'status', 'draft');
      if restored_status not in ('draft', 'open_pool', 'patrol_review') then
        raise check_violation using message = 'The prior coverage workflow cannot be restored safely.';
      end if;

      update public.shift_coverage_cases coverage
      set
        status = restored_status,
        resolved_by = null,
        resolved_at = null,
        updated_at = reopened_at
      where coverage.id = coverage_before.id
      returning * into coverage_after;

      if restored_status = 'open_pool' then
        update public.shifts coverage_shift
        set
          -- Clear only the cancellation written by this lifecycle. A shift
          -- canceled independently after retirement must never be revived.
          canceled_at = null,
          canceled_by = null,
          cancellation_reason = null,
          is_open = private.active_shift_assignment_count(coverage_shift.id) < coverage_shift.headcount_required,
          updated_at = reopened_at
        where coverage_shift.id = coverage_after.coverage_shift_id
          and (
            coverage_shift.canceled_at is null
            or coverage_shift.cancellation_reason like 'Call-off lifecycle retirement:%'
          );

        if coverage_after.coverage_shift_id is not null and not found then
          raise check_violation using
            message = 'The replacement shift was canceled outside the call-off lifecycle and cannot be reopened.';
        end if;

        update public.announcements announcement
        set
          published_at = coalesce(announcement.published_at, reopened_at),
          expires_at = greatest(
            cutoff_at,
            coalesce(announcement.published_at, reopened_at) + interval '1 microsecond'
          ),
          updated_at = reopened_at
        where announcement.id in (coverage_after.announcement_id, report.announcement_id);

        insert into private.shift_coverage_notification_waves (
          coverage_case_id,
          wave_number,
          audience,
          due_at
        ) values
          (coverage_after.id, 1, 'flex_no_overtime', reopened_at),
          (coverage_after.id, 2, 'other_no_overtime', reopened_at + interval '10 minutes')
        on conflict (coverage_case_id, wave_number) do update
        set
          audience = excluded.audience,
          due_at = excluded.due_at,
          status = 'pending',
          attempts = 0,
          recipient_count = 0,
          claimed_at = null,
          processed_at = null,
          last_error = null,
          updated_at = reopened_at;

        if coverage_after.allow_overtime_wave then
          insert into private.shift_coverage_notification_waves (
            coverage_case_id,
            wave_number,
            audience,
            due_at
          ) values (
            coverage_after.id,
            3,
            'overtime',
            reopened_at + interval '20 minutes'
          )
          on conflict (coverage_case_id, wave_number) do update
          set
            audience = excluded.audience,
            due_at = excluded.due_at,
            status = 'pending',
            attempts = 0,
            recipient_count = 0,
            claimed_at = null,
            processed_at = null,
            last_error = null,
            updated_at = reopened_at;
        else
          update private.shift_coverage_notification_waves wave
          set
            status = 'canceled',
            processed_at = coalesce(wave.processed_at, reopened_at),
            updated_at = reopened_at,
            last_error = coalesce(wave.last_error, 'Overtime notification was not authorized when coverage reopened.')
          where wave.coverage_case_id = coverage_after.id
            and wave.wave_number = 3
            and wave.status in ('pending', 'processing');
        end if;
      elsif restored_status = 'patrol_review' then
        -- Keep the retired notification rows as history. A generation-specific
        -- INSERT receives a new id, so push/email delivery state from the prior
        -- lifecycle cannot suppress this reopened action.
        insert into public.employee_notifications (
          recipient_employee_id,
          sender_employee_id,
          source_type,
          source_id,
          source_key,
          title,
          body,
          priority,
          requires_acknowledgement,
          action_required,
          action_path,
          action_label,
          expires_at,
          resolved_at,
          created_at
        )
        select
          patrol_employee.id,
          coverage_after.opened_by,
          'shift_coverage',
          coverage_after.id,
          left(concat(
            'shift-coverage-patrol-review:',
            coverage_after.id,
            ':',
            patrol_employee.id,
            ':reopen:',
            reopen_generation
          ), 500),
          'Patrol coverage review requested',
          'A scheduled site needs a one-night patrol coverage review. Open Requests for the shift window and protected operational details.',
          'urgent',
          true,
          true,
          '/requests',
          'Review coverage',
          cutoff_at,
          null,
          reopened_at
        from public.employees patrol_employee
        join private.employee_accounts patrol_account
          on patrol_account.employee_id = patrol_employee.id
        where patrol_employee.status = 'active'
          and patrol_account.activated_at is not null
          and patrol_account.disabled_at is null
          and 'patrol.assignments.manage' = any(
            private.employee_effective_permissions(patrol_employee.id)
          )
        on conflict (source_key) do update
        set
          action_required = true,
          resolved_at = null,
          expires_at = excluded.expires_at,
          read_at = null,
          dismissed_at = null,
          created_at = excluded.created_at;
      end if;

      insert into public.shift_coverage_case_actions (
        coverage_case_id,
        action,
        actor_id,
        reason,
        before_record,
        after_record
      ) values (
        coverage_after.id,
        case restored_status
          when 'open_pool' then 'opened_pool'
          when 'patrol_review' then 'patrol_review_requested'
          else 'created'
        end,
        actor_id,
        'Replacement coverage was reopened before the live response window ended.',
        to_jsonb(coverage_before),
        to_jsonb(coverage_after) || jsonb_build_object('lifecycleReopened', true)
      );
    end if;
  end if;

  -- Historical producers did not all use the canonical deduplication key.
  -- Prefer that row when present, otherwise reactivate the oldest retained row.
  select alert.id
  into alert_id
  from public.operational_alerts alert
  where alert.related_record_type = 'call_off_report'
    and alert.related_record_id = report.id
  order by
    (alert.deduplication_key = concat('call-off:', report.id)) desc,
    alert.created_at,
    alert.id
  limit 1;

  if alert_id is not null then
    update public.operational_alerts alert
    set
      priority = 'urgent',
      title = 'Employee call-off — coverage review required',
      summary = concat(
        coalesce(nullif(employee.preferred_name, ''), employee.first_name),
        ' ', employee.last_name, ' has an unresolved call-off.'
      ),
      employee_id = report.employee_id,
      shift_id = report.shift_id,
      direct_path = concat('/time-off?tab=call-offs&callOff=', report.id),
      active = true,
      lifecycle_state = 'active_operations',
      live_until_at = cutoff_at,
      lifecycle_evaluated_at = reopened_at,
      cleared_at = null,
      cleared_by = null,
      clear_source = null,
      cleared_reason = null
    where alert.id = alert_id;
  else
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
      deduplication_key,
      active,
      lifecycle_state,
      live_until_at,
      lifecycle_evaluated_at
    ) values (
      'employee_call_off',
      'urgent',
      'Employee call-off — coverage review required',
      concat(
        coalesce(nullif(employee.preferred_name, ''), employee.first_name),
        ' ', employee.last_name, ' has an unresolved call-off.'
      ),
      report.employee_id,
      report.shift_id,
      'call_off_report',
      report.id,
      array['dispatcher', 'scheduler', 'supervisor', 'admin']::public.app_role[],
      concat('/time-off?tab=call-offs&callOff=', report.id),
      concat('call-off:', report.id),
      true,
      'active_operations',
      cutoff_at,
      reopened_at
    )
    on conflict (deduplication_key) do update
    set
      active = true,
      lifecycle_state = 'active_operations',
      live_until_at = excluded.live_until_at,
      lifecycle_evaluated_at = excluded.lifecycle_evaluated_at,
      cleared_at = null,
      cleared_by = null,
      clear_source = null,
      cleared_reason = null
    returning id into alert_id;
  end if;

  update public.operational_alerts alert
  set
    active = false,
    lifecycle_state = 'resolved',
    lifecycle_evaluated_at = reopened_at,
    cleared_at = coalesce(alert.cleared_at, reopened_at),
    cleared_by = null,
    clear_source = 'superseded_duplicate',
    cleared_reason = 'A single retained call-off alert is authoritative for the reopened lifecycle.'
  where alert.related_record_type = 'call_off_report'
    and alert.related_record_id = report.id
    and alert.id <> alert_id
    and (
      alert.active
      or alert.lifecycle_state <> 'resolved'
      or alert.clear_source is distinct from 'superseded_duplicate'
    );

  -- The existing workflow AFTER trigger runs before this zz_* lifecycle
  -- trigger and reopens its fixed-key row. Retire every prior generation again
  -- (including that row) before inserting the one authoritative new generation.
  update public.employee_notifications notification
  set
    action_required = false,
    resolved_at = coalesce(notification.resolved_at, reopened_at),
    expires_at = least(coalesce(notification.expires_at, reopened_at), reopened_at)
  where notification.source_type = 'call_off_request'
    and notification.source_id = report.id
    and (
      notification.action_required
      or notification.resolved_at is null
      or notification.expires_at is null
      or notification.expires_at > reopened_at
    );

  update private.employee_push_deliveries delivery
  set
    completed_at = coalesce(delivery.completed_at, reopened_at),
    outcome = coalesce(delivery.outcome, 'expired')
  from public.employee_notifications notification
  where notification.id = delivery.notification_id
    and notification.source_type = 'call_off_request'
    and notification.source_id = report.id
    and delivery.completed_at is null;

  update public.employee_notification_email_deliveries delivery
  set
    failed_at = coalesce(delivery.failed_at, reopened_at),
    last_error = coalesce(
      delivery.last_error,
      'Superseded by a newer call-off lifecycle notification generation.'
    )
  from public.employee_notifications notification
  where notification.id = delivery.notification_id
    and notification.source_type = 'call_off_request'
    and notification.source_id = report.id
    and delivery.delivered_at is null
    and delivery.failed_at is null;

  -- Generate new notification identities for the reopened lifecycle instead
  -- of mutating retired history. AFTER INSERT delivery hooks can therefore
  -- enqueue a fresh push for every currently authorized reviewer.
  insert into public.employee_notifications (
    recipient_employee_id,
    sender_employee_id,
    source_type,
    source_id,
    source_key,
    title,
    body,
    priority,
    requires_acknowledgement,
    action_required,
    action_path,
    action_label,
    expires_at,
    resolved_at,
    created_at
  )
  select
    reviewer.id,
    coalesce(report.reported_by, report.employee_id),
    'call_off_request',
    report.id,
    left(concat(
      'workflow-action:call_off_request:',
      report.id,
      ':',
      reviewer.id,
      ':reopen:',
      reopen_generation
    ), 500),
    'Urgent call-off needs coverage action',
    'A reported call-off is waiting for an authorized coverage response.',
    'urgent',
    false,
    true,
    concat('/time-off?tab=call-offs&callOff=', report.id),
    'Open call-off',
    cutoff_at,
    null,
    reopened_at
  from public.employees reviewer
  join private.employee_accounts reviewer_account
    on reviewer_account.employee_id = reviewer.id
  where reviewer.status = 'active'
    and reviewer_account.activated_at is not null
    and reviewer_account.disabled_at is null
    and reviewer.id is distinct from coalesce(report.reported_by, report.employee_id)
    and coalesce(
      private.employee_effective_permissions(reviewer.id),
      array[]::text[]
    ) && array['requests.manage']::text[]
    and (
      reviewer.role = 'admin'
      or exists (
        select 1
        from public.employee_access_roles role_assignment
        join public.access_roles access_role
          on access_role.id = role_assignment.role_id
        where role_assignment.employee_id = reviewer.id
          and access_role.active
          and access_role.code = 'system_admin'
      )
      or not exists (
        select 1
        from private.employee_supervisor_assignments scope
        where scope.supervisor_employee_id = reviewer.id
      )
      or exists (
        select 1
        from private.employee_supervisor_assignments scope
        where scope.supervisor_employee_id = reviewer.id
          and scope.employee_id = report.employee_id
      )
    )
  on conflict (source_key) do update
  set
    action_required = true,
    resolved_at = null,
    expires_at = excluded.expires_at,
    read_at = null,
    dismissed_at = null,
    created_at = excluded.created_at;

  return alert_id;
end
$$;

revoke all on function private.reactivate_call_off_operational_work(uuid)
  from public, anon, authenticated;

-- The alert itself is a final safety boundary. Some report-producing RPCs
-- insert their required alert row after the report's AFTER triggers have run.
-- Deriving lifecycle here keeps that retained alert row inactive when its
-- source is already terminal, including replacement-not-required creation.
create or replace function private.prepare_operational_alert_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_exception public.timekeeping_operational_exceptions;
  source_call_off public.call_off_reports;
  source_shift public.shifts;
  call_off_terminal boolean := false;
  call_off_source_missing boolean := false;
begin
  if new.related_record_type = 'timekeeping_operational_exception' then
    select * into source_exception
    from public.timekeeping_operational_exceptions exception
    where exception.id = new.related_record_id;

    if source_exception.id is not null then
      new.occurrence_key := source_exception.occurrence_key;
      new.live_until_at := case
        when source_exception.exception_code = 'missing_clock_in'
          then source_exception.scheduled_end_at + interval '1 hour'
        else null
      end;
    end if;
  elsif new.related_record_type = 'call_off_report' then
    -- Lock the source before a new alert row or deduplication key is acquired,
    -- so report retirement cannot finish its sweep before this INSERT lands.
    if tg_op = 'INSERT' then
      perform 1
      from public.call_off_reports report
      where report.id = new.related_record_id
      for share;
    end if;

    select * into source_call_off
    from public.call_off_reports report
    where report.id = new.related_record_id;
    call_off_source_missing := source_call_off.id is null;
    if not call_off_source_missing then
      select * into source_shift
      from public.shifts shift
      where shift.id = source_call_off.shift_id;
      new.employee_id := source_call_off.employee_id;
      new.shift_id := source_call_off.shift_id;
      new.live_until_at := source_shift.ends_at + interval '1 hour';
      call_off_terminal :=
        source_call_off.canceled_at is not null
        or source_call_off.resolved_at is not null
        or source_call_off.duplicate_of_call_off_report_id is not null
        or not source_call_off.replacement_needed
        or clock_timestamp() >= source_shift.ends_at + interval '1 hour';
    end if;
  end if;

  new.lifecycle_evaluated_at := clock_timestamp();

  if new.related_record_type = 'call_off_report'
     and (call_off_source_missing or call_off_terminal)
  then
    new.active := false;
    new.lifecycle_state := 'resolved';
    new.cleared_at := coalesce(
      new.cleared_at,
      source_call_off.canceled_at,
      source_call_off.resolved_at,
      source_shift.ends_at + interval '1 hour',
      clock_timestamp()
    );
    new.clear_source := case
      when call_off_source_missing then 'orphaned_source'
      when source_call_off.duplicate_of_call_off_report_id is not null then 'superseded_duplicate'
      else 'automatic_resolution'
    end;
    new.cleared_reason := case
      when call_off_source_missing
        then 'The linked call-off report is unavailable, so this alert cannot remain actionable.'
      when source_call_off.resolution_outcome = 'shift_ended_unfilled'
        or (
          source_call_off.resolution_outcome is null
          and clock_timestamp() >= source_shift.ends_at + interval '1 hour'
        ) then private.call_off_lifecycle_reason('shift_ended_unfilled')
      when source_call_off.canceled_at is not null
        then private.call_off_lifecycle_reason('canceled')
      when not source_call_off.replacement_needed
        then private.call_off_lifecycle_reason('no_replacement_required')
      else private.call_off_lifecycle_reason(
        coalesce(source_call_off.resolution_outcome, 'legacy_resolved')
      )
    end;
  elsif new.active then
    new.lifecycle_state := 'active_operations';
    new.cleared_at := null;
    new.cleared_by := null;
    new.clear_source := null;
    new.cleared_reason := null;
  elsif source_exception.id is not null and source_exception.status = 'unresolved' then
    new.lifecycle_state := 'payroll_review';
    new.clear_source := coalesce(new.clear_source, 'payroll_handoff');
    new.cleared_reason := coalesce(
      new.cleared_reason,
      'The live response window ended. The unresolved occurrence remains available for payroll review.'
    );
  else
    new.lifecycle_state := 'resolved';
    new.clear_source := coalesce(new.clear_source, 'manual_resolution');
    new.cleared_reason := coalesce(new.cleared_reason, 'The alert was resolved by an authorized action.');
  end if;

  return new;
end
$$;

revoke all on function private.prepare_operational_alert_lifecycle()
  from public, anon, authenticated;

-- Creation-time fail-closed behavior is part of the lifecycle invariant, so
-- do not depend on an earlier migration having left this trigger enabled.
drop trigger if exists operational_alert_lifecycle
  on public.operational_alerts;

create trigger operational_alert_lifecycle
before insert or update on public.operational_alerts
for each row execute function private.prepare_operational_alert_lifecycle();

-- Replace the narrow prior trigger with an atomic report/artifact lifecycle.
drop trigger if exists clear_call_off_operational_alert_on_close
  on public.call_off_reports;

create or replace function private.sync_call_off_terminal_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  terminal_outcome text;
  terminal_reason text;
  retired_at timestamptz;
  prior_was_terminal boolean := false;
begin
  terminal_outcome := case
    when new.canceled_at is not null then 'canceled'
    when not new.replacement_needed then 'no_replacement_required'
    when new.duplicate_of_call_off_report_id is not null then coalesce(new.resolution_outcome, 'legacy_resolved')
    when new.resolved_at is not null then coalesce(new.resolution_outcome, 'legacy_resolved')
    else null
  end;

  if terminal_outcome is not null then
    terminal_reason := private.call_off_lifecycle_reason(terminal_outcome);
    retired_at := case
      when terminal_outcome = 'shift_ended_unfilled' then new.resolved_at
      when terminal_outcome = 'canceled' then coalesce(new.canceled_at, clock_timestamp())
      else coalesce(new.resolved_at, clock_timestamp())
    end;

    perform private.retire_call_off_live_artifacts(
      new.id,
      terminal_outcome,
      terminal_reason,
      retired_at,
      case
        when terminal_outcome in ('covered', 'no_replacement', 'canceled')
          then coalesce(new.canceled_by, new.acknowledged_by)
        else null
      end
    );
    perform private.record_call_off_system_resolution(
      new.id,
      terminal_outcome,
      terminal_reason
    );
  elsif tg_op = 'UPDATE' then
    prior_was_terminal :=
      old.canceled_at is not null
      or old.resolved_at is not null
      or old.duplicate_of_call_off_report_id is not null
      or not old.replacement_needed;
    if prior_was_terminal then
      perform private.reactivate_call_off_operational_work(new.id);
    end if;
  end if;

  return new;
end
$$;

revoke all on function private.sync_call_off_terminal_lifecycle()
  from public, anon, authenticated;

drop trigger if exists zz_sync_call_off_terminal_lifecycle
  on public.call_off_reports;
create trigger zz_sync_call_off_terminal_lifecycle
after insert or update of
  replacement_needed,
  resolved_at,
  canceled_at,
  duplicate_of_call_off_report_id,
  resolution_outcome
on public.call_off_reports
for each row execute function private.sync_call_off_terminal_lifecycle();

create or replace function private.reconcile_call_off_alert_lifecycle(
  target_full_reconciliation boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  candidate record;
  artifact_counts jsonb;
  locked boolean;
  lifecycle_outcome text;
  lifecycle_reason text;
  retired_at timestamptz;
  prior_action_count integer;
  current_action_count integer;
  recorded_action_count integer;
  resolved_count integer := 0;
  action_count integer := 0;
  alert_count integer := 0;
  alert_window_count integer := 0;
  call_off_notification_count integer := 0;
  coverage_notification_count integer := 0;
  email_delivery_count integer := 0;
  push_count integer := 0;
  outbox_count integer := 0;
  coverage_case_count integer := 0;
  wave_count integer := 0;
  announcement_count integer := 0;
  request_count integer := 0;
  coverage_shift_count integer := 0;
begin
  select pg_try_advisory_xact_lock(
    hashtext('sygshift.call.off.alert.lifecycle')
  ) into locked;
  if not locked then
    return jsonb_build_object(
      'callOffReconciliationStatus', 'skipped',
      'callOffReconciliationReason', 'reconciliation_already_running'
    );
  end if;

  update public.operational_alerts alert
  set
    live_until_at = shift.ends_at + interval '1 hour',
    lifecycle_evaluated_at = clock_timestamp()
  from public.call_off_reports report
  join public.shifts shift on shift.id = report.shift_id
  where alert.related_record_type = 'call_off_report'
    and alert.related_record_id = report.id
    and (
      alert.live_until_at is distinct from shift.ends_at + interval '1 hour'
      or (
        alert.active
        and (
          target_full_reconciliation
          or alert.lifecycle_evaluated_at is null
          or alert.lifecycle_evaluated_at < clock_timestamp() - interval '5 minutes'
        )
      )
    );
  get diagnostics alert_window_count = row_count;

  -- Generic source columns intentionally support many workflows and have no
  -- call-off FK. Fail closed for legacy/orphan call-off artifacts as well as
  -- at INSERT time so neither the backfill nor future reconciliations leave
  -- an actionable row with no authoritative report.
  update public.operational_alerts alert
  set
    active = false,
    lifecycle_state = 'resolved',
    lifecycle_evaluated_at = clock_timestamp(),
    cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
    cleared_by = null,
    clear_source = 'orphaned_source',
    cleared_reason = 'The linked call-off report is unavailable, so this alert cannot remain actionable.'
  where alert.related_record_type = 'call_off_report'
    and not exists (
      select 1
      from public.call_off_reports report
      where report.id = alert.related_record_id
    )
    and (
      alert.active
      or alert.lifecycle_state <> 'resolved'
      or alert.clear_source is distinct from 'orphaned_source'
    );
  get diagnostics alert_count = row_count;

  update public.employee_notifications notification
  set
    action_required = false,
    resolved_at = coalesce(notification.resolved_at, clock_timestamp()),
    expires_at = least(
      coalesce(notification.expires_at, clock_timestamp()),
      clock_timestamp()
    )
  where notification.source_type = 'call_off_request'
    and not exists (
      select 1
      from public.call_off_reports report
      where report.id = notification.source_id
    )
    and (
      notification.action_required
      or notification.resolved_at is null
      or notification.expires_at is null
      or notification.expires_at > clock_timestamp()
    );
  get diagnostics call_off_notification_count = row_count;

  update private.employee_push_deliveries delivery
  set
    completed_at = coalesce(delivery.completed_at, clock_timestamp()),
    outcome = coalesce(delivery.outcome, 'expired')
  from public.employee_notifications notification
  where notification.id = delivery.notification_id
    and notification.source_type = 'call_off_request'
    and not exists (
      select 1
      from public.call_off_reports report
      where report.id = notification.source_id
    )
    and delivery.completed_at is null;
  get diagnostics push_count = row_count;

  update public.employee_notification_email_deliveries delivery
  set
    failed_at = coalesce(delivery.failed_at, clock_timestamp()),
    last_error = coalesce(
      delivery.last_error,
      'Suppressed because the linked call-off report is unavailable.'
    )
  from public.employee_notifications notification
  where notification.id = delivery.notification_id
    and notification.source_type = 'call_off_request'
    and not exists (
      select 1
      from public.call_off_reports report
      where report.id = notification.source_id
    )
    and delivery.delivered_at is null
    and delivery.failed_at is null;
  get diagnostics email_delivery_count = row_count;

  update private.notification_outbox outbox
  set
    failed_at = coalesce(outbox.failed_at, clock_timestamp()),
    last_error = coalesce(
      outbox.last_error,
      'Suppressed because the linked call-off report is unavailable.'
    )
  where outbox.message_type = 'call_off_supervisor_alert'
    and outbox.aggregate_type = 'call_off_report'
    and not exists (
      select 1
      from public.call_off_reports report
      where report.id = outbox.aggregate_id
    )
    and outbox.delivered_at is null
    and outbox.failed_at is null;
  get diagnostics outbox_count = row_count;

  for candidate in
    select
      report.*,
      shift.ends_at as source_shift_ends_at,
      exists (
        select 1
        from public.shift_coverage_cases coverage
        join public.vacancy_patrol_recovery_requests recovery
          on recovery.source_shift_id in (coverage.source_shift_id, coverage.coverage_shift_id)
        where coverage.call_off_report_id = report.id
          and recovery.status = 'completed'
      ) as patrol_completed,
      coverage_evidence.outcome as coverage_outcome,
      coverage_evidence.resolved_at as coverage_resolved_at,
      coverage_evidence.resolved_by as coverage_resolved_by
    from public.call_off_reports report
    join public.shifts shift on shift.id = report.shift_id
    left join lateral (
      select
        case
          when coverage.status = 'assigned'
            or coverage.coverage_mode = 'assigned_guard'
            then 'covered'
          when coverage.status = 'no_replacement'
            or coverage.coverage_mode = 'no_replacement'
            then 'no_replacement'
          else null
        end as outcome,
        coverage.resolved_at,
        coverage.resolved_by
      from public.shift_coverage_cases coverage
      where coverage.call_off_report_id = report.id
        and (
          coverage.status in ('assigned', 'no_replacement')
          or coverage.coverage_mode in ('assigned_guard', 'no_replacement')
        )
      order by coverage.resolved_at desc nulls last, coverage.updated_at desc, coverage.id
      limit 1
    ) coverage_evidence on true
    where (
      report.resolved_at is null
      and report.canceled_at is null
      and (
        report.duplicate_of_call_off_report_id is not null
        or not report.replacement_needed
        or coverage_evidence.outcome is not null
        or clock_timestamp() >= shift.ends_at + interval '1 hour'
        or exists (
          select 1
          from public.shift_coverage_cases coverage
          join public.vacancy_patrol_recovery_requests recovery
            on recovery.source_shift_id in (coverage.source_shift_id, coverage.coverage_shift_id)
          where coverage.call_off_report_id = report.id
            and recovery.status = 'completed'
        )
      )
    ) or (
      (
        report.canceled_at is not null
        or report.resolved_at is not null
        or report.duplicate_of_call_off_report_id is not null
        or not report.replacement_needed
      )
      and (
        target_full_reconciliation
        or report.resolution_outcome is null
        or (
          report.canceled_at is not null
          and report.resolution_outcome is distinct from 'canceled'
        )
        or (
          not report.replacement_needed
          and report.resolution_outcome is distinct from 'no_replacement_required'
        )
        or exists (
          select 1
          from public.shift_coverage_cases coverage
          join public.vacancy_patrol_recovery_requests recovery
            on recovery.source_shift_id in (coverage.source_shift_id, coverage.coverage_shift_id)
          where coverage.call_off_report_id = report.id
            and recovery.status = 'completed'
            and report.resolution_outcome is distinct from 'patrol_completed'
        )
        or exists (
          select 1
          from public.operational_alerts alert
          where alert.related_record_type = 'call_off_report'
            and alert.related_record_id = report.id
            and (alert.active or alert.lifecycle_state <> 'resolved')
        )
        or exists (
          select 1
          from public.employee_notifications notification
          where notification.source_type = 'call_off_request'
            and notification.source_id = report.id
            and (
              notification.action_required
              or notification.resolved_at is null
              or notification.expires_at is null
              or notification.expires_at > clock_timestamp()
            )
        )
        or exists (
          select 1
          from public.shift_coverage_cases coverage
          left join public.shifts coverage_shift on coverage_shift.id = coverage.coverage_shift_id
          left join public.announcements announcement
            on announcement.id in (coverage.announcement_id, report.announcement_id)
          where coverage.call_off_report_id = report.id
            and (
              coverage.status in ('draft', 'open_pool', 'patrol_review')
              or coalesce(coverage_shift.is_open, false)
              or (
                announcement.id is not null
                and (
                  announcement.expires_at is null
                  or announcement.expires_at > clock_timestamp()
                )
              )
              or exists (
                select 1
                from private.shift_coverage_notification_waves wave
                where wave.coverage_case_id = coverage.id
                  and wave.status in ('pending', 'processing')
              )
              or exists (
                select 1
                from public.shift_requests request
                where request.shift_id = coverage.coverage_shift_id
                  and request.status = 'pending'
              )
              or exists (
                select 1
                from public.employee_notifications notification
                where (
                  (
                    notification.source_type = 'shift_coverage'
                    and notification.source_id = coverage.id
                  )
                  or (
                    notification.source_type = 'shift_request'
                    and exists (
                      select 1
                      from public.shift_requests request
                      where request.id = notification.source_id
                        and request.shift_id = coverage.coverage_shift_id
                    )
                  )
                )
                  and (
                    notification.action_required
                    or notification.resolved_at is null
                    or notification.expires_at is null
                    or notification.expires_at > clock_timestamp()
                  )
              )
            )
        )
        or exists (
          select 1
          from public.employee_notification_email_deliveries delivery
          join public.employee_notifications notification
            on notification.id = delivery.notification_id
          where delivery.delivered_at is null
            and delivery.failed_at is null
            and (
              (
                notification.source_type = 'call_off_request'
                and notification.source_id = report.id
              )
              or (
                notification.source_type = 'shift_coverage'
                and exists (
                  select 1
                  from public.shift_coverage_cases coverage
                  where coverage.id = notification.source_id
                    and coverage.call_off_report_id = report.id
                )
              )
              or (
                notification.source_type = 'shift_request'
                and exists (
                  select 1
                  from public.shift_requests request
                  join public.shift_coverage_cases coverage
                    on coverage.coverage_shift_id = request.shift_id
                  where request.id = notification.source_id
                    and coverage.call_off_report_id = report.id
                )
              )
            )
        )
        or exists (
          select 1
          from private.employee_push_deliveries delivery
          join public.employee_notifications notification
            on notification.id = delivery.notification_id
          where delivery.completed_at is null
            and (
              (
                notification.source_type = 'call_off_request'
                and notification.source_id = report.id
              )
              or (
                notification.source_type = 'shift_coverage'
                and exists (
                  select 1
                  from public.shift_coverage_cases coverage
                  where coverage.id = notification.source_id
                    and coverage.call_off_report_id = report.id
                )
              )
              or (
                notification.source_type = 'shift_request'
                and exists (
                  select 1
                  from public.shift_requests request
                  join public.shift_coverage_cases coverage
                    on coverage.coverage_shift_id = request.shift_id
                  where request.id = notification.source_id
                    and coverage.call_off_report_id = report.id
                )
              )
            )
        )
        or exists (
          select 1
          from private.notification_outbox outbox
          where outbox.message_type = 'call_off_supervisor_alert'
            and outbox.aggregate_type = 'call_off_report'
            and outbox.aggregate_id = report.id
            and outbox.delivered_at is null
            and outbox.failed_at is null
        )
      )
    )
    order by shift.ends_at, report.id
    for update of report
  loop
    lifecycle_outcome := case
      when candidate.canceled_at is not null then 'canceled'
      when not candidate.replacement_needed then 'no_replacement_required'
      when candidate.patrol_completed then 'patrol_completed'
      when candidate.coverage_outcome is not null then candidate.coverage_outcome
      when candidate.duplicate_of_call_off_report_id is not null
        then coalesce(candidate.resolution_outcome, 'legacy_resolved')
      when candidate.resolved_at is not null
        then coalesce(candidate.resolution_outcome, 'legacy_resolved')
      else 'shift_ended_unfilled'
    end;
    lifecycle_reason := private.call_off_lifecycle_reason(lifecycle_outcome);
    retired_at := case
      when lifecycle_outcome = 'canceled' then coalesce(candidate.canceled_at, clock_timestamp())
      when candidate.resolved_at is not null then candidate.resolved_at
      when lifecycle_outcome in ('covered', 'no_replacement')
        then coalesce(candidate.coverage_resolved_at, clock_timestamp())
      when lifecycle_outcome = 'shift_ended_unfilled' then candidate.source_shift_ends_at + interval '1 hour'
      else clock_timestamp()
    end;

    select count(*)::integer
    into prior_action_count
    from public.call_off_report_actions action
    where action.call_off_report_id = candidate.id
      and action.action = 'resolved'
      and action.reason = lifecycle_reason
      and action.snapshot ->> 'resolution_outcome' = lifecycle_outcome;

    artifact_counts := private.retire_call_off_live_artifacts(
      candidate.id,
      lifecycle_outcome,
      lifecycle_reason,
      retired_at,
      case
        when lifecycle_outcome in ('covered', 'no_replacement', 'canceled')
          then coalesce(
            candidate.coverage_resolved_by,
            candidate.canceled_by,
            candidate.acknowledged_by
          )
        else null
      end
    );

    alert_count := alert_count + coalesce((artifact_counts ->> 'callOffAlertRetiredCount')::integer, 0);
    call_off_notification_count := call_off_notification_count
      + coalesce((artifact_counts ->> 'callOffNotificationResolvedCount')::integer, 0);
    coverage_notification_count := coverage_notification_count
      + coalesce((artifact_counts ->> 'coverageNotificationExpiredCount')::integer, 0);
    email_delivery_count := email_delivery_count
      + coalesce((artifact_counts ->> 'employeeNotificationEmailSuppressedCount')::integer, 0);
    push_count := push_count + coalesce((artifact_counts ->> 'employeePushExpiredCount')::integer, 0);
    outbox_count := outbox_count + coalesce((artifact_counts ->> 'callOffOutboxSuppressedCount')::integer, 0);
    coverage_case_count := coverage_case_count
      + coalesce((artifact_counts ->> 'staleCoverageCaseClosedCount')::integer, 0);
    wave_count := wave_count + coalesce((artifact_counts ->> 'coverageWaveCanceledCount')::integer, 0);
    announcement_count := announcement_count
      + coalesce((artifact_counts ->> 'coverageAnnouncementExpiredCount')::integer, 0);
    request_count := request_count
      + coalesce((artifact_counts ->> 'coverageShiftRequestDeclinedCount')::integer, 0);
    coverage_shift_count := coverage_shift_count
      + coalesce((artifact_counts ->> 'coverageShiftClosedCount')::integer, 0);

    if candidate.resolved_at is null
       and candidate.canceled_at is null
    then
      update public.call_off_reports report
      set
        resolved_at = retired_at,
        resolution_outcome = lifecycle_outcome,
        updated_at = clock_timestamp()
      where report.id = candidate.id;
      resolved_count := resolved_count + 1;
    elsif candidate.resolution_outcome is distinct from lifecycle_outcome then
      update public.call_off_reports report
      set resolution_outcome = lifecycle_outcome,
          updated_at = clock_timestamp()
      where report.id = candidate.id;
    end if;

    recorded_action_count := private.record_call_off_system_resolution(
      candidate.id,
      lifecycle_outcome,
      lifecycle_reason
    );

    select count(*)::integer
    into current_action_count
    from public.call_off_report_actions action
    where action.call_off_report_id = candidate.id
      and action.action = 'resolved'
      and action.reason = lifecycle_reason
      and action.snapshot ->> 'resolution_outcome' = lifecycle_outcome;

    action_count := action_count + greatest(
      current_action_count - prior_action_count,
      recorded_action_count,
      0
    );
  end loop;

  return jsonb_build_object(
    'callOffReconciliationStatus', 'completed',
    'callOffFullReconciliation', target_full_reconciliation,
    'callOffResolvedCount', resolved_count,
    'callOffActionRecordedCount', action_count,
    'callOffAlertRetiredCount', alert_count,
    'callOffAlertWindowUpdatedCount', alert_window_count,
    'callOffNotificationResolvedCount', call_off_notification_count,
    'coverageNotificationExpiredCount', coverage_notification_count,
    'employeeNotificationEmailSuppressedCount', email_delivery_count,
    'employeePushExpiredCount', push_count,
    'callOffOutboxSuppressedCount', outbox_count,
    'staleCoverageCaseClosedCount', coverage_case_count,
    'coverageWaveCanceledCount', wave_count,
    'coverageAnnouncementExpiredCount', announcement_count,
    'coverageShiftRequestDeclinedCount', request_count,
    'coverageShiftClosedCount', coverage_shift_count
  );
end
$$;

revoke all on function private.reconcile_call_off_alert_lifecycle(boolean)
  from public, anon, authenticated;

-- Preserve the reviewed timekeeping reconciliation implementation as a
-- private base, then merge the call-off lifecycle counts into its established
-- public JSON contract.
alter function public.service_reconcile_operational_alert_lifecycle(boolean)
  rename to service_reconcile_operational_alert_lifecycle_pre_call_off;
alter function public.service_reconcile_operational_alert_lifecycle_pre_call_off(boolean)
  set schema private;

revoke all on function private.service_reconcile_operational_alert_lifecycle_pre_call_off(boolean)
  from public, anon, authenticated, service_role;

create function public.service_reconcile_operational_alert_lifecycle(
  target_full_reconciliation boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  base_result jsonb;
  call_off_result jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  base_result := private.service_reconcile_operational_alert_lifecycle_pre_call_off(
    target_full_reconciliation
  );
  if base_result ->> 'status' <> 'completed' then
    return base_result;
  end if;

  call_off_result := private.reconcile_call_off_alert_lifecycle(
    target_full_reconciliation
  );
  return base_result || call_off_result;
end
$$;

revoke all on function public.service_reconcile_operational_alert_lifecycle(boolean)
  from public, anon, authenticated;
grant execute on function public.service_reconcile_operational_alert_lifecycle(boolean)
  to service_role;

-- The email dispatcher gets a source recheck immediately before returning a
-- claimed job, in addition to the insert trigger and scheduled reconciliation.
alter function public.service_claim_notification_batch(integer)
  rename to service_claim_notification_batch_pre_call_off;
alter function public.service_claim_notification_batch_pre_call_off(integer)
  set schema private;

revoke all on function private.service_claim_notification_batch_pre_call_off(integer)
  from public, anon, authenticated, service_role;

create function public.service_claim_notification_batch(
  target_limit integer default 10
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claimed jsonb;
  filtered jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  update private.notification_outbox outbox
  set
    failed_at = coalesce(outbox.failed_at, clock_timestamp()),
    last_error = coalesce(
      outbox.last_error,
      'Suppressed by call-off lifecycle reconciliation because no live coverage action remains.'
    )
  where outbox.message_type = 'call_off_supervisor_alert'
    and outbox.aggregate_type = 'call_off_report'
    and outbox.delivered_at is null
    and outbox.failed_at is null
    and not exists (
      select 1
      from public.call_off_reports report
      join public.shifts shift on shift.id = report.shift_id
      where report.id = outbox.aggregate_id
        and report.canceled_at is null
        and report.resolved_at is null
        and report.duplicate_of_call_off_report_id is null
        and report.replacement_needed
        and clock_timestamp() < shift.ends_at + interval '1 hour'
    );

  claimed := private.service_claim_notification_batch_pre_call_off(target_limit);

  -- Recheck the exact claimed rows. A report that was already terminal when
  -- the base claimant ran must never be handed to the provider worker.
  update private.notification_outbox outbox
  set
    failed_at = coalesce(outbox.failed_at, clock_timestamp()),
    last_error = coalesce(
      outbox.last_error,
      'Suppressed by call-off lifecycle reconciliation because no live coverage action remains.'
    )
  where outbox.id in (
      select (item.value ->> 'id')::uuid
      from jsonb_array_elements(coalesce(claimed, '[]'::jsonb)) item
      where item.value ->> 'id' is not null
    )
    and outbox.message_type = 'call_off_supervisor_alert'
    and outbox.aggregate_type = 'call_off_report'
    and outbox.delivered_at is null
    and not exists (
      select 1
      from public.call_off_reports report
      join public.shifts shift on shift.id = report.shift_id
      where report.id = outbox.aggregate_id
        and report.canceled_at is null
        and report.resolved_at is null
        and report.duplicate_of_call_off_report_id is null
        and report.replacement_needed
        and clock_timestamp() < shift.ends_at + interval '1 hour'
    );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into filtered
  from jsonb_array_elements(coalesce(claimed, '[]'::jsonb))
    with ordinality as item(value, ordinality)
  where not (
    item.value ->> 'messageType' = 'call_off_supervisor_alert'
    and item.value ->> 'aggregateType' = 'call_off_report'
    and not exists (
      select 1
      from public.call_off_reports report
      join public.shifts shift on shift.id = report.shift_id
      where report.id::text = item.value ->> 'aggregateId'
        and report.canceled_at is null
        and report.resolved_at is null
        and report.duplicate_of_call_off_report_id is null
        and report.replacement_needed
        and clock_timestamp() < shift.ends_at + interval '1 hour'
    )
  );

  return filtered;
end
$$;

revoke all on function public.service_claim_notification_batch(integer)
  from public, anon, authenticated;
grant execute on function public.service_claim_notification_batch(integer)
  to service_role;

-- Employee-addressed email uses a separate queue. Revalidate both the inbox
-- row and every supported call-off source before and after the base claimant.
alter function public.service_claim_employee_notification_batch(integer)
  rename to service_claim_employee_notification_batch_pre_call_off;
alter function public.service_claim_employee_notification_batch_pre_call_off(integer)
  set schema private;

revoke all on function private.service_claim_employee_notification_batch_pre_call_off(integer)
  from public, anon, authenticated, service_role;

create function public.service_claim_employee_notification_batch(
  target_limit integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claimed jsonb;
  filtered jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  update public.employee_notification_email_deliveries delivery
  set
    failed_at = coalesce(delivery.failed_at, clock_timestamp()),
    last_error = coalesce(
      delivery.last_error,
      'Suppressed by call-off lifecycle reconciliation because no live coverage action remains.'
    )
  from public.employee_notifications notification
  where notification.id = delivery.notification_id
    and delivery.delivered_at is null
    and delivery.failed_at is null
    and (
      notification.resolved_at is not null
      or notification.dismissed_at is not null
      or notification.expires_at <= clock_timestamp()
      or (
        notification.source_type = 'call_off_request'
        and exists (
          select 1
          from public.call_off_reports report
          join public.shifts shift on shift.id = report.shift_id
          where report.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
      or (
        notification.source_type = 'shift_coverage'
        and exists (
          select 1
          from public.shift_coverage_cases coverage
          join public.call_off_reports report on report.id = coverage.call_off_report_id
          join public.shifts shift on shift.id = report.shift_id
          where coverage.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
      or (
        notification.source_type = 'shift_request'
        and exists (
          select 1
          from public.shift_requests request
          join public.shift_coverage_cases coverage
            on coverage.coverage_shift_id = request.shift_id
          join public.call_off_reports report on report.id = coverage.call_off_report_id
          join public.shifts shift on shift.id = report.shift_id
          where request.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
    );

  claimed := private.service_claim_employee_notification_batch_pre_call_off(target_limit);

  update public.employee_notification_email_deliveries delivery
  set
    failed_at = coalesce(delivery.failed_at, clock_timestamp()),
    last_error = coalesce(
      delivery.last_error,
      'Suppressed by call-off lifecycle reconciliation because no live coverage action remains.'
    )
  from public.employee_notifications notification
  where notification.id = delivery.notification_id
    and delivery.id in (
      select (item.value ->> 'id')::uuid
      from jsonb_array_elements(coalesce(claimed, '[]'::jsonb)) item
      where item.value ->> 'id' is not null
    )
    and delivery.delivered_at is null
    and (
      notification.resolved_at is not null
      or notification.dismissed_at is not null
      or notification.expires_at <= clock_timestamp()
      or (
        notification.source_type = 'call_off_request'
        and exists (
          select 1
          from public.call_off_reports report
          join public.shifts shift on shift.id = report.shift_id
          where report.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
      or (
        notification.source_type = 'shift_coverage'
        and exists (
          select 1
          from public.shift_coverage_cases coverage
          join public.call_off_reports report on report.id = coverage.call_off_report_id
          join public.shifts shift on shift.id = report.shift_id
          where coverage.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
      or (
        notification.source_type = 'shift_request'
        and exists (
          select 1
          from public.shift_requests request
          join public.shift_coverage_cases coverage
            on coverage.coverage_shift_id = request.shift_id
          join public.call_off_reports report on report.id = coverage.call_off_report_id
          join public.shifts shift on shift.id = report.shift_id
          where request.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
    );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into filtered
  from jsonb_array_elements(coalesce(claimed, '[]'::jsonb))
    with ordinality as item(value, ordinality)
  join public.employee_notification_email_deliveries delivery
    on delivery.id = (item.value ->> 'id')::uuid
  where delivery.failed_at is null;

  return filtered;
end
$$;

revoke all on function public.service_claim_employee_notification_batch(integer)
  from public, anon, authenticated;
grant execute on function public.service_claim_employee_notification_batch(integer)
  to service_role;

-- Editing replacement_needed is itself a lifecycle transition. Only the
-- automatic no-replacement-required outcome may be reopened, and only while
-- the live response window is still open.
create or replace function public.update_employee_call_off(
  target_call_off_report_id uuid,
  target_call_off_type text,
  target_reason text,
  target_notes text,
  target_replacement_needed boolean,
  target_operational_details text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('accountability.report_call_off');
  existing public.call_off_reports%rowtype;
  changed public.call_off_reports%rowtype;
  shift_ends_at timestamptz;
  replacement_required boolean := coalesce(target_replacement_needed, true);
  reopening boolean := false;
begin
  if target_call_off_type not in ('sick', 'other') then
    raise check_violation using message = 'Choose Sick or Other call-off.';
  end if;
  if btrim(coalesce(target_reason, '')) = '' then
    raise check_violation using message = 'A call-off reason is required.';
  end if;

  select report.*
  into existing
  from public.call_off_reports report
  where report.id = target_call_off_report_id
    and report.canceled_at is null
    and report.duplicate_of_call_off_report_id is null
  for update;
  if existing.id is null then
    raise check_violation using message = 'The call-off is no longer active.';
  end if;

  select shift.ends_at
  into shift_ends_at
  from public.shifts shift
  where shift.id = existing.shift_id;

  reopening := replacement_required and not existing.replacement_needed;
  if reopening then
    if existing.resolution_outcome <> 'no_replacement_required' then
      raise check_violation using message = 'Only a no-replacement-required call-off can be reopened.';
    end if;
    if clock_timestamp() >= shift_ends_at + interval '1 hour' then
      raise check_violation using message = 'Replacement coverage cannot be reopened after the live response window.';
    end if;
  elsif replacement_required
        and existing.resolved_at is not null
        and existing.resolution_outcome is distinct from 'no_replacement_required'
  then
    raise check_violation using message = 'A completed call-off outcome cannot be reopened.';
  end if;

  update public.call_off_reports report
  set
    call_off_type = target_call_off_type,
    reason = concat(
      btrim(target_reason),
      case when btrim(coalesce(target_notes, '')) = ''
        then '' else E'\n\n' || btrim(target_notes)
      end
    ),
    replacement_needed = replacement_required,
    operational_details = nullif(btrim(coalesce(target_operational_details, '')), ''),
    resolved_at = case when reopening then null else report.resolved_at end,
    resolution_outcome = case when reopening then null else report.resolution_outcome end,
    updated_at = clock_timestamp()
  where report.id = existing.id
  returning * into changed;

  insert into public.call_off_report_actions (
    call_off_report_id,
    action,
    reason,
    actor_id,
    snapshot
  ) values (
    changed.id,
    'updated',
    case when reopening then 'Replacement coverage was reopened.' else btrim(target_reason) end,
    actor_id,
    to_jsonb(changed) || jsonb_build_object('replacementReopened', reopening)
  );

  return jsonb_build_object(
    'id', changed.id,
    'status', case when reopening then 'reopened' else 'updated' end,
    'replacementNeeded', changed.replacement_needed,
    'resolutionOutcome', changed.resolution_outcome,
    'resolvedAt', changed.resolved_at
  );
end
$$;

revoke all on function public.update_employee_call_off(uuid, text, text, text, boolean, text)
  from public, anon;
grant execute on function public.update_employee_call_off(uuid, text, text, text, boolean, text)
  to authenticated;

-- Historical coverage details remain readable, but terminal sources return a
-- fail-closed workspace with no candidates or patrol action.
alter function public.get_call_off_coverage_workspace(uuid)
  rename to get_call_off_coverage_workspace_pre_call_off_lifecycle;
alter function public.get_call_off_coverage_workspace_pre_call_off_lifecycle(uuid)
  set schema private;

revoke all on function private.get_call_off_coverage_workspace_pre_call_off_lifecycle(uuid)
  from public, anon, authenticated;

create function public.get_call_off_coverage_workspace(
  target_call_off_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  report public.call_off_reports%rowtype;
  shift_ends_at timestamptz;
  actionable boolean;
  non_actionable_reason text;
begin
  payload := private.get_call_off_coverage_workspace_pre_call_off_lifecycle(
    target_call_off_id
  );

  select item.*
  into report
  from public.call_off_reports item
  where item.id = target_call_off_id;

  if report.id is not null then
    select shift.ends_at
    into shift_ends_at
    from public.shifts shift
    where shift.id = report.shift_id;
  end if;

  actionable := report.id is not null
    and report.canceled_at is null
    and report.resolved_at is null
    and report.duplicate_of_call_off_report_id is null
    and report.replacement_needed
    and statement_timestamp() < shift_ends_at + interval '1 hour';

  if actionable then
    return payload || jsonb_build_object('actionable', true);
  end if;

  non_actionable_reason := coalesce(
    private.call_off_lifecycle_reason(report.resolution_outcome),
    'This call-off no longer has a live replacement-coverage window.'
  );

  payload := jsonb_set(payload, '{candidates}', '[]'::jsonb, true);
  payload := jsonb_set(payload, '{shift,isOpen}', 'false'::jsonb, true);
  payload := jsonb_set(
    payload,
    '{patrolFallback}',
    jsonb_build_object(
      'available', false,
      'message', non_actionable_reason
    ),
    true
  );

  return payload || jsonb_build_object(
    'actionable', false,
    'nonActionableReason', non_actionable_reason
  );
end
$$;

revoke all on function public.get_call_off_coverage_workspace(uuid)
  from public, anon;
grant execute on function public.get_call_off_coverage_workspace(uuid)
  to authenticated;

-- Keep the canonical Request Center reader aligned with the same one-hour
-- live window and replacement requirement. The exact reviewed fragments make
-- a production definition drift fail loudly instead of widening the queue.
do $request_center_call_off_lifecycle$
declare
  definition text;
  prior_manager text := '(can_manage and report.announcement_id is null and report.resolved_at is null)';
  replacement_manager text := '(can_manage and report.announcement_id is null and report.resolved_at is null and report.replacement_needed)';
  prior_cutoff text := 'and report.canceled_at is null
        and report.duplicate_of_call_off_report_id is null
        and shift.ends_at > clock_timestamp()';
  replacement_cutoff text := 'and report.canceled_at is null
        and report.duplicate_of_call_off_report_id is null
        and shift.ends_at + interval ''1 hour'' > clock_timestamp()';
begin
  select pg_get_functiondef('public.get_request_center_payload()'::regprocedure)
  into definition;
  if definition is null
     or position(prior_manager in definition) = 0
     or position(prior_cutoff in definition) = 0
  then
    raise exception 'Request Center call-off lifecycle precondition did not match the reviewed canonical definition.';
  end if;
  definition := replace(definition, prior_manager, replacement_manager);
  definition := replace(definition, prior_cutoff, replacement_cutoff);
  execute definition;
end
$request_center_call_off_lifecycle$;

-- Preserve the mature coverage implementation behind a report-locking gate.
-- This prevents a stale direct link from reopening live work after the source
-- report has become terminal while retaining idempotent completed responses.
alter function public.resolve_call_off_coverage(uuid, text, uuid, text, text, text, boolean, uuid)
  rename to resolve_call_off_coverage_pre_call_off_lifecycle;
alter function public.resolve_call_off_coverage_pre_call_off_lifecycle(uuid, text, uuid, text, text, text, boolean, uuid)
  set schema private;

revoke all on function private.resolve_call_off_coverage_pre_call_off_lifecycle(uuid, text, uuid, text, text, text, boolean, uuid)
  from public, anon, authenticated;

do $align_coverage_resolution_cutoff$
declare
  definition text;
  prior text := 'shift_record.ends_at <= clock_timestamp()';
  replacement text := 'clock_timestamp() >= shift_record.ends_at + interval ''1 hour''';
begin
  select pg_get_functiondef(
    'private.resolve_call_off_coverage_pre_call_off_lifecycle(uuid,text,uuid,text,text,text,boolean,uuid)'::regprocedure
  ) into definition;
  if definition is null or position(prior in definition) = 0 then
    raise exception 'resolve_call_off_coverage cutoff precondition did not match the reviewed definition.';
  end if;
  execute replace(definition, prior, replacement);
end
$align_coverage_resolution_cutoff$;

create function public.resolve_call_off_coverage(
  target_call_off_id uuid,
  target_mode text,
  target_replacement_employee_id uuid,
  announcement_title text,
  announcement_body text,
  target_reason text,
  target_allow_overtime boolean,
  target_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  report public.call_off_reports%rowtype;
  replay public.shift_coverage_cases%rowtype;
  shift_ends_at timestamptz;
begin
  if not private.shift_coverage_manager_allowed() then
    raise insufficient_privilege using message = 'Coverage management permission with MFA is required.';
  end if;

  select item.*
  into report
  from public.call_off_reports item
  where item.id = target_call_off_id
  for update of item;

  if report.id is null then
    raise check_violation using message = 'This call-off is no longer available.';
  end if;

  select shift.ends_at
  into shift_ends_at
  from public.shifts shift
  where shift.id = report.shift_id;

  -- A successful first call may itself make the report terminal. Permit only
  -- the exact same call-off/key replay after the report lock is held; the
  -- call-off predicate prevents a globally unique key from leaking another
  -- report's coverage result.
  select *
  into replay
  from public.shift_coverage_cases coverage
  where coverage.call_off_report_id = report.id
    and coverage.last_idempotency_key = target_idempotency_key;

  if replay.id is not null then
    return jsonb_build_object(
      'coverageCaseId', replay.id,
      'status', replay.status,
      'coverageMode', replay.coverage_mode,
      'coverageShiftId', replay.coverage_shift_id,
      'announcementId', replay.announcement_id,
      'replacementAssignmentId', replay.replacement_assignment_id,
      'idempotentReplay', true
    );
  end if;

  if exists (
    select 1
    from public.shift_coverage_cases coverage
    where coverage.last_idempotency_key = target_idempotency_key
      and coverage.call_off_report_id <> report.id
  ) then
    raise check_violation using message = 'This idempotency key belongs to a different call-off.';
  end if;

  if report.canceled_at is not null
     or report.resolved_at is not null
     or report.duplicate_of_call_off_report_id is not null
     or not report.replacement_needed
     or clock_timestamp() >= shift_ends_at + interval '1 hour'
  then
    raise check_violation using message = 'This call-off no longer has a live replacement-coverage window.';
  end if;

  return private.resolve_call_off_coverage_pre_call_off_lifecycle(
    target_call_off_id,
    target_mode,
    target_replacement_employee_id,
    announcement_title,
    announcement_body,
    target_reason,
    target_allow_overtime,
    target_idempotency_key
  );
end
$$;

revoke all on function public.resolve_call_off_coverage(uuid, text, uuid, text, text, text, boolean, uuid)
  from public, anon;
grant execute on function public.resolve_call_off_coverage(uuid, text, uuid, text, text, text, boolean, uuid)
  to authenticated;

-- The request gate reads the request only to discover its linked call-off,
-- locks that report first, and lets the preserved implementation lock the
-- pending request and coverage case afterward. Every writer therefore uses
-- report -> request/coverage ordering.
alter function public.decide_shift_request(uuid, public.request_status, text)
  rename to decide_shift_request_pre_call_off_lifecycle;
alter function public.decide_shift_request_pre_call_off_lifecycle(uuid, public.request_status, text)
  set schema private;

revoke all on function private.decide_shift_request_pre_call_off_lifecycle(uuid, public.request_status, text)
  from public, anon, authenticated;

create function public.decide_shift_request(
  target_request_id uuid,
  target_decision public.request_status,
  target_note text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  request_record public.shift_requests%rowtype;
  report public.call_off_reports%rowtype;
  shift_ends_at timestamptz;
begin
  if public.current_employee_id() is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to decide shift requests.';
  end if;
  if not public.has_mfa()
     or not public.has_any_effective_permission(array['requests.manage', 'shift_pool.manage']::text[])
  then
    raise insufficient_privilege using message = 'Request management permission with MFA is required to decide shift requests.';
  end if;

  select *
  into request_record
  from public.shift_requests request
  where request.id = target_request_id;

  if request_record.id is not null and target_decision = 'approved' then
    select report_row.*
    into report
    from public.shift_coverage_cases coverage
    join public.call_off_reports report_row
      on report_row.id = coverage.call_off_report_id
    where coverage.coverage_shift_id = request_record.shift_id
    for update of report_row;

    if report.id is not null then
      select source_shift.ends_at
      into shift_ends_at
      from public.shifts source_shift
      where source_shift.id = report.shift_id;
    end if;

    if report.id is not null
       and (
         report.canceled_at is not null
         or report.resolved_at is not null
         or report.duplicate_of_call_off_report_id is not null
         or not report.replacement_needed
         or clock_timestamp() >= shift_ends_at + interval '1 hour'
       )
    then
      raise check_violation using message = 'The linked call-off no longer has a live replacement-coverage window.';
    end if;
  end if;

  return private.decide_shift_request_pre_call_off_lifecycle(
    target_request_id,
    target_decision,
    target_note
  );
end
$$;

revoke all on function public.decide_shift_request(uuid, public.request_status, text)
  from public, anon;
grant execute on function public.decide_shift_request(uuid, public.request_status, text)
  to authenticated;

-- Reclassification away from an absence is also a call-off cancellation.
-- Preserve both records and their prior audit rows, but sever the live source
-- link and append explicit cancellation/unlink history in the same transaction.
alter function public.reclassify_attendance_accountability_event(uuid, text, text)
  rename to reclassify_attendance_accountability_event_pre_call_off_lifecycle;
alter function public.reclassify_attendance_accountability_event_pre_call_off_lifecycle(uuid, text, text)
  set schema private;

revoke all on function private.reclassify_attendance_accountability_event_pre_call_off_lifecycle(uuid, text, text)
  from public, anon, authenticated;

create function public.reclassify_attendance_accountability_event(
  target_event_id uuid,
  target_event_type text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  event_before public.attendance_accountability_events%rowtype;
  event_after public.attendance_accountability_events%rowtype;
  report_before public.call_off_reports%rowtype;
  report_after public.call_off_reports%rowtype;
  result jsonb;
  cancellation_reason text;
begin
  select *
  into event_before
  from public.attendance_accountability_events event
  where event.id = target_event_id
  for update;

  if target_event_type not in ('called_in_sick', 'call_off', 'no_call_no_show')
     and event_before.call_off_report_id is not null
  then
    select *
    into report_before
    from public.call_off_reports report
    where report.id = event_before.call_off_report_id
    for update;
  end if;

  result := private.reclassify_attendance_accountability_event_pre_call_off_lifecycle(
    target_event_id,
    target_event_type,
    target_reason
  );

  if target_event_type not in ('called_in_sick', 'call_off', 'no_call_no_show')
     and report_before.id is not null
  then
    cancellation_reason := concat(
      'The linked attendance occurrence was reclassified as ',
      replace(target_event_type, '_', ' '),
      ': ',
      btrim(target_reason)
    );

    update public.call_off_reports report
    set
      canceled_at = coalesce(report.canceled_at, clock_timestamp()),
      canceled_by = coalesce(report.canceled_by, actor_id),
      cancellation_note = coalesce(report.cancellation_note, cancellation_reason),
      updated_at = clock_timestamp()
    where report.id = report_before.id
    returning * into report_after;

    insert into public.call_off_report_actions (
      call_off_report_id,
      action,
      reason,
      actor_id,
      snapshot
    )
    select
      report_after.id,
      'canceled',
      cancellation_reason,
      actor_id,
      to_jsonb(report_after) || jsonb_build_object(
        'attendanceEventId', target_event_id,
        'reclassifiedEventType', target_event_type
      )
    where not exists (
      select 1
      from public.call_off_report_actions action
      where action.call_off_report_id = report_after.id
        and action.action = 'canceled'
        and action.snapshot ->> 'attendanceEventId' = target_event_id::text
    );

    select *
    into event_before
    from public.attendance_accountability_events event
    where event.id = target_event_id
    for update;

    update public.attendance_accountability_events event
    set
      call_off_report_id = null,
      updated_at = clock_timestamp()
    where event.id = target_event_id
      and event.call_off_report_id = report_after.id
    returning * into event_after;

    if event_after.id is not null then
      insert into public.attendance_accountability_event_actions (
        event_id,
        action,
        reason,
        actor_id,
        before_record,
        after_record
      ) values (
        event_after.id,
        'reclassified',
        'Unlinked the retired call-off after the attendance occurrence was reclassified.',
        actor_id,
        to_jsonb(event_before),
        to_jsonb(event_after)
      );

      insert into private.audit_events (
        auth_user_id,
        employee_id,
        schema_name,
        table_name,
        operation,
        row_id,
        old_record,
        new_record
      ) values (
        auth.uid(),
        actor_id,
        'public',
        'attendance_accountability_events',
        'RECLASSIFY',
        event_after.id::text,
        to_jsonb(event_before),
        to_jsonb(event_after)
      );
    end if;

    result := result || jsonb_build_object(
      'callOffId', null,
      'coverageRequired', false
    );
  end if;

  return result;
end
$$;

revoke all on function public.reclassify_attendance_accountability_event(uuid, text, text)
  from public, anon;
grant execute on function public.reclassify_attendance_accountability_event(uuid, text, text)
  to authenticated;

create or replace function public.service_process_shift_coverage_notification_waves(
  target_limit integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  candidate_wave record;
  wave private.shift_coverage_notification_waves%rowtype;
  coverage public.shift_coverage_cases%rowtype;
  report public.call_off_reports%rowtype;
  source_shift public.shifts%rowtype;
  shift_record public.shifts%rowtype;
  employee public.employees%rowtype;
  candidate jsonb;
  notification_generation text := '';
  sent_count integer;
  processed_count integer := 0;
  total_recipients integer := 0;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service-role access is required.';
  end if;

  for candidate_wave in
    select pending.id
    from private.shift_coverage_notification_waves pending
    where pending.status in ('pending', 'processing')
      and pending.due_at <= clock_timestamp()
      and (
        pending.status = 'pending'
        or pending.claimed_at < clock_timestamp() - interval '5 minutes'
      )
    order by pending.due_at, pending.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  loop
    -- Serialize on report -> coverage -> wave, matching coverage decisions and
    -- report retirement. The lifecycle is rechecked only after all locks hold.
    select report_row.*
    into report
    from public.call_off_reports report_row
    join public.shift_coverage_cases coverage_row
      on coverage_row.call_off_report_id = report_row.id
    join private.shift_coverage_notification_waves wave_row
      on wave_row.coverage_case_id = coverage_row.id
    where wave_row.id = candidate_wave.id
    for update of report_row;

    if report.id is null then
      continue;
    end if;

    select *
    into coverage
    from public.shift_coverage_cases coverage_row
    where coverage_row.call_off_report_id = report.id
    for update;

    select concat(':reopen:', action.id)
    into notification_generation
    from public.shift_coverage_case_actions action
    where action.coverage_case_id = coverage.id
      and coalesce(
        (action.after_record ->> 'lifecycleReopened')::boolean,
        false
      )
    order by action.created_at desc, action.id desc
    limit 1;
    notification_generation := coalesce(notification_generation, '');

    select *
    into wave
    from private.shift_coverage_notification_waves wave_row
    where wave_row.id = candidate_wave.id
      and wave_row.status in ('pending', 'processing')
      and wave_row.due_at <= clock_timestamp()
      and (
        wave_row.status = 'pending'
        or wave_row.claimed_at < clock_timestamp() - interval '5 minutes'
      )
    for update skip locked;
    if wave.id is null then
      continue;
    end if;

    select * into source_shift from public.shifts where id = report.shift_id;
    select * into shift_record from public.shifts where id = coverage.coverage_shift_id;

    if report.canceled_at is not null
       or report.resolved_at is not null
       or report.duplicate_of_call_off_report_id is not null
       or not report.replacement_needed
       or clock_timestamp() >= source_shift.ends_at + interval '1 hour'
       or coverage.status <> 'open_pool'
       or not coalesce(shift_record.is_open, false)
       or shift_record.ends_at <= clock_timestamp()
    then
      update private.shift_coverage_notification_waves item
      set
        status = 'canceled',
        processed_at = coalesce(item.processed_at, clock_timestamp()),
        updated_at = clock_timestamp(),
        last_error = coalesce(item.last_error, 'Canceled because the linked call-off no longer needs live coverage.')
      where item.id = wave.id;
      continue;
    end if;

    update private.shift_coverage_notification_waves item
    set
      status = 'processing',
      attempts = item.attempts + 1,
      claimed_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      last_error = null
    where item.id = wave.id
    returning * into wave;
    sent_count := 0;

    begin
      for employee in
        select *
        from public.employees candidate_employee
        where candidate_employee.status = 'active'
          and candidate_employee.role = 'guard'
          and candidate_employee.id <> coverage.absent_employee_id
        order by candidate_employee.id
      loop
        candidate := private.shift_coverage_candidate_payload(shift_record.id, employee.id);
        if candidate is null
           or not coalesce((candidate ->> 'eligible')::boolean, false)
        then
          continue;
        end if;
        if wave.audience = 'flex_no_overtime' and not (
          coalesce((candidate ->> 'isFlex')::boolean, false)
          and not coalesce((candidate ->> 'requiresOvertimeApproval')::boolean, false)
        ) then
          continue;
        end if;
        if wave.audience = 'other_no_overtime' and not (
          not coalesce((candidate ->> 'isFlex')::boolean, false)
          and not coalesce((candidate ->> 'requiresOvertimeApproval')::boolean, false)
        ) then
          continue;
        end if;
        if wave.audience = 'overtime' and not (
          coverage.allow_overtime_wave
          and coalesce((candidate ->> 'requiresOvertimeApproval')::boolean, false)
        ) then
          continue;
        end if;

        perform private.create_employee_notification(
          employee.id,
          'shift_coverage',
          coverage.id,
          concat(
            'shift-coverage:', coverage.id,
            ':wave:', wave.wave_number,
            notification_generation,
            ':employee:', employee.id
          ),
          case when wave.audience = 'overtime'
            then 'Open shift — overtime approval available'
            else 'Open shift available'
          end,
          concat(
            'A ',
            case when shift_record.requires_armed then 'qualified armed ' else 'qualified ' end,
            'guard is needed ',
            to_char(
              shift_record.starts_at at time zone shift_record.time_zone,
              'Mon FMMonth FMDD at FMHH12:MI AM'
            ),
            '. Review the shift details and request it if you are available.'
          ),
          case when wave.wave_number = 1 then 'important' else 'urgent' end,
          false,
          '/schedule',
          'Review open shift',
          coverage.opened_by,
          null,
          shift_record.ends_at
        );
        sent_count := sent_count + 1;
      end loop;

      update private.shift_coverage_notification_waves item
      set
        status = 'sent',
        recipient_count = sent_count,
        processed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      where item.id = wave.id;

      insert into public.shift_coverage_case_actions (
        coverage_case_id,
        action,
        actor_id,
        reason,
        before_record,
        after_record
      ) values (
        coverage.id,
        'notification_wave_sent',
        null,
        format(
          'Notification wave %s completed for %s eligible guard(s).',
          wave.wave_number,
          sent_count
        ),
        null,
        jsonb_build_object(
          'waveNumber', wave.wave_number,
          'audience', wave.audience,
          'recipientCount', sent_count
        )
      );
      processed_count := processed_count + 1;
      total_recipients := total_recipients + sent_count;
    exception when others then
      update private.shift_coverage_notification_waves item
      set
        status = case when item.attempts >= 5 then 'failed' else 'pending' end,
        due_at = case when item.attempts >= 5
          then item.due_at else clock_timestamp() + interval '2 minutes'
        end,
        last_error = left(sqlerrm, 1000),
        updated_at = clock_timestamp()
      where item.id = wave.id;
    end;
  end loop;

  return jsonb_build_object(
    'processed', processed_count,
    'recipients', total_recipients
  );
end
$$;

revoke all on function public.service_process_shift_coverage_notification_waves(integer)
  from public, anon, authenticated;
grant execute on function public.service_process_shift_coverage_notification_waves(integer)
  to service_role;

alter function public.service_claim_employee_push(integer)
  rename to service_claim_employee_push_pre_call_off;
alter function public.service_claim_employee_push_pre_call_off(integer)
  set schema private;

revoke all on function private.service_claim_employee_push_pre_call_off(integer)
  from public, anon, authenticated, service_role;

create function public.service_claim_employee_push(
  target_limit integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claimed jsonb;
  filtered jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  claimed := private.service_claim_employee_push_pre_call_off(target_limit);

  update private.employee_push_deliveries delivery
  set
    completed_at = coalesce(delivery.completed_at, clock_timestamp()),
    outcome = coalesce(delivery.outcome, 'expired')
  from public.employee_notifications notification
  where notification.id = delivery.notification_id
    and delivery.completed_at is null
    and delivery.id in (
      select (item.value ->> 'id')::uuid
      from jsonb_array_elements(coalesce(claimed, '[]'::jsonb)) item
      where item.value ->> 'id' is not null
    )
    and (
      notification.resolved_at is not null
      or notification.dismissed_at is not null
      or notification.expires_at <= clock_timestamp()
      or (
        notification.source_type = 'call_off_request'
        and exists (
          select 1
          from public.call_off_reports report
          join public.shifts shift on shift.id = report.shift_id
          where report.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
      or (
        notification.source_type = 'shift_coverage'
        and exists (
          select 1
          from public.shift_coverage_cases coverage
          join public.call_off_reports report on report.id = coverage.call_off_report_id
          join public.shifts shift on shift.id = report.shift_id
          where coverage.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
      or (
        notification.source_type = 'shift_request'
        and exists (
          select 1
          from public.shift_requests request
          join public.shift_coverage_cases coverage
            on coverage.coverage_shift_id = request.shift_id
          join public.call_off_reports report on report.id = coverage.call_off_report_id
          join public.shifts shift on shift.id = report.shift_id
          where request.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
    );

  select coalesce(
    jsonb_agg(item.value order by item.ordinality),
    '[]'::jsonb
  )
  into filtered
  from jsonb_array_elements(coalesce(claimed, '[]'::jsonb))
    with ordinality as item(value, ordinality)
  left join private.employee_push_deliveries delivery
    on delivery.id = (item.value ->> 'id')::uuid
  where not (
    delivery.completed_at is not null
    and delivery.outcome = 'expired'
  );

  return filtered;
end
$$;

revoke all on function public.service_claim_employee_push(integer)
  from public, anon, authenticated;
grant execute on function public.service_claim_employee_push(integer)
  to service_role;

-- Keep Time Operations fail-closed for call-off alerts while preserving the
-- canonical duplicate filtering introduced by the accountability repair.
create or replace function public.get_timekeeping_operations_workspace(
  target_from_date date default current_date - 14,
  target_through_date date default current_date + 14
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  enriched_call_offs jsonb;
  enriched_alerts jsonb;
begin
  payload := private.get_timekeeping_operations_workspace_pre_absence_completion(
    target_from_date,
    target_through_date
  );

  select coalesce(
    jsonb_agg(
      call_off.item || jsonb_build_object(
        'resolvedAt', report.resolved_at,
        'coverageStatus', coverage.status,
        'resolutionOutcome', report.resolution_outcome
      ) order by call_off.ordinality
    ),
    '[]'::jsonb
  )
  into enriched_call_offs
  from jsonb_array_elements(coalesce(payload -> 'callOffReports', '[]'::jsonb))
    with ordinality as call_off(item, ordinality)
  left join public.call_off_reports report
    on report.id::text = call_off.item ->> 'id'
  left join public.shift_coverage_cases coverage
    on coverage.call_off_report_id = report.id
  where report.id is null or report.duplicate_of_call_off_report_id is null;

  select coalesce(
    jsonb_agg(
      alert.item || jsonb_build_object(
        'active', operational.active,
        'lifecycleStatus', operational.lifecycle_state,
        'liveUntil', operational.live_until_at
      ) order by alert.ordinality
    ),
    '[]'::jsonb
  )
  into enriched_alerts
  from jsonb_array_elements(coalesce(payload -> 'alerts', '[]'::jsonb))
    with ordinality as alert(item, ordinality)
  join public.operational_alerts operational
    on operational.id::text = alert.item ->> 'id'
  where operational.active
    and operational.lifecycle_state = 'active_operations'
    and (
      (
        operational.related_record_type = 'call_off_report'
        and operational.live_until_at is not null
        and operational.live_until_at > statement_timestamp()
      )
      or (
        operational.related_record_type is distinct from 'call_off_report'
        and (
          operational.live_until_at is null
          or operational.live_until_at > statement_timestamp()
        )
      )
    );

  return jsonb_set(
    jsonb_set(payload, '{callOffReports}', enriched_call_offs, true),
    '{alerts}',
    enriched_alerts,
    true
  );
end
$$;

revoke all on function public.get_timekeeping_operations_workspace(date, date)
  from public, anon;
grant execute on function public.get_timekeeping_operations_workspace(date, date)
  to authenticated;

-- Reconcile pre-existing rows through the same serialized implementation used
-- by the scheduled service path. This preserves all report and notification
-- history while removing stale live work before the consistency constraint is
-- validated.
do $call_off_lifecycle_backfill$
begin
  perform pg_advisory_xact_lock(hashtext('sygshift.call.off.alert.lifecycle'));
  perform private.reconcile_call_off_alert_lifecycle(true);
end
$call_off_lifecycle_backfill$;

alter table public.call_off_reports
  drop constraint if exists call_off_reports_resolution_consistency;
alter table public.call_off_reports
  add constraint call_off_reports_resolution_consistency
  check (
    (
      resolution_outcome is null
      and resolved_at is null
      and canceled_at is null
    )
    or (
      resolution_outcome = 'canceled'
      and canceled_at is not null
    )
    or (
      resolution_outcome is not null
      and resolution_outcome <> 'canceled'
      and resolved_at is not null
      and canceled_at is null
    )
  );

comment on column public.call_off_reports.resolution_outcome is
  'Authoritative terminal outcome. NULL is reserved for live reports; lifecycle timestamps are enforced by call_off_reports_resolution_consistency.';

notify pgrst, 'reload schema';

commit;
