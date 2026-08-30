select jsonb_build_object(
  'readinessRpcInstalled',
    to_regprocedure('public.get_hris_stage2_identity_readiness(text,text,integer,integer)') is not null,
  'backfillGateClosed',
    not exists (
      select 1
      from private.hr_stage2_backfill_gate
      where singleton and enabled
    ),
  'employees', (select count(*) from public.employees),
  'employeeAccessRoles', (select count(*) from public.employee_access_roles),
  'employeePermissionOverrides', (select count(*) from public.employee_permission_overrides),
  'personIdentifiers', (select count(*) from private.hr_person_identifiers),
  'workerIdentifiers', (select count(*) from private.hr_worker_identifiers)
) as stage2_verification;
