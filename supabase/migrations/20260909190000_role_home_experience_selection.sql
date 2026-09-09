begin;

-- Home is an authenticated destination for every employee. This presentation
-- permission selects the management-oriented landing experience; the existing
-- operations.view permission continues to protect the data shown on that page.
do $$
begin
  if (
    select count(*)
    from public.access_roles access_role
    where access_role.active
      and access_role.code = any(array[
        'system_admin',
        'system_supervisor',
        'custom_chief',
        'human_resources',
        'operations_manager'
      ]::text[])
  ) <> 5 then
    raise check_violation
      using message = 'One or more established Operations Home roles are unavailable; no Home experience change was applied.';
  end if;

  if exists (
    select 1
    from public.access_roles access_role
    where access_role.active
      and access_role.code = any(array[
        'system_admin',
        'system_supervisor',
        'custom_chief',
        'human_resources',
        'operations_manager'
      ]::text[])
      and not exists (
        select 1
        from public.access_role_permissions role_permission
        where role_permission.role_id = access_role.id
          and role_permission.permission_code = 'operations.view'
          and role_permission.enabled
      )
  ) then
    raise check_violation
      using message = 'An Operations Home role is missing operations dashboard access; no Home experience change was applied.';
  end if;
end
$$;

create temp table home_experience_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_access_role_count,
  (select count(*) from public.employee_permission_overrides) as employee_override_count,
  (select count(*) from public.access_roles) as access_role_count,
  (
    select coalesce(
      md5(string_agg(
        concat_ws(':', catalog.code, catalog.category, catalog.name, catalog.description, catalog.risk_level, catalog.requires_mfa, catalog.locked, catalog.active),
        '|' order by catalog.code
      )),
      md5('')
    )
    from public.permission_catalog catalog
    where catalog.code <> 'home.operations.view'
  ) as other_catalog_fingerprint,
  (
    select coalesce(
      md5(string_agg(
        concat_ws(':', role_permission.role_id::text, role_permission.permission_code, role_permission.enabled::text),
        '|' order by role_permission.role_id, role_permission.permission_code
      )),
      md5('')
    )
    from public.access_role_permissions role_permission
    where role_permission.permission_code <> 'home.operations.view'
  ) as other_role_permission_fingerprint;

create temp table home_experience_target_baseline on commit drop as
select
  access_role.id as role_id,
  access_role.code as role_code,
  coalesce(role_permission.enabled, false) as previously_enabled
from public.access_roles access_role
left join public.access_role_permissions role_permission
  on role_permission.role_id = access_role.id
 and role_permission.permission_code = 'home.operations.view'
where access_role.code = any(array[
  'system_admin',
  'system_supervisor',
  'custom_chief',
  'human_resources',
  'operations_manager'
]::text[]);

insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
)
values (
  'home.operations.view',
  'Home',
  'Use Operations Home',
  'Use the management-focused Home with company coverage, staffing totals, priority queues, and authorized operational workspaces.',
  'standard',
  false,
  false,
  true
)
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = excluded.active,
    updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select baseline.role_id, 'home.operations.view', true
from home_experience_target_baseline baseline
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

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
)
select
  null,
  null,
  'migration:20260909190000',
  'public',
  'access_role_permissions',
  'UPDATE',
  baseline.role_id::text,
  jsonb_build_object(
    'homeExperience', case when baseline.previously_enabled then 'operations' else 'basic' end,
    'permissionCode', 'home.operations.view',
    'roleCode', baseline.role_code,
    'source', 'role-home-experience-release'
  ),
  jsonb_build_object(
    'homeExperience', 'operations',
    'permissionCode', 'home.operations.view',
    'roleCode', baseline.role_code,
    'source', 'role-home-experience-release'
  )
from home_experience_target_baseline baseline
where not baseline.previously_enabled;

do $$
declare
  baseline home_experience_baseline%rowtype;
begin
  select * into strict baseline from home_experience_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_access_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.employee_override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.access_role_count <> (select count(*) from public.access_roles)
  then
    raise exception 'Home experience release changed protected employee, assignment, override, or role records.';
  end if;

  if baseline.other_catalog_fingerprint is distinct from (
    select coalesce(
      md5(string_agg(
        concat_ws(':', catalog.code, catalog.category, catalog.name, catalog.description, catalog.risk_level, catalog.requires_mfa, catalog.locked, catalog.active),
        '|' order by catalog.code
      )),
      md5('')
    )
    from public.permission_catalog catalog
    where catalog.code <> 'home.operations.view'
  ) then
    raise exception 'Home experience release changed another permission definition.';
  end if;

  if baseline.other_role_permission_fingerprint is distinct from (
    select coalesce(
      md5(string_agg(
        concat_ws(':', role_permission.role_id::text, role_permission.permission_code, role_permission.enabled::text),
        '|' order by role_permission.role_id, role_permission.permission_code
      )),
      md5('')
    )
    from public.access_role_permissions role_permission
    where role_permission.permission_code <> 'home.operations.view'
  ) then
    raise exception 'Home experience release changed an unrelated role permission.';
  end if;

  if exists (
    select 1
    from home_experience_target_baseline target
    where not exists (
      select 1
      from public.access_role_permissions role_permission
      where role_permission.role_id = target.role_id
        and role_permission.permission_code = 'home.operations.view'
        and role_permission.enabled
    )
  ) then
    raise exception 'Home experience release did not assign Operations Home to every established leadership role.';
  end if;

  if not exists (
    select 1
    from public.permission_catalog catalog
    where catalog.code = 'home.operations.view'
      and catalog.category = 'Home'
      and catalog.name = 'Use Operations Home'
      and catalog.risk_level = 'standard'
      and not catalog.requires_mfa
      and not catalog.locked
      and catalog.active
  ) then
    raise exception 'The Operations Home permission was not created with the approved definition.';
  end if;

  if exists (
    select 1
    from public.permission_catalog catalog
    where catalog.active
      and not exists (
        select 1
        from public.access_roles access_role
        join public.access_role_permissions role_permission
          on role_permission.role_id = access_role.id
        where access_role.code = 'system_admin'
          and access_role.active
          and role_permission.permission_code = catalog.code
          and role_permission.enabled
      )
  ) then
    raise exception 'The protected Admin role does not retain every active permission.';
  end if;
end
$$;

commit;
