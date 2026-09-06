begin;

-- PL/pgSQL row variables must receive the expanded composite. The original
-- release was valid DDL, but database lint correctly identified that selecting
-- the table alias itself would fail when these two runtime paths were invoked.
create or replace function public.get_scheduled_overtime_update_preview_v2(
  target_shift_id uuid,
  target_employee_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_dispatch_mode text default 'primary_shift'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  target_shift public.shifts%rowtype;
  dispatch_location boolean := false;
  proposed_starts_at timestamptz;
  proposed_ends_at timestamptz;
  proposed_minutes integer := 0;
  current_minutes integer := 0;
  resulting_minutes integer := 0;
  changing_mode boolean := false;
begin
  if private.current_employee_id() is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to calculate scheduled overtime.';
  end if;

  if target_dispatch_mode not in ('primary_shift', 'concurrent_duty') then
    raise check_violation using message = 'Choose whether Dispatch coverage is a primary paid shift or concurrent phone duty.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null;

  if target_shift.id is null then
    raise check_violation using message = 'The selected shift could not be found.';
  end if;

  select coalesce(site.supports_dispatch_phone_duty, false) into dispatch_location
  from public.posts post
  join public.sites site on site.id = post.site_id
  where post.id = target_shift.post_id;
  if target_dispatch_mode = 'concurrent_duty' and not dispatch_location then
    raise check_violation using message = 'Concurrent phone duty can only be used with the Dispatch coverage location.';
  end if;

  result := private.scheduled_overtime_update_preview(
    target_shift_id, target_employee_id, shift_operational_date, shift_start_time, shift_end_time
  );

  if not dispatch_location or target_dispatch_mode = 'primary_shift' then
    proposed_starts_at := (shift_operational_date + shift_start_time) at time zone target_shift.time_zone;
    proposed_ends_at := ((case when shift_end_time <= shift_start_time then shift_operational_date + 1 else shift_operational_date end) + shift_end_time) at time zone target_shift.time_zone;
    proposed_minutes := greatest(0, round(extract(epoch from (proposed_ends_at - proposed_starts_at)) / 60.0)::integer);
  end if;

  changing_mode := dispatch_location and (
    (target_shift.assignment_type = 'dispatch_phone_duty') is distinct from (target_dispatch_mode = 'concurrent_duty')
  );
  current_minutes := coalesce((result ->> 'currentMinutes')::integer, 0);
  resulting_minutes := current_minutes + proposed_minutes;

  return result || jsonb_build_object(
    'proposedMinutes', proposed_minutes,
    'resultingMinutes', resulting_minutes,
    'overtimeMinutes', greatest(0, resulting_minutes - 2400),
    'requiresOverride', resulting_minutes > 2400 and (changing_mode or not coalesce((result ->> 'approvalCarriedForward')::boolean, false)),
    'approvalCarriedForward', not changing_mode and coalesce((result ->> 'approvalCarriedForward')::boolean, false),
    'concurrentDispatchDuty', dispatch_location and target_dispatch_mode = 'concurrent_duty'
  );
end
$$;

create or replace function public.scheduler_update_typed_draft_shift_v3(
  target_shift_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_open boolean,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null,
  target_overtime_override_note text default null,
  target_dispatch_mode text default 'primary_shift'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  dispatch_location boolean := false;
  old_assignment_type text;
  new_assignment_type text := 'standard';
  result jsonb;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to edit a draft shift.';
  end if;
  if target_dispatch_mode not in ('primary_shift', 'concurrent_duty') then
    raise check_violation using message = 'Choose whether Dispatch coverage is a primary paid shift or concurrent phone duty.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null
  for update;

  if target_shift.id is not null then
    select schedule.* into target_schedule
    from public.schedules schedule
    where schedule.id = target_shift.schedule_id;
  end if;

  if target_shift.id is null or target_schedule.status <> 'draft' then
    raise check_violation using message = 'Only a shift in the working schedule draft can be edited.';
  end if;

  select coalesce(site.supports_dispatch_phone_duty, false) into dispatch_location
  from public.posts post join public.sites site on site.id = post.site_id
  where post.id = target_shift.post_id;

  if target_dispatch_mode = 'concurrent_duty' and not dispatch_location then
    raise check_violation using message = 'Concurrent phone duty can only be used with the Dispatch coverage location.';
  end if;
  if dispatch_location and target_dispatch_mode = 'concurrent_duty' then
    new_assignment_type := 'dispatch_phone_duty';
  end if;

  old_assignment_type := target_shift.assignment_type;
  update public.shifts shift
  set assignment_type = new_assignment_type, updated_at = clock_timestamp()
  where shift.id = target_shift_id;

  result := public.scheduler_update_typed_draft_shift_v2(
    target_shift_id, shift_operational_date, shift_start_time, shift_end_time,
    target_headcount, target_is_open, target_is_overtime, target_notes,
    target_work_type, target_employee_id, target_availability_override_note,
    target_credential_override_note, target_overtime_override_note
  );

  if old_assignment_type is distinct from new_assignment_type then
    insert into private.audit_events (
      auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
    ) values (
      auth.uid(), actor_id, 'public', 'shifts', 'CHANGE_DISPATCH_COVERAGE_MODE', target_shift_id::text,
      jsonb_build_object('assignmentType', old_assignment_type),
      jsonb_build_object('assignmentType', new_assignment_type, 'dispatchMode', target_dispatch_mode)
    );
  end if;

  return result;
end
$$;

revoke all on function public.get_scheduled_overtime_update_preview_v2(uuid, uuid, date, time, time, text) from public, anon;
revoke all on function public.scheduler_update_typed_draft_shift_v3(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text, text) from public, anon;
grant execute on function public.get_scheduled_overtime_update_preview_v2(uuid, uuid, date, time, time, text) to authenticated;
grant execute on function public.scheduler_update_typed_draft_shift_v3(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
