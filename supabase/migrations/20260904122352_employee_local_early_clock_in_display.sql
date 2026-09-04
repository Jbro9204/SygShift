begin;

-- Preserve trusted-server enforcement while returning the employee's configured
-- time zone so every clock-in surface can present the same instant locally.
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
  employee_time_zone text;
  server_now timestamptz := clock_timestamp();
  resolved_shift_id uuid := target_shift_id;
  clean_idempotency_key text := nullif(btrim(coalesce(target_idempotency_key, '')), '');
  existing_event public.time_events%rowtype;
  last_kind public.time_event_kind;
  last_shift_id uuid;
  eligible_shift_count integer;
  selected_shift record;
  clock_in_eligible_at timestamptz;
  inserted_event public.time_events%rowtype;
begin
  if actor_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required to record time.';
  end if;

  select employee.time_zone
    into employee_time_zone
  from public.employees employee
  where employee.id = actor_employee_id;

  employee_time_zone := coalesce(employee_time_zone, 'America/Denver');

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
    end if;

    select
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.requires_armed,
      post.name as post_name,
      site.name as site_name,
      site.code as site_code,
      schedule_event.name as event_name,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Assigned shift') as location_name
    into selected_shift
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    where assignment.employee_id = actor_employee_id
      and assignment.shift_id = resolved_shift_id
      and assignment.status in ('assigned', 'confirmed')
      and schedule.status = 'published'
      and shift.canceled_at is null
    order by case assignment.status when 'confirmed' then 0 else 1 end, assignment.assigned_at, assignment.id
    limit 1;

    if not found then
      raise check_violation using message = 'The selected shift is not an active published assignment for this employee.';
    end if;

    clock_in_eligible_at := selected_shift.starts_at - interval '5 minutes';

    if server_now < clock_in_eligible_at then
      if not exists (
        select 1
        from private.audit_events audit
        where audit.employee_id = actor_employee_id
          and audit.operation = 'EARLY_CLOCK_IN_BLOCKED'
          and audit.row_id = resolved_shift_id::text
          and audit.occurred_at >= server_now - interval '30 seconds'
      ) then
        insert into private.audit_events (
          auth_user_id,
          employee_id,
          request_id,
          schema_name,
          table_name,
          operation,
          row_id,
          new_record
        ) values (
          (select auth.uid()),
          actor_employee_id,
          clean_idempotency_key,
          'public',
          'time_events',
          'EARLY_CLOCK_IN_BLOCKED',
          resolved_shift_id::text,
          jsonb_build_object(
            'attemptedAt', server_now,
            'scheduledStart', selected_shift.starts_at,
            'clockInEligibleAt', clock_in_eligible_at,
            'secondsEarly', floor(extract(epoch from (clock_in_eligible_at - server_now)))::integer,
            'sourceSurface', 'employee_self_service',
            'employeeTimeZone', employee_time_zone,
            'shiftTimeZone', selected_shift.time_zone,
            'result', 'blocked'
          )
        );
      end if;

      return jsonb_build_object(
        'status', 'blocked',
        'code', 'EARLY_CLOCK_IN_BLOCKED',
        'trustedServerTime', server_now,
        'scheduledShiftStart', selected_shift.starts_at,
        'scheduledShiftEnd', selected_shift.ends_at,
        'clockInEligibleAt', clock_in_eligible_at,
        'shiftDate', (selected_shift.starts_at at time zone employee_time_zone)::date,
        'shiftDisplayName', coalesce(selected_shift.post_name, selected_shift.event_name, selected_shift.location_name, 'Assigned shift'),
        'siteCode', selected_shift.site_code,
        'siteName', selected_shift.site_name,
        'postName', selected_shift.post_name,
        'locationName', selected_shift.location_name,
        'coverageType', case when selected_shift.requires_armed then 'Armed coverage' else 'Unarmed coverage' end,
        'timeZone', selected_shift.time_zone,
        'employeeTimeZone', employee_time_zone,
        'clockInWindowMinutes', 5
      );
    end if;

    if selected_shift.ends_at < server_now then
      raise check_violation using message = 'Clock-in is no longer available because the assigned shift has ended.';
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

comment on function public.record_time_event(public.time_event_kind, uuid, timestamptz, text) is
  'Records authorized employee time using trusted server time; early attempts return employee-local display context without creating payable time.';

notify pgrst, 'reload schema';

commit;
