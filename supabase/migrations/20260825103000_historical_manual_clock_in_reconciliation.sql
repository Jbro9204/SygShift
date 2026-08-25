begin;

-- Historical supervisor-entered clock-ins are frequently entered from a
-- verified paper timecard after the scheduled shift has ended. Reconcile the
-- scheduled clock-out in the same transaction so the operator sees the full
-- pair immediately and cannot add a second clock-out while the cron job is
-- catching up. Source punches remain append-only and every automatic close is
-- still reviewable through the existing exception ledger.
create or replace function public.supervisor_record_time_event_with_location(
  target_employee_id uuid,
  target_kind public.time_event_kind,
  target_effective_at timestamptz,
  target_shift_id uuid,
  target_location_name text,
  target_time_zone text,
  target_reason text,
  target_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('time.manage');
  automatic_grace integer := private.timekeeping_setting_integer('timekeeping.automatic_clock_out_grace_minutes', 3);
  clean_location text := btrim(coalesce(target_location_name, ''));
  clean_time_zone text := coalesce(nullif(btrim(coalesce(target_time_zone, '')), ''), 'America/Denver');
  clean_reason text := btrim(coalesce(target_reason, ''));
  safe_key text := coalesce(nullif(btrim(coalesce(target_idempotency_key, '')), ''), gen_random_uuid()::text);
  target_employee public.employees%rowtype;
  target_shift public.shifts%rowtype;
  existing_event public.time_events%rowtype;
  inserted_event public.time_events%rowtype;
  automatic_event public.time_events%rowtype;
  automatic_exception public.timekeeping_operational_exceptions%rowtype;
  prior_clock_in_at timestamptz;
begin
  if target_employee_id is null or target_kind is null or target_effective_at is null then
    raise check_violation using message = 'Employee, punch type, and punch time are required.';
  end if;

  if clean_reason = '' then
    raise check_violation using message = 'A maintenance reason is required.';
  end if;

  if length(clean_reason) > 700 then
    raise check_violation using message = 'The maintenance reason must be 700 characters or less.';
  end if;

  if target_effective_at > clock_timestamp() + interval '15 minutes' then
    raise check_violation using message = 'Manual time events cannot be created in the future.';
  end if;

  if (target_shift_id is null and clean_location = '')
    or (target_shift_id is not null and clean_location <> '') then
    raise check_violation using message = 'Choose one Site/Post or enter one verified other location.';
  end if;

  if length(clean_location) > 180 then
    raise check_violation using message = 'The verified location must be 180 characters or less.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_timezone_names zone
    where zone.name = clean_time_zone
  ) then
    raise check_violation using message = 'The selected time zone is not valid.';
  end if;

  -- Serialize manual maintenance for one employee. This closes the gap between
  -- the duplicate check and insert even when two browser tabs submit together.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sygshift.supervisor-time-event:' || target_employee_id::text, 0)
  );

  select employee.* into target_employee
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status in ('active', 'leave');

  if target_employee.id is null then
    raise no_data_found using message = 'The selected employee is not active.';
  end if;

  if target_shift_id is not null then
    select shift.* into target_shift
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    where shift.id = target_shift_id
      and shift.canceled_at is null
      and schedule.status in ('draft', 'published');

    if target_shift.id is null then
      raise no_data_found using message = 'The selected Site/Post shift is no longer available.';
    end if;

    if target_effective_at < target_shift.starts_at - interval '4 hours'
      or target_effective_at > target_shift.ends_at + interval '4 hours' then
      raise check_violation using message = 'The selected Site/Post shift does not match this punch date and time. Choose the shift for the correct workday.';
    end if;

    -- Repeated clicks and stale maintenance views cannot create the same punch
    -- twice under a new request key.
    if exists (
      select 1
      from public.time_events event
      cross join lateral private.current_effective_time_event(event.id) effective
      where event.employee_id = target_employee_id
        and event.shift_id = target_shift_id
        and event.idempotency_key is distinct from safe_key
        and private.current_effective_time_event_kind(event.id) = target_kind
        and not effective.voided
        and abs(extract(epoch from (effective.effective_at - target_effective_at))) < 1
    ) then
      raise check_violation using message = 'That punch already exists for this employee and Site/Post. The time record has been refreshed; review the existing punch before adding another.';
    end if;

    -- A clock-out closes the most recent clock-in session for this occurrence.
    -- If that session is already closed (including by the automatic safeguard),
    -- the existing event must be corrected instead of duplicated.
    if target_kind = 'clock_out' then
      select effective.effective_at into prior_clock_in_at
      from public.time_events event
      cross join lateral private.current_effective_time_event(event.id) effective
      where event.employee_id = target_employee_id
        and event.shift_id = target_shift_id
        and private.current_effective_time_event_kind(event.id) = 'clock_in'
        and not effective.voided
        and effective.effective_at <= target_effective_at
        and effective.effective_at between target_shift.starts_at - interval '4 hours' and target_shift.ends_at + interval '4 hours'
      order by effective.effective_at desc, event.recorded_at desc, event.id desc
      limit 1;

      if prior_clock_in_at is not null and exists (
        select 1
        from public.time_events event
        cross join lateral private.current_effective_time_event(event.id) effective
        where event.employee_id = target_employee_id
          and event.shift_id = target_shift_id
          and event.idempotency_key is distinct from safe_key
          and private.current_effective_time_event_kind(event.id) = 'clock_out'
          and not effective.voided
          and effective.effective_at >= prior_clock_in_at
          and effective.effective_at <= target_shift.ends_at + interval '4 hours'
      ) then
        raise check_violation using message = 'This work session already has a clock-out. Review or correct the existing clock-out instead of adding a duplicate.';
      end if;
    end if;
  end if;

  select event.* into existing_event
  from public.time_events event
  where event.idempotency_key = safe_key;

  if existing_event.id is not null then
    inserted_event := existing_event;
  else
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
    values (
      target_employee_id,
      target_shift_id,
      target_kind,
      target_effective_at,
      null,
      'supervisor',
      safe_key,
      actor_id
    )
    returning * into inserted_event;

    insert into public.time_event_maintenance_notes (
      time_event_id,
      action,
      note,
      created_by
    )
    values (
      inserted_event.id,
      'manual_add',
      clean_reason,
      actor_id
    );

    if target_shift_id is null then
      insert into public.time_event_location_overrides (
        time_event_id,
        location_name,
        time_zone,
        reason,
        created_by
      )
      values (
        inserted_event.id,
        clean_location,
        clean_time_zone,
        clean_reason,
        actor_id
      );
    end if;
  end if;

  -- When a verified historical clock-in belongs to a shift that has already
  -- ended, close it at the scheduled end immediately. A legitimate break or
  -- other event during the shift does not close the work session, so only an
  -- existing clock-out suppresses this reconciliation.
  if target_kind = 'clock_in'
    and target_shift_id is not null
    and target_effective_at <= target_shift.ends_at
    and target_shift.ends_at + make_interval(mins => automatic_grace) <= clock_timestamp()
    and not exists (
      select 1
      from public.time_events later_event
      cross join lateral private.current_effective_time_event(later_event.id) effective
      where later_event.employee_id = target_employee_id
        and later_event.shift_id = target_shift_id
        and later_event.id <> inserted_event.id
        and private.current_effective_time_event_kind(later_event.id) = 'clock_out'
        and not effective.voided
        and effective.effective_at > target_effective_at
        and effective.effective_at <= target_shift.ends_at + interval '4 hours'
    ) then
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
    values (
      target_employee_id,
      target_shift_id,
      'clock_out',
      target_shift.ends_at,
      null,
      'system',
      concat('automatic-clock-out:supervisor:', target_employee_id, ':', target_shift_id, ':', extract(epoch from target_shift.ends_at)::bigint),
      null
    )
    on conflict (idempotency_key) do nothing
    returning * into automatic_event;

    if automatic_event.id is not null then
      insert into public.time_event_maintenance_notes (time_event_id, action, note, created_by)
      values (
        automatic_event.id,
        'automatic_clock_out',
        'Automatically clocked out at the scheduled shift end after an authorized historical clock-in was recorded.',
        null
      );

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
      values (
        target_employee_id,
        target_shift_id,
        'automatic_clock_out',
        'unresolved',
        'warning',
        target_shift.starts_at,
        target_shift.ends_at,
        automatic_event.id,
        null
      )
      on conflict (employee_id, shift_id, exception_code) do nothing
      returning * into automatic_exception;

      if automatic_exception.id is not null then
        insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
        values (
          automatic_exception.id,
          'created',
          'The historical clock-in reconciliation created an automatic clock-out review item.',
          actor_id,
          to_jsonb(automatic_exception)
        );

        insert into private.notification_outbox (
          message_type,
          aggregate_type,
          aggregate_id,
          recipient_employee_id,
          payload,
          idempotency_key
        )
        values (
          'automatic_clock_out_employee',
          'timekeeping_operational_exception',
          automatic_exception.id,
          automatic_exception.employee_id,
          jsonb_build_object('scheduledEndAt', automatic_exception.scheduled_end_at, 'shiftId', automatic_exception.shift_id),
          concat('automatic-clock-out-employee:', automatic_exception.id)
        )
        on conflict (idempotency_key) do nothing;
      end if;
    end if;
  end if;

  -- Return an already-existing automatic close as well as one created by this
  -- call. The UI can therefore explain the result after retries/idempotent calls.
  if target_kind = 'clock_in' and target_shift_id is not null and automatic_event.id is null then
    select event.* into automatic_event
    from public.time_events event
    cross join lateral private.current_effective_time_event(event.id) effective
    join public.time_event_maintenance_notes note
      on note.time_event_id = event.id
     and note.action = 'automatic_clock_out'
    where event.employee_id = target_employee_id
      and event.shift_id = target_shift_id
      and private.current_effective_time_event_kind(event.id) = 'clock_out'
      and not effective.voided
      and effective.effective_at >= target_effective_at
      and effective.effective_at <= target_shift.ends_at + interval '4 hours'
    order by effective.effective_at desc, event.recorded_at desc, event.id desc
    limit 1;
  end if;

  return jsonb_build_object(
    'id', inserted_event.id,
    'employeeId', inserted_event.employee_id,
    'shiftId', inserted_event.shift_id,
    'kind', inserted_event.kind,
    'recordedAt', inserted_event.recorded_at,
    'effectiveAt', inserted_event.recorded_at,
    'clientRecordedAt', inserted_event.client_recorded_at,
    'source', inserted_event.source,
    'voided', false,
    'automaticClockOutEventId', automatic_event.id,
    'automaticClockOutAt', automatic_event.recorded_at
  );
end
$$;

revoke all on function public.supervisor_record_time_event_with_location(
  uuid,
  public.time_event_kind,
  timestamptz,
  uuid,
  text,
  text,
  text,
  text
) from public, anon;

grant execute on function public.supervisor_record_time_event_with_location(
  uuid,
  public.time_event_kind,
  timestamptz,
  uuid,
  text,
  text,
  text,
  text
) to authenticated;

commit;
