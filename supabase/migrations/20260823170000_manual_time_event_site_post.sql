begin;

-- A supervisor-entered punch must be complete when it is created. This
-- transaction records the punch and either its scheduled Site/Post or its
-- verified manual location together, preserving one audit trail and avoiding
-- a second repair step.
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
  clean_location text := btrim(coalesce(target_location_name, ''));
  clean_time_zone text := coalesce(nullif(btrim(coalesce(target_time_zone, '')), ''), 'America/Denver');
  clean_reason text := btrim(coalesce(target_reason, ''));
  safe_key text := coalesce(nullif(btrim(coalesce(target_idempotency_key, '')), ''), gen_random_uuid()::text);
  target_employee public.employees%rowtype;
  target_shift public.shifts%rowtype;
  existing_event public.time_events%rowtype;
  inserted_event public.time_events%rowtype;
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

  return jsonb_build_object(
    'id', inserted_event.id,
    'employeeId', inserted_event.employee_id,
    'shiftId', inserted_event.shift_id,
    'kind', inserted_event.kind,
    'recordedAt', inserted_event.recorded_at,
    'effectiveAt', inserted_event.recorded_at,
    'clientRecordedAt', inserted_event.client_recorded_at,
    'source', inserted_event.source,
    'voided', false
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
