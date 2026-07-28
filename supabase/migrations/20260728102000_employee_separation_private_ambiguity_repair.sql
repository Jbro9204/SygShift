begin;

create or replace function private.separate_employee_account_and_future_work(
  target_employee_id uuid,
  actor_id uuid,
  separation_reason text default null,
  separated_on date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  account_record private.employee_accounts%rowtype;
  clean_reason text := nullif(btrim(coalesce(separation_reason, '')), '');
  disabled_time timestamptz := clock_timestamp();
  released_count integer := 0;
  request_count integer := 0;
begin
  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if employee_record.id is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  select * into account_record
  from private.employee_accounts account
  where account.employee_id = target_employee_id
  for update;

  if employee_record.role = 'admin'
    and employee_record.status = 'active'
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one active admin account must remain.';
  end if;

  update public.employees employee
  set
    status = 'separated',
    separated_on = coalesce($4, (disabled_time at time zone 'America/Denver')::date),
    updated_at = disabled_time
  where employee.id = target_employee_id;

  update private.employee_accounts account
  set
    disabled_at = coalesce(account.disabled_at, disabled_time),
    disabled_by = actor_id,
    disabled_reason = coalesce(clean_reason, 'Employee separated in SygShift.'),
    updated_at = disabled_time
  where account.employee_id = target_employee_id;

  update private.trusted_devices trusted_device
  set
    revoked_at = disabled_time,
    revoked_by = actor_id
  where trusted_device.employee_id = target_employee_id
    and trusted_device.revoked_at is null;

  update public.shift_assignments assignment
  set
    status = 'canceled',
    canceled_at = disabled_time,
    cancellation_reason = coalesce(clean_reason, 'Employee separated from SygShift.'),
    updated_at = disabled_time
  from public.shifts shift
  where assignment.shift_id = shift.id
    and assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed')
    and shift.canceled_at is null
    and (shift.starts_at at time zone shift.time_zone)::date >= (disabled_time at time zone 'America/Denver')::date;

  get diagnostics released_count = row_count;

  update public.shifts shift
  set
    is_open = true,
    updated_at = disabled_time
  where shift.canceled_at is null
    and (shift.starts_at at time zone shift.time_zone)::date >= (disabled_time at time zone 'America/Denver')::date
    and exists (
      select 1
      from public.shift_assignments assignment
      where assignment.shift_id = shift.id
        and assignment.employee_id = target_employee_id
        and assignment.canceled_at = disabled_time
    )
    and (
      select count(*)
      from public.shift_assignments active_assignment
      where active_assignment.shift_id = shift.id
        and active_assignment.status in ('assigned', 'confirmed', 'completed')
    ) < shift.headcount_required;

  update public.shift_requests request
  set
    status = 'canceled',
    decision_note = coalesce(clean_reason, 'Employee separated from SygShift.'),
    decided_by = actor_id,
    decided_at = disabled_time,
    updated_at = disabled_time
  from public.shifts shift
  where request.shift_id = shift.id
    and request.employee_id = target_employee_id
    and request.status = 'pending'
    and (shift.starts_at at time zone shift.time_zone)::date >= (disabled_time at time zone 'America/Denver')::date;

  get diagnostics request_count = row_count;

  insert into private.employee_separation_events (
    employee_id,
    separated_by,
    separated_at,
    access_disabled_at,
    reason,
    previous_status,
    previous_account_disabled_at,
    future_assignments_released,
    pending_shift_requests_canceled
  ) values (
    target_employee_id,
    actor_id,
    disabled_time,
    disabled_time,
    clean_reason,
    employee_record.status,
    account_record.disabled_at,
    released_count,
    request_count
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
    (select auth.uid()),
    actor_id,
    'public',
    'employees',
    'SEPARATE_EMPLOYEE',
    target_employee_id::text,
    to_jsonb(employee_record),
    jsonb_build_object(
      'employeeId', target_employee_id,
      'status', 'separated',
      'separatedAt', disabled_time,
      'accessDisabledAt', disabled_time,
      'futureAssignmentsReleased', released_count,
      'pendingShiftRequestsCanceled', request_count,
      'reason', clean_reason
    )
  );

  return jsonb_build_object(
    'employeeId', target_employee_id,
    'accessDisabledAt', disabled_time,
    'futureAssignmentsReleased', released_count,
    'pendingShiftRequestsCanceled', request_count
  );
end
$$;

revoke all on function private.separate_employee_account_and_future_work(uuid, uuid, text, date) from public, anon, authenticated;

commit;
