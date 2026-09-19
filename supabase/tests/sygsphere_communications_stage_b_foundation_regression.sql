-- Rollback-only Stage B verification. This test adds no tenant, employee,
-- account, permission, role, or audit fixture and leaves no persistent data.
begin;

do $$
declare
  tenant_relation regclass := 'private.sygsphere_tenants'::regclass;
  context_function regprocedure := 'public.service_get_sygsphere_communications_context(uuid)'::regprocedure;
  resolver_function regprocedure := 'private.current_sygsphere_tenant_id()'::regprocedure;
  permission_function regprocedure := 'private.sygsphere_comms_permissions(uuid)'::regprocedure;
  context_definition text;
begin
  assert (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid = tenant_relation),
    'The communications tenant registry must enforce RLS.';
  assert not has_table_privilege('anon', tenant_relation, 'select,insert,update,delete'),
    'Anonymous callers received direct tenant-table access.';
  assert not has_table_privilege('authenticated', tenant_relation, 'select,insert,update,delete'),
    'Authenticated callers received direct tenant-table access.';

  assert exists (
    select 1
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid = tenant_relation
      and constraint_record.conname = 'sygsphere_tenants_singleton'
      and pg_catalog.pg_get_constraintdef(constraint_record.oid) like '%CHECK (singleton)%'
  ), 'The tenant singleton check is missing.';
  assert exists (
    select 1
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid = tenant_relation
      and constraint_record.conname = 'sygsphere_tenants_primary_key'
      and pg_catalog.pg_get_constraintdef(constraint_record.oid) like '%sygshift-primary%'
  ), 'The canonical primary-tenant check is missing.';
  assert (select count(*) from private.sygsphere_tenants) = 1,
    'The communications registry must contain exactly one tenant.';
  assert (select tenant_key = 'sygshift-primary' and active from private.sygsphere_tenants limit 1),
    'The active communications tenant is not canonical.';

  assert (select count(*) from public.permission_catalog where code like 'sygsphere.comms.%' and active) = 14,
    'The exact communications permission vocabulary is incomplete.';
  assert (select count(*) from public.permission_catalog where code in (
    'sygsphere.comms.use', 'sygsphere.comms.ptt.listen', 'sygsphere.comms.ptt.transmit',
    'sygsphere.comms.call.start', 'sygsphere.comms.call.receive'
  ) and not requires_mfa) = 5, 'The approved Guard baseline must remain AAL1-capable.';
  assert (select count(*) from public.permission_catalog where code in (
    'sygsphere.comms.ptt.priority', 'sygsphere.comms.ptt.monitor', 'sygsphere.comms.moderate',
    'sygsphere.comms.usage.read', 'sygsphere.comms.configure'
  ) and requires_mfa) = 5, 'Elevated communications capabilities must remain MFA-protected.';
  assert (select count(*) from public.access_role_permissions where permission_code like 'sygsphere.comms.%') = 0,
    'Stage B must not create role grants.';

  assert not has_function_privilege('public', context_function, 'execute'),
    'The public role can execute the communications context function.';
  assert not has_function_privilege('anon', context_function, 'execute'),
    'Anonymous callers can execute the communications context function.';
  assert not has_function_privilege('authenticated', context_function, 'execute'),
    'Authenticated callers can execute the communications context function.';
  assert has_function_privilege('service_role', context_function, 'execute'),
    'The service role cannot execute the communications context function.';
  assert has_function_privilege('service_role', resolver_function, 'execute')
    and has_function_privilege('service_role', permission_function, 'execute'),
    'The server-only private communications helpers lost their service-role grants.';

  select pg_catalog.pg_get_functiondef(context_function::oid) into context_definition;
  assert (select prosecdef and coalesce(proconfig, array[]::text[]) @> array['search_path='] from pg_catalog.pg_proc where oid = context_function),
    'The communications context function must retain SECURITY DEFINER with an empty search path.';
  assert position('auth.role()' in context_definition) = 0,
    'The deprecated auth.role() helper returned to the communications context function.';
  assert position('account.disabled_at is null' in context_definition) > 0
    and position('employee.status = ''active''' in context_definition) > 0,
    'The context function no longer requires an active enabled canonical account.';
end
$$;

rollback;
