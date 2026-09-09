begin;

do $$
declare
  current_definition text;
  repaired_definition text;
begin
  select pg_get_functiondef('public.get_operations_report()'::regprocedure)
  into current_definition;

  if current_definition like '%if not public.has_effective_permission(''reports.view'') then%' then
    return;
  end if;

  if current_definition not like '%if not public.is_supervisor_or_admin() then%' then
    raise exception 'get_operations_report has an unexpected authorization boundary; refusing to rewrite it.';
  end if;

  repaired_definition := replace(
    current_definition,
    'if not public.is_supervisor_or_admin() then',
    'if not public.has_effective_permission(''reports.view'') then'
  );
  repaired_definition := replace(
    repaired_definition,
    'Supervisor or Admin access is required to view operations reports.',
    'Reports access with verified MFA is required to view operations reports.'
  );

  execute repaired_definition;
end
$$;

comment on function public.get_operations_report() is
  'Returns the aggregate operations report to an active employee whose effective additive access includes reports.view and whose required MFA is verified.';

revoke all on function public.get_operations_report() from public, anon;
grant execute on function public.get_operations_report() to authenticated, service_role;

commit;
