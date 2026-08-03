begin;

create table if not exists private.removed_employee_records (
  employee_id uuid primary key references public.employees(id) on delete restrict,
  removed_by uuid references public.employees(id) on delete set null,
  removed_at timestamptz not null default clock_timestamp(),
  reason text not null,
  snapshot jsonb not null default '{}'::jsonb,
  constraint removed_employee_records_reason_present check (btrim(reason) <> '')
);

comment on table private.removed_employee_records is
  'Administrative tombstones that remove separated records from working directories while preserving payroll and audit references.';

update public.permission_catalog
set name = 'Remove separated employees',
    description = 'Remove separated employees from working directories while preserving required payroll, schedule, licensing, and audit history.',
    updated_at = now()
where code = 'admin.users.delete';

create or replace function public.get_admin_user_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  records jsonb;
begin
  actor_id := private.require_any_user_admin_permission(
    array['admin.users.view', 'admin.users.basic', 'admin.users.manage', 'admin.users.separate', 'admin.users.delete'],
    false
  );

  select coalesce(jsonb_agg(private.admin_user_record(employee.id) order by employee.last_name, employee.first_name, employee.id), '[]'::jsonb)
  into records
  from public.employees employee
  where not exists (
    select 1
    from private.removed_employee_records removed
    where removed.employee_id = employee.id
  );

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'currentEmployeeId', actor_id,
    'users', records
  );
end
$$;

create or replace function public.get_employee_removal_preview(target_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  employee_record jsonb;
begin
  perform private.require_user_admin_permission('admin.users.delete', true);
  employee_record := private.admin_user_record(target_employee_id);

  if employee_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if employee_record ->> 'status' <> 'separated' then
    raise check_violation using message = 'Separate the employee before removing the record.';
  end if;

  if exists (select 1 from private.removed_employee_records where employee_id = target_employee_id) then
    raise check_violation using message = 'This employee has already been removed from the working system.';
  end if;

  return jsonb_build_object(
    'employeeId', target_employee_id,
    'displayName', employee_record ->> 'displayName',
    'username', employee_record ->> 'username',
    'operationalHistory', jsonb_build_object(
      'shiftAssignments', (select count(*) from public.shift_assignments where employee_id = target_employee_id),
      'shiftRequests', (select count(*) from public.shift_requests where employee_id = target_employee_id),
      'timeEvents', (select count(*) from public.time_events where employee_id = target_employee_id),
      'timeOffRequests', (select count(*) from public.time_off_requests where employee_id = target_employee_id),
      'callOffReports', (select count(*) from public.call_off_reports where employee_id = target_employee_id),
      'credentials', (select count(*) from public.employee_credentials where employee_id = target_employee_id)
    )
  );
end
$$;

create or replace function public.get_removed_employee_ids()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (
    public.has_effective_permission('licensing.view')
    or public.has_effective_permission('admin.users.view')
    or public.is_admin()
  ) then
    raise insufficient_privilege using message = 'Directory or licensing permission is required.';
  end if;

  return coalesce((
    select jsonb_agg(removed.employee_id order by removed.removed_at)
    from private.removed_employee_records removed
  ), '[]'::jsonb);
end
$$;

create or replace function public.admin_remove_separated_employee(
  target_employee_id uuid,
  confirmation_username text,
  removal_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  employee_record jsonb;
  deleted_record_id uuid;
  clean_reason text := nullif(btrim(coalesce(removal_reason, '')), '');
begin
  actor_id := private.require_user_admin_permission('admin.users.delete', true);
  employee_record := private.admin_user_record(target_employee_id);

  if employee_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if target_employee_id = actor_id then
    raise check_violation using message = 'You cannot remove your own employee record.';
  end if;

  if employee_record ->> 'status' <> 'separated' then
    raise check_violation using message = 'Separate the employee before removing the record.';
  end if;

  if employee_record ->> 'role' = 'admin' and private.active_admin_account_count() <= 1 then
    raise check_violation using message = 'At least one active admin account must remain.';
  end if;

  if lower(btrim(coalesce(confirmation_username, ''))) <> lower(employee_record ->> 'username') then
    raise check_violation using message = 'The confirmation username does not match this employee.';
  end if;

  if clean_reason is null or length(clean_reason) < 8 then
    raise check_violation using message = 'Enter a clear removal reason of at least 8 characters.';
  end if;

  if exists (select 1 from private.removed_employee_records where employee_id = target_employee_id) then
    raise check_violation using message = 'This employee has already been removed from the working system.';
  end if;

  insert into private.recently_deleted_records (
    record_type,
    record_id,
    display_name,
    metadata,
    deleted_by
  ) values (
    'employee',
    target_employee_id,
    employee_record ->> 'displayName',
    employee_record || jsonb_build_object('removalReason', clean_reason, 'removalMode', 'history_preserving'),
    actor_id
  )
  returning id into deleted_record_id;

  insert into private.removed_employee_records (employee_id, removed_by, reason, snapshot)
  values (target_employee_id, actor_id, clean_reason, employee_record);

  update private.employee_accounts
  set disabled_at = coalesce(disabled_at, clock_timestamp()),
      disabled_by = actor_id,
      disabled_reason = clean_reason
  where employee_id = target_employee_id;

  update private.trusted_devices
  set revoked_at = coalesce(revoked_at, clock_timestamp()),
      revoked_by = coalesce(revoked_by, actor_id)
  where employee_id = target_employee_id;

  delete from public.employee_access_roles where employee_id = target_employee_id;
  delete from public.employee_permission_overrides where employee_id = target_employee_id;

  return jsonb_build_object(
    'deletedId', deleted_record_id,
    'employeeId', target_employee_id,
    'displayName', employee_record ->> 'displayName',
    'expiresAt', (select expires_at from private.recently_deleted_records where id = deleted_record_id),
    'removalMode', 'history_preserving'
  );
end
$$;

revoke all on function public.get_employee_removal_preview(uuid) from public;
revoke all on function public.admin_remove_separated_employee(uuid, text, text) from public;
revoke all on function public.get_removed_employee_ids() from public;
grant execute on function public.get_employee_removal_preview(uuid) to authenticated;
grant execute on function public.admin_remove_separated_employee(uuid, text, text) to authenticated;
grant execute on function public.get_removed_employee_ids() to authenticated;

do $$
declare
  target record;
  target_snapshot jsonb;
begin
  for target in
    select employee.id, employee.first_name, employee.last_name, employee.username
    from public.employees employee
    where (
      lower(btrim(employee.first_name)) = 'patrol' and lower(btrim(employee.last_name)) = 'break'
    ) or (
      lower(btrim(employee.first_name)) = 'test' and lower(btrim(employee.last_name)) in ('employee', 'tester')
    )
  loop
    target_snapshot := private.admin_user_record(target.id);

    update public.employees
    set status = 'separated',
        separated_on = coalesce(separated_on, current_date),
        updated_at = now()
    where id = target.id;

    update private.employee_accounts
    set disabled_at = coalesce(disabled_at, clock_timestamp()),
        disabled_reason = 'Removed as a test or non-employee record during directory cleanup.'
    where employee_id = target.id;

    update private.trusted_devices
    set revoked_at = coalesce(revoked_at, clock_timestamp())
    where employee_id = target.id;

    delete from public.employee_access_roles where employee_id = target.id;
    delete from public.employee_permission_overrides where employee_id = target.id;

    insert into private.removed_employee_records (employee_id, reason, snapshot)
    values (
      target.id,
      'Removed as a test or non-employee record during directory cleanup.',
      coalesce(target_snapshot, '{}'::jsonb)
    )
    on conflict (employee_id) do nothing;

    if not exists (
      select 1 from private.recently_deleted_records deleted
      where deleted.record_type = 'employee'
        and deleted.record_id = target.id
        and deleted.expires_at > clock_timestamp()
    ) then
      insert into private.recently_deleted_records (record_type, record_id, display_name, metadata)
      values (
        'employee',
        target.id,
        concat_ws(' ', target.first_name, target.last_name),
        coalesce(target_snapshot, '{}'::jsonb) || jsonb_build_object(
          'removalReason', 'Removed as a test or non-employee record during directory cleanup.',
          'removalMode', 'history_preserving'
        )
      );
    end if;
  end loop;
end
$$;

commit;
