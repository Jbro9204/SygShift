begin;

-- Supabase exposes public functions through the Data API. Keep the stable RPC
-- names there as SECURITY INVOKER entrypoints, while the privileged bodies live
-- in a schema that is intentionally absent from api.schemas in config.toml.
-- Use a dedicated schema and fail closed if it unexpectedly already exists.
-- Supabase migrations run as postgres; pinning ownership prevents a pre-existing
-- or untrusted owner from becoming the owner of privileged implementations.
create schema sygshift_access_internal authorization postgres;

revoke all on schema sygshift_access_internal from public, anon, authenticated, service_role;
grant usage on schema sygshift_access_internal to authenticated;

alter default privileges for role postgres in schema sygshift_access_internal
  revoke execute on functions from public, anon, authenticated, service_role;

comment on schema sygshift_access_internal is
  'Non-exposed implementation schema. Privileged helpers repeat their own authorization checks and are reached through public SECURITY INVOKER RPC wrappers.';

-- SET SCHEMA preserves the original function OID. A view, trigger, expression,
-- or SQL-standard function bound to that OID would therefore follow it into
-- the implementation schema instead of resolving the new public wrapper.
-- Fail closed rather than silently changing such a consumer's boundary.
do $dependency_preflight$
begin
  if exists (
    select 1
    from pg_catalog.pg_depend dependency_record
    where dependency_record.refclassid = 'pg_catalog.pg_proc'::regclass
      and dependency_record.refobjid in (
        'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
        'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure
      )
  ) then
    raise dependent_objects_still_exist using message =
      'A database object is bound to an access-profile RPC. Review pg_depend before installing the SECURITY INVOKER boundary.';
  end if;
end
$dependency_preflight$;

-- Move the installed implementation rather than duplicating it. ALTER keeps
-- its owner, body, volatility, audit behavior, row locks, and SECURITY DEFINER
-- execution context intact.
alter function public.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) set schema sygshift_access_internal;

alter function sygshift_access_internal.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) security definer;

alter function sygshift_access_internal.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) set search_path = '';

alter function sygshift_access_internal.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) owner to postgres;

revoke all on function sygshift_access_internal.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) from public, anon, authenticated, service_role;
grant execute on function sygshift_access_internal.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) to authenticated;

create function public.set_employee_access_profile_with_primary_role(
  target_employee_id uuid,
  target_primary_role public.app_role,
  target_role_ids uuid[],
  target_permission_codes text[],
  target_reason text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select sygshift_access_internal.set_employee_access_profile_with_primary_role(
    target_employee_id,
    target_primary_role,
    target_role_ids,
    target_permission_codes,
    target_reason
  )
$$;

revoke all on function public.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) from public, anon, authenticated, service_role;
grant execute on function public.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) to authenticated;

comment on function public.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) is
  'SECURITY INVOKER Data API boundary for the non-exposed, authorization-enforcing atomic access-profile implementation.';

comment on function sygshift_access_internal.set_employee_access_profile_with_primary_role(
  uuid, public.app_role, uuid[], text[], text
) is
  'Non-exposed SECURITY DEFINER implementation for atomic primary role, additive role, and direct-permission changes.';

-- Apply the same boundary to the role-only endpoint. Replacing the moved body
-- changes only its final internal call; all authorization, row locking, direct
-- grant preservation, and self-lockout behavior remains byte-for-byte aligned
-- with the installed implementation.
alter function public.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) set schema sygshift_access_internal;

create or replace function sygshift_access_internal.set_employee_workforce_roles(
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

  select coalesce(
    array_agg(permission_override.permission_code order by permission_override.permission_code),
    array[]::text[]
  )
  into current_grant_codes
  from public.employee_permission_overrides permission_override
  where permission_override.employee_id = target_employee_id
    and permission_override.active
    and permission_override.effect = 'grant';

  return sygshift_access_internal.set_employee_access_profile_with_primary_role(
    target_employee_id,
    target_primary_role,
    target_role_ids,
    current_grant_codes,
    target_reason
  );
end
$$;

alter function sygshift_access_internal.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) owner to postgres;

revoke all on function sygshift_access_internal.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) from public, anon, authenticated, service_role;
grant execute on function sygshift_access_internal.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) to authenticated;

create function public.set_employee_workforce_roles(
  target_employee_id uuid,
  target_primary_role public.app_role,
  target_role_ids uuid[],
  target_reason text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select sygshift_access_internal.set_employee_workforce_roles(
    target_employee_id,
    target_primary_role,
    target_role_ids,
    target_reason
  )
$$;

revoke all on function public.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) from public, anon, authenticated, service_role;
grant execute on function public.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) to authenticated;

comment on function public.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) is
  'SECURITY INVOKER Data API boundary for role-only saves that preserve direct grants under the employee row lock.';

comment on function sygshift_access_internal.set_employee_workforce_roles(
  uuid, public.app_role, uuid[], text
) is
  'Non-exposed SECURITY DEFINER implementation for role-only saves with write-time direct-grant preservation.';

commit;
