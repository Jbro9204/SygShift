begin;

-- Employee self-service clock-ins open five minutes before the published shift.
-- Supervisors retain their separate audited manual-entry workflow for approved
-- early work; this function intentionally cannot be used to bypass that rule.
create or replace function public.record_time_event(
  target_kind public.time_event_kind,
  target_shift_id uuid default null,
  target_client_recorded_at timestamptz default null,
  target_idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_employee_id uuid := private.current_employee_id();
  server_now timestamptz := clock_timestamp();
  resolved_shift_id uuid := target_shift_id;
  clean_idempotency_key text := nullif(btrim(coalesce(target_idempotency_key, '')), '');
  existing_event public.time_events%rowtype;
  last_kind public.time_event_kind;
  last_shift_id uuid;
  eligible_shift_count integer;
  inserted_event public.time_events%rowtype;
begin
  if actor_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required to record time.';
  end if;

  if not (public.has_effective_permission('time.punch') or public.has_effective_permission('time.manage')) then
    raise insufficient_privilege using message = 'Time clock permission is required to record time.';
  end if;

  if target_kind is null then
    raise check_violation using message = 'A time event kind is required.';
  end if;

  clean_idempotency_key := coalesce(clean_idempotency_key, gen_random_uuid()::text);
  perform pg_advisory_xact_lock(hashtextextended(actor_employee_id::text, 0));

  select * into existing_event
  from public.time_events event
  where event.idempotency_key = clean_idempotency_key;

  if found then
    if existing_event.employee_id <> actor_employee_id then
      raise unique_violation using message = 'This time event request was already used by another employee.';
    end if;
    return jsonb_build_object(
      'id', existing_event.id, 'employeeId', existing_event.employee_id,
      'shiftId', existing_event.shift_id, 'kind', existing_event.kind,
      'recordedAt', existing_event.recorded_at, 'effectiveAt', existing_event.recorded_at,
      'clientRecordedAt', existing_event.client_recorded_at,
      'source', existing_event.source, 'voided', false
    );
  end if;

  select event.kind, event.shift_id into last_kind, last_shift_id
  from public.time_events event
  where event.employee_id = actor_employee_id
    and not exists (
      select 1 from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null and correction.voided
    )
  order by coalesce((
    select correction.replacement_time
    from public.time_event_corrections correction
    where correction.time_event_id = event.id
      and correction.approved_at is not null
      and correction.voided = false
      and correction.replacement_time is not null
    order by correction.approved_at desc limit 1
  ), event.recorded_at) desc, event.created_at desc
  limit 1;

  if target_kind = 'clock_in' then
    if last_kind in ('clock_in', 'break_start', 'break_end') then
      raise check_violation using message = 'Clock out before starting another time session.';
    end if;

    if resolved_shift_id is null then
      select count(*)::integer, min(shift.id::text)::uuid
      into eligible_shift_count, resolved_shift_id
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      join public.schedules schedule on schedule.id = shift.schedule_id
      where assignment.employee_id = actor_employee_id
        and assignment.status in ('assigned', 'confirmed')
        and schedule.status = 'published'
        and shift.canceled_at is null
        and shift.starts_at <= server_now + interval '5 minutes'
        and shift.ends_at >= server_now;

      if eligible_shift_count = 0 then
        raise check_violation using message = 'Clock-in opens five minutes before your scheduled shift. Open your schedule to see the start time.';
      elsif eligible_shift_count > 1 then
        raise check_violation using message = 'Multiple assigned shifts are available. Select the shift before clocking in.';
      end if;
    elsif not exists (
      select 1
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      join public.schedules schedule on schedule.id = shift.schedule_id
      where assignment.employee_id = actor_employee_id
        and assignment.shift_id = resolved_shift_id
        and assignment.status in ('assigned', 'confirmed')
        and schedule.status = 'published'
        and shift.canceled_at is null
        and shift.starts_at <= server_now + interval '5 minutes'
        and shift.ends_at >= server_now
    ) then
      raise check_violation using message = 'Clock-in opens five minutes before your assigned shift and closes when the shift ends.';
    end if;
  elsif target_kind = 'break_start' then
    if last_kind not in ('clock_in', 'break_end') then
      raise check_violation using message = 'A break can only start after clocking in.';
    end if;
    resolved_shift_id := coalesce(resolved_shift_id, last_shift_id);
  elsif target_kind = 'break_end' then
    if last_kind <> 'break_start' then
      raise check_violation using message = 'A break can only end after a break has started.';
    end if;
    resolved_shift_id := coalesce(resolved_shift_id, last_shift_id);
  elsif target_kind = 'clock_out' then
    if last_kind not in ('clock_in', 'break_end') then
      raise check_violation using message = 'Clock out is only available after active work time.';
    end if;
    resolved_shift_id := coalesce(resolved_shift_id, last_shift_id);
  else
    raise check_violation using message = 'Unsupported time event kind.';
  end if;

  if target_kind <> 'clock_in' and last_shift_id is not null and resolved_shift_id is distinct from last_shift_id then
    raise check_violation using message = 'The active time session must be completed before using another shift.';
  end if;

  insert into public.time_events (
    employee_id, shift_id, kind, recorded_at, client_recorded_at,
    source, idempotency_key, created_by
  ) values (
    actor_employee_id, resolved_shift_id, target_kind, server_now,
    target_client_recorded_at, 'web', clean_idempotency_key, actor_employee_id
  ) returning * into inserted_event;

  return jsonb_build_object(
    'id', inserted_event.id, 'employeeId', inserted_event.employee_id,
    'shiftId', inserted_event.shift_id, 'kind', inserted_event.kind,
    'recordedAt', inserted_event.recorded_at, 'effectiveAt', inserted_event.recorded_at,
    'clientRecordedAt', inserted_event.client_recorded_at,
    'source', inserted_event.source, 'voided', false
  );
end
$$;

revoke all on function public.record_time_event(public.time_event_kind, uuid, timestamptz, text) from public, anon;
grant execute on function public.record_time_event(public.time_event_kind, uuid, timestamptz, text) to authenticated;

-- Routine system clock-outs are authoritative completed punches, not work for
-- the review queue. Preserve their exception row as resolved audit history and
-- keep the employee notification produced by the automation job.
create or replace function private.resolve_routine_automatic_clock_out()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.exception_code <> 'automatic_clock_out' or new.status <> 'unresolved' then
    return new;
  end if;

  update public.timekeeping_operational_exceptions exception
  set status = 'resolved',
      resolution_method = 'automatic_policy',
      resolution_note = 'Routine automatic clock-out recorded at the scheduled shift end; no review is required.',
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where exception.id = new.id;

  insert into public.timekeeping_operational_exception_actions (
    exception_id, action, reason, actor_id, snapshot
  )
  select exception.id, 'resolved_adjustment', exception.resolution_note, null, to_jsonb(exception)
  from public.timekeeping_operational_exceptions exception
  where exception.id = new.id;

  return new;
end
$$;

drop trigger if exists timekeeping_resolve_routine_auto_clock_out on public.timekeeping_operational_exceptions;
create trigger timekeeping_resolve_routine_auto_clock_out
after insert on public.timekeeping_operational_exceptions
for each row execute function private.resolve_routine_automatic_clock_out();

create or replace function private.clear_routine_automatic_clock_out_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.alert_type = 'automatic_clock_out' then
    update public.operational_alerts alert
    set active = false, cleared_at = clock_timestamp()
    where alert.id = new.id;
  end if;
  return new;
end
$$;

drop trigger if exists operational_alert_clear_routine_auto_clock_out on public.operational_alerts;
create trigger operational_alert_clear_routine_auto_clock_out
after insert on public.operational_alerts
for each row execute function private.clear_routine_automatic_clock_out_alert();

with resolved as (
  update public.timekeeping_operational_exceptions exception
  set status = 'resolved',
      resolution_method = 'automatic_policy',
      resolution_note = 'Routine automatic clock-out recorded at the scheduled shift end; no review is required.',
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where exception.exception_code = 'automatic_clock_out'
    and exception.status = 'unresolved'
  returning exception.*
)
insert into public.timekeeping_operational_exception_actions (
  exception_id, action, reason, actor_id, snapshot
)
select resolved.id, 'resolved_adjustment', resolved.resolution_note, null, to_jsonb(resolved)
from resolved
where not exists (
  select 1 from public.timekeeping_operational_exception_actions action
  where action.exception_id = resolved.id and action.action = 'resolved_adjustment'
);

update public.operational_alerts alert
set active = false, cleared_at = coalesce(alert.cleared_at, clock_timestamp())
where alert.alert_type = 'automatic_clock_out' and alert.active;

revoke all on function private.resolve_routine_automatic_clock_out() from public, anon, authenticated;
revoke all on function private.clear_routine_automatic_clock_out_alert() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
