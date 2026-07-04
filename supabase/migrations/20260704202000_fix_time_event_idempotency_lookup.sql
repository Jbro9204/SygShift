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

  if target_kind is null then
    raise check_violation using message = 'A time event kind is required.';
  end if;

  clean_idempotency_key := coalesce(clean_idempotency_key, gen_random_uuid()::text);

  select *
  into existing_event
  from public.time_events event
  where event.idempotency_key = clean_idempotency_key;

  if found then
    if existing_event.employee_id <> actor_employee_id then
      raise unique_violation using message = 'This time event request was already used by another employee.';
    end if;

    return jsonb_build_object(
      'id', existing_event.id,
      'employeeId', existing_event.employee_id,
      'shiftId', existing_event.shift_id,
      'kind', existing_event.kind,
      'recordedAt', existing_event.recorded_at,
      'clientRecordedAt', existing_event.client_recorded_at,
      'source', existing_event.source
    );
  end if;

  select event.kind, event.shift_id
  into last_kind, last_shift_id
  from public.time_events event
  where event.employee_id = actor_employee_id
    and not exists (
      select 1
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
        and correction.voided
    )
  order by coalesce((
    select correction.replacement_time
    from public.time_event_corrections correction
    where correction.time_event_id = event.id
      and correction.approved_at is not null
      and correction.voided = false
      and correction.replacement_time is not null
    order by correction.approved_at desc
    limit 1
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
        and shift.starts_at <= server_now + interval '12 hours'
        and shift.ends_at >= server_now - interval '6 hours';

      if eligible_shift_count > 1 then
        raise check_violation using message = 'Multiple assigned shifts are available. Select the shift before clocking in.';
      end if;
    else
      if not exists (
        select 1
        from public.shift_assignments assignment
        join public.shifts shift on shift.id = assignment.shift_id
        join public.schedules schedule on schedule.id = shift.schedule_id
        where assignment.employee_id = actor_employee_id
          and assignment.shift_id = resolved_shift_id
          and assignment.status in ('assigned', 'confirmed')
          and schedule.status = 'published'
          and shift.starts_at <= server_now + interval '12 hours'
          and shift.ends_at >= server_now - interval '6 hours'
      ) then
        raise insufficient_privilege using message = 'You can only clock into an assigned shift inside the allowed punch window.';
      end if;
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

  if target_kind <> 'clock_in'
    and last_shift_id is not null
    and resolved_shift_id is distinct from last_shift_id
  then
    raise check_violation using message = 'The active time session must be completed before using another shift.';
  end if;

  insert into public.time_events (
    employee_id,
    shift_id,
    kind,
    recorded_at,
    client_recorded_at,
    source,
    idempotency_key,
    created_by
  ) values (
    actor_employee_id,
    resolved_shift_id,
    target_kind,
    server_now,
    target_client_recorded_at,
    'web',
    clean_idempotency_key,
    actor_employee_id
  )
  returning * into inserted_event;

  return jsonb_build_object(
    'id', inserted_event.id,
    'employeeId', inserted_event.employee_id,
    'shiftId', inserted_event.shift_id,
    'kind', inserted_event.kind,
    'recordedAt', inserted_event.recorded_at,
    'clientRecordedAt', inserted_event.client_recorded_at,
    'source', inserted_event.source
  );
end
$$;

revoke all on function public.record_time_event(public.time_event_kind, uuid, timestamptz, text) from public, anon;
grant execute on function public.record_time_event(public.time_event_kind, uuid, timestamptz, text) to authenticated;
