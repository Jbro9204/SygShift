begin;

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
  clean_role_ids uuid[];
  clean_permission_codes text[];
  clean_reason text := btrim(coalesce(target_reason, ''));
  employee_primary_role public.app_role;
  inherited_permission_codes text[];
  old_role_ids uuid[];
  old_grant_codes text[];
begin
  select coalesce(array_agg(distinct requested_role.id order by requested_role.id), array[]::uuid[])
  into clean_role_ids
  from unnest(coalesce(target_role_ids, array[]::uuid[])) requested_role(id);

  select coalesce(array_agg(distinct requested_permission.code order by requested_permission.code), array[]::text[])
  into clean_permission_codes
  from unnest(coalesce(target_permission_codes, array[]::text[])) requested_permission(code);

  if clean_reason = '' then
    raise check_violation using message = 'An audit reason is required to change employee access.';
  end if;

  select employee.role
  into employee_primary_role
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status = 'active'
  for update;

  if not found then
    raise no_data_found using message = 'The selected employee is not active.';
  end if;

  if exists (
    select 1
    from unnest(clean_role_ids) requested_role(id)
    left join public.access_roles access_role
      on access_role.id = requested_role.id
     and access_role.active
    where access_role.id is null
  ) then
    raise check_violation using message = 'One or more selected roles are not available.';
  end if;

  select coalesce(array_agg(role_id order by role_id), array[]::uuid[])
  into clean_role_ids
  from unnest(clean_role_ids) requested_role(role_id)
  join public.access_roles access_role on access_role.id = requested_role.role_id
  where not (
    access_role.system_role
    and access_role.base_app_role = employee_primary_role
  );

  if exists (
    select 1
    from unnest(clean_permission_codes) requested_permission(code)
    left join public.permission_catalog catalog
      on catalog.code = requested_permission.code
     and catalog.active
    where catalog.code is null
  ) then
    raise check_violation using message = 'One or more selected permission additions are not available.';
  end if;

  select coalesce(array_agg(assignment.role_id order by assignment.role_id), array[]::uuid[])
  into old_role_ids
  from public.employee_access_roles assignment
  where assignment.employee_id = target_employee_id;

  select coalesce(array_agg(permission_override.permission_code order by permission_override.permission_code), array[]::text[])
  into old_grant_codes
  from public.employee_permission_overrides permission_override
  where permission_override.employee_id = target_employee_id
    and permission_override.active
    and permission_override.effect = 'grant';

  with employee_record as (
    select employee.role
    from public.employees employee
    where employee.id = target_employee_id
  ), role_scope as (
    select access_role.id
    from public.access_roles access_role
    join employee_record employee on access_role.base_app_role = employee.role
    where access_role.system_role
      and access_role.active
    union
    select access_role.id
    from unnest(clean_role_ids) requested_role(id)
    join public.access_roles access_role on access_role.id = requested_role.id
    where access_role.active
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
    from unnest(clean_permission_codes) requested_permission(code)
    where requested_permission.code = any(inherited_permission_codes)
  ) then
    raise check_violation using message = 'Individual additions may include only permissions not already inherited from a role.';
  end if;

  if exists (
    select 1
    from unnest(clean_permission_codes) requested_permission(code)
    join public.employee_permission_overrides permission_override
      on permission_override.employee_id = target_employee_id
     and permission_override.permission_code = requested_permission.code
     and permission_override.effect = 'deny'
     and permission_override.active
  ) then
    raise check_violation using message = 'A protected legacy restriction must be reviewed separately before this permission can be added.';
  end if;

  delete from public.employee_access_roles
  where employee_id = target_employee_id
    and not (role_id = any(clean_role_ids));

  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  select target_employee_id, requested_role.id, actor_id
  from unnest(clean_role_ids) requested_role(id)
  on conflict (employee_id, role_id) do update
  set assigned_by = excluded.assigned_by,
      assigned_at = now();

  update public.employee_permission_overrides permission_override
  set active = false,
      updated_at = now()
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
  on conflict (employee_id, permission_code) where active do update
  set effect = 'grant',
      reason = excluded.reason,
      created_by = excluded.created_by,
      updated_at = now();

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  )
  values (
    (select auth.uid()),
    actor_id,
    'public',
    'employee_access_profile',
    'UPDATE',
    target_employee_id::text,
    jsonb_build_object(
      'roleIds', old_role_ids,
      'permissionAdditions', old_grant_codes
    ),
    jsonb_build_object(
      'roleIds', clean_role_ids,
      'permissionAdditions', clean_permission_codes,
      'reason', clean_reason
    )
  );

  return public.get_access_control_center();
end
$$;

create or replace function public.get_access_control_center()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
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
          where employee.status = 'active'
            and access_role.system_role
            and employee.role = access_role.base_app_role
          union
          select assignment.employee_id
          from public.employee_access_roles assignment
          join public.employees employee on employee.id = assignment.employee_id
          where assignment.role_id = access_role.id
            and employee.status = 'active'
        ) role_employee
      ) assignments on true
      where access_role.active
    ),
    'users', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'displayName', employee.first_name || ' ' || employee.last_name,
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
          and access_role.active
          and not (
            access_role.system_role
            and access_role.base_app_role = employee.role
          )
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
      where employee.status = 'active'
    )
  );
end
$$;

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

  select coalesce(array_agg(distinct requested_permission.code order by requested_permission.code), array[]::text[])
  into clean_permissions
  from unnest(coalesce(target_permission_codes, array[]::text[])) requested_permission(code);

  if target_role.protected
    and target_role.code = 'system_admin'
    and (
      not ('admin.roles.manage' = any(clean_permissions))
      or not ('admin.users.manage' = any(clean_permissions))
      or not ('admin.security.manage' = any(clean_permissions))
    )
  then
    raise insufficient_privilege using message = 'Protected Admin permissions cannot be removed.';
  end if;

  if exists (
    select 1
    from unnest(clean_permissions) requested_permission(code)
    left join public.permission_catalog catalog
      on catalog.code = requested_permission.code
     and catalog.active
    where catalog.code is null
  ) then
    raise check_violation using message = 'One or more selected permissions are not available.';
  end if;

  select coalesce(array_agg(role_permission.permission_code order by role_permission.permission_code), array[]::text[])
  into old_permissions
  from public.access_role_permissions role_permission
  where role_permission.role_id = target_role_id
    and role_permission.enabled;

  update public.access_role_permissions
  set enabled = false,
      updated_at = now()
  where role_id = target_role_id;

  insert into public.access_role_permissions (role_id, permission_code, enabled)
  select target_role_id, requested_permission.code, true
  from unnest(clean_permissions) requested_permission(code)
  on conflict (role_id, permission_code) do update
  set enabled = true,
      updated_at = now();

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  )
  values (
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

revoke all on function public.set_employee_access_profile(uuid, uuid[], text[], text) from public, anon;
grant execute on function public.set_employee_access_profile(uuid, uuid[], text[], text) to authenticated;

revoke all on function public.set_access_role_permissions(uuid, text[]) from public, anon;
grant execute on function public.set_access_role_permissions(uuid, text[]) to authenticated;

commit;
