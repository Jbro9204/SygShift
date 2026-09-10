begin;
set local lock_timeout = '5s';

-- The launch permission remains critical and MFA-protected for every role except
-- the canonical Guard role, whose authoritative policy does not require MFA.
-- Direct employee denials remain authoritative because this function starts
-- from private.employee_effective_permissions().
create or replace function public.get_effective_permissions()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with actor as (
    select private.current_employee_id() as employee_id
  )
  select coalesce(array_agg(permission_code order by permission_code), array[]::text[])
  from actor
  cross join unnest(private.employee_effective_permissions(actor.employee_id)) permission_code
  join public.permission_catalog catalog on catalog.code = permission_code
  where catalog.active
    and (
      not catalog.requires_mfa
      or public.has_mfa()
      or (
        permission_code = 'apps.sygilant.access'
        and exists (
          select 1
          from public.employees employee
          where employee.id = actor.employee_id
            and employee.status = 'active'
            and employee.role = 'guard'
            and not private.employee_requires_mfa(employee.id)
        )
      )
    )
$$;

revoke all on function public.get_effective_permissions() from public, anon;
grant execute on function public.get_effective_permissions() to authenticated;

do $$
declare
  function_definition text;
begin
  select pg_catalog.pg_get_functiondef(procedure_record.oid)
  into function_definition
  from pg_catalog.pg_proc procedure_record
  join pg_catalog.pg_namespace namespace_record
    on namespace_record.oid = procedure_record.pronamespace
  where namespace_record.nspname = 'public'
    and procedure_record.proname = 'get_effective_permissions'
    and pg_catalog.pg_get_function_identity_arguments(procedure_record.oid) = '';

  if function_definition is null
    or position('apps.sygilant.access' in function_definition) = 0
    or position('employee.role = ''guard''' in function_definition) = 0
    or position('not private.employee_requires_mfa(employee.id)' in function_definition) = 0
    or position('private.employee_effective_permissions(actor.employee_id)' in function_definition) = 0 then
    raise exception 'The Guard AAL1 Sygilant permission projection was not installed correctly.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc procedure_record
    join pg_catalog.pg_namespace namespace_record
      on namespace_record.oid = procedure_record.pronamespace
    where namespace_record.nspname = 'public'
      and procedure_record.proname = 'get_effective_permissions'
      and pg_catalog.pg_get_function_identity_arguments(procedure_record.oid) = ''
      and procedure_record.prosecdef
      and exists (
        select 1
        from unnest(procedure_record.proconfig) setting
        where setting like 'search_path=%'
      )
  ) then
    raise exception 'The permission projection lost its security-definer search-path controls.';
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
