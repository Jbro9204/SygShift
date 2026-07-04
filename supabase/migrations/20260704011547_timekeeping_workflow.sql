begin;

create index if not exists time_event_corrections_event_idx
  on public.time_event_corrections (time_event_id, approved_at);

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'time_events_audit'
  ) then
    execute 'create trigger time_events_audit after insert on public.time_events for each row execute function private.write_audit_event()';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgname = 'time_event_corrections_audit'
  ) then
    execute 'create trigger time_event_corrections_audit after insert on public.time_event_corrections for each row execute function private.write_audit_event()';
  end if;
end
$$;

create or replace function public.get_timekeeping_dashboard(target_operational_date date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  target_date date := coalesce(target_operational_date, (clock_timestamp() at time zone 'America/Denver')::date);
  server_now timestamptz := clock_timestamp();
  employee_record record;
  last_event jsonb;
  eligible_shifts jsonb;
  recent_events jsonb;
  pending_correction_count integer;
begin
  if viewer_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required for timekeeping.';
  end if;

  select
    employee.id,
    employee.username,
    employee.first_name,
    employee.last_name,
    employee.preferred_name,
    employee.role,
    employee.employment_type
  into employee_record
  from public.employees employee
  where employee.id = viewer_employee_id;

  select jsonb_build_object(
    'id', event.id,
    'kind', event.kind,
    'shiftId', event.shift_id,
    'recordedAt', event.recorded_at,
    'effectiveAt', coalesce((
      select correction.replacement_time
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
        and correction.voided = false
        and correction.replacement_time is not null
      order by correction.approved_at desc
      limit 1
    ), event.recorded_at),
    'source', event.source
  )
  into last_event
  from public.time_events event
  where event.employee_id = viewer_employee_id
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'assignmentId', assignment.id,
    'shiftId', shift.id,
    'status', assignment.status,
    'startsAt', shift.starts_at,
    'endsAt', shift.ends_at,
    'timeZone', shift.time_zone,
    'requiresArmed', shift.requires_armed,
    'isOvertime', shift.is_overtime,
    'postName', post.name,
    'siteName', site.name,
    'siteCode', site.code,
    'eventName', event.name,
    'locationName', coalesce(event.location_name, site.name, post.name, event.name)
  ) order by shift.starts_at), '[]'::jsonb)
  into eligible_shifts
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  where assignment.employee_id = viewer_employee_id
    and assignment.status in ('assigned', 'confirmed')
    and (shift.starts_at at time zone shift.time_zone)::date = target_date;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', event.id,
    'kind', event.kind,
    'shiftId', event.shift_id,
    'recordedAt', event.recorded_at,
    'effectiveAt', coalesce((
      select correction.replacement_time
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
        and correction.voided = false
        and correction.replacement_time is not null
      order by correction.approved_at desc
      limit 1
    ), event.recorded_at),
    'clientRecordedAt', event.client_recorded_at,
    'source', event.source,
    'voided', exists (
      select 1
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
        and correction.voided
    )
  ) order by event.recorded_at desc), '[]'::jsonb)
  into recent_events
  from public.time_events event
  where event.employee_id = viewer_employee_id
    and (event.recorded_at at time zone 'America/Denver')::date = target_date;

  select count(*)::integer
  into pending_correction_count
  from public.time_event_corrections correction
  join public.time_events event on event.id = correction.time_event_id
  where event.employee_id = viewer_employee_id
    and correction.approved_at is null;

  return jsonb_build_object(
    'serverTimestamp', server_now,
    'operationalDate', target_date,
    'operationalTimeZone', 'America/Denver',
    'employee', jsonb_build_object(
      'id', employee_record.id,
      'username', employee_record.username,
      'displayName', btrim(coalesce(employee_record.preferred_name, employee_record.first_name) || ' ' || employee_record.last_name),
      'role', employee_record.role,
      'employmentType', employee_record.employment_type
    ),
    'lastEvent', last_event,
    'eligibleShifts', eligible_shifts,
    'recentEvents', recent_events,
    'pendingCorrectionCount', pending_correction_count
  );
end
$$;

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
  idempotency_key text := nullif(btrim(coalesce(target_idempotency_key, '')), '');
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

  idempotency_key := coalesce(idempotency_key, gen_random_uuid()::text);

  select *
  into existing_event
  from public.time_events event
  where event.idempotency_key = idempotency_key;

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
      where assignment.employee_id = actor_employee_id
        and assignment.status in ('assigned', 'confirmed')
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
        where assignment.employee_id = actor_employee_id
          and assignment.shift_id = resolved_shift_id
          and assignment.status in ('assigned', 'confirmed')
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
    idempotency_key,
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

create or replace function public.request_time_event_correction(
  target_time_event_id uuid,
  target_replacement_time timestamptz default null,
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
  requester_employee_id uuid := private.current_employee_id();
  target_event public.time_events%rowtype;
  can_auto_approve boolean;
  inserted_correction public.time_event_corrections%rowtype;
begin
  if requester_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required to request a time correction.';
  end if;

  if btrim(coalesce(target_reason, '')) = '' then
    raise check_violation using message = 'A correction reason is required.';
  end if;

  if not coalesce(target_voided, false) and target_replacement_time is null then
    raise check_violation using message = 'Provide a replacement time or mark the punch void.';
  end if;

  select *
  into target_event
  from public.time_events event
  where event.id = target_time_event_id;

  if not found then
    raise no_data_found using message = 'The requested time event does not exist.';
  end if;

  can_auto_approve := public.is_supervisor_or_admin() and public.has_mfa();

  if target_event.employee_id <> requester_employee_id and not can_auto_approve then
    raise insufficient_privilege using message = 'Only supervisors with MFA can correct another employee time event.';
  end if;

  insert into public.time_event_corrections (
    time_event_id,
    replacement_time,
    voided,
    reason,
    requested_by,
    approved_by,
    approved_at
  ) values (
    target_time_event_id,
    target_replacement_time,
    coalesce(target_voided, false),
    btrim(target_reason),
    requester_employee_id,
    case when can_auto_approve then requester_employee_id else null end,
    case when can_auto_approve then clock_timestamp() else null end
  )
  returning * into inserted_correction;

  return jsonb_build_object(
    'id', inserted_correction.id,
    'timeEventId', inserted_correction.time_event_id,
    'replacementTime', inserted_correction.replacement_time,
    'voided', inserted_correction.voided,
    'requestedBy', inserted_correction.requested_by,
    'approvedBy', inserted_correction.approved_by,
    'approvedAt', inserted_correction.approved_at
  );
end
$$;

revoke all on function public.get_timekeeping_dashboard(date) from public, anon;
revoke all on function public.record_time_event(public.time_event_kind, uuid, timestamptz, text) from public, anon;
revoke all on function public.request_time_event_correction(uuid, timestamptz, boolean, text) from public, anon;

grant execute on function public.get_timekeeping_dashboard(date) to authenticated;
grant execute on function public.record_time_event(public.time_event_kind, uuid, timestamptz, text) to authenticated;
grant execute on function public.request_time_event_correction(uuid, timestamptz, boolean, text) to authenticated;

commit;
