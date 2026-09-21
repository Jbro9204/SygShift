-- A blocking required-action checkpoint pauses normal workspace and outbound
-- communications use. Keep only the inbound controls necessary for an
-- already-authorized employee to receive a direct call or listen to PTT.
-- Direct employee denials still take precedence in the permission projector.

begin;

set local lock_timeout = '5s';

do $required_action_comms_permissions$
begin
  if exists (
    select 1
    from unnest(array[
      'sygsphere.comms.use',
      'sygsphere.comms.call.receive',
      'sygsphere.comms.ptt.listen'
    ]::text[]) required_permission(code)
    left join public.permission_catalog catalog
      on catalog.code = required_permission.code
      and catalog.active
    where catalog.code is null
  ) then
    raise exception 'Required inbound SygSphere communications permissions are missing or inactive.';
  end if;
end
$required_action_comms_permissions$;

create or replace function private.employee_effective_permissions(target_employee_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  checkpoint_blocks_access boolean := false;
  effective_permissions text[] := array[]::text[];
begin
  -- Evaluate the checkpoint once per permission projection. The prior SQL
  -- predicate evaluated it once for every granted permission.
  if private.employee_required_action_checkpoint_enrolled(target_employee_id) then
    checkpoint_blocks_access := private.employee_has_blocking_required_actions(target_employee_id);
  end if;

  with employee_record as (
    select employee.id, employee.role
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
    limit 1
  ),
  base_roles as (
    select access_role.id
    from public.access_roles access_role
    join employee_record employee on access_role.base_app_role = employee.role
    where access_role.system_role and access_role.active
  ),
  assigned_roles as (
    select access_role.id
    from public.employee_access_roles assignment
    join public.access_roles access_role on access_role.id = assignment.role_id
    join employee_record employee on employee.id = assignment.employee_id
    where access_role.active
  ),
  role_grants as (
    select permission.permission_code
    from public.access_role_permissions permission
    join (select id from base_roles union select id from assigned_roles) role_scope on role_scope.id = permission.role_id
    join public.permission_catalog catalog on catalog.code = permission.permission_code
    where permission.enabled and catalog.active
  ),
  direct_grants as (
    select override.permission_code
    from public.employee_permission_overrides override
    join public.permission_catalog catalog on catalog.code = override.permission_code
    where override.employee_id = target_employee_id
      and override.active and override.effect = 'grant' and catalog.active
  ),
  direct_denies as (
    select override.permission_code
    from public.employee_permission_overrides override
    where override.employee_id = target_employee_id
      and override.active and override.effect = 'deny'
  ),
  granted_permissions as (
    select permission_code from role_grants
    union
    select permission_code from direct_grants
  ),
  allowed_during_checkpoint(permission_code) as (
    values
      ('actions.self.view'::text),
      ('time.punch'::text),
      ('time.self.view'::text),
      ('accountability.report_call_off'::text),
      ('documents.signatures.sign_own'::text),
      ('sygsphere.comms.use'::text),
      ('sygsphere.comms.call.receive'::text),
      ('sygsphere.comms.ptt.listen'::text)
  )
  select coalesce(array_agg(distinct granted.permission_code order by granted.permission_code), array[]::text[])
  into effective_permissions
  from granted_permissions granted
  where not exists (
    select 1 from direct_denies denied where denied.permission_code = granted.permission_code
  )
    and (
      not checkpoint_blocks_access
      or exists (
        select 1 from allowed_during_checkpoint allowed where allowed.permission_code = granted.permission_code
      )
    );

  return coalesce(effective_permissions, array[]::text[]);
end
$$;

-- This projection is only called by protected database entry points. Keep it
-- inaccessible to browser roles after replacing the function.
revoke all on function private.employee_effective_permissions(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
