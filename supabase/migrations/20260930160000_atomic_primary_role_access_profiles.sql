begin;

update public.permission_catalog
set description = 'Create employees with default Guard access and edit basic profile, contact, and employment details without changing roles or access.',
    updated_at = clock_timestamp()
where code = 'admin.users.basic';

create or replace function private.canonical_system_access_role_id(
  target_role public.app_role
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  matching_role_ids uuid[];
begin
  if target_role is null then
    raise check_violation using message = 'A primary workforce role is required.';
  end if;

  select coalesce(array_agg(access_role.id order by access_role.id), array[]::uuid[])
  into matching_role_ids
  from public.access_roles access_role
  where access_role.system_role
    and access_role.active
    and access_role.base_app_role = target_role;

  if cardinality(matching_role_ids) <> 1 then
    raise check_violation using message = 'The selected primary workforce role does not have one active canonical system role.';
  end if;

  return matching_role_ids[1];
end
$$;

revoke all on function private.canonical_system_access_role_id(public.app_role)
  from public, anon, authenticated;

-- Last-Admin protection is about recoverability, not merely the Admin label.
-- A primary Admin whose account is disabled or whose effective access is denied
-- any critical recovery permission cannot safely be the final recovery path.
create or replace function private.employee_is_recovery_capable_active_admin(
  target_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_employee_id
      and employee.role = 'admin'
      and employee.status = 'active'
      and account.auth_user_id is not null
      and account.activated_at is not null
      and account.disabled_at is null
      and array[
        'admin.roles.manage'::text,
        'admin.users.manage'::text,
        'admin.security.manage'::text
      ] <@ private.employee_effective_permissions(employee.id)
  )
$$;

revoke all on function private.employee_is_recovery_capable_active_admin(uuid)
  from public, anon, authenticated;

-- Keep the long-standing helper name so every older decrement path that calls
-- it automatically participates in the same serialization and recovery-safe
-- definition. Advisory locks are transaction scoped and therefore also cover
-- the mutation that follows a successful count.
create or replace function private.active_admin_account_count()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  recovery_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('sygshift.active_admin_recovery', 0));

  select count(*)::integer
  into recovery_count
  from public.employees employee
  where private.employee_is_recovery_capable_active_admin(employee.id);

  return recovery_count;
end
$$;

revoke all on function private.active_admin_account_count()
  from public, anon, authenticated;

-- Read-only access is intentionally broader than mutation authority. A viewer
-- still needs MFA, while every mutation continues to call the existing
-- admin.roles.manage guard.
create or replace function private.require_access_control_viewer()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to view roles and permissions.';
  end if;

  if not public.has_any_effective_permission(array['admin.roles.view', 'admin.roles.manage']) then
    raise insufficient_privilege using message = 'Roles and permission viewing access is required.';
  end if;

  return actor_id;
end
$$;

revoke all on function private.require_access_control_viewer()
  from public, anon, authenticated;

-- Licensing mutations return the full Licensing Center payload. Management is
-- a strict superset of viewing, so an MFA-authenticated licensing manager must
-- satisfy read guards even when their role does not redundantly grant
-- licensing.view. Credential-only editors retain their established read path.
create or replace function private.require_licensing_mfa(
  required_permission text default 'licensing.view'
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  permitted boolean;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  permitted := case
    when required_permission = 'licensing.view' then
      public.has_any_effective_permission(array[
        'licensing.view',
        'licensing.manage',
        'directory.edit_credentials'
      ])
    else
      public.has_effective_permission(required_permission)
  end;

  if not permitted then
    raise insufficient_privilege using message = 'The required Licensing Center permission with MFA is required.';
  end if;

  return actor_id;
end
$$;

revoke all on function private.require_licensing_mfa(text)
  from public, anon, authenticated;

create or replace function private.enforce_primary_admin_for_system_admin_membership_delta()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  touches_system_admin boolean := false;
  actor_employee_id uuid;
  changed_employee_id uuid;
  previous_employee_id uuid;
  previous_role_id uuid;
  replacement_role_id uuid;
begin
  if (select auth.uid()) is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  actor_employee_id := private.current_employee_id();
  if tg_op = 'INSERT' then
    changed_employee_id := new.employee_id;
    replacement_role_id := new.role_id;
  elsif tg_op = 'DELETE' then
    changed_employee_id := old.employee_id;
    previous_employee_id := old.employee_id;
    previous_role_id := old.role_id;
  else
    changed_employee_id := new.employee_id;
    previous_employee_id := old.employee_id;
    previous_role_id := old.role_id;
    replacement_role_id := new.role_id;
  end if;

  if actor_employee_id = changed_employee_id
    and (
      tg_op <> 'UPDATE'
      or previous_employee_id is distinct from changed_employee_id
      or previous_role_id is distinct from replacement_role_id
    )
  then
    raise insufficient_privilege using message = 'You cannot change your own additional role memberships. Use another Admin or role manager.';
  end if;

  if tg_op = 'UPDATE'
    and previous_employee_id is not distinct from changed_employee_id
    and previous_role_id is not distinct from replacement_role_id
  then
    -- A retained membership is not a reassignment. Preserve its original
    -- assigner and timestamp even when an older client performs an upsert.
    return old;
  end if;

  if exists (
    select 1
    from public.employees employee
    where employee.id in (previous_employee_id, changed_employee_id)
      and employee.role = 'admin'
  ) and not public.is_admin()
  then
    raise insufficient_privilege using message = 'A primary Admin account is required to change a primary Admin access profile.';
  end if;

  select exists (
    select 1
    from public.access_roles access_role
    where access_role.id in (previous_role_id, replacement_role_id)
      and access_role.system_role
      and access_role.base_app_role = 'admin'
  ) into touches_system_admin;

  if touches_system_admin and not public.is_admin() then
    raise insufficient_privilege using message = 'A primary Admin account is required to add or remove the Admin access role.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

revoke all on function private.enforce_primary_admin_for_system_admin_membership_delta()
  from public, anon, authenticated;

drop trigger if exists employee_access_roles_primary_admin_delta
  on public.employee_access_roles;
create trigger employee_access_roles_primary_admin_delta
before insert or update or delete on public.employee_access_roles
for each row execute function private.enforce_primary_admin_for_system_admin_membership_delta();

create or replace function private.enforce_primary_role_self_lockout()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
    and old.role is distinct from new.role
    and private.current_employee_id() = old.id
  then
    raise insufficient_privilege using message = 'You cannot change your own primary workforce role. Use another Admin or role manager.';
  end if;

  return new;
end
$$;

revoke all on function private.enforce_primary_role_self_lockout()
  from public, anon, authenticated;

drop trigger if exists employees_primary_role_self_lockout on public.employees;
create trigger employees_primary_role_self_lockout
before update of role on public.employees
for each row execute function private.enforce_primary_role_self_lockout();

-- A deny (or removal of a necessary direct grant) must never leave the system
-- without one active primary Admin who can recover roles, users, and security.
-- The AFTER trigger observes the proposed effective state and raises to roll the
-- entire statement back when the invariant would be lost.
create or replace function private.enforce_recovery_capable_admin_override()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed_employee_id uuid;
  touches_recovery_permission boolean := false;
  actor_employee_id uuid;
  access_changed boolean := true;
begin
  if tg_op = 'INSERT' then
    changed_employee_id := new.employee_id;
    touches_recovery_permission := new.permission_code in ('admin.roles.manage', 'admin.users.manage', 'admin.security.manage');
  elsif tg_op = 'DELETE' then
    changed_employee_id := old.employee_id;
    touches_recovery_permission := old.permission_code in ('admin.roles.manage', 'admin.users.manage', 'admin.security.manage');
  else
    changed_employee_id := new.employee_id;
    access_changed := old.employee_id is distinct from new.employee_id
      or old.permission_code is distinct from new.permission_code
      or old.effect is distinct from new.effect
      or old.active is distinct from new.active;
    touches_recovery_permission :=
      old.permission_code in ('admin.roles.manage', 'admin.users.manage', 'admin.security.manage')
      or new.permission_code in ('admin.roles.manage', 'admin.users.manage', 'admin.security.manage');
  end if;

  if (select auth.uid()) is not null then
    actor_employee_id := private.current_employee_id();

    if actor_employee_id = changed_employee_id then
      if tg_op <> 'UPDATE' then
        raise insufficient_privilege using message = 'You cannot change your own permission overrides. Use another Admin or role manager.';
      elsif old.employee_id is distinct from new.employee_id
        or old.permission_code is distinct from new.permission_code
        or old.effect is distinct from new.effect
        or old.active is distinct from new.active
      then
        raise insufficient_privilege using message = 'You cannot change your own permission overrides. Use another Admin or role manager.';
      end if;
    end if;
  end if;

  if access_changed
    and exists (
      select 1
      from public.employees employee
      where employee.id = changed_employee_id
        and employee.role = 'admin'
    )
    and (select auth.uid()) is not null
    and not public.is_admin()
  then
    raise insufficient_privilege using message = 'A primary Admin account is required to change a primary Admin access profile.';
  end if;

  if touches_recovery_permission
    and exists (
      select 1
      from public.employees employee
      where employee.id = changed_employee_id
        and employee.role = 'admin'
    )
  then
    perform pg_advisory_xact_lock(hashtextextended('sygshift.active_admin_recovery', 0));

    if private.active_admin_account_count() < 1 then
      raise check_violation using message = 'At least one recovery-capable active Admin account must remain.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

revoke all on function private.enforce_recovery_capable_admin_override()
  from public, anon, authenticated;

drop trigger if exists employee_permission_overrides_admin_recovery
  on public.employee_permission_overrides;
create trigger employee_permission_overrides_admin_recovery
after insert or update or delete on public.employee_permission_overrides
for each row execute function private.enforce_recovery_capable_admin_override();

create or replace function private.separate_employee_account_and_future_work(
  target_employee_id uuid,
  actor_id uuid,
  separation_reason text default null,
  separated_on date default null
)
returns jsonb
language plpgsql
volatile
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

  if employee_record.role = 'admin' then
    perform pg_advisory_xact_lock(hashtextextended('sygshift.active_admin_recovery', 0));

    if not public.is_admin() then
      raise insufficient_privilege using message = 'A primary Admin account is required to separate an Admin.';
    end if;
  end if;

  if employee_record.role = 'admin'
    and employee_record.status = 'active'
    and account_record.employee_id is not null
    and account_record.disabled_at is null
    and private.employee_is_recovery_capable_active_admin(employee_record.id)
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one recovery-capable active Admin account must remain.';
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

revoke all on function private.separate_employee_account_and_future_work(uuid, uuid, text, date)
  from public, anon, authenticated;

-- Access administrators need the complete employee population so User Accounts
-- can round-trip existing additional memberships without silently deleting them.
-- Reading this payload never normalizes or mutates assignments.
create or replace function public.get_access_control_center()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_viewer();
begin
  return jsonb_build_object(
    'generatedAt', to_char(clock_timestamp() at time zone 'America/Denver', 'MM/DD/YYYY HH12:MI AM'),
    'permissions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'code', permission.code,
        'category', permission.category,
        'name', permission.name,
        'description', permission.description,
        'riskLevel', permission.risk_level,
        'requiresMfa', permission.requires_mfa,
        'locked', permission.locked,
        'active', permission.active
      ) order by permission.category, permission.name), '[]'::jsonb)
      from public.permission_catalog permission
      where permission.active
    ),
    'roles', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', access_role.id,
        'code', access_role.code,
        'name', access_role.name,
        'description', access_role.description,
        'baseAppRole', access_role.base_app_role,
        'systemRole', access_role.system_role,
        'protected', access_role.protected,
        'mfaRequired', access_role.mfa_required,
        'active', access_role.active,
        'permissionCodes', coalesce(role_permissions.permission_codes, array[]::text[]),
        'assignedCount', coalesce(assignments.assigned_count, 0)
      ) order by access_role.system_role desc, access_role.name), '[]'::jsonb)
      from public.access_roles access_role
      left join lateral (
        select array_agg(permission.permission_code order by permission.permission_code) as permission_codes
        from public.access_role_permissions permission
        where permission.role_id = access_role.id
          and permission.enabled
      ) role_permissions on true
      left join lateral (
        select count(distinct role_employee.employee_id)::integer as assigned_count
        from (
          select employee.id as employee_id
          from public.employees employee
          where access_role.system_role
            and employee.role = access_role.base_app_role
          union
          select assignment.employee_id
          from public.employee_access_roles assignment
          where assignment.role_id = access_role.id
        ) role_employee
      ) assignments on true
      where access_role.active
    ),
    'users', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'displayName', coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
        'username', employee.username,
        'primaryRole', employee.role,
        'jobTitle', employee.job_title,
        'status', employee.status,
        'assignedRoleIds', coalesce(assigned_roles.role_ids, array[]::uuid[]),
        'overrides', coalesce(overrides.records, '[]'::jsonb),
        'effectivePermissionCodes', private.employee_effective_permissions(employee.id)
      ) order by employee.first_name, employee.last_name), '[]'::jsonb)
      from public.employees employee
      left join lateral (
        select array_agg(assignment.role_id order by access_role.name) as role_ids
        from public.employee_access_roles assignment
        join public.access_roles access_role on access_role.id = assignment.role_id
        where assignment.employee_id = employee.id
      ) assigned_roles on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
          'id', permission_override.id,
          'permissionCode', permission_override.permission_code,
          'effect', permission_override.effect,
          'reason', permission_override.reason,
          'createdAt', to_char(permission_override.created_at at time zone 'America/Denver', 'MM/DD/YYYY HH12:MI AM')
        ) order by permission_override.permission_code) as records
        from public.employee_permission_overrides permission_override
        where permission_override.employee_id = employee.id
          and permission_override.active
      ) overrides on true
    )
  );
end
$$;

create or replace function public.set_employee_access_profile_with_primary_role(
  target_employee_id uuid,
  target_primary_role public.app_role,
  target_role_ids uuid[],
  target_permission_codes text[],
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  employee_record public.employees%rowtype;
  canonical_primary_role_id uuid;
  canonical_previous_role_id uuid;
  clean_role_ids uuid[];
  requested_permission_codes text[];
  clean_permission_codes text[];
  inherited_permission_codes text[];
  old_role_ids uuid[];
  old_grant_codes text[];
  clean_reason text := btrim(coalesce(target_reason, ''));
  target_has_active_account boolean;
begin
  if clean_reason = '' then
    raise check_violation using message = 'An audit reason is required to change employee access.';
  end if;

  select employee.*
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status <> 'separated'
  for update;

  if not found then
    raise no_data_found using message = 'The selected employee is separated or no longer exists.';
  end if;

  if target_employee_id = actor_id then
    raise insufficient_privilege using message = 'You cannot change your own role or access profile. Use another Admin or role manager.';
  end if;

  canonical_primary_role_id := private.canonical_system_access_role_id(target_primary_role);
  canonical_previous_role_id := private.canonical_system_access_role_id(employee_record.role);

  if employee_record.role = 'admin' or target_primary_role = 'admin' then
    perform pg_advisory_xact_lock(hashtextextended('sygshift.active_admin_recovery', 0));

    if not public.is_admin() then
      raise insufficient_privilege using message = 'A primary Admin account is required to promote or demote an Admin.';
    end if;
  end if;

  select exists (
    select 1
    from private.employee_accounts account
    where account.employee_id = employee_record.id
      and account.disabled_at is null
  ) into target_has_active_account;

  if employee_record.role = 'admin'
    and target_primary_role <> 'admin'
    and employee_record.status = 'active'
    and target_has_active_account
    and private.employee_is_recovery_capable_active_admin(employee_record.id)
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one recovery-capable active Admin account must remain.';
  end if;

  select coalesce(array_agg(distinct requested_role.id order by requested_role.id), array[]::uuid[])
  into clean_role_ids
  from unnest(coalesce(target_role_ids, array[]::uuid[])) requested_role(id);

  select coalesce(array_agg(assignment.role_id order by assignment.role_id), array[]::uuid[])
  into old_role_ids
  from public.employee_access_roles assignment
  where assignment.employee_id = target_employee_id;

  if exists (
    select 1
    from unnest(clean_role_ids) requested_role(id)
    left join public.access_roles access_role
      on access_role.id = requested_role.id
    where access_role.id is null
      or (not access_role.active and not (requested_role.id = any(old_role_ids)))
  ) then
    raise check_violation using message = 'One or more selected roles are not available.';
  end if;

  select coalesce(array_agg(requested_role.id order by requested_role.id), array[]::uuid[])
  into clean_role_ids
  from unnest(clean_role_ids) requested_role(id)
  where requested_role.id is distinct from canonical_primary_role_id
    and requested_role.id is distinct from canonical_previous_role_id;

  select coalesce(array_agg(permission_override.permission_code order by permission_override.permission_code), array[]::text[])
  into old_grant_codes
  from public.employee_permission_overrides permission_override
  where permission_override.employee_id = target_employee_id
    and permission_override.active
    and permission_override.effect = 'grant';

  select coalesce(array_agg(distinct requested_permission.code order by requested_permission.code), array[]::text[])
  into requested_permission_codes
  from unnest(coalesce(target_permission_codes, array[]::text[])) requested_permission(code);

  if exists (
    select 1
    from unnest(requested_permission_codes) requested_permission(code)
    left join public.permission_catalog catalog
      on catalog.code = requested_permission.code
     and catalog.active
    where catalog.code is null
  ) then
    raise check_violation using message = 'One or more selected permission additions are not available.';
  end if;

  with role_scope as (
    select canonical_primary_role_id as id
    union
    select requested_role.id
    from unnest(clean_role_ids) requested_role(id)
    join public.access_roles access_role
      on access_role.id = requested_role.id
     and access_role.active
  )
  select coalesce(array_agg(distinct role_permission.permission_code order by role_permission.permission_code), array[]::text[])
  into inherited_permission_codes
  from public.access_role_permissions role_permission
  join role_scope on role_scope.id = role_permission.role_id
  join public.permission_catalog catalog on catalog.code = role_permission.permission_code
  where role_permission.enabled
    and catalog.active;

  if exists (
    select 1
    from unnest(requested_permission_codes) requested_permission(code)
    where requested_permission.code = any(inherited_permission_codes)
      and not (requested_permission.code = any(old_grant_codes))
  ) then
    raise check_violation using message = 'A new individual addition cannot duplicate permission inherited from a role.';
  end if;

  -- A primary-role change can make an existing individual grant redundant.
  -- Retain that override so a later demotion does not silently destroy the
  -- employee-specific exception, even when the current role already supplies it.
  select coalesce(array_agg(distinct permission_code order by permission_code), array[]::text[])
  into clean_permission_codes
  from (
    select requested_permission.code as permission_code
    from unnest(requested_permission_codes) requested_permission(code)
    union
    select old_permission.code
    from unnest(old_grant_codes) old_permission(code)
    where old_permission.code = any(inherited_permission_codes)
  ) final_grant;

  if exists (
    select 1
    from unnest(clean_permission_codes) requested_permission(code)
    join public.employee_permission_overrides permission_override
      on permission_override.employee_id = target_employee_id
     and permission_override.permission_code = requested_permission.code
     and permission_override.effect = 'deny'
     and permission_override.active
  ) then
    raise check_violation using message = 'A protected individual restriction must be reviewed separately before this permission can be added.';
  end if;

  if employee_record.role is distinct from target_primary_role then
    update public.employees employee
    set role = target_primary_role,
        updated_at = clock_timestamp()
    where employee.id = target_employee_id;
  end if;

  delete from public.employee_access_roles assignment
  where assignment.employee_id = target_employee_id
    and not (assignment.role_id = any(clean_role_ids));

  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  select target_employee_id, requested_role.id, actor_id
  from unnest(clean_role_ids) requested_role(id)
  where not exists (
    select 1
    from public.employee_access_roles retained_assignment
    where retained_assignment.employee_id = target_employee_id
      and retained_assignment.role_id = requested_role.id
  )
  on conflict (employee_id, role_id) do nothing;

  update public.employee_permission_overrides permission_override
  set active = false,
      updated_at = clock_timestamp()
  where permission_override.employee_id = target_employee_id
    and permission_override.active
    and permission_override.effect = 'grant'
    and not (permission_override.permission_code = any(clean_permission_codes));

  insert into public.employee_permission_overrides (
    employee_id,
    permission_code,
    effect,
    reason,
    created_by
  )
  select target_employee_id, requested_permission.code, 'grant', clean_reason, actor_id
  from unnest(clean_permission_codes) requested_permission(code)
  where not exists (
    select 1
    from public.employee_permission_overrides retained_grant
    where retained_grant.employee_id = target_employee_id
      and retained_grant.permission_code = requested_permission.code
      and retained_grant.active
  )
  on conflict (employee_id, permission_code) where active do nothing;

  if target_primary_role = 'admin'
    and employee_record.status = 'active'
    and target_has_active_account
    and private.active_admin_account_count() < 1
  then
    raise check_violation using message = 'At least one recovery-capable active Admin account must remain.';
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    request_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id',
    'public',
    'employee_access_profile',
    'UPDATE_WITH_PRIMARY_ROLE',
    target_employee_id::text,
    jsonb_build_object(
      'primaryRole', employee_record.role,
      'roleIds', old_role_ids,
      'permissionAdditions', old_grant_codes
    ),
    jsonb_build_object(
      'primaryRole', target_primary_role,
      'roleIds', clean_role_ids,
      'permissionAdditions', clean_permission_codes,
      'reason', clean_reason
    )
  );

  return public.get_access_control_center();
end
$$;

revoke all on function public.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) from public, anon, authenticated;
grant execute on function public.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) to authenticated;

-- User Accounts edits workforce roles but does not own the direct-permission
-- desired state. Snapshot active grants only after locking the employee row so
-- a grant committed after the page loaded cannot be erased by a stale role save.
-- Permission-override writers take this same employee lock below.
create or replace function public.set_employee_workforce_roles(
  target_employee_id uuid,
  target_primary_role public.app_role,
  target_role_ids uuid[],
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  current_grant_codes text[];
begin
  perform 1
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status <> 'separated'
  for update;

  if not found then
    raise no_data_found using message = 'The selected employee is separated or no longer exists.';
  end if;

  if target_employee_id = actor_id then
    raise insufficient_privilege using message = 'You cannot change your own workforce roles. Use another Admin or role manager.';
  end if;

  select coalesce(array_agg(permission_override.permission_code order by permission_override.permission_code), array[]::text[])
  into current_grant_codes
  from public.employee_permission_overrides permission_override
  where permission_override.employee_id = target_employee_id
    and permission_override.active
    and permission_override.effect = 'grant';

  return public.set_employee_access_profile_with_primary_role(
    target_employee_id,
    target_primary_role,
    target_role_ids,
    current_grant_codes,
    target_reason
  );
end
$$;

revoke all on function public.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) from public, anon;
grant execute on function public.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) to authenticated;

comment on function public.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) is
  'Atomically changes primary and additive workforce roles while preserving active direct permission grants read under the employee row lock.';

-- Keep the established four-argument endpoint for older clients, but delegate
-- its additive-only save to the same atomic implementation. The locked current
-- primary role is passed through unchanged, so this signature cannot promote
-- or demote while it gains retired-membership round trips, direct-grant
-- preservation, Admin boundaries, provenance preservation, and self lockout.
create or replace function public.set_employee_access_profile(
  target_employee_id uuid,
  target_role_ids uuid[],
  target_permission_codes text[],
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  employee_primary_role public.app_role;
  canonical_primary_role_id uuid;
  old_grant_codes text[];
  inherited_permission_codes text[];
  merged_permission_codes text[];
begin
  select employee.role
  into employee_primary_role
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status <> 'separated'
  for update;

  if not found then
    raise no_data_found using message = 'The selected employee is separated or no longer exists.';
  end if;

  canonical_primary_role_id := private.canonical_system_access_role_id(employee_primary_role);

  select coalesce(array_agg(permission_override.permission_code order by permission_override.permission_code), array[]::text[])
  into old_grant_codes
  from public.employee_permission_overrides permission_override
  where permission_override.employee_id = target_employee_id
    and permission_override.active
    and permission_override.effect = 'grant';

  with role_scope as (
    select canonical_primary_role_id as id
    union
    select assignment.role_id
    from public.employee_access_roles assignment
    join public.access_roles access_role
      on access_role.id = assignment.role_id
     and access_role.active
    where assignment.employee_id = target_employee_id
  )
  select coalesce(array_agg(distinct role_permission.permission_code order by role_permission.permission_code), array[]::text[])
  into inherited_permission_codes
  from public.access_role_permissions role_permission
  join role_scope on role_scope.id = role_permission.role_id
  join public.permission_catalog catalog
    on catalog.code = role_permission.permission_code
   and catalog.active
  where role_permission.enabled;

  select coalesce(array_agg(distinct permission_code order by permission_code), array[]::text[])
  into merged_permission_codes
  from (
    select requested_permission.code as permission_code
    from unnest(coalesce(target_permission_codes, array[]::text[])) requested_permission(code)
    union
    select old_permission.code
    from unnest(old_grant_codes) old_permission(code)
    where old_permission.code = any(inherited_permission_codes)
  ) preserved_permission;

  return public.set_employee_access_profile_with_primary_role(
    target_employee_id,
    employee_primary_role,
    target_role_ids,
    merged_permission_codes,
    target_reason
  );
end
$$;

revoke all on function public.set_employee_access_profile(uuid, uuid[], text[], text)
  from public, anon, authenticated;
grant execute on function public.set_employee_access_profile(uuid, uuid[], text[], text)
  to authenticated;

-- Preserve the oldest two-argument membership surface for stale clients, but
-- route it through the same atomic invariants. Existing direct grants are
-- round-tripped unchanged; retained retired memberships are accepted, primary
-- system bundles are normalized, and Admin/self boundaries cannot be bypassed.
create or replace function public.set_employee_access_roles(
  target_employee_id uuid,
  target_role_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  employee_primary_role public.app_role;
begin
  select employee.role
  into employee_primary_role
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status <> 'separated'
  for update;

  if not found then
    raise no_data_found using message = 'The selected employee is separated or no longer exists.';
  end if;

  return public.set_employee_workforce_roles(
    target_employee_id,
    employee_primary_role,
    target_role_ids,
    'Additional roles updated from the legacy role-membership endpoint.'
  );
end
$$;

revoke all on function public.set_employee_access_roles(uuid, uuid[])
  from public, anon;
grant execute on function public.set_employee_access_roles(uuid, uuid[])
  to authenticated;

-- Basic user administration can onboard the safe default Guard profile. Any
-- other requested primary role is an access mutation and needs role-management
-- authority. The base routine remains callable by its
-- SECURITY DEFINER time-zone wrappers, not directly by browser clients.
create or replace function public.admin_create_employee(
  target_first_name text,
  target_middle_name text default null,
  target_last_name text default null,
  target_preferred_name text default null,
  target_role public.app_role default 'guard',
  target_employment_type public.employment_type default 'hourly',
  target_status public.employee_status default 'active',
  target_employee_number text default null,
  target_job_title text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  employee_id uuid;
begin
  actor_id := private.require_any_user_admin_permission(array['admin.users.basic', 'admin.users.manage'], false);

  perform private.canonical_system_access_role_id(target_role);

  if target_role is distinct from 'guard'::public.app_role then
    perform private.require_access_control_admin();
  end if;

  if target_status = 'separated' then
    actor_id := private.require_user_admin_permission('admin.users.separate');
  end if;

  if target_role = 'admin' then
    perform pg_advisory_xact_lock(hashtextextended('sygshift.active_admin_recovery', 0));

    if not public.is_admin() then
      raise insufficient_privilege using message = 'A primary Admin account is required to create another Admin.';
    end if;
  end if;

  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;

  if target_personal_email is not null
    and btrim(target_personal_email) <> ''
    and btrim(target_personal_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The personal email address is invalid.';
  end if;

  if target_company_email is not null
    and btrim(target_company_email) <> ''
    and btrim(target_company_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The company email address is invalid.';
  end if;

  insert into public.employees (
    employee_number,
    job_title,
    first_name,
    middle_name,
    last_name,
    preferred_name,
    role,
    employment_type,
    status
  ) values (
    nullif(upper(btrim(coalesce(target_employee_number, ''))), ''),
    nullif(btrim(coalesce(target_job_title, '')), ''),
    btrim(target_first_name),
    nullif(btrim(coalesce(target_middle_name, '')), ''),
    btrim(target_last_name),
    nullif(btrim(coalesce(target_preferred_name, '')), ''),
    target_role,
    target_employment_type,
    target_status
  )
  returning id into employee_id;

  if coalesce(target_personal_email, target_company_email, target_mobile_phone) is not null then
    insert into private.employee_contacts (
      employee_id,
      personal_email,
      company_email,
      mobile_phone
    ) values (
      employee_id,
      nullif(lower(btrim(coalesce(target_personal_email, ''))), ''),
      nullif(lower(btrim(coalesce(target_company_email, ''))), ''),
      nullif(btrim(coalesce(target_mobile_phone, '')), '')
    );
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employees',
    'ADMIN_CREATE',
    employee_id::text,
    private.admin_user_record(employee_id)
  );

  return private.admin_user_record(employee_id);
end
$$;

revoke all on function public.admin_create_employee(
  text, text, text, text, public.app_role, public.employment_type,
  public.employee_status, text, text, text, text, text
) from public, anon, authenticated;

-- Keep the long-lived profile mutation signature, but do not let a client with
-- only basic-profile authority promote or demote an employee.
create or replace function public.admin_update_employee(
  target_employee_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_preferred_name text,
  target_role public.app_role,
  target_employment_type public.employment_type,
  target_status public.employee_status,
  target_employee_number text default null,
  target_job_title text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  employee_record public.employees%rowtype;
  contact_record private.employee_contacts%rowtype;
  before_record jsonb;
  after_record jsonb;
  target_has_active_account boolean;
  role_changed boolean;
  profile_changed boolean;
  existing_role_ids uuid[];
  existing_grant_codes text[];
begin
  select employee.*
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  select contact.*
  into contact_record
  from private.employee_contacts contact
  where contact.employee_id = target_employee_id
  for update;

  role_changed := employee_record.role is distinct from target_role;
  profile_changed :=
    employee_record.first_name is distinct from btrim(coalesce(target_first_name, ''))
    or employee_record.middle_name is distinct from nullif(btrim(coalesce(target_middle_name, '')), '')
    or employee_record.last_name is distinct from btrim(coalesce(target_last_name, ''))
    or employee_record.preferred_name is distinct from nullif(btrim(coalesce(target_preferred_name, '')), '')
    or employee_record.employment_type is distinct from target_employment_type
    or employee_record.status is distinct from target_status
    or employee_record.employee_number is distinct from nullif(upper(btrim(coalesce(target_employee_number, ''))), '')
    or employee_record.job_title is distinct from nullif(btrim(coalesce(target_job_title, '')), '')
    or contact_record.personal_email is distinct from nullif(lower(btrim(coalesce(target_personal_email, ''))), '')
    or contact_record.company_email is distinct from nullif(lower(btrim(coalesce(target_company_email, ''))), '')
    or contact_record.mobile_phone is distinct from nullif(btrim(coalesce(target_mobile_phone, '')), '');

  if role_changed then
    actor_id := private.require_access_control_admin();
  end if;

  if profile_changed or not role_changed then
    actor_id := private.require_any_user_admin_permission(array['admin.users.basic', 'admin.users.manage'], false);
  end if;

  before_record := private.admin_user_record(target_employee_id);

  if role_changed then
    if target_employee_id = actor_id then
      raise insufficient_privilege using message = 'You cannot change your own primary workforce role. Use another Admin or role manager.';
    end if;

    perform private.canonical_system_access_role_id(target_role);
  end if;

  if employee_record.role = 'admin' or target_role = 'admin' then
    perform pg_advisory_xact_lock(hashtextextended('sygshift.active_admin_recovery', 0));

    if not public.is_admin() then
      raise insufficient_privilege using message = 'A primary Admin account is required to create, edit, promote, demote, or separate an Admin.';
    end if;
  end if;

  if target_status = 'separated' or employee_record.status = 'separated' then
    actor_id := private.require_user_admin_permission('admin.users.separate');
  end if;

  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;

  if target_personal_email is not null
    and btrim(target_personal_email) <> ''
    and btrim(target_personal_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The personal email address is invalid.';
  end if;

  if target_company_email is not null
    and btrim(target_company_email) <> ''
    and btrim(target_company_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The company email address is invalid.';
  end if;

  select exists (
    select 1
    from private.employee_accounts account
    where account.employee_id = employee_record.id
      and account.disabled_at is null
  ) into target_has_active_account;

  if employee_record.role = 'admin'
    and employee_record.status = 'active'
    and target_has_active_account
    and (target_role <> 'admin' or target_status <> 'active')
    and private.employee_is_recovery_capable_active_admin(employee_record.id)
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one recovery-capable active Admin account must remain.';
  end if;

  if role_changed then
    select coalesce(array_agg(assignment.role_id order by assignment.role_id), array[]::uuid[])
    into existing_role_ids
    from public.employee_access_roles assignment
    where assignment.employee_id = target_employee_id;

    select coalesce(array_agg(permission_override.permission_code order by permission_override.permission_code), array[]::text[])
    into existing_grant_codes
    from public.employee_permission_overrides permission_override
    where permission_override.employee_id = target_employee_id
      and permission_override.active
      and permission_override.effect = 'grant';

    perform public.set_employee_access_profile_with_primary_role(
      target_employee_id,
      target_role,
      existing_role_ids,
      existing_grant_codes,
      'Primary workforce role updated from the legacy employee profile workflow.'
    );
  end if;

  update public.employees employee
  set
    employee_number = nullif(upper(btrim(coalesce(target_employee_number, ''))), ''),
    job_title = nullif(btrim(coalesce(target_job_title, '')), ''),
    first_name = btrim(target_first_name),
    middle_name = nullif(btrim(coalesce(target_middle_name, '')), ''),
    last_name = btrim(target_last_name),
    preferred_name = nullif(btrim(coalesce(target_preferred_name, '')), ''),
    role = target_role,
    employment_type = target_employment_type,
    status = target_status,
    separated_on = case
      when target_status = 'separated' then coalesce(employee.separated_on, (clock_timestamp() at time zone 'America/Denver')::date)
      when target_status = 'active' then null
      else employee.separated_on
    end,
    updated_at = clock_timestamp()
  where employee.id = target_employee_id;

  insert into private.employee_contacts (
    employee_id,
    personal_email,
    company_email,
    mobile_phone
  ) values (
    target_employee_id,
    nullif(lower(btrim(coalesce(target_personal_email, ''))), ''),
    nullif(lower(btrim(coalesce(target_company_email, ''))), ''),
    nullif(btrim(coalesce(target_mobile_phone, '')), '')
  )
  on conflict (employee_id) do update set
    personal_email = excluded.personal_email,
    company_email = excluded.company_email,
    mobile_phone = excluded.mobile_phone,
    updated_at = clock_timestamp();

  if target_status = 'separated' then
    perform private.separate_employee_account_and_future_work(
      target_employee_id,
      actor_id,
      'Employee marked separated from Users & Access.',
      null
    );
  end if;

  after_record := private.admin_user_record(target_employee_id);

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    request_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id',
    'public',
    'employees',
    'UPDATE',
    target_employee_id::text,
    before_record,
    after_record
  );

  return after_record;
end
$$;

create or replace function public.admin_set_employee_account_state(
  target_employee_id uuid,
  target_disabled boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  employee_record public.employees%rowtype;
  account_record private.employee_accounts%rowtype;
  before_record jsonb;
  after_record jsonb;
begin
  actor_id := private.require_user_admin_permission('admin.users.manage');

  select employee.*
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  select account.*
  into account_record
  from private.employee_accounts account
  where account.employee_id = target_employee_id
  for update;

  if not found then
    raise check_violation using message = 'A login account has not been created for this employee yet.';
  end if;

  if employee_record.role = 'admin' then
    perform pg_advisory_xact_lock(hashtextextended('sygshift.active_admin_recovery', 0));

    if not public.is_admin() then
      raise insufficient_privilege using message = 'A primary Admin account is required to disable or restore an Admin account.';
    end if;
  end if;

  if employee_record.role = 'admin'
    and employee_record.status = 'active'
    and target_disabled
    and account_record.disabled_at is null
    and private.employee_is_recovery_capable_active_admin(employee_record.id)
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one recovery-capable active Admin account must remain.';
  end if;

  before_record := private.admin_user_record(target_employee_id);

  update private.employee_accounts account
  set
    disabled_at = case when target_disabled then coalesce(account.disabled_at, clock_timestamp()) else null end,
    updated_at = clock_timestamp()
  where account.employee_id = target_employee_id;

  after_record := private.admin_user_record(target_employee_id);

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
    'private',
    'employee_accounts',
    case when target_disabled then 'ADMIN_DISABLE' else 'ADMIN_ENABLE' end,
    target_employee_id::text,
    before_record,
    after_record
  );

  return after_record;
end
$$;

revoke all on function public.admin_set_employee_account_state(uuid, boolean)
  from public, anon;
grant execute on function public.admin_set_employee_account_state(uuid, boolean)
  to authenticated;

-- User Accounts must be able to round-trip an already assigned retired role,
-- but cannot add a retired role to another employee. This central helper also
-- makes every legacy combined profile/access wrapper reject self lockout and
-- lets the Admin-membership trigger enforce the exact primary-Admin boundary.
create or replace function private.replace_employee_additional_access_roles(
  target_actor_id uuid,
  target_employee_id uuid,
  target_role_ids uuid[]
)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  employee_primary_role public.app_role;
  employee_status public.employee_status;
  canonical_primary_role_id uuid;
  requested_role_ids uuid[];
  clean_role_ids uuid[];
  old_role_ids uuid[];
begin
  select employee.role, employee.status
  into employee_primary_role, employee_status
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected employee does not exist.';
  end if;

  if employee_status = 'separated' then
    raise no_data_found using message = 'Separated employee access is read-only.';
  end if;

  canonical_primary_role_id := private.canonical_system_access_role_id(employee_primary_role);

  select coalesce(array_agg(distinct assignment.role_id order by assignment.role_id), array[]::uuid[])
  into old_role_ids
  from public.employee_access_roles assignment
  where assignment.employee_id = target_employee_id;

  select coalesce(array_agg(distinct requested_role.id order by requested_role.id), array[]::uuid[])
  into requested_role_ids
  from unnest(coalesce(target_role_ids, array[]::uuid[])) requested_role(id);

  if exists (
    select 1
    from unnest(requested_role_ids) requested_role(id)
    left join public.access_roles access_role on access_role.id = requested_role.id
    where access_role.id is null
      or (not access_role.active and not (requested_role.id = any(old_role_ids)))
  ) then
    raise check_violation using message = 'One or more selected roles are not available.';
  end if;

  select coalesce(array_agg(requested_role.id order by requested_role.id), array[]::uuid[])
  into clean_role_ids
  from unnest(requested_role_ids) requested_role(id)
  where requested_role.id is distinct from canonical_primary_role_id;

  if target_actor_id = target_employee_id
    and old_role_ids is distinct from clean_role_ids
  then
    raise insufficient_privilege using message = 'You cannot change your own additional role memberships. Use another Admin or role manager.';
  end if;

  delete from public.employee_access_roles assignment
  where assignment.employee_id = target_employee_id
    and not (assignment.role_id = any(clean_role_ids));

  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  select target_employee_id, requested_role.id, target_actor_id
  from unnest(clean_role_ids) requested_role(id)
  where not exists (
    select 1
    from public.employee_access_roles retained_assignment
    where retained_assignment.employee_id = target_employee_id
      and retained_assignment.role_id = requested_role.id
  )
  on conflict (employee_id, role_id) do nothing;

  if old_role_ids is distinct from clean_role_ids then
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
      target_actor_id,
      'public',
      'employee_access_roles',
      'UPDATE_FROM_USER_ACCOUNTS',
      target_employee_id::text,
      jsonb_build_object('roleIds', old_role_ids),
      jsonb_build_object('roleIds', clean_role_ids)
    );
  end if;

  return clean_role_ids;
end
$$;

revoke all on function private.replace_employee_additional_access_roles(uuid, uuid, uuid[])
  from public, anon, authenticated;

-- Serialize permission changes with role-only saves on the employee row. This
-- closes the stale-page window where User Accounts could otherwise snapshot an
-- old grant list while another administrator was adding a direct permission.
create or replace function public.set_employee_permission_override(
  target_employee_id uuid,
  target_permission_code text,
  target_effect text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  employee_status public.employee_status;
  clean_reason text := btrim(coalesce(target_reason, ''));
begin
  select employee.status
  into employee_status
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found or employee_status <> 'active' then
    raise no_data_found using message = 'The selected employee is not active.';
  end if;

  if target_effect not in ('grant', 'deny') then
    raise check_violation using message = 'Permission override must be grant or deny.';
  end if;

  if clean_reason = '' then
    raise check_violation using message = 'A reason is required for individual permission overrides.';
  end if;

  if not exists (
    select 1
    from public.permission_catalog catalog
    where catalog.code = target_permission_code
      and catalog.active
  ) then
    raise no_data_found using message = 'The selected permission is not available.';
  end if;

  if target_effect = 'deny'
    and target_permission_code in ('admin.roles.manage', 'admin.users.manage', 'admin.security.manage')
    and target_employee_id = actor_id
  then
    raise insufficient_privilege using message = 'You cannot remove your own critical admin access.';
  end if;

  insert into public.employee_permission_overrides (
    employee_id, permission_code, effect, reason, created_by
  ) values (
    target_employee_id, target_permission_code, target_effect, clean_reason, actor_id
  )
  on conflict (employee_id, permission_code) where active do update
  set effect = excluded.effect,
      reason = excluded.reason,
      created_by = excluded.created_by,
      updated_at = now();

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name,
    operation, row_id, new_record
  ) values (
    (select auth.uid()), actor_id, 'public', 'employee_permission_overrides',
    'UPSERT', target_employee_id::text,
    jsonb_build_object('permissionCode', target_permission_code, 'effect', target_effect)
  );

  return public.get_access_control_center();
end
$$;

revoke all on function public.set_employee_permission_override(uuid, text, text, text)
  from public, anon;
grant execute on function public.set_employee_permission_override(uuid, text, text, text)
  to authenticated;

-- Separated employees remain visible to access administrators for historical
-- review, but their retained permission history is immutable. Keep controlled
-- hard deletion in admin_remove_separated_employee untouched; this guard is on
-- the interactive access-edit surface only.
create or replace function public.clear_employee_permission_override(
  target_override_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  override_record public.employee_permission_overrides%rowtype;
begin
  select permission_override.*
  into override_record
  from public.employee_permission_overrides permission_override
  where permission_override.id = target_override_id
    and permission_override.active;

  if not found then
    raise no_data_found using message = 'The selected override no longer exists.';
  end if;

  perform 1
  from public.employees employee
  where employee.id = override_record.employee_id
  for update;

  select permission_override.*
  into override_record
  from public.employee_permission_overrides permission_override
  where permission_override.id = target_override_id
    and permission_override.active
  for update;

  if not found then
    raise no_data_found using message = 'The selected override no longer exists.';
  end if;

  if exists (
    select 1
    from public.employees employee
    where employee.id = override_record.employee_id
      and employee.status = 'separated'
  ) then
    raise no_data_found using message = 'Separated employee access is read-only.';
  end if;

  update public.employee_permission_overrides permission_override
  set active = false,
      updated_at = now()
  where permission_override.id = target_override_id;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name,
    operation, row_id, old_record
  ) values (
    (select auth.uid()), actor_id, 'public', 'employee_permission_overrides',
    'DELETE', target_override_id::text, to_jsonb(override_record)
  );

  return public.get_access_control_center();
end
$$;

revoke all on function public.clear_employee_permission_override(uuid)
  from public, anon;
grant execute on function public.clear_employee_permission_override(uuid)
  to authenticated;

-- The explicit-time-zone wrapper historically performed a second privileged
-- write even when the submitted time zone was unchanged. That caused a pure
-- role change by a roles.manage-only operator to fail after the role update.
-- Skip the no-op profile write; a real time-zone change still requires the
-- normal user-profile authority in admin_set_employee_time_zone, and any
-- failure rolls the entire call back atomically.
create or replace function public.admin_update_employee_with_time_zone(
  target_employee_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_preferred_name text,
  target_role public.app_role,
  target_employment_type public.employment_type,
  target_status public.employee_status,
  target_employee_number text default null,
  target_job_title text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null,
  target_time_zone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_time_zone text;
begin
  if target_time_zone is null
    or target_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles')
  then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
  end if;

  select employee.time_zone
  into current_time_zone
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  perform public.admin_update_employee(
    target_employee_id,
    target_first_name,
    target_middle_name,
    target_last_name,
    target_preferred_name,
    target_role,
    target_employment_type,
    target_status,
    target_employee_number,
    target_job_title,
    target_personal_email,
    target_company_email,
    target_mobile_phone
  );

  if current_time_zone is distinct from target_time_zone then
    return public.admin_set_employee_time_zone(target_employee_id, target_time_zone);
  end if;

  return private.admin_user_record(target_employee_id);
end
$$;

revoke all on function public.admin_update_employee_with_time_zone(
  uuid, text, text, text, text, public.app_role, public.employment_type,
  public.employee_status, text, text, text, text, text, text
) from public, anon;
grant execute on function public.admin_update_employee_with_time_zone(
  uuid, text, text, text, text, public.app_role, public.employment_type,
  public.employee_status, text, text, text, text, text, text
) to authenticated;

-- Stale User Accounts clients can submit the former primary role in the
-- additional-role array. Filter both the former and replacement primary system
-- bundles while retaining every unrelated valid or invalid ID for the helper's
-- normal validation behavior.
create or replace function public.admin_update_employee_with_time_zone_and_access_roles(
  target_employee_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_preferred_name text,
  target_role public.app_role,
  target_employment_type public.employment_type,
  target_status public.employee_status,
  target_employee_number text default null,
  target_job_title text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null,
  target_time_zone text default null,
  target_access_role_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  employee_record public.employees%rowtype;
  contact_record private.employee_contacts%rowtype;
  previous_primary_role public.app_role;
  previous_primary_role_id uuid;
  replacement_primary_role_id uuid;
  normalized_access_role_ids uuid[];
  old_role_ids uuid[];
  profile_changed boolean;
  access_changed boolean;
begin
  if target_time_zone is null
    or target_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles')
  then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
  end if;

  select employee.*
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  previous_primary_role := employee_record.role;
  previous_primary_role_id := private.canonical_system_access_role_id(previous_primary_role);
  replacement_primary_role_id := private.canonical_system_access_role_id(target_role);

  select contact.*
  into contact_record
  from private.employee_contacts contact
  where contact.employee_id = target_employee_id
  for update;

  if actor_id = target_employee_id
    and previous_primary_role is distinct from target_role
  then
    raise insufficient_privilege using message = 'You cannot change your own primary workforce role. Use another Admin or role manager.';
  end if;

  select coalesce(array_agg(distinct requested_role.id order by requested_role.id), array[]::uuid[])
  into normalized_access_role_ids
  from unnest(coalesce(target_access_role_ids, array[]::uuid[])) requested_role(id)
  where requested_role.id is distinct from previous_primary_role_id
    and requested_role.id is distinct from replacement_primary_role_id;

  select coalesce(array_agg(assignment.role_id order by assignment.role_id), array[]::uuid[])
  into old_role_ids
  from public.employee_access_roles assignment
  where assignment.employee_id = target_employee_id;

  profile_changed :=
    employee_record.first_name is distinct from btrim(coalesce(target_first_name, ''))
    or employee_record.middle_name is distinct from nullif(btrim(coalesce(target_middle_name, '')), '')
    or employee_record.last_name is distinct from btrim(coalesce(target_last_name, ''))
    or employee_record.preferred_name is distinct from nullif(btrim(coalesce(target_preferred_name, '')), '')
    or employee_record.employment_type is distinct from target_employment_type
    or employee_record.status is distinct from target_status
    or employee_record.employee_number is distinct from nullif(upper(btrim(coalesce(target_employee_number, ''))), '')
    or employee_record.job_title is distinct from nullif(btrim(coalesce(target_job_title, '')), '')
    or employee_record.time_zone is distinct from target_time_zone
    or contact_record.personal_email is distinct from nullif(lower(btrim(coalesce(target_personal_email, ''))), '')
    or contact_record.company_email is distinct from nullif(lower(btrim(coalesce(target_company_email, ''))), '')
    or contact_record.mobile_phone is distinct from nullif(btrim(coalesce(target_mobile_phone, '')), '');

  access_changed := previous_primary_role is distinct from target_role
    or old_role_ids is distinct from normalized_access_role_ids;

  if not profile_changed and access_changed then
    perform public.set_employee_workforce_roles(
      target_employee_id,
      target_role,
      normalized_access_role_ids,
      'Primary role or additional roles updated from User Accounts.'
    );

    return private.admin_user_record(target_employee_id);
  end if;

  perform public.admin_update_employee_with_time_zone(
    target_employee_id,
    target_first_name,
    target_middle_name,
    target_last_name,
    target_preferred_name,
    target_role,
    target_employment_type,
    target_status,
    target_employee_number,
    target_job_title,
    target_personal_email,
    target_company_email,
    target_mobile_phone,
    target_time_zone
  );

  perform private.replace_employee_additional_access_roles(
    actor_id,
    target_employee_id,
    normalized_access_role_ids
  );

  return private.admin_user_record(target_employee_id);
end
$$;

revoke all on function public.admin_update_employee_with_time_zone_and_access_roles(
  uuid, text, text, text, text, public.app_role, public.employment_type,
  public.employee_status, text, text, text, text, text, text, uuid[]
) from public, anon;
grant execute on function public.admin_update_employee_with_time_zone_and_access_roles(
  uuid, text, text, text, text, public.app_role, public.employment_type,
  public.employee_status, text, text, text, text, text, text, uuid[]
) to authenticated;

-- roles.manage is sufficient for ordinary role definitions, but the protected
-- system_admin bundle is a recovery boundary. Additive Admin membership does
-- not establish primary-Admin identity, so only public.is_admin() may edit it.
create or replace function public.set_access_role_permissions(
  target_role_id uuid,
  target_permission_codes text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  target_role public.access_roles%rowtype;
  baseline_permissions constant text[] := array[
    'sygsphere.comms.use',
    'sygsphere.comms.ptt.listen',
    'sygsphere.comms.ptt.transmit',
    'sygsphere.comms.call.start',
    'sygsphere.comms.call.receive'
  ]::text[];
  clean_permissions text[];
  old_permissions text[];
begin
  select * into target_role
  from public.access_roles
  where id = target_role_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected role no longer exists.';
  end if;

  if target_role.code = 'system_admin' and not public.is_admin() then
    raise insufficient_privilege using message = 'A primary Admin account is required to edit the protected Admin role.';
  end if;

  if exists (
    select 1
    from unnest(coalesce(target_permission_codes, array[]::text[])) requested_permission(code)
    left join public.permission_catalog catalog
      on catalog.code = requested_permission.code
     and catalog.active
    where catalog.code is null
  ) then
    raise check_violation using message = 'One or more selected permissions are not available.';
  end if;

  select coalesce(array_agg(distinct requested_permission.code order by requested_permission.code), array[]::text[])
  into clean_permissions
  from unnest(
    coalesce(target_permission_codes, array[]::text[])
    || case when target_role.active then baseline_permissions else array[]::text[] end
  ) requested_permission(code);

  if target_role.protected
    and target_role.code = 'system_admin'
    and exists (
      select 1
      from public.permission_catalog catalog
      where catalog.active
        and not (catalog.code = any(clean_permissions))
    )
  then
    raise insufficient_privilege using message = 'The protected Admin role must retain every active permission.';
  end if;

  if target_role.protected
    and target_role.code = 'system_dispatcher'
    and not (
      array[
        'operations.view',
        'scheduler.view',
        'reports.view',
        'time.reports.view'
      ]::text[] <@ clean_permissions
    )
  then
    raise insufficient_privilege
      using message = 'The protected Dispatcher role must retain Home, Scheduler, Reports, and Timekeeping Reports access.';
  end if;

  select coalesce(array_agg(role_permission.permission_code order by role_permission.permission_code), array[]::text[])
  into old_permissions
  from public.access_role_permissions role_permission
  where role_permission.role_id = target_role_id
    and role_permission.enabled;

  update public.access_role_permissions
  set enabled = false,
      updated_at = clock_timestamp()
  where role_id = target_role_id;

  insert into public.access_role_permissions (role_id, permission_code, enabled)
  select target_role_id, requested_permission.code, true
  from unnest(clean_permissions) requested_permission(code)
  on conflict (role_id, permission_code) do update
  set enabled = true,
      updated_at = clock_timestamp();

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
    'access_role_permissions',
    'UPDATE',
    target_role_id::text,
    jsonb_build_object('permissionCodes', old_permissions),
    jsonb_build_object('permissionCodes', clean_permissions)
  );

  return public.get_access_control_center();
end
$$;

revoke all on function public.set_access_role_permissions(uuid, text[])
  from public, anon;
grant execute on function public.set_access_role_permissions(uuid, text[])
  to authenticated;

comment on function public.set_access_role_permissions(uuid, text[]) is
  'Replaces an access-role permission bundle with an audited save. Only a primary Admin may edit system_admin; active employee roles retain the locked SygSphere communications baseline.';

-- Licensing keeps its safe Guard default. A caller with roles.manage may
-- request a non-Guard/non-Admin role; a primary Admin is additionally required
-- only when the source or target primary workforce role is Admin.
create or replace function public.upsert_licensing_employee(
  target_employee_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_preferred_name text,
  target_job_title text,
  target_employment_type public.employment_type,
  target_status public.employee_status,
  target_personal_email text,
  target_company_email text,
  target_mobile_phone text,
  target_role public.app_role,
  target_time_zone text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  working_employee_id uuid := target_employee_id;
  employee_record public.employees%rowtype;
  persisted_time_zone text;
  target_has_active_account boolean;
  existing_role_ids uuid[];
  existing_grant_codes text[];
begin
  actor_id := private.require_licensing_mfa('licensing.manage');

  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;

  if working_employee_id is null then
    if target_time_zone is null
      or target_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles')
    then
      raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
    end if;

    perform private.canonical_system_access_role_id(target_role);

    if target_role is distinct from 'guard'::public.app_role then
      perform private.require_access_control_admin();
    end if;

    if target_role = 'admin' then
      perform pg_advisory_xact_lock(hashtextextended('sygshift.active_admin_recovery', 0));

      if not public.is_admin() then
        raise insufficient_privilege using message = 'A primary Admin account is required to create another Admin.';
      end if;
    end if;
  elsif target_time_zone is not null then
    raise check_violation using message = 'Use User Accounts to change an existing employee time zone.';
  else
    select employee.*
    into employee_record
    from public.employees employee
    where employee.id = working_employee_id
    for update;

    if not found then
      raise no_data_found using message = 'Employee was not found.';
    end if;

    persisted_time_zone := employee_record.time_zone;

    if employee_record.role is distinct from target_role then
      if working_employee_id = actor_id then
        raise insufficient_privilege using message = 'You cannot change your own primary workforce role. Use another Admin or role manager.';
      end if;

      perform private.require_access_control_admin();
      perform private.canonical_system_access_role_id(target_role);
    end if;

    if employee_record.role = 'admin' or target_role = 'admin' then
      perform pg_advisory_xact_lock(hashtextextended('sygshift.active_admin_recovery', 0));

      if not public.is_admin() then
        raise insufficient_privilege using message = 'A primary Admin account is required to promote, demote, or maintain an Admin.';
      end if;
    end if;

    select exists (
      select 1
      from private.employee_accounts account
      where account.employee_id = employee_record.id
        and account.disabled_at is null
    ) into target_has_active_account;

    if employee_record.role = 'admin'
      and employee_record.status = 'active'
      and target_has_active_account
      and (target_role <> 'admin' or target_status <> 'active')
      and private.employee_is_recovery_capable_active_admin(employee_record.id)
      and private.active_admin_account_count() <= 1
    then
      raise check_violation using message = 'At least one recovery-capable active Admin account must remain.';
    end if;

    if employee_record.role is distinct from target_role then
      select coalesce(array_agg(assignment.role_id order by assignment.role_id), array[]::uuid[])
      into existing_role_ids
      from public.employee_access_roles assignment
      where assignment.employee_id = working_employee_id;

      select coalesce(array_agg(permission_override.permission_code order by permission_override.permission_code), array[]::text[])
      into existing_grant_codes
      from public.employee_permission_overrides permission_override
      where permission_override.employee_id = working_employee_id
        and permission_override.active
        and permission_override.effect = 'grant';

      perform public.set_employee_access_profile_with_primary_role(
        working_employee_id,
        target_role,
        existing_role_ids,
        existing_grant_codes,
        'Primary workforce role updated from Licensing.'
      );
    end if;
  end if;

  if target_personal_email is not null
    and btrim(target_personal_email) <> ''
    and btrim(target_personal_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The personal email address is invalid.';
  end if;

  if target_company_email is not null
    and btrim(target_company_email) <> ''
    and btrim(target_company_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The company email address is invalid.';
  end if;

  if working_employee_id is null then
    insert into public.employees (
      username,
      first_name,
      middle_name,
      last_name,
      preferred_name,
      role,
      employment_type,
      status,
      job_title,
      time_zone
    ) values (
      private.generate_username(target_first_name, target_last_name),
      btrim(target_first_name),
      nullif(btrim(coalesce(target_middle_name, '')), ''),
      btrim(target_last_name),
      nullif(btrim(coalesce(target_preferred_name, '')), ''),
      target_role,
      target_employment_type,
      target_status,
      nullif(btrim(coalesce(target_job_title, '')), ''),
      target_time_zone
    )
    returning id, time_zone into working_employee_id, persisted_time_zone;

    insert into private.employee_contacts (
      employee_id,
      personal_email,
      company_email,
      mobile_phone
    ) values (
      working_employee_id,
      nullif(btrim(coalesce(target_personal_email, '')), ''),
      nullif(btrim(coalesce(target_company_email, '')), ''),
      nullif(btrim(coalesce(target_mobile_phone, '')), '')
    );
  else
    update public.employees
    set
      first_name = btrim(target_first_name),
      middle_name = nullif(btrim(coalesce(target_middle_name, '')), ''),
      last_name = btrim(target_last_name),
      preferred_name = nullif(btrim(coalesce(target_preferred_name, '')), ''),
      role = target_role,
      employment_type = target_employment_type,
      status = target_status,
      job_title = nullif(btrim(coalesce(target_job_title, '')), ''),
      updated_at = clock_timestamp()
    where id = working_employee_id;

    insert into private.employee_contacts (
      employee_id,
      personal_email,
      company_email,
      mobile_phone
    ) values (
      working_employee_id,
      nullif(btrim(coalesce(target_personal_email, '')), ''),
      nullif(btrim(coalesce(target_company_email, '')), ''),
      nullif(btrim(coalesce(target_mobile_phone, '')), '')
    )
    on conflict on constraint employee_contacts_pkey do update
    set
      personal_email = excluded.personal_email,
      company_email = excluded.company_email,
      mobile_phone = excluded.mobile_phone,
      updated_at = clock_timestamp();
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employees',
    case when target_employee_id is null then 'LICENSING_EMPLOYEE_CREATE' else 'LICENSING_EMPLOYEE_UPDATE' end,
    working_employee_id::text,
    jsonb_build_object(
      'employeeId', working_employee_id,
      'firstName', btrim(target_first_name),
      'lastName', btrim(target_last_name),
      'role', target_role,
      'employmentType', target_employment_type,
      'employmentStatus', target_status,
      'timeZone', persisted_time_zone
    )
  );

  return public.get_licensing_center();
end
$$;

revoke all on function public.upsert_licensing_employee(
  uuid, text, text, text, text, text, public.employment_type,
  public.employee_status, text, text, text, public.app_role, text
) from public, anon;
grant execute on function public.upsert_licensing_employee(
  uuid, text, text, text, text, text, public.employment_type,
  public.employee_status, text, text, text, public.app_role, text
) to authenticated;

-- Employee creation through Recruiting and Onboarding is performed by a
-- service-role Worker after requireRecentHrSession has verified the operator's
-- recent MFA. The database still revalidates the named, active operator and
-- their effective role-management authority on the exact employee row being
-- inserted. Authenticated import promotion additionally proves that the named
-- operator is the current MFA-verified database actor.
create or replace function private.require_primary_role_creation_authority(
  target_actor_id uuid,
  target_role public.app_role
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_role public.app_role;
  actor_status public.employee_status;
  actor_account_active boolean;
  actor_permissions text[];
begin
  if target_role = 'guard' then
    return;
  end if;

  select employee.role,
         employee.status,
         account.employee_id is not null
           and account.activated_at is not null
           and account.disabled_at is null
  into actor_role, actor_status, actor_account_active
  from public.employees employee
  left join private.employee_accounts account on account.employee_id = employee.id
  where employee.id = target_actor_id;

  if not found
    or actor_status <> 'active'
    or not coalesce(actor_account_active, false)
  then
    raise insufficient_privilege using message = 'An active employee account is required to create a non-Guard role.';
  end if;

  actor_permissions := private.employee_effective_permissions(target_actor_id);
  if not ('admin.roles.manage' = any(coalesce(actor_permissions, array[]::text[]))) then
    raise insufficient_privilege using message = 'Role-management authority with MFA is required to create a non-Guard employee.';
  end if;

  if (select auth.role()) <> 'service_role' then
    if private.current_employee_id() is distinct from target_actor_id
      or not public.has_mfa()
    then
      raise insufficient_privilege using message = 'The current MFA-verified role manager must authorize this employee role.';
    end if;
  end if;

  if target_role = 'admin' and actor_role <> 'admin' then
    raise insufficient_privilege using message = 'A primary Admin must authorize creation of another Admin.';
  end if;
end
$$;

revoke all on function private.require_primary_role_creation_authority(uuid, public.app_role)
  from public, anon, authenticated, service_role;

-- The wrappers below set this transaction-local actor immediately before their
-- protected creation body runs. The trigger sees the final NEW.role value, so
-- a queued candidate or import mapping cannot bypass a later authority change.
create or replace function private.enforce_contextual_primary_role_creation_authority()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  context_actor_text text := nullif(current_setting('sygshift.role_creation_actor_id', true), '');
  context_actor_id uuid;
begin
  if context_actor_text is null then
    return new;
  end if;

  begin
    context_actor_id := context_actor_text::uuid;
  exception when invalid_text_representation then
    raise insufficient_privilege using message = 'The employee-role authorization context is invalid.';
  end;

  perform private.require_primary_role_creation_authority(context_actor_id, new.role);
  return new;
end
$$;

revoke all on function private.enforce_contextual_primary_role_creation_authority()
  from public, anon, authenticated, service_role;

drop trigger if exists employees_contextual_primary_role_creation_authority
  on public.employees;
create trigger employees_contextual_primary_role_creation_authority
before insert on public.employees
for each row execute function private.enforce_contextual_primary_role_creation_authority();

-- Preserve the mature Recruiting conversion body and put a narrow, auditable
-- boundary around it. The existing body still performs module authorization,
-- second-review separation, duplicate detection, data creation, and auditing.
alter function public.service_review_candidate_conversion(uuid, uuid, text, text)
  set schema private;
alter function private.service_review_candidate_conversion(uuid, uuid, text, text)
  rename to review_candidate_conversion_legacy_body;
revoke all on function private.review_candidate_conversion_legacy_body(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

create function public.service_review_candidate_conversion(
  target_actor_id uuid,
  target_request_id uuid,
  target_decision text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  perform set_config('sygshift.role_creation_actor_id', target_actor_id::text, true);
  return private.review_candidate_conversion_legacy_body(
    target_actor_id,
    target_request_id,
    target_decision,
    target_reason
  );
end
$$;

revoke all on function public.service_review_candidate_conversion(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.service_review_candidate_conversion(uuid, uuid, text, text)
  to service_role;

-- The Onboarding Worker has the same recent-MFA service contract. Default
-- Guard pre-hires continue to use onboarding.manage alone; the final insert of
-- any other workforce role activates the additional role-management boundary.
alter function public.service_hr_onboarding_create_prehire(uuid, jsonb, text)
  set schema private;
alter function private.service_hr_onboarding_create_prehire(uuid, jsonb, text)
  rename to hr_onboarding_create_prehire_legacy_body;
revoke all on function private.hr_onboarding_create_prehire_legacy_body(uuid, jsonb, text)
  from public, anon, authenticated, service_role;

create function public.service_hr_onboarding_create_prehire(
  target_actor_id uuid,
  target_payload jsonb,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  perform set_config('sygshift.role_creation_actor_id', target_actor_id::text, true);
  return private.hr_onboarding_create_prehire_legacy_body(
    target_actor_id,
    target_payload,
    target_reason
  );
end
$$;

revoke all on function public.service_hr_onboarding_create_prehire(uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.service_hr_onboarding_create_prehire(uuid, jsonb, text)
  to service_role;

-- The public import RPC remains locked to the already approved Colorado source
-- by its existing body. This wrapper adds the current authenticated operator to
-- the final-write context; require_import_admin still enforces the import
-- module permission and AAL2 before any promotion work begins.
alter function public.promote_import_scope(uuid, date, date, boolean, text)
  set schema private;
alter function private.promote_import_scope(uuid, date, date, boolean, text)
  rename to promote_locked_colorado_import_scope_legacy_body;
revoke all on function private.promote_locked_colorado_import_scope_legacy_body(uuid, date, date, boolean, text)
  from public, anon, authenticated, service_role;

create function public.promote_import_scope(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date,
  target_publish boolean,
  target_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
begin
  perform private.require_import_admin();
  actor_id := private.current_employee_id();
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required for import promotion.';
  end if;

  perform set_config('sygshift.role_creation_actor_id', actor_id::text, true);
  return private.promote_locked_colorado_import_scope_legacy_body(
    target_import_run_id,
    target_from_date,
    target_through_date,
    target_publish,
    target_note
  );
end
$$;

revoke all on function public.promote_import_scope(uuid, date, date, boolean, text)
  from public, anon;
grant execute on function public.promote_import_scope(uuid, date, date, boolean, text)
  to authenticated;

-- This older bootstrap service has no end-user actor or MFA provenance. Keep
-- its conservative Guard import capability, but fail closed instead of using
-- the historical hard-coded actor for any privileged workforce role.
alter function public.service_promote_import_people(uuid)
  set schema private;
alter function private.service_promote_import_people(uuid)
  rename to promote_import_people_legacy_guard_body;
revoke all on function private.promote_import_people_legacy_guard_body(uuid)
  from public, anon, authenticated, service_role;

create function public.service_promote_import_people(
  target_import_run_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  selected_import_run_id uuid := target_import_run_id;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  if selected_import_run_id is null then
    select import_run.id
    into selected_import_run_id
    from private.import_runs import_run
    order by import_run.received_at desc nulls last,
             import_run.started_at desc nulls last,
             import_run.id desc
    limit 1;
  end if;

  if selected_import_run_id is null then
    raise check_violation using message = 'No import run is available.';
  end if;

  if exists (
    with candidate_names as (
      select candidate.*,
             private.normalize_import_label(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(coalesce(candidate.payload ->> 'name', ''), '"[^" ]+"', '', 'g'),
                   '[*?]', '', 'g'
                 ),
                 '[[:space:]]+', ' ', 'g'
               )
             ) as normalized_name,
             (case when nullif(btrim(coalesce(candidate.payload ->> 'email', '')), '') is not null then 2 else 0 end
               + case when nullif(btrim(coalesce(candidate.payload ->> 'phone', '')), '') is not null then 1 else 0 end) as contact_score
      from private.import_candidates candidate
      where candidate.import_run_id = selected_import_run_id
        and candidate.kind = 'employee'
    ), ranked as (
      select candidate_names.*,
             row_number() over (
               partition by normalized_name
               order by contact_score desc, created_at asc, id asc
             ) as duplicate_rank
      from candidate_names
    )
    select 1
    from ranked candidate
    where candidate.duplicate_rank = 1
      and not exists (
        select 1
        from private.import_entity_links link
        where link.candidate_id = candidate.id
          and link.entity_table = 'employees'
      )
      and coalesce(nullif(btrim(candidate.payload ->> 'roleCandidate'), ''), 'guard') <> 'guard'
  ) then
    raise insufficient_privilege using message = 'This legacy import can create Guards only. Use the controlled role-authorized candidate, onboarding, or operational import path for any other role.';
  end if;

  return private.promote_import_people_legacy_guard_body(selected_import_run_id);
end
$$;

revoke all on function public.service_promote_import_people(uuid)
  from public, anon, authenticated;
grant execute on function public.service_promote_import_people(uuid)
  to service_role;

comment on function public.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) is
  'Atomically changes an employee primary workforce role, additive memberships, and direct additions with MFA, role-management authority, normalization, Admin recovery protection, and one audit record.';

commit;
