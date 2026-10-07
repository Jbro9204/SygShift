do $$
declare
  constraint_definition text;
  issue_definition text;
  issue_search_path_hardened boolean;
begin
  select pg_catalog.pg_get_constraintdef(constraint_record.oid)
  into constraint_definition
  from pg_catalog.pg_constraint constraint_record
  where constraint_record.conrelid = 'private.sygilant_shared_launches'::regclass
    and constraint_record.conname = 'sygilant_shared_launch_destination';

  issue_definition := pg_catalog.pg_get_functiondef(
    'public.service_issue_sygilant_shared_launch(jsonb)'::regprocedure
  );
  select coalesce('search_path=""' = any(procedure.proconfig), false)
  into issue_search_path_hardened
  from pg_catalog.pg_proc procedure
  where procedure.oid = 'public.service_issue_sygilant_shared_launch(jsonb)'::regprocedure;

  if constraint_definition not like '%/dashboard%'
     or constraint_definition not like '%/dispatch%call=%'
     or constraint_definition not like '%/daily-activity-reports%report=%'
     or constraint_definition not like '%/incident-reports%report=%'
     or constraint_definition not like '%/vehicle-inspections%report=%' then
    raise exception 'Sygilant launch destinations are not constrained to the approved exact paths.';
  end if;
  if issue_definition not like '%destination_value%'
     or issue_definition not like '%private.sygilant_launch_assurance_allowed%'
     or issue_definition not like '%private.employee_effective_permissions%'
     or issue_definition not like '%source_session.not_after%'
     or not issue_search_path_hardened
     or issue_definition not like '%''destination'', destination_value%' then
    raise exception 'Sygilant launch issuance no longer preserves destination, session, assurance, or entitlement checks.';
  end if;
  if has_function_privilege('anon', 'public.service_issue_sygilant_shared_launch(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.service_issue_sygilant_shared_launch(jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.service_issue_sygilant_shared_launch(jsonb)', 'EXECUTE') then
    raise exception 'Sygilant launch issuance privileges are not service-only.';
  end if;
  if '/dispatch?call=4896f7c0-7143-48f9-9978-d1f6a342186f' !~* '^/dispatch[?]call=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or '/daily-activity-reports?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5' !~* '^/daily-activity-reports[?]report=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or '/incident-reports?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5' !~* '^/incident-reports[?]report=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or '/vehicle-inspections?report=eacdc293-e7ff-4d14-8f8e-38340e26a2c5' !~* '^/vehicle-inspections[?]report=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or '/dispatch?call=4896f7c0-7143-48f9-9978-d1f6a342186f&admin=true' ~* '^/dispatch[?]call=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Sygilant launch destination allowlist behavior is not exact.';
  end if;
end
$$;

select jsonb_build_object(
  'destinationConstraint', pg_catalog.pg_get_constraintdef(constraint_record.oid),
  'issueFunctionServiceOnly',
    not has_function_privilege('anon', 'public.service_issue_sygilant_shared_launch(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.service_issue_sygilant_shared_launch(jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.service_issue_sygilant_shared_launch(jsonb)', 'EXECUTE')
) as sygilant_deep_link_launch_postflight
from pg_catalog.pg_constraint constraint_record
where constraint_record.conrelid = 'private.sygilant_shared_launches'::regclass
  and constraint_record.conname = 'sygilant_shared_launch_destination';
