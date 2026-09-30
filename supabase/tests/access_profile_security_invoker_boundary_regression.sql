begin;

set local statement_timeout = '15s';

do $access_profile_security_invoker_boundary_regression$
declare
  public_profile_definition text := pg_get_functiondef(
    'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure
  );
  public_roles_definition text := pg_get_functiondef(
    'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure
  );
  internal_profile_definition text := pg_get_functiondef(
    'sygshift_access_internal.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure
  );
  internal_roles_definition text := pg_get_functiondef(
    'sygshift_access_internal.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure
  );
begin
  assert not exists (
    select 1
    from pg_catalog.pg_proc function_record
    join pg_catalog.pg_namespace namespace_record
      on namespace_record.oid = function_record.pronamespace
    where namespace_record.nspname = 'public'
      and function_record.oid in (
        'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
        'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure
      )
      and function_record.prosecdef
  ), 'An exposed access-profile RPC is still SECURITY DEFINER.';

  assert (
    select count(*) = 2
    from pg_catalog.pg_proc function_record
    join pg_catalog.pg_namespace namespace_record
      on namespace_record.oid = function_record.pronamespace
    join pg_catalog.pg_language language_record
      on language_record.oid = function_record.prolang
    where namespace_record.nspname = 'public'
      and function_record.oid in (
        'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
        'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure
      )
      and not function_record.prosecdef
      and function_record.provolatile = 'v'
      and language_record.lanname = 'sql'
      and exists (
        select 1
        from unnest(coalesce(function_record.proconfig, array[]::text[])) setting(value)
        where replace(setting.value, '"', '') = 'search_path='
      )
  ), 'The exposed wrappers are not volatile, empty-search-path SECURITY INVOKER functions.';

  assert (
    select pg_catalog.pg_get_userbyid(namespace_record.nspowner) = 'postgres'
    from pg_catalog.pg_namespace namespace_record
    where namespace_record.nspname = 'sygshift_access_internal'
  ), 'The dedicated implementation schema is not owned by the trusted postgres role.';

  assert (
    select count(*) = 2
    from pg_catalog.pg_proc function_record
    join pg_catalog.pg_namespace namespace_record
      on namespace_record.oid = function_record.pronamespace
    where namespace_record.nspname = 'sygshift_access_internal'
  ), 'The dedicated implementation schema contains an unexpected routine.';

  assert (
    select count(*) = 2
    from pg_catalog.pg_proc function_record
    join pg_catalog.pg_namespace namespace_record
      on namespace_record.oid = function_record.pronamespace
    where namespace_record.nspname = 'sygshift_access_internal'
      and function_record.oid in (
        'sygshift_access_internal.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
        'sygshift_access_internal.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure
      )
      and function_record.prosecdef
      and function_record.provolatile = 'v'
      and exists (
        select 1
        from unnest(coalesce(function_record.proconfig, array[]::text[])) setting(value)
        where replace(setting.value, '"', '') = 'search_path='
      )
  ), 'The non-exposed implementations are not volatile, search-path-hardened SECURITY DEFINER helpers.';

  assert (
    select count(*) = 4
    from pg_catalog.pg_proc function_record
    where function_record.oid in (
      'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure,
      'sygshift_access_internal.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'sygshift_access_internal.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure
    )
      and pg_catalog.pg_get_userbyid(function_record.proowner) = 'postgres'
  ), 'An access-profile boundary function is not owned by the trusted postgres role.';

  assert position('sygshift_access_internal.set_employee_access_profile_with_primary_role' in public_profile_definition) > 0
    and position('sygshift_access_internal.set_employee_workforce_roles' in public_roles_definition) > 0,
    'A public SECURITY INVOKER wrapper is not delegating to its non-exposed helper.';

  assert position('private.require_access_control_admin()' in internal_profile_definition) > 0
    and position('for update' in lower(internal_profile_definition)) > 0
    and position('pg_advisory_xact_lock' in internal_profile_definition) > 0
    and position('private.require_access_control_admin()' in internal_roles_definition) > 0
    and position('for update' in lower(internal_roles_definition)) > 0
    and position('sygshift_access_internal.set_employee_access_profile_with_primary_role' in internal_roles_definition) > 0,
    'Authorization, employee locking, Admin serialization, or role-only delegation was lost while moving the implementations.';

  assert has_schema_privilege('authenticated', 'sygshift_access_internal', 'USAGE')
    and not has_schema_privilege('authenticated', 'sygshift_access_internal', 'CREATE')
    and not has_schema_privilege('anon', 'sygshift_access_internal', 'USAGE')
    and not has_schema_privilege('service_role', 'sygshift_access_internal', 'USAGE'),
    'The internal schema privilege boundary is broader or narrower than the invoker bridge requires.';

  assert has_function_privilege(
      'authenticated',
      'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'sygshift_access_internal.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'sygshift_access_internal.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'sygshift_access_internal.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'sygshift_access_internal.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure,
    'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'sygshift_access_internal.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'sygshift_access_internal.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure,
      'EXECUTE'
    ),
    'Public wrapper or internal helper execute grants do not match the authenticated-only contract.';

  assert not exists (
    select 1
    from pg_catalog.pg_proc function_record
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        function_record.proacl,
        pg_catalog.acldefault('f', function_record.proowner)
      )
    ) function_acl
    where function_record.oid in (
      'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure,
      'sygshift_access_internal.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'sygshift_access_internal.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure
    )
      and function_acl.grantee = 0
      and function_acl.privilege_type = 'EXECUTE'
  ), 'PUBLIC can execute an access-profile wrapper or privileged implementation.';

  assert not exists (
    select 1
    from pg_catalog.pg_proc function_record
    join pg_catalog.pg_namespace namespace_record
      on namespace_record.oid = function_record.pronamespace
    where namespace_record.nspname = 'sygshift_access_internal'
      and function_record.oid not in (
        'sygshift_access_internal.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
        'sygshift_access_internal.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure
      )
      and has_function_privilege('authenticated', function_record.oid, 'EXECUTE')
  ), 'Authenticated can execute an unintended function in the internal implementation schema.';

  -- The full behavioral regression invokes both public RPCs after every
  -- migration is installed. Its promotion/demotion, stale grant, deny,
  -- retired-role, Admin, self-lockout, audit, and rollback assertions therefore
  -- also prove that this invoker/definer split preserves the endpoint contract.
end
$access_profile_security_invoker_boundary_regression$;

rollback;
