begin;
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  actor_id uuid;
  employee_count_before bigint;
  case_count_before bigint;
  result jsonb;
  case_payload jsonb;
  report_payload jsonb;
begin
  select gate.enabled_by into actor_id
  from private.hr_onboarding_release_gate gate
  where gate.singleton and gate.enabled;

  if actor_id is null then
    raise exception 'The enabled onboarding gate does not have a regression-test actor.';
  end if;
  if not ('reports.account_activity.view' = any(private.employee_effective_permissions(actor_id))) then
    raise exception 'The onboarding release actor does not have the protected account-report permission.';
  end if;

  select count(*) into employee_count_before from public.employees;
  select count(*) into case_count_before from private.hr_onboarding_cases;

  result := public.service_hr_onboarding_create_prehire(
    actor_id,
    jsonb_build_object(
      'firstName','Onboarding',
      'lastName','Regression',
      'personalEmail','onboarding-regression-20260924@example.invalid',
      'positionTitle','Regression Guard',
      'workState','NC',
      'timeZone','America/New_York',
      'role','guard',
      'employmentType','hourly',
      'jobFamily','guard',
      'startDate','2026-10-01',
      'requiresGuardLicense',true,
      'requiresArmedCredentials',false
    ),
    'Rollback-only onboarding creation regression test.'
  );

  if result->>'employeeId' is null or result->>'caseId' is null then
    raise exception 'Onboarding creation did not return the employee and case identifiers.';
  end if;
  if (select count(*) from public.employees) <> employee_count_before + 1 then
    raise exception 'Onboarding creation did not create exactly one employee.';
  end if;
  if (select count(*) from private.hr_onboarding_cases) <> case_count_before + 1 then
    raise exception 'Onboarding creation did not create exactly one case.';
  end if;
  if not exists(select 1 from private.hr_onboarding_profiles profile where profile.case_id=(result->>'caseId')::uuid) then
    raise exception 'Onboarding creation did not create the employee profile.';
  end if;
  if not exists(
    select 1
    from private.hr_onboarding_profiles profile
    join public.employees employee on employee.id = (result->>'employeeId')::uuid
    where profile.case_id = (result->>'caseId')::uuid
      and profile.work_state = 'NC'
      and employee.time_zone = 'America/New_York'
  ) then
    raise exception 'North Carolina onboarding did not preserve the explicitly confirmed Eastern time zone.';
  end if;
  if not exists(select 1 from private.hr_onboarding_tasks task where task.case_id=(result->>'caseId')::uuid) then
    raise exception 'Onboarding creation did not create applicable checklist tasks.';
  end if;
  if not exists(
    select 1
    from private.hr_onboarding_tasks task
    where task.case_id = (result->>'caseId')::uuid
      and task.step_code = 'nc_withholding'
      and task.required
      and task.source_requirement->'states' ? 'NC'
  ) then
    raise exception 'North Carolina onboarding did not create its required withholding task.';
  end if;

  case_payload := public.service_get_hr_onboarding_case(actor_id,(result->>'caseId')::uuid);
  if case_payload#>>'{accountReadiness,accountState}' <> 'not_created' then
    raise exception 'Onboarding account readiness did not identify the pre-hire as having no account.';
  end if;

  report_payload := public.service_get_user_account_activity_report(
    actor_id,'','','','','','', '',30,10,0,false,'authenticator',clock_timestamp(),'rollback-regression'
  );
  if jsonb_typeof(report_payload->'rows') <> 'array'
    or (report_payload->>'totalCount')::integer < 1 then
    raise exception 'The protected user account activity report did not return a valid result.';
  end if;
end
$$;

rollback;
