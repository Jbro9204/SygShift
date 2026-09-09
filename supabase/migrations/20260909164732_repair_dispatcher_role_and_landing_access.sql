begin;

-- Repair the protected Dispatcher baseline in place. The primary app-role enum,
-- MFA policy, schedule/timekeeping defaults, and notification routing all refer
-- to system_dispatcher, so replacing that role would sever canonical identity
-- relationships instead of repairing them.
do $$
begin
  if not exists (
    select 1
    from public.access_roles access_role
    where access_role.code = 'system_dispatcher'
      and access_role.base_app_role = 'dispatcher'
      and access_role.system_role
      and access_role.protected
      and access_role.mfa_required
      and access_role.active
  ) then
    raise check_violation
      using message = 'The active protected Dispatcher role is unavailable; no access repair was applied.';
  end if;

  if exists (
    select 1
    from unnest(array[
      'operations.view',
      'scheduler.view',
      'reports.view',
      'time.reports.view'
    ]::text[]) required_permission(code)
    left join public.permission_catalog catalog
      on catalog.code = required_permission.code
     and catalog.active
    where catalog.code is null
  ) then
    raise check_violation
      using message = 'One or more required Dispatcher permissions are unavailable; no access repair was applied.';
  end if;
end
$$;

create temp table dispatcher_access_repair_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_access_role_count,
  (select count(*) from public.employee_permission_overrides) as employee_override_count,
  (select count(*) from public.access_roles) as access_role_count,
  (
    select coalesce(
      md5(string_agg(
        concat_ws(':', role_permission.role_id::text, role_permission.permission_code, role_permission.enabled::text),
        '|' order by role_permission.role_id, role_permission.permission_code
      )),
      md5('')
    )
    from public.access_role_permissions role_permission
    where role_permission.role_id <> (
      select id from public.access_roles where code = 'system_dispatcher'
    )
  ) as other_role_permission_fingerprint,
  (
    select coalesce(
      md5(string_agg(
        concat_ws(':', role_permission.permission_code, role_permission.enabled::text),
        '|' order by role_permission.permission_code
      )),
      md5('')
    )
    from public.access_role_permissions role_permission
    where role_permission.role_id = (
      select id from public.access_roles where code = 'system_dispatcher'
    )
      and role_permission.permission_code <> all(array[
        'operations.view',
        'scheduler.view',
        'reports.view',
        'time.reports.view'
      ]::text[])
  ) as dispatcher_other_permission_fingerprint;

do $$
declare
  dispatcher_role_id uuid;
  old_permissions text[];
  new_permissions text[];
begin
  select id
  into strict dispatcher_role_id
  from public.access_roles
  where code = 'system_dispatcher';

  select coalesce(
    array_agg(role_permission.permission_code order by role_permission.permission_code),
    array[]::text[]
  )
  into old_permissions
  from public.access_role_permissions role_permission
  where role_permission.role_id = dispatcher_role_id
    and role_permission.enabled;

  insert into public.access_role_permissions (role_id, permission_code, enabled)
  select dispatcher_role_id, required_permission.code, true
  from unnest(array[
    'operations.view',
    'scheduler.view',
    'reports.view',
    'time.reports.view'
  ]::text[]) required_permission(code)
  on conflict (role_id, permission_code) do update
  set enabled = true,
      updated_at = now();

  select coalesce(
    array_agg(role_permission.permission_code order by role_permission.permission_code),
    array[]::text[]
  )
  into new_permissions
  from public.access_role_permissions role_permission
  where role_permission.role_id = dispatcher_role_id
    and role_permission.enabled;

  if old_permissions is distinct from new_permissions then
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
    values (
      null,
      null,
      'migration:20260909164732',
      'public',
      'access_role_permissions',
      'UPDATE',
      dispatcher_role_id::text,
      jsonb_build_object('permissionCodes', old_permissions, 'source', 'dispatcher-role-repair'),
      jsonb_build_object('permissionCodes', new_permissions, 'source', 'dispatcher-role-repair')
    );
  end if;
end
$$;

-- Prevent a future permission-editor save from silently removing the four
-- established Dispatcher workspaces again. Other Dispatcher permissions remain
-- editable through the existing audited workflow.
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

comment on function public.set_access_role_permissions(uuid, text[]) is
  'Replaces an access-role permission bundle with an audited save. The protected Admin role retains every active permission and the protected Dispatcher role retains its required Home, Scheduler, Reports, and Timekeeping Reports baseline.';

do $$
declare
  baseline dispatcher_access_repair_baseline%rowtype;
begin
  select * into strict baseline from dispatcher_access_repair_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_access_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.employee_override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.access_role_count <> (select count(*) from public.access_roles)
  then
    raise exception 'Dispatcher access repair changed protected employee, assignment, override, or role records.';
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
    where role_permission.role_id <> (
      select id from public.access_roles where code = 'system_dispatcher'
    )
  ) then
    raise exception 'Dispatcher access repair changed another role permission bundle.';
  end if;

  if baseline.dispatcher_other_permission_fingerprint is distinct from (
    select coalesce(
      md5(string_agg(
        concat_ws(':', role_permission.permission_code, role_permission.enabled::text),
        '|' order by role_permission.permission_code
      )),
      md5('')
    )
    from public.access_role_permissions role_permission
    where role_permission.role_id = (
      select id from public.access_roles where code = 'system_dispatcher'
    )
      and role_permission.permission_code <> all(array[
        'operations.view',
        'scheduler.view',
        'reports.view',
        'time.reports.view'
      ]::text[])
  ) then
    raise exception 'Dispatcher access repair changed an unrelated Dispatcher permission.';
  end if;

  if exists (
    select 1
    from unnest(array[
      'operations.view',
      'scheduler.view',
      'reports.view',
      'time.reports.view'
    ]::text[]) required_permission(code)
    where not exists (
      select 1
      from public.access_roles access_role
      join public.access_role_permissions role_permission
        on role_permission.role_id = access_role.id
      where access_role.code = 'system_dispatcher'
        and role_permission.permission_code = required_permission.code
        and role_permission.enabled
    )
  ) then
    raise exception 'Dispatcher access repair did not restore the complete required baseline.';
  end if;
end
$$;

commit;
