begin;

-- Operations previously read only the newer adjustment-request tables while
-- Team Attendance counted the original punch-correction workflow. Expose the
-- still-pending punch requests through one small, date-scoped RPC so both
-- workspaces can show the same queue without loading the full payroll review.
create index if not exists time_event_corrections_pending_event_idx
  on public.time_event_corrections (time_event_id, created_at)
  where approved_at is null and declined_at is null;

create or replace function public.get_pending_time_event_corrections(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  can_review boolean := public.has_mfa()
    and public.has_effective_permission('time.adjustments.review');
  pending_requests jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if target_from_date is null
    or target_through_date is null
    or target_through_date < target_from_date
  then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 366 then
    raise check_violation using message = 'Correction request ranges are limited to 367 days.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', correction.id,
    'timeEventId', correction.time_event_id,
    'employeeId', event.employee_id,
    'employeeName', btrim(concat_ws(
      ' ',
      coalesce(nullif(employee.preferred_name, ''), employee.first_name),
      employee.last_name
    )),
    'username', employee.username,
    'kind', event.kind,
    'recordedAt', event.recorded_at,
    'replacementTime', correction.replacement_time,
    'voided', correction.voided,
    'reason', correction.reason,
    'requestedBy', correction.requested_by,
    'requestedAt', correction.created_at,
    'shiftId', event.shift_id
  ) order by correction.created_at), '[]'::jsonb)
  into pending_requests
  from public.time_event_corrections correction
  join public.time_events event on event.id = correction.time_event_id
  join public.employees employee on employee.id = event.employee_id
  where correction.approved_at is null
    and correction.declined_at is null
    and (event.recorded_at at time zone 'America/Denver')::date
      between target_from_date and target_through_date
    and (can_review or correction.requested_by = actor_id);

  return pending_requests;
end
$$;

revoke all on function public.get_pending_time_event_corrections(date, date) from public, anon;
grant execute on function public.get_pending_time_event_corrections(date, date) to authenticated;

-- Keep the original event and every request immutable. When an authorized
-- manager applies the effective correction directly, decide any older pending
-- request for that same punch in the same transaction. A matching request is
-- approved; a different managerial decision supersedes and declines it.
create or replace function public.supervisor_correct_time_event_details(
  target_time_event_id uuid,
  target_replacement_time timestamptz default null,
  target_replacement_kind public.time_event_kind default null,
  target_voided boolean default false,
  target_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_reason text := btrim(coalesce(target_reason, ''));
  target_event public.time_events%rowtype;
  current_effective_at timestamptz;
  current_voided boolean;
  current_effective_kind public.time_event_kind;
  resolved_replacement_time timestamptz;
  resolved_replacement_kind public.time_event_kind;
  inserted_correction public.time_event_corrections%rowtype;
  approved_pending_count integer := 0;
  declined_pending_count integer := 0;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Operations access with MFA is required to maintain employee time.';
  end if;

  if target_time_event_id is null then
    raise check_violation using message = 'A time event is required.';
  end if;

  if clean_reason = '' then
    raise check_violation using message = 'A maintenance reason is required.';
  end if;

  if coalesce(target_voided, false)
    and (target_replacement_time is not null or target_replacement_kind is not null)
  then
    raise check_violation using message = 'Void the duplicate or accidental punch, or correct its details; do not do both.';
  end if;

  if not coalesce(target_voided, false)
    and target_replacement_time is null
    and target_replacement_kind is null
  then
    raise check_violation using message = 'Choose a corrected time, punch type, or both.';
  end if;

  select * into target_event
  from public.time_events event
  where event.id = target_time_event_id
  for update;

  if target_event.id is null then
    raise no_data_found using message = 'The selected time event was not found.';
  end if;

  select effective.effective_at, effective.voided
  into current_effective_at, current_voided
  from private.current_effective_time_event(target_event.id) effective;

  current_effective_kind := private.current_effective_time_event_kind(target_event.id);

  if coalesce(current_voided, false) then
    raise check_violation using message = 'This punch is already voided and cannot be corrected.';
  end if;

  if not coalesce(target_voided, false) then
    resolved_replacement_time := coalesce(target_replacement_time, current_effective_at);
    resolved_replacement_kind := coalesce(target_replacement_kind, current_effective_kind);

    if resolved_replacement_time > clock_timestamp() + interval '15 minutes' then
      raise check_violation using message = 'Replacement time cannot be in the future.';
    end if;

    if resolved_replacement_time is not distinct from current_effective_at
      and resolved_replacement_kind is not distinct from current_effective_kind
    then
      raise check_violation using message = 'The corrected punch is unchanged. Update the time, punch type, or both.';
    end if;
  end if;

  insert into public.time_event_corrections (
    time_event_id,
    replacement_time,
    replacement_kind,
    voided,
    reason,
    requested_by,
    approved_by,
    approved_at,
    decision_note
  )
  values (
    target_event.id,
    case when coalesce(target_voided, false) then null else resolved_replacement_time end,
    case when coalesce(target_voided, false) then null else resolved_replacement_kind end,
    coalesce(target_voided, false),
    clean_reason,
    actor_id,
    actor_id,
    clock_timestamp(),
    'Operations maintenance correction.'
  )
  returning * into inserted_correction;

  insert into public.time_event_maintenance_notes (
    time_event_id,
    action,
    note,
    created_by
  )
  values (
    target_event.id,
    case
      when coalesce(target_voided, false) then 'void'
      when resolved_replacement_kind is distinct from current_effective_kind then 'punch_type_update'
      else 'time_adjust'
    end,
    clean_reason,
    actor_id
  );

  with pending as (
    select
      correction.id,
      (
        (correction.voided and inserted_correction.voided)
        or (
          not correction.voided
          and not inserted_correction.voided
          and (
            correction.replacement_time is null
            or correction.replacement_time is not distinct from inserted_correction.replacement_time
          )
          and (
            correction.replacement_kind is null
            or correction.replacement_kind is not distinct from inserted_correction.replacement_kind
          )
        )
      ) as request_satisfied
    from public.time_event_corrections correction
    where correction.time_event_id = target_event.id
      and correction.approved_at is null
      and correction.declined_at is null
  ), resolved as (
    update public.time_event_corrections correction
    set
      approved_by = case when pending.request_satisfied then actor_id else null end,
      approved_at = case when pending.request_satisfied then inserted_correction.approved_at else null end,
      declined_by = case when pending.request_satisfied then null else actor_id end,
      declined_at = case when pending.request_satisfied then null else inserted_correction.approved_at end,
      decision_note = case
        when pending.request_satisfied
          then 'Approved automatically because the authorized Operations correction applied the requested punch change.'
        else 'Superseded by an authorized Operations maintenance correction. Reason: ' || clean_reason
      end
    from pending
    where correction.id = pending.id
    returning correction.approved_at is not null as was_approved
  )
  select
    count(*) filter (where was_approved)::integer,
    count(*) filter (where not was_approved)::integer
  into approved_pending_count, declined_pending_count
  from resolved;

  return jsonb_build_object(
    'id', inserted_correction.id,
    'timeEventId', inserted_correction.time_event_id,
    'replacementTime', inserted_correction.replacement_time,
    'replacementKind', inserted_correction.replacement_kind,
    'recordedKind', target_event.kind,
    'voided', inserted_correction.voided,
    'requestedBy', inserted_correction.requested_by,
    'approvedBy', inserted_correction.approved_by,
    'approvedAt', inserted_correction.approved_at,
    'reason', inserted_correction.reason,
    'resolvedPendingRequestCount', approved_pending_count + declined_pending_count,
    'approvedPendingRequestCount', approved_pending_count,
    'declinedPendingRequestCount', declined_pending_count
  );
end
$$;

revoke all on function public.supervisor_correct_time_event_details(uuid, timestamptz, public.time_event_kind, boolean, text) from public, anon;
grant execute on function public.supervisor_correct_time_event_details(uuid, timestamptz, public.time_event_kind, boolean, text) to authenticated;

-- One-time cleanup for requests already left pending by the old workflow. Only
-- rows followed by a completed Operations maintenance correction are eligible.
with candidates as (
  select
    pending.id,
    approved.approved_by,
    approved.approved_at,
    (
      (pending.voided and approved.voided)
      or (
        not pending.voided
        and not approved.voided
        and (pending.replacement_time is null or pending.replacement_time is not distinct from approved.replacement_time)
        and (pending.replacement_kind is null or pending.replacement_kind is not distinct from approved.replacement_kind)
      )
    ) as request_satisfied
  from public.time_event_corrections pending
  join lateral (
    select correction.*
    from public.time_event_corrections correction
    where correction.time_event_id = pending.time_event_id
      and correction.approved_at is not null
      and correction.decision_note = 'Operations maintenance correction.'
      and correction.created_at >= pending.created_at
    order by correction.created_at desc, correction.id desc
    limit 1
  ) approved on true
  where pending.approved_at is null
    and pending.declined_at is null
)
update public.time_event_corrections pending
set
  approved_by = candidates.approved_by,
  approved_at = candidates.approved_at,
  decision_note = 'Approved during correction-workflow reconciliation because the authorized Operations correction applied the requested change.'
from candidates
where pending.id = candidates.id
  and candidates.request_satisfied;

with candidates as (
  select
    pending.id,
    approved.approved_by,
    approved.approved_at
  from public.time_event_corrections pending
  join lateral (
    select correction.*
    from public.time_event_corrections correction
    where correction.time_event_id = pending.time_event_id
      and correction.approved_at is not null
      and correction.decision_note = 'Operations maintenance correction.'
      and correction.created_at >= pending.created_at
    order by correction.created_at desc, correction.id desc
    limit 1
  ) approved on true
  where pending.approved_at is null
    and pending.declined_at is null
)
update public.time_event_corrections pending
set
  declined_by = candidates.approved_by,
  declined_at = candidates.approved_at,
  decision_note = 'Superseded by an authorized Operations maintenance correction before correction-workflow reconciliation.'
from candidates
where pending.id = candidates.id;

comment on function public.get_pending_time_event_corrections(date, date) is
  'Returns the pending employee punch-correction queue for Operations or the current employee, scoped to a requested operational date range.';

comment on function public.supervisor_correct_time_event_details(uuid, timestamptz, public.time_event_kind, boolean, text) is
  'Appends an authorized effective punch correction and atomically resolves older pending employee requests for the same source punch.';

commit;
