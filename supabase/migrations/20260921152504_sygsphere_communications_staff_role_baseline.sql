begin;
set local lock_timeout = '5s';

-- `access_roles` is the employee-only authorization model: it is assigned
-- exclusively through employee_access_roles, whose subject is a public.employees
-- record. Client and public-portal identities do not use this table or this
-- permission projection. Every active employee role therefore gets the basic,
-- user-initiated communications baseline. A person-specific deny still wins in
-- private.employee_effective_permissions when an individual must be excluded.
do $baseline_catalog$
begin
  if exists (
    select 1
    from unnest(array[
      'sygsphere.comms.use',
      'sygsphere.comms.ptt.listen',
      'sygsphere.comms.ptt.transmit',
      'sygsphere.comms.call.start',
      'sygsphere.comms.call.receive'
    ]::text[]) required_permission(code)
    left join public.permission_catalog permission
      on permission.code = required_permission.code
     and permission.active
    where permission.code is null
  ) then
    raise check_violation using message = 'The active SygSphere Communications baseline is unavailable.';
  end if;
end
$baseline_catalog$;

create or replace function private.ensure_sygsphere_communications_staff_role_baseline(
  target_role_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  role_is_active boolean := false;
begin
  select access_role.active
  into role_is_active
  from public.access_roles access_role
  where access_role.id = target_role_id;

  -- An inactive role never contributes effective permissions. Leave its saved
  -- bundle untouched; activation is what establishes the staff baseline.
  if not coalesce(role_is_active, false) then
    return;
  end if;

  insert into public.access_role_permissions (role_id, permission_code, enabled)
  select target_role_id, required_permission.code, true
  from unnest(array[
    'sygsphere.comms.use',
    'sygsphere.comms.ptt.listen',
    'sygsphere.comms.ptt.transmit',
    'sygsphere.comms.call.start',
    'sygsphere.comms.call.receive'
  ]::text[]) required_permission(code)
  join public.permission_catalog permission
    on permission.code = required_permission.code
   and permission.active
  on conflict (role_id, permission_code) do update
  set enabled = true,
      updated_at = clock_timestamp();
end
$$;

create or replace function private.apply_sygsphere_communications_staff_role_baseline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active then
    perform private.ensure_sygsphere_communications_staff_role_baseline(new.id);
  end if;

  return new;
end
$$;

drop trigger if exists ensure_sygsphere_communications_staff_role_baseline on public.access_roles;
create trigger ensure_sygsphere_communications_staff_role_baseline
after insert or update of active on public.access_roles
for each row
when (new.active)
execute function private.apply_sygsphere_communications_staff_role_baseline();

-- Repair existing active employee-role bundles. This is additive and leaves
-- employee assignments, individual overrides, and every non-baseline permission
-- unchanged.
select private.ensure_sygsphere_communications_staff_role_baseline(access_role.id)
from public.access_roles access_role
where access_role.active;

-- The role editor is a full-bundle save. Normalize its requested permissions
-- with the locked baseline so a routine role edit cannot quietly disconnect a
-- staff member from the global communications runtime. Individual employee
-- denies remain the intentional, audited exception path.
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

revoke all on function private.ensure_sygsphere_communications_staff_role_baseline(uuid) from public, anon, authenticated;
revoke all on function private.apply_sygsphere_communications_staff_role_baseline() from public, anon, authenticated;
revoke all on function public.set_access_role_permissions(uuid, text[]) from public, anon;
grant execute on function public.set_access_role_permissions(uuid, text[]) to authenticated;

comment on function private.ensure_sygsphere_communications_staff_role_baseline(uuid) is
  'Adds the locked, user-initiated SygSphere communications baseline to one active employee access role. Client/public identities are not modeled by access_roles; individual employee denies remain authoritative.';
comment on function public.set_access_role_permissions(uuid, text[]) is
  'Replaces an access-role permission bundle with an audited save. Active employee roles retain the locked SygSphere communications baseline; individual employee denies remain the intentional exclusion path.';

do $baseline_assertion$
begin
  if exists (
    select 1
    from public.access_roles access_role
    cross join unnest(array[
      'sygsphere.comms.use',
      'sygsphere.comms.ptt.listen',
      'sygsphere.comms.ptt.transmit',
      'sygsphere.comms.call.start',
      'sygsphere.comms.call.receive'
    ]::text[]) required_permission(code)
    left join public.access_role_permissions role_permission
      on role_permission.role_id = access_role.id
     and role_permission.permission_code = required_permission.code
     and role_permission.enabled
    where access_role.active
      and role_permission.role_id is null
  ) then
    raise check_violation using message = 'An active employee role is missing the SygSphere Communications baseline.';
  end if;
end
$baseline_assertion$;

notify pgrst, 'reload schema';
commit;
