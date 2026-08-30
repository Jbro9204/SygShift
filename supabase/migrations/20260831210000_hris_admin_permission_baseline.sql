begin;

-- This is the reviewed HRIS access activation for the protected Admin role.
-- It intentionally grants every permission that is active at the time of this
-- migration. Future catalog additions still require a separate reviewed change.

create temporary table hris_admin_permission_baseline on commit drop as
select
  (
    select count(*)
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where access_role.code <> 'system_admin'
  ) as non_admin_role_permission_count,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', access_role.code, role_permission.permission_code, role_permission.enabled::text),
      '|' order by access_role.code, role_permission.permission_code
    )), md5(''))
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where access_role.code <> 'system_admin'
  ) as non_admin_role_permission_fingerprint,
  (select count(*) from public.employee_access_roles) as employee_access_role_count,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', employee_id::text, role_id::text),
      '|' order by employee_id, role_id
    )), md5(''))
    from public.employee_access_roles
  ) as employee_access_role_fingerprint,
  (select count(*) from public.employee_permission_overrides) as employee_override_count,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', employee_id::text, permission_code, effect, active::text),
      '|' order by employee_id, permission_code, id
    )), md5(''))
    from public.employee_permission_overrides
  ) as employee_override_fingerprint,
  (select count(*) from public.employees) as employee_count,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', id::text, username, role::text, status::text),
      '|' order by id
    )), md5(''))
    from public.employees
  ) as employee_identity_fingerprint,
  (
    (select count(*) from private.hr_stage2_backfill_gate where enabled)
    + (select count(*) from private.hr_document_release_gate where enabled)
    + (select count(*) from private.hr_automation_release_gate where enabled)
    + (select count(*) from private.hr_recruiting_release_gate where enabled)
    + (select count(*) from private.hr_onboarding_release_gate where enabled)
    + (select count(*) from private.hr_leave_release_gate where enabled)
    + (select count(*) from private.hr_benefits_release_gate where enabled)
    + (select count(*) from private.hr_compensation_release_gate where enabled)
    + (select count(*) from private.hr_stage8_release_gates where enabled)
    + (select count(*) from private.hr_stage9_release_gates where enabled)
    + (select count(*) from private.hr_stage10_release_gates where enabled)
  ) as enabled_hr_release_gate_count;

do $$
begin
  if not exists (
    select 1
    from public.access_roles
    where code = 'system_admin'
      and protected
      and active
  ) then
    raise exception using message = 'The protected Admin role is unavailable; no access change was applied.';
  end if;

  if (select enabled_hr_release_gate_count from hris_admin_permission_baseline) <> 0 then
    raise exception using message = 'One or more dormant HR release gates were already enabled; Admin activation was stopped for review.';
  end if;
end
$$;

insert into public.access_role_permissions (role_id, permission_code, enabled)
select admin_role.id, permission.code, true
from public.access_roles admin_role
cross join public.permission_catalog permission
where admin_role.code = 'system_admin'
  and admin_role.protected
  and admin_role.active
  and permission.active
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

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

create or replace function private.repair_system_admin_permission_baseline()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  admin_role_id uuid;
  before_count integer;
  after_count integer;
  catalog_count integer;
begin
  select id into admin_role_id
  from public.access_roles
  where code = 'system_admin'
    and protected
    and active
  for update;

  if admin_role_id is null then
    raise exception using message = 'The protected Admin role is unavailable.';
  end if;

  select count(*) into before_count
  from public.access_role_permissions
  where role_id = admin_role_id
    and enabled;

  insert into public.access_role_permissions (role_id, permission_code, enabled)
  select admin_role_id, permission.code, true
  from public.permission_catalog permission
  where permission.active
  on conflict (role_id, permission_code) do update
  set enabled = true,
      updated_at = clock_timestamp();

  select count(*) into catalog_count
  from public.permission_catalog
  where active;

  select count(*) into after_count
  from public.access_role_permissions role_permission
  join public.permission_catalog permission on permission.code = role_permission.permission_code
  where role_permission.role_id = admin_role_id
    and role_permission.enabled
    and permission.active;

  insert into private.audit_events (
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  )
  values (
    'public',
    'access_role_permissions',
    'REPAIR',
    admin_role_id::text,
    jsonb_build_object('enabledPermissionCount', before_count),
    jsonb_build_object(
      'activeCatalogPermissionCount', catalog_count,
      'enabledActivePermissionCount', after_count,
      'scope', 'reviewed-current-catalog-only'
    )
  );

  return jsonb_build_object(
    'roleCode', 'system_admin',
    'beforeEnabledPermissionCount', before_count,
    'activeCatalogPermissionCount', catalog_count,
    'afterEnabledActivePermissionCount', after_count,
    'complete', after_count = catalog_count
  );
end
$$;

revoke all on function public.set_access_role_permissions(uuid, text[]) from public, anon;
grant execute on function public.set_access_role_permissions(uuid, text[]) to authenticated;

revoke all on function private.repair_system_admin_permission_baseline() from public, anon, authenticated;
grant execute on function private.repair_system_admin_permission_baseline() to service_role;

do $$
declare
  baseline hris_admin_permission_baseline%rowtype;
  active_permission_count integer;
  admin_permission_count integer;
  current_enabled_gate_count integer;
begin
  select * into baseline from hris_admin_permission_baseline;

  select count(*) into active_permission_count
  from public.permission_catalog
  where active;

  select count(*) into admin_permission_count
  from public.access_role_permissions role_permission
  join public.access_roles access_role on access_role.id = role_permission.role_id
  join public.permission_catalog permission on permission.code = role_permission.permission_code
  where access_role.code = 'system_admin'
    and role_permission.enabled
    and permission.active;

  if admin_permission_count <> active_permission_count then
    raise exception using message = 'Admin permission activation did not cover the complete active catalog.';
  end if;

  if baseline.non_admin_role_permission_count <> (
    select count(*)
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where access_role.code <> 'system_admin'
  ) or baseline.non_admin_role_permission_fingerprint <> (
    select coalesce(md5(string_agg(
      concat_ws(':', access_role.code, role_permission.permission_code, role_permission.enabled::text),
      '|' order by access_role.code, role_permission.permission_code
    )), md5(''))
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where access_role.code <> 'system_admin'
  ) then
    raise exception using message = 'A non-Admin role permission changed during Admin activation.';
  end if;

  if baseline.employee_access_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.employee_access_role_fingerprint <> (
      select coalesce(md5(string_agg(
        concat_ws(':', employee_id::text, role_id::text),
        '|' order by employee_id, role_id
      )), md5(''))
      from public.employee_access_roles
    )
  then
    raise exception using message = 'Employee role assignments changed during Admin activation.';
  end if;

  if baseline.employee_override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.employee_override_fingerprint <> (
      select coalesce(md5(string_agg(
        concat_ws(':', employee_id::text, permission_code, effect, active::text),
        '|' order by employee_id, permission_code, id
      )), md5(''))
      from public.employee_permission_overrides
    )
  then
    raise exception using message = 'Employee permission overrides changed during Admin activation.';
  end if;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_identity_fingerprint <> (
      select coalesce(md5(string_agg(
        concat_ws(':', id::text, username, role::text, status::text),
        '|' order by id
      )), md5(''))
      from public.employees
    )
  then
    raise exception using message = 'Employee identities or primary roles changed during Admin activation.';
  end if;

  select
    (select count(*) from private.hr_stage2_backfill_gate where enabled)
    + (select count(*) from private.hr_document_release_gate where enabled)
    + (select count(*) from private.hr_automation_release_gate where enabled)
    + (select count(*) from private.hr_recruiting_release_gate where enabled)
    + (select count(*) from private.hr_onboarding_release_gate where enabled)
    + (select count(*) from private.hr_leave_release_gate where enabled)
    + (select count(*) from private.hr_benefits_release_gate where enabled)
    + (select count(*) from private.hr_compensation_release_gate where enabled)
    + (select count(*) from private.hr_stage8_release_gates where enabled)
    + (select count(*) from private.hr_stage9_release_gates where enabled)
    + (select count(*) from private.hr_stage10_release_gates where enabled)
  into current_enabled_gate_count;

  if current_enabled_gate_count <> 0 or current_enabled_gate_count <> baseline.enabled_hr_release_gate_count then
    raise exception using message = 'A dormant HR release gate changed during Admin activation.';
  end if;

  insert into private.audit_events (
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  )
  select
    'public',
    'access_role_permissions',
    'MIGRATION',
    access_role.id::text,
    jsonb_build_object(
      'roleCode', access_role.code,
      'enabledActivePermissionCount', admin_permission_count,
      'activeCatalogPermissionCount', active_permission_count,
      'scope', 'reviewed-current-catalog-only',
      'otherAccessPreserved', true,
      'hrReleaseGatesRemainDisabled', true
    )
  from public.access_roles access_role
  where access_role.code = 'system_admin';
end
$$;

notify pgrst, 'reload schema';

commit;
