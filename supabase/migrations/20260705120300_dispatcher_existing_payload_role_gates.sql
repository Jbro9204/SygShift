do $$
declare
  definition text;
begin
  select pg_get_functiondef('public.get_patrol_coverage'::regproc) into definition;
  definition := replace(
    definition,
    'viewer_role in (''supervisor'', ''admin'')',
    'viewer_role in (''dispatcher'', ''supervisor'', ''admin'')'
  );
  execute definition;

  select pg_get_functiondef('public.get_request_center_payload'::regproc) into definition;
  definition := replace(
    definition,
    'privileged boolean := viewer_role in (''supervisor'', ''admin'');',
    'privileged boolean := viewer_role in (''dispatcher'', ''supervisor'', ''admin'');'
  );
  execute definition;

  select pg_get_functiondef('public.service_claim_notification_batch(integer)'::regprocedure) into definition;
  definition := replace(
    definition,
    'employee.role in (''supervisor'', ''admin'')',
    'employee.role in (''dispatcher'', ''supervisor'', ''admin'')'
  );
  definition := replace(
    definition,
    'employee.role in (''guard'', ''supervisor'', ''admin'')',
    'employee.role in (''guard'', ''dispatcher'', ''supervisor'', ''admin'')'
  );
  execute definition;
end
$$;
