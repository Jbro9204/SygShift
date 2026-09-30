begin;

set local statement_timeout = '45s';

-- Build a complete accepted-candidate fixture so the named review wrapper is
-- exercised through its mature workflow rather than by calling only the
-- final-write helper/trigger.
create or replace function pg_temp.seed_atomic_candidate_conversion(
  target_requisition_id uuid,
  target_suffix text,
  target_role public.app_role,
  target_requested_by uuid
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  applicant_id uuid;
  application_id uuid;
  request_id uuid;
begin
  insert into private.hr_applicants (
    legal_first_name, legal_last_name, personal_email, source, created_by
  ) values (
    'AtomicCandidate',
    'Path' || target_suffix,
    'atomic-candidate-' || lower(target_suffix) || '@example.invalid',
    'rollback_regression',
    target_requested_by
  ) returning id into applicant_id;

  insert into private.hr_applications (
    applicant_id, requisition_id, stage, status, owner_id
  ) values (
    applicant_id, target_requisition_id, 'accepted', 'active', target_requested_by
  ) returning id into application_id;

  insert into private.hr_offers (
    application_id, status, job_title, employment_type,
    proposed_start_date, compensation_basis, compensation_amount,
    approved_by, approved_at, candidate_decided_at, prepared_by
  ) values (
    application_id, 'accepted', 'Atomic Path Guard', 'hourly',
    current_date + 14, 'hourly', 25.00,
    target_requested_by, clock_timestamp(), clock_timestamp(), target_requested_by
  );

  insert into private.hr_candidate_conversion_requests (
    application_id, status, proposed_role, proposed_employment_type,
    proposed_job_title, proposed_start_date, proposed_time_zone,
    requested_by, request_reason
  ) values (
    application_id, 'requested', target_role, 'hourly',
    'Atomic Path Guard', current_date + 14, 'America/Denver',
    target_requested_by, 'Rollback-only role-boundary request.'
  ) returning id into request_id;

  insert into private.hr_candidate_conversion_events (
    conversion_request_id, event_type, actor_id, reason
  ) values (
    request_id, 'requested', target_requested_by,
    'Rollback-only role-boundary request.'
  );

  return request_id;
end
$$;

do $atomic_primary_role_regression$
declare
  admin_employee constant uuid := 'e9300000-0000-4000-8000-000000000001';
  limited_employee constant uuid := 'e9300000-0000-4000-8000-000000000002';
  role_manager_employee constant uuid := 'e9300000-0000-4000-8000-000000000003';
  target_employee constant uuid := 'e9300000-0000-4000-8000-000000000004';
  stale_employee constant uuid := 'e9300000-0000-4000-8000-000000000005';
  inactive_employee constant uuid := 'e9300000-0000-4000-8000-000000000006';
  admin_membership_employee constant uuid := 'e9300000-0000-4000-8000-000000000007';
  recovery_admin_employee constant uuid := 'e9300000-0000-4000-8000-000000000008';
  role_viewer_employee constant uuid := 'e9300000-0000-4000-8000-000000000009';
  onboarding_employee constant uuid := 'e9300000-0000-4000-8000-000000000010';
  separated_employee constant uuid := 'e9300000-0000-4000-8000-000000000011';
  unactivated_admin_employee constant uuid := 'e9300000-0000-4000-8000-000000000012';
  admin_auth constant uuid := 'e9310000-0000-4000-8000-000000000001';
  limited_auth constant uuid := 'e9310000-0000-4000-8000-000000000002';
  role_manager_auth constant uuid := 'e9310000-0000-4000-8000-000000000003';
  recovery_admin_auth constant uuid := 'e9310000-0000-4000-8000-000000000004';
  role_viewer_auth constant uuid := 'e9310000-0000-4000-8000-000000000005';
  unactivated_admin_auth constant uuid := 'e9310000-0000-4000-8000-000000000006';
  extra_role_id constant uuid := 'e9320000-0000-4000-8000-000000000001';
  retired_role_id constant uuid := 'e9320000-0000-4000-8000-000000000002';
  retired_guard_role_id constant uuid := 'e9320000-0000-4000-8000-000000000006';
  limited_role_id constant uuid := 'e9320000-0000-4000-8000-000000000003';
  role_manager_role_id constant uuid := 'e9320000-0000-4000-8000-000000000004';
  role_viewer_role_id constant uuid := 'e9320000-0000-4000-8000-000000000005';
  guard_role_id uuid;
  supervisor_role_id uuid;
  admin_role_id uuid;
  effective_difference_code text;
  redundant_grant_code text;
  direct_grant_code text;
  denied_code text;
  payload jsonb;
  created_guard_id uuid;
  self_override_id uuid;
  retained_assignment_actor uuid;
  retained_assignment_time timestamptz;
  retained_admin_assignment_actor uuid;
  retained_admin_assignment_time timestamptz;
  stale_assignment_actor uuid;
  stale_assignment_time timestamptz;
  retained_grant_id uuid;
  retained_grant_actor uuid;
  retained_grant_reason text;
  retained_grant_created_at timestamptz;
  legacy_hidden_grant_id uuid;
  legacy_hidden_grant_actor uuid;
  legacy_hidden_grant_reason text;
  legacy_hidden_grant_created_at timestamptz;
  admin_permission_codes text[];
  audit_count_before integer;
  expected_assigned_count integer;
  reported_assigned_count integer;
  boundary_employee_id uuid;
  recruiting_requisition_id uuid;
  candidate_request_id uuid;
  candidate_employee_id uuid;
  separated_override_id uuid;
  employee_count_before integer;
  contact_count_before integer;
  person_count_before integer;
  worker_count_before integer;
  access_count_before integer;
  onboarding_case_count_before integer;
  error_message text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  guard_role_id := private.canonical_system_access_role_id('guard');
  supervisor_role_id := private.canonical_system_access_role_id('supervisor');
  admin_role_id := private.canonical_system_access_role_id('admin');

  select coalesce(array_agg(catalog.code order by catalog.code), array[]::text[])
  into admin_permission_codes
  from public.permission_catalog catalog
  where catalog.active;

  insert into public.employees (
    id, employee_number, username, first_name, last_name, role,
    employment_type, status, time_zone
  ) values
    (admin_employee, 'SYG-9901', 'atomicroleadmin', 'Atomic', 'Admin', 'admin', 'salary', 'active', 'America/Denver'),
    (limited_employee, 'SYG-9902', 'atomicrolelimited', 'Atomic', 'Limited', 'guard', 'hourly', 'active', 'America/Denver'),
    (role_manager_employee, 'SYG-9903', 'atomicrolemanager', 'Atomic', 'Role Manager', 'guard', 'salary', 'active', 'America/Denver'),
    (target_employee, 'SYG-9904', 'atomicroletarget', 'Atomic', 'Target', 'guard', 'hourly', 'active', 'America/New_York'),
    (stale_employee, 'SYG-9905', 'atomicrolestale', 'Atomic', 'Stale Client', 'guard', 'hourly', 'active', 'America/Chicago'),
    (inactive_employee, 'SYG-9906', 'atomicroleinactive', 'Atomic', 'Inactive', 'guard', 'hourly', 'inactive', 'America/Los_Angeles'),
    (admin_membership_employee, 'SYG-9907', 'atomicroleaddadmin', 'Atomic', 'Additive Admin', 'guard', 'hourly', 'active', 'America/Denver'),
    (recovery_admin_employee, 'SYG-9908', 'atomicrecoveryadmin', 'Atomic', 'Recovery Admin', 'admin', 'salary', 'active', 'America/Denver'),
    (role_viewer_employee, 'SYG-9909', 'atomicroleviewer', 'Atomic', 'Role Viewer', 'guard', 'hourly', 'active', 'America/Denver'),
    (onboarding_employee, 'SYG-9910', 'atomicroleonboarding', 'Atomic', 'Onboarding', 'guard', 'hourly', 'onboarding', 'America/Denver'),
    (separated_employee, 'SYG-9911', 'atomicroleseparated', 'Atomic', 'Separated', 'guard', 'hourly', 'separated', 'America/Denver'),
    (unactivated_admin_employee, 'SYG-9912', 'atomicunactivatedadmin', 'Atomic', 'Unactivated Admin', 'admin', 'salary', 'active', 'America/Denver');

  insert into auth.users(id, email)
  values
    (admin_auth, 'atomic-role-admin@example.invalid'),
    (limited_auth, 'atomic-role-limited@example.invalid'),
    (role_manager_auth, 'atomic-role-manager@example.invalid'),
    (recovery_admin_auth, 'atomic-role-recovery@example.invalid'),
    (role_viewer_auth, 'atomic-role-viewer@example.invalid'),
    (unactivated_admin_auth, 'atomic-role-unactivated-admin@example.invalid');

  insert into private.employee_accounts(employee_id, auth_user_id, activated_at)
  values
    (admin_employee, admin_auth, clock_timestamp()),
    (limited_employee, limited_auth, clock_timestamp()),
    (role_manager_employee, role_manager_auth, clock_timestamp()),
    (recovery_admin_employee, recovery_admin_auth, clock_timestamp()),
    (role_viewer_employee, role_viewer_auth, clock_timestamp()),
    (unactivated_admin_employee, unactivated_admin_auth, null);

  -- Preserve only the two rollback-only Admin accounts. The actor is then
  -- denied one critical recovery permission, leaving Recovery Admin as the
  -- sole recovery-capable active Admin while the actor remains a primary Admin.
  update private.employee_accounts account
  set disabled_at = coalesce(account.disabled_at, clock_timestamp()),
      updated_at = clock_timestamp()
  from public.employees employee
  where employee.id = account.employee_id
    and employee.role = 'admin'
    and employee.status = 'active'
    and employee.id not in (admin_employee, recovery_admin_employee, unactivated_admin_employee)
    and account.disabled_at is null;

  insert into public.employee_permission_overrides (
    employee_id, permission_code, effect, reason, created_by
  ) values (
    admin_employee,
    'admin.security.manage',
    'deny',
    'Rollback-only fixture leaves another Admin as the recovery path.',
    recovery_admin_employee
  );

  assert private.active_admin_account_count() = 1,
    'The rollback fixture must have exactly one recovery-capable active Admin account.';
  assert not private.employee_is_recovery_capable_active_admin(unactivated_admin_employee),
    'An unactivated Admin account was incorrectly counted as a recovery path.';

  insert into public.access_roles (
    id, code, name, description, system_role, protected, mfa_required, active
  ) values
    (extra_role_id, 'atomic_role_extra', 'Atomic Role Extra', 'Rollback-only custom membership.', false, false, true, true),
    (retired_role_id, 'atomic_role_retired', 'Atomic Role Retired', 'Rollback-only retired membership.', false, false, true, false),
    (limited_role_id, 'atomic_role_limited', 'Atomic Role Limited', 'Rollback-only profile editor.', false, false, true, true),
    (role_manager_role_id, 'atomic_role_manager', 'Atomic Role Manager', 'Rollback-only non-Admin role manager.', false, false, true, true),
    (role_viewer_role_id, 'atomic_role_viewer', 'Atomic Role Viewer', 'Rollback-only read-only role viewer.', false, false, true, true);

  insert into public.access_roles (
    id, code, name, description, base_app_role,
    system_role, protected, mfa_required, active
  ) values (
    retired_guard_role_id,
    'atomic_role_retired_guard',
    'Atomic Retired Guard',
    'Rollback-only retired historical Guard system bundle.',
    'guard',
    true,
    true,
    true,
    false
  );

  insert into public.access_role_permissions(role_id, permission_code, enabled)
  values
    (limited_role_id, 'admin.users.basic', true),
    (limited_role_id, 'licensing.manage', true),
    (limited_role_id, 'hr.recruiting.approve', true),
    (limited_role_id, 'hr.onboarding.manage', true),
    (limited_role_id, 'admin.security.manage', true),
    (role_manager_role_id, 'admin.roles.manage', true),
    (role_manager_role_id, 'licensing.manage', true),
    (role_manager_role_id, 'hr.recruiting.approve', true),
    (role_manager_role_id, 'hr.onboarding.manage', true),
    (role_manager_role_id, 'admin.security.manage', true),
    (role_viewer_role_id, 'admin.roles.view', true);

  insert into public.employee_access_roles(employee_id, role_id, assigned_by)
  values
    (limited_employee, limited_role_id, admin_employee),
    (role_manager_employee, role_manager_role_id, admin_employee),
    (role_viewer_employee, role_viewer_role_id, admin_employee),
    (target_employee, extra_role_id, admin_employee),
    (stale_employee, extra_role_id, admin_employee),
    (inactive_employee, extra_role_id, admin_employee),
    (inactive_employee, guard_role_id, admin_employee),
    (inactive_employee, retired_role_id, admin_employee),
    (inactive_employee, retired_guard_role_id, admin_employee),
    (admin_membership_employee, extra_role_id, admin_employee),
    (onboarding_employee, extra_role_id, admin_employee),
    (onboarding_employee, guard_role_id, admin_employee),
    (separated_employee, extra_role_id, admin_employee),
    (separated_employee, guard_role_id, admin_employee);

  -- Recruiting, Onboarding, and import permissions remain sufficient for a
  -- default Guard. At the exact employee insert, a non-Guard role additionally
  -- requires roles.manage, and Admin additionally requires a primary Admin.
  assert array['hr.recruiting.approve', 'hr.onboarding.manage', 'admin.security.manage']::text[]
      <@ private.employee_effective_permissions(limited_employee)
    and not ('admin.roles.manage' = any(private.employee_effective_permissions(limited_employee))),
    'The module-only creation-boundary fixture is invalid.';

  perform set_config('sygshift.role_creation_actor_id', limited_employee::text, true);
  insert into public.employees (first_name, last_name, role, employment_type, status, time_zone)
  values ('Boundary', 'Default Guard', 'guard', 'hourly', 'onboarding', 'America/Denver')
  returning id into boundary_employee_id;
  assert (select role = 'guard' from public.employees where id = boundary_employee_id),
    'A module-authorized actor could not retain the default Guard creation path.';
  delete from public.employees where id = boundary_employee_id;

  begin
    insert into public.employees (first_name, last_name, role, employment_type, status, time_zone)
    values ('Boundary', 'Forged Supervisor', 'supervisor', 'hourly', 'onboarding', 'America/Denver');
    raise exception 'A module-only actor created a non-Guard employee.';
  exception when insufficient_privilege then
    null;
  end;

  perform set_config('sygshift.role_creation_actor_id', role_manager_employee::text, true);
  insert into public.employees (first_name, last_name, role, employment_type, status, time_zone)
  values ('Boundary', 'Managed Supervisor', 'supervisor', 'hourly', 'onboarding', 'America/Denver')
  returning id into boundary_employee_id;
  assert (select role = 'supervisor' from public.employees where id = boundary_employee_id),
    'A service-routed roles manager could not create a non-Admin workforce role.';
  delete from public.employees where id = boundary_employee_id;

  begin
    insert into public.employees (first_name, last_name, role, employment_type, status, time_zone)
    values ('Boundary', 'Forged Admin', 'admin', 'salary', 'onboarding', 'America/Denver');
    raise exception 'A non-primary role manager created an Admin.';
  exception when insufficient_privilege then
    null;
  end;

  perform set_config('sygshift.role_creation_actor_id', recovery_admin_employee::text, true);
  insert into public.employees (first_name, last_name, role, employment_type, status, time_zone)
  values ('Boundary', 'Authorized Admin', 'admin', 'salary', 'onboarding', 'America/Denver')
  returning id into boundary_employee_id;
  assert (select role = 'admin' from public.employees where id = boundary_employee_id),
    'A primary Admin could not authorize Admin employee creation.';
  delete from public.employees where id = boundary_employee_id;
  perform set_config('sygshift.role_creation_actor_id', '', true);

  -- Exercise the named Recruiting approval path end to end. The request is a
  -- complete accepted-candidate record, including its offer and request event.
  update private.hr_recruiting_release_gate gate
  set enabled = true,
      enabled_at = coalesce(gate.enabled_at, clock_timestamp()),
      enabled_by = coalesce(gate.enabled_by, admin_employee),
      reason = coalesce(nullif(btrim(gate.reason), ''), 'Rollback-only atomic role regression.'),
      updated_at = clock_timestamp()
  where gate.singleton;

  insert into private.hr_requisitions (
    title, employment_type, status, requested_by
  ) values (
    'Atomic role-boundary recruiting path', 'hourly', 'open', admin_employee
  ) returning id into recruiting_requisition_id;

  candidate_request_id := pg_temp.seed_atomic_candidate_conversion(
    recruiting_requisition_id, 'GuardAllowed', 'guard', admin_employee
  );
  payload := public.service_review_candidate_conversion(
    limited_employee, candidate_request_id, 'approve',
    'Rollback-only module-authorized Guard conversion.'
  );
  candidate_employee_id := (payload ->> 'employeeId')::uuid;
  assert (select role = 'guard' and status = 'onboarding'
          from public.employees where id = candidate_employee_id)
    and (select status = 'converted' and converted_employee_id = candidate_employee_id
         from private.hr_candidate_conversion_requests where id = candidate_request_id),
    'The module-only Recruiting reviewer could not approve the default Guard path.';

  -- This request was queued as Guard, then changed to Supervisor before final
  -- approval. The final employee INSERT must revalidate the current queued role.
  candidate_request_id := pg_temp.seed_atomic_candidate_conversion(
    recruiting_requisition_id, 'StaleSupervisorDenied', 'guard', admin_employee
  );
  update private.hr_candidate_conversion_requests request
  set proposed_role = 'supervisor',
      proposed_job_title = 'Atomic queued Supervisor'
  where request.id = candidate_request_id;

  select (select count(*) from public.employees),
         (select count(*) from private.employee_contacts),
         (select count(*) from private.hr_person_identifiers),
         (select count(*) from private.hr_worker_identifiers),
         (select count(*) from public.employee_access_roles)
  into employee_count_before, contact_count_before, person_count_before,
       worker_count_before, access_count_before;

  begin
    perform public.service_review_candidate_conversion(
      limited_employee, candidate_request_id, 'approve',
      'Rollback-only stale queued Supervisor denial.'
    );
    raise exception 'A module-only Recruiting reviewer approved a queued Supervisor.';
  exception when insufficient_privilege then
    null;
  end;
  assert employee_count_before = (select count(*) from public.employees)
    and contact_count_before = (select count(*) from private.employee_contacts)
    and person_count_before = (select count(*) from private.hr_person_identifiers)
    and worker_count_before = (select count(*) from private.hr_worker_identifiers)
    and access_count_before = (select count(*) from public.employee_access_roles)
    and (select status = 'requested' and converted_employee_id is null
         from private.hr_candidate_conversion_requests where id = candidate_request_id),
    'The denied stale Recruiting conversion left partial employee, identity, contact, access, or request state.';

  candidate_request_id := pg_temp.seed_atomic_candidate_conversion(
    recruiting_requisition_id, 'SupervisorAllowed', 'supervisor', admin_employee
  );
  payload := public.service_review_candidate_conversion(
    role_manager_employee, candidate_request_id, 'approve',
    'Rollback-only roles-manager Supervisor conversion.'
  );
  candidate_employee_id := (payload ->> 'employeeId')::uuid;
  assert (select role = 'supervisor' from public.employees where id = candidate_employee_id),
    'The roles-manager Recruiting reviewer could not approve a Supervisor.';

  candidate_request_id := pg_temp.seed_atomic_candidate_conversion(
    recruiting_requisition_id, 'AdminDenied', 'admin', admin_employee
  );
  select (select count(*) from public.employees),
         (select count(*) from private.employee_contacts),
         (select count(*) from private.hr_person_identifiers),
         (select count(*) from private.hr_worker_identifiers),
         (select count(*) from public.employee_access_roles)
  into employee_count_before, contact_count_before, person_count_before,
       worker_count_before, access_count_before;
  begin
    perform public.service_review_candidate_conversion(
      role_manager_employee, candidate_request_id, 'approve',
      'Rollback-only non-primary Admin creation denial.'
    );
    raise exception 'A non-primary role manager approved an Admin conversion.';
  exception when insufficient_privilege then
    null;
  end;
  assert employee_count_before = (select count(*) from public.employees)
    and contact_count_before = (select count(*) from private.employee_contacts)
    and person_count_before = (select count(*) from private.hr_person_identifiers)
    and worker_count_before = (select count(*) from private.hr_worker_identifiers)
    and access_count_before = (select count(*) from public.employee_access_roles)
    and (select status = 'requested' and converted_employee_id is null
         from private.hr_candidate_conversion_requests where id = candidate_request_id),
    'The denied Admin Recruiting conversion left partial employee or access state.';

  candidate_request_id := pg_temp.seed_atomic_candidate_conversion(
    recruiting_requisition_id, 'AdminAllowed', 'admin', limited_employee
  );
  payload := public.service_review_candidate_conversion(
    recovery_admin_employee, candidate_request_id, 'approve',
    'Rollback-only primary-Admin candidate conversion.'
  );
  candidate_employee_id := (payload ->> 'employeeId')::uuid;
  assert (select role = 'admin' from public.employees where id = candidate_employee_id),
    'A primary Admin could not approve an Admin candidate conversion.';

  -- Exercise the named pre-hire path with the same final-write authority
  -- matrix and verify failed calls roll back every downstream onboarding row.
  update private.hr_onboarding_release_gate gate
  set enabled = true,
      enabled_at = coalesce(gate.enabled_at, clock_timestamp()),
      enabled_by = coalesce(gate.enabled_by, admin_employee),
      reason = coalesce(nullif(btrim(gate.reason), ''), 'Rollback-only atomic role regression.'),
      updated_at = clock_timestamp()
  where gate.singleton;

  payload := public.service_hr_onboarding_create_prehire(
    limited_employee,
    jsonb_build_object(
      'firstName','AtomicOnboarding', 'lastName','GuardAllowed',
      'personalEmail','atomic-onboarding-guard@example.invalid',
      'positionTitle','Guard', 'workState','CO', 'timeZone','America/Denver',
      'role','guard', 'employmentType','hourly', 'jobFamily','guard',
      'startDate',(current_date + 14), 'requiresGuardLicense',false,
      'requiresArmedCredentials',false
    ),
    'Rollback-only module-authorized Guard onboarding.'
  );
  assert (select role = 'guard' and status = 'onboarding'
          from public.employees where id = (payload ->> 'employeeId')::uuid),
    'The module-only onboarding manager could not create a default Guard.';

  select (select count(*) from public.employees),
         (select count(*) from private.employee_contacts),
         (select count(*) from private.hr_person_identifiers),
         (select count(*) from private.hr_worker_identifiers),
         (select count(*) from public.employee_access_roles),
         (select count(*) from private.hr_onboarding_cases)
  into employee_count_before, contact_count_before, person_count_before,
       worker_count_before, access_count_before, onboarding_case_count_before;
  begin
    perform public.service_hr_onboarding_create_prehire(
      limited_employee,
      jsonb_build_object(
        'firstName','AtomicOnboarding', 'lastName','SupervisorDenied',
        'personalEmail','atomic-onboarding-supervisor-denied@example.invalid',
        'positionTitle','Supervisor', 'workState','CO', 'timeZone','America/Denver',
        'role','supervisor', 'employmentType','hourly', 'jobFamily','operations',
        'startDate',(current_date + 14), 'requiresGuardLicense',false,
        'requiresArmedCredentials',false
      ),
      'Rollback-only module-only Supervisor onboarding denial.'
    );
    raise exception 'A module-only onboarding manager created a Supervisor.';
  exception when insufficient_privilege then
    null;
  end;
  assert employee_count_before = (select count(*) from public.employees)
    and contact_count_before = (select count(*) from private.employee_contacts)
    and person_count_before = (select count(*) from private.hr_person_identifiers)
    and worker_count_before = (select count(*) from private.hr_worker_identifiers)
    and access_count_before = (select count(*) from public.employee_access_roles)
    and onboarding_case_count_before = (select count(*) from private.hr_onboarding_cases)
    and not exists (
      select 1 from private.employee_contacts
      where personal_email = 'atomic-onboarding-supervisor-denied@example.invalid'
    ), 'The denied Supervisor pre-hire left partial employee, contact, identity, access, or onboarding rows.';

  payload := public.service_hr_onboarding_create_prehire(
    role_manager_employee,
    jsonb_build_object(
      'firstName','AtomicOnboarding', 'lastName','SupervisorAllowed',
      'personalEmail','atomic-onboarding-supervisor@example.invalid',
      'positionTitle','Supervisor', 'workState','CO', 'timeZone','America/Denver',
      'role','supervisor', 'employmentType','hourly', 'jobFamily','operations',
      'startDate',(current_date + 14), 'requiresGuardLicense',false,
      'requiresArmedCredentials',false
    ),
    'Rollback-only roles-manager Supervisor onboarding.'
  );
  assert (select role = 'supervisor'
          from public.employees where id = (payload ->> 'employeeId')::uuid),
    'The roles-manager onboarding path could not create a Supervisor.';

  select (select count(*) from public.employees),
         (select count(*) from private.employee_contacts),
         (select count(*) from private.hr_person_identifiers),
         (select count(*) from private.hr_worker_identifiers),
         (select count(*) from public.employee_access_roles),
         (select count(*) from private.hr_onboarding_cases)
  into employee_count_before, contact_count_before, person_count_before,
       worker_count_before, access_count_before, onboarding_case_count_before;
  begin
    perform public.service_hr_onboarding_create_prehire(
      role_manager_employee,
      jsonb_build_object(
        'firstName','AtomicOnboarding', 'lastName','AdminDenied',
        'personalEmail','atomic-onboarding-admin-denied@example.invalid',
        'positionTitle','Admin', 'workState','CO', 'timeZone','America/Denver',
        'role','admin', 'employmentType','salary', 'jobFamily','administration',
        'startDate',(current_date + 14), 'requiresGuardLicense',false,
        'requiresArmedCredentials',false
      ),
      'Rollback-only non-primary Admin onboarding denial.'
    );
    raise exception 'A non-primary role manager created an Admin pre-hire.';
  exception when insufficient_privilege then
    null;
  end;
  assert employee_count_before = (select count(*) from public.employees)
    and contact_count_before = (select count(*) from private.employee_contacts)
    and person_count_before = (select count(*) from private.hr_person_identifiers)
    and worker_count_before = (select count(*) from private.hr_worker_identifiers)
    and access_count_before = (select count(*) from public.employee_access_roles)
    and onboarding_case_count_before = (select count(*) from private.hr_onboarding_cases)
    and not exists (
      select 1 from private.employee_contacts
      where personal_email = 'atomic-onboarding-admin-denied@example.invalid'
    ), 'The denied Admin pre-hire left partial employee, contact, identity, access, or onboarding rows.';

  payload := public.service_hr_onboarding_create_prehire(
    recovery_admin_employee,
    jsonb_build_object(
      'firstName','AtomicOnboarding', 'lastName','AdminAllowed',
      'personalEmail','atomic-onboarding-admin@example.invalid',
      'positionTitle','Admin', 'workState','CO', 'timeZone','America/Denver',
      'role','admin', 'employmentType','salary', 'jobFamily','administration',
      'startDate',(current_date + 14), 'requiresGuardLicense',false,
      'requiresArmedCredentials',false
    ),
    'Rollback-only primary-Admin onboarding.'
  );
  assert (select role = 'admin'
          from public.employees where id = (payload ->> 'employeeId')::uuid),
    'A primary Admin could not create an Admin pre-hire.';
  perform set_config('sygshift.role_creation_actor_id', '', true);

  select supervisor_permission.permission_code
  into effective_difference_code
  from public.access_role_permissions supervisor_permission
  where supervisor_permission.role_id = supervisor_role_id
    and supervisor_permission.enabled
    and supervisor_permission.permission_code not in (
      'admin.users.basic', 'admin.users.manage', 'admin.roles.manage',
      'admin.security.manage', 'licensing.manage'
    )
    and not exists (
      select 1
      from public.access_role_permissions guard_permission
      where guard_permission.role_id = guard_role_id
        and guard_permission.permission_code = supervisor_permission.permission_code
        and guard_permission.enabled
    )
  order by supervisor_permission.permission_code
  limit 1;

  select supervisor_permission.permission_code
  into redundant_grant_code
  from public.access_role_permissions supervisor_permission
  where supervisor_permission.role_id = supervisor_role_id
    and supervisor_permission.enabled
    and supervisor_permission.permission_code <> effective_difference_code
    and not exists (
      select 1
      from public.access_role_permissions guard_permission
      where guard_permission.role_id = guard_role_id
        and guard_permission.permission_code = supervisor_permission.permission_code
        and guard_permission.enabled
    )
  order by supervisor_permission.permission_code
  limit 1;

  select catalog.code
  into direct_grant_code
  from public.permission_catalog catalog
  where catalog.active
    and catalog.code not in (effective_difference_code, redundant_grant_code)
    and not exists (
      select 1 from public.access_role_permissions role_permission
      where role_permission.role_id in (guard_role_id, supervisor_role_id)
        and role_permission.permission_code = catalog.code
        and role_permission.enabled
    )
  order by catalog.code
  limit 1;

  select catalog.code
  into denied_code
  from public.permission_catalog catalog
  where catalog.active
    and catalog.code not in (effective_difference_code, redundant_grant_code, direct_grant_code)
    and not exists (
      select 1 from public.access_role_permissions role_permission
      where role_permission.role_id in (guard_role_id, supervisor_role_id)
        and role_permission.permission_code = catalog.code
        and role_permission.enabled
    )
  order by catalog.code
  limit 1;

  assert effective_difference_code is not null
    and redundant_grant_code is not null
    and direct_grant_code is not null
    and denied_code is not null,
    'The regression requires Supervisor-only and non-inherited permissions.';

  insert into public.access_role_permissions (role_id, permission_code, enabled)
  values (extra_role_id, direct_grant_code, true)
  on conflict (role_id, permission_code) do update
  set enabled = true,
      updated_at = clock_timestamp();

  insert into public.employee_permission_overrides (
    employee_id, permission_code, effect, reason, created_by
  ) values
    (target_employee, redundant_grant_code, 'grant', 'Preexisting individual grant.', admin_employee),
    (target_employee, direct_grant_code, 'grant', 'Preexisting explicit direct grant.', admin_employee),
    (target_employee, denied_code, 'deny', 'Preexisting protected restriction.', admin_employee),
    (inactive_employee, redundant_grant_code, 'grant', 'Inactive employee inherited-grant fixture.', admin_employee),
    (inactive_employee, direct_grant_code, 'grant', 'Legacy hidden direct grant fixture.', admin_employee);

  insert into public.employee_permission_overrides (
    employee_id, permission_code, effect, reason, created_by
  ) values (
    role_manager_employee,
    effective_difference_code,
    'grant',
    'Rollback-only self-override protection fixture.',
    admin_employee
  ) returning id into self_override_id;

  insert into public.employee_permission_overrides (
    employee_id, permission_code, effect, reason, created_by
  ) values (
    separated_employee,
    direct_grant_code,
    'grant',
    'Separated access-history preservation fixture.',
    admin_employee
  ) returning id into separated_override_id;

  perform set_config('request.jwt.claim.sub', role_viewer_auth::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', role_viewer_auth, 'role', 'authenticated', 'aal', 'aal1'
  )::text, true);

  begin
    perform public.get_access_control_center();
    raise exception 'An AAL1 roles viewer opened the access center.';
  exception when insufficient_privilege then
    null;
  end;

  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', role_viewer_auth, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);
  payload := public.get_access_control_center();
  assert jsonb_typeof(payload -> 'users') = 'array',
    'admin.roles.view with AAL2 could not read the Access Center.';

  -- Role counts describe every retained assignment represented by the Center,
  -- not only currently active employees. Primary and additive sources are
  -- combined once per employee even when the canonical primary bundle was
  -- also retained by an older client.
  select (role_record ->> 'assignedCount')::integer
  into reported_assigned_count
  from jsonb_array_elements(payload -> 'roles') role_record
  where (role_record ->> 'id')::uuid = guard_role_id;

  select count(*)::integer
  into expected_assigned_count
  from (
    select employee.id as employee_id
    from public.employees employee
    where employee.role = 'guard'
    union
    select assignment.employee_id
    from public.employee_access_roles assignment
    where assignment.role_id = guard_role_id
  ) retained_guard_assignment;

  assert reported_assigned_count = expected_assigned_count,
    'The canonical Guard assignedCount omitted a non-active employee or double-counted a retained primary bundle.';

  select (role_record ->> 'assignedCount')::integer
  into reported_assigned_count
  from jsonb_array_elements(payload -> 'roles') role_record
  where (role_record ->> 'id')::uuid = extra_role_id;

  select count(distinct assignment.employee_id)::integer
  into expected_assigned_count
  from public.employee_access_roles assignment
  where assignment.role_id = extra_role_id;

  assert reported_assigned_count = expected_assigned_count
    and expected_assigned_count = 6,
    'The custom-role assignedCount did not include active, inactive, onboarding, and separated retained assignments.';

  assert exists (
    select 1
    from jsonb_array_elements(payload -> 'users') user_record
    where (user_record ->> 'id')::uuid = onboarding_employee
      and user_record ->> 'status' = 'onboarding'
  ) and exists (
    select 1
    from jsonb_array_elements(payload -> 'users') user_record
    where (user_record ->> 'id')::uuid = separated_employee
      and user_record ->> 'status' = 'separated'
  ), 'The all-status Access Center omitted the onboarding or separated count fixture.';

  begin
    perform public.set_employee_access_profile_with_primary_role(
      target_employee, 'supervisor', array[extra_role_id], array[]::text[],
      'A read-only viewer cannot mutate roles.'
    );
    raise exception 'A roles viewer mutated employee access.';
  exception when insufficient_privilege then
    null;
  end;

  perform set_config('request.jwt.claim.sub', limited_auth::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', limited_auth, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);

  -- A basic profile editor can save an unchanged role.
  perform public.admin_update_employee(
    target_employee, 'Atomic', null, 'Target', null, 'guard', 'hourly', 'active',
    'SYG-9904', 'Profile-only update', null, null, null
  );
  assert (select role = 'guard' and job_title = 'Profile-only update' from public.employees where id = target_employee),
    'admin.users.basic could not save a same-role profile update.';

  begin
    perform public.admin_update_employee(
      target_employee, 'Atomic', null, 'Target', null, 'supervisor', 'hourly', 'active',
      'SYG-9904', 'Forbidden promotion', null, null, null
    );
    raise exception 'A basic profile editor changed the primary role.';
  exception when insufficient_privilege then
    null;
  end;
  assert (select role = 'guard' from public.employees where id = target_employee),
    'The denied basic-editor promotion was not rolled back.';

  begin
    perform public.admin_update_employee_with_time_zone_and_access_roles(
      target_employee, 'Atomic', null, 'Target', null, 'supervisor', 'hourly', 'active',
      'SYG-9904', 'Forbidden combined promotion', null, null, null, 'America/New_York',
      array[extra_role_id]
    );
    raise exception 'A basic profile editor used the combined User Accounts wrapper to change a role.';
  exception when insufficient_privilege then
    null;
  end;
  assert (select role = 'guard' from public.employees where id = target_employee),
    'The denied combined-wrapper promotion was not rolled back.';

  begin
    perform public.upsert_licensing_employee(
      null, 'Forged', null, 'Licensing Supervisor', null, null,
      'hourly', 'onboarding', null, null, null, 'supervisor', 'America/Denver'
    );
    raise exception 'A licensing/basic editor forged a non-Guard role through Licensing.';
  exception when insufficient_privilege then
    null;
  end;
  assert not exists (
    select 1 from public.employees
    where first_name = 'Forged' and last_name = 'Licensing Supervisor'
  ), 'The denied Licensing role creation left a partial employee.';

  begin
    perform public.admin_create_employee_with_time_zone(
      'Forged', null, 'Supervisor', null, 'supervisor', 'hourly', 'active',
      'SYG-9998', null, null, null, null, 'America/Denver'
    );
    raise exception 'A basic profile editor forged a non-Guard creation role.';
  exception when insufficient_privilege then
    null;
  end;
  assert not exists (select 1 from public.employees where employee_number = 'SYG-9998'),
    'The denied non-Guard employee creation left a partial row.';

  payload := public.admin_create_employee_with_time_zone(
    'Default', null, 'Guard', null, 'guard', 'hourly', 'onboarding',
    'SYG-9999', null, null, null, null, 'America/Denver'
  );
  created_guard_id := (payload ->> 'id')::uuid;
  assert (select role = 'guard' from public.employees where id = created_guard_id),
    'A basic profile editor could not create the default Guard onboarding profile.';

  -- The operational-import RPC is intentionally and cryptographically locked
  -- to one completed Colorado source/run/date scope, so a second independent
  -- end-to-end promotion cannot be safely seeded even inside this rollback:
  -- the mature body rejects every other run and rejects replay of the completed
  -- range before candidate writes. Exercise the named wrapper boundary itself,
  -- prove a module-only AAL2 operator reaches that immutable lock without any
  -- partial employee/access rows, then rely on the executable final-write tests
  -- above for Guard/Supervisor/Admin mapped-role revalidation.
  select count(*) into employee_count_before from public.employees;
  select count(*) into access_count_before from public.employee_access_roles;
  begin
    perform public.promote_import_scope(
      'e9390000-0000-4000-8000-000000000001'::uuid,
      date '2026-06-28', date '2026-08-15', false,
      'Rollback-only module boundary execution.'
    );
    raise exception 'The immutable operational-import lock accepted an unknown run.';
  exception when check_violation then
    get stacked diagnostics error_message = message_text;
  end;
  assert employee_count_before = (select count(*) from public.employees)
    and access_count_before = (select count(*) from public.employee_access_roles)
    and nullif(error_message, '') is not null,
    'The module-only operational-import boundary left partial employee/access state.';

  -- roles.manage is the exact ordinary role-change authority, but still needs
  -- AAL2. It does not require admin.users.manage for the roles-only endpoint.
  perform set_config('request.jwt.claim.sub', role_manager_auth::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', role_manager_auth, 'role', 'authenticated', 'aal', 'aal1'
  )::text, true);

  perform set_config('sygshift.role_creation_actor_id', role_manager_employee::text, true);
  begin
    insert into public.employees (first_name, last_name, role, employment_type, status, time_zone)
    values ('Boundary', 'AAL1 Supervisor', 'supervisor', 'hourly', 'onboarding', 'America/Denver');
    raise exception 'An AAL1 roles manager created a non-Guard employee.';
  exception when insufficient_privilege then
    null;
  end;
  perform set_config('sygshift.role_creation_actor_id', '', true);

  begin
    perform public.set_employee_access_profile_with_primary_role(
      target_employee, 'supervisor', array[extra_role_id], array[]::text[],
      'AAL1 must not be enough for role administration.'
    );
    raise exception 'An AAL1 role manager changed a primary role.';
  exception when insufficient_privilege then
    null;
  end;
  assert (select role = 'guard' from public.employees where id = target_employee),
    'The AAL1 role attempt changed the employee.';

  begin
    perform public.get_licensing_center();
    raise exception 'An AAL1 Licensing manager opened the Licensing Center.';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.promote_import_scope(
      'e9390000-0000-4000-8000-000000000002'::uuid,
      date '2026-06-28', date '2026-08-15', false,
      'Rollback-only AAL1 import denial.'
    );
    raise exception 'An AAL1 operational-import operator entered the promotion body.';
  exception when insufficient_privilege then
    null;
  end;

  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', role_manager_auth, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);

  assert public.has_effective_permission('admin.roles.manage')
    and public.has_effective_permission('licensing.manage')
    and public.has_effective_permission('hr.recruiting.approve')
    and public.has_effective_permission('hr.onboarding.manage')
    and public.has_effective_permission('admin.security.manage')
    and not public.has_effective_permission('licensing.view')
    and not public.has_any_effective_permission(array['admin.users.basic', 'admin.users.manage']),
    'The roles-manager fixture must not inherit profile-edit authority.';

  select count(*) into employee_count_before from public.employees;
  select count(*) into access_count_before from public.employee_access_roles;
  error_message := null;
  begin
    perform public.promote_import_scope(
      'e9390000-0000-4000-8000-000000000003'::uuid,
      date '2026-06-28', date '2026-08-15', false,
      'Rollback-only roles-manager import boundary execution.'
    );
    raise exception 'The immutable operational-import lock accepted an unknown roles-manager run.';
  exception when check_violation then
    get stacked diagnostics error_message = message_text;
  end;
  assert employee_count_before = (select count(*) from public.employees)
    and access_count_before = (select count(*) from public.employee_access_roles)
    and nullif(error_message, '') is not null,
    'The roles-manager operational-import boundary left partial employee/access state.';

  perform set_config('sygshift.role_creation_actor_id', role_manager_employee::text, true);
  insert into public.employees (first_name, last_name, role, employment_type, status, time_zone)
  values ('Boundary', 'AAL2 Supervisor', 'supervisor', 'hourly', 'onboarding', 'America/Denver')
  returning id into boundary_employee_id;
  assert (select role = 'supervisor' from public.employees where id = boundary_employee_id),
    'An AAL2 roles manager could not authorize a non-Admin employee creation.';
  delete from public.employees where id = boundary_employee_id;
  perform set_config('sygshift.role_creation_actor_id', '', true);

  payload := public.get_licensing_center();
  assert (payload ->> 'currentEmployeeId')::uuid = role_manager_employee
    and coalesce((payload -> 'permissions' ->> 'canManage')::boolean, false),
    'licensing.manage without a redundant licensing.view grant could not read the mutation return payload.';

  -- Simulate User Accounts loading roles before another administrator adds a
  -- direct grant. The dedicated role-only endpoint has no cached grant input;
  -- it snapshots the grant only after taking the employee lock, so the later
  -- permission survives the role change.
  select permission_override.id
  into retained_grant_id
  from public.employee_permission_overrides permission_override
  where permission_override.employee_id = target_employee
    and permission_override.permission_code = direct_grant_code
    and permission_override.active;
  perform public.clear_employee_permission_override(retained_grant_id);
  perform public.set_employee_permission_override(
    target_employee,
    direct_grant_code,
    'grant',
    'Grant committed after the role-only page snapshot.'
  );
  perform public.set_employee_workforce_roles(
    target_employee,
    'supervisor',
    array[guard_role_id, extra_role_id],
    'Role-only stale grant preservation regression.'
  );
  assert (select role = 'supervisor' from public.employees where id = target_employee)
    and exists (
      select 1
      from public.employee_permission_overrides permission_override
      where permission_override.employee_id = target_employee
        and permission_override.permission_code = direct_grant_code
        and permission_override.effect = 'grant'
        and permission_override.active
    ), 'A role-only save removed a direct grant committed after the page snapshot.';
  perform public.set_employee_workforce_roles(
    target_employee,
    'guard',
    array[supervisor_role_id, extra_role_id],
    'Restore after role-only stale grant preservation regression.'
  );

  perform public.set_employee_access_profile_with_primary_role(
    target_employee, 'supervisor', array[extra_role_id], array[direct_grant_code],
    'Non-Admin roles manager promotion regression.'
  );
  assert (select role = 'supervisor' from public.employees where id = target_employee),
    'An AAL2 roles manager without admin.users.manage could not promote an ordinary employee.';

  perform public.set_employee_access_profile_with_primary_role(
    target_employee, 'guard', array[extra_role_id], array[direct_grant_code, redundant_grant_code],
    'Restore the ordinary employee after authority regression.'
  );

  -- User Accounts submits the unchanged profile alongside role changes. A
  -- roles.manage-only operator must be able to use that combined wrapper when
  -- every profile/contact/employment/status/time-zone value is unchanged.
  perform public.admin_update_employee_with_time_zone_and_access_roles(
    target_employee, 'Atomic', null, 'Target', null, 'supervisor', 'hourly', 'active',
    'SYG-9904', 'Profile-only update', null, null, null, 'America/New_York',
    array[guard_role_id, extra_role_id]
  );
  assert (select role = 'supervisor'
                 and job_title = 'Profile-only update'
                 and time_zone = 'America/New_York'
          from public.employees where id = target_employee)
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = target_employee and role_id = extra_role_id
    )
    and not exists (
      select 1 from public.employee_access_roles
      where employee_id = target_employee and role_id in (guard_role_id, supervisor_role_id)
    )
    and exists (
      select 1 from public.employee_permission_overrides
      where employee_id = target_employee and permission_code = direct_grant_code
        and effect = 'grant' and active
    ), 'roles.manage-only could not save an unchanged profile with a role change through User Accounts.';

  perform public.admin_update_employee_with_time_zone_and_access_roles(
    target_employee, 'Atomic', null, 'Target', null, 'guard', 'hourly', 'active',
    'SYG-9904', 'Profile-only update', null, null, null, 'America/New_York',
    array[supervisor_role_id, extra_role_id]
  );
  assert (select role = 'guard' and job_title = 'Profile-only update'
          from public.employees where id = target_employee),
    'roles.manage-only could not restore the primary role through User Accounts.';

  begin
    perform public.admin_update_employee_with_time_zone_and_access_roles(
      target_employee, 'Atomic', null, 'Target', null, 'supervisor', 'hourly', 'active',
      'SYG-9904', 'Forbidden roles-manager profile change', null, null, null,
      'America/New_York', array[guard_role_id, extra_role_id]
    );
    raise exception 'A roles.manage-only operator changed a profile field through User Accounts.';
  exception when insufficient_privilege then
    null;
  end;
  assert (select role = 'guard' and job_title = 'Profile-only update'
          from public.employees where id = target_employee),
    'The denied roles-manager profile mutation did not roll back the role and profile together.';

  -- The base and explicit-time-zone legacy wrappers obey the same boundary:
  -- a pure role change is allowed, while the no-op time-zone write does not
  -- introduce a hidden admin.users.basic requirement.
  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  values (target_employee, guard_role_id, role_manager_employee);

  perform public.admin_update_employee(
    target_employee, 'Atomic', null, 'Target', null, 'supervisor', 'hourly', 'active',
    'SYG-9904', 'Profile-only update', null, null, null
  );
  assert (select role = 'supervisor' from public.employees where id = target_employee)
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = target_employee and role_id = extra_role_id
    )
    and not exists (
      select 1 from public.employee_access_roles
      where employee_id = target_employee and role_id in (guard_role_id, supervisor_role_id)
    ), 'The base legacy wrapper failed to normalize a roles.manage-only promotion.';

  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  values (target_employee, supervisor_role_id, role_manager_employee);

  perform public.admin_update_employee_with_time_zone(
    target_employee, 'Atomic', null, 'Target', null, 'guard', 'hourly', 'active',
    'SYG-9904', 'Profile-only update', null, null, null, 'America/New_York'
  );
  assert (select role = 'guard' and time_zone = 'America/New_York'
          from public.employees where id = target_employee)
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = target_employee and role_id = extra_role_id
    )
    and not exists (
      select 1 from public.employee_access_roles
      where employee_id = target_employee and role_id in (guard_role_id, supervisor_role_id)
    ), 'The explicit-time-zone wrapper failed to normalize a roles.manage-only demotion.';

  begin
    perform public.admin_update_employee_with_time_zone(
      target_employee, 'Atomic', null, 'Target', null, 'supervisor', 'hourly', 'active',
      'SYG-9904', 'Profile-only update', null, null, null, 'America/Chicago'
    );
    raise exception 'A roles.manage-only operator changed an employee time zone.';
  exception when insufficient_privilege then
    null;
  end;
  assert (select role = 'guard' and time_zone = 'America/New_York'
          from public.employees where id = target_employee),
    'The denied time-zone/profile mutation did not roll back its primary-role change.';

  begin
    perform public.set_access_role_permissions(admin_role_id, admin_permission_codes);
    raise exception 'A non-primary role manager edited the protected Admin role.';
  exception when insufficient_privilege then
    null;
  end;

  -- Licensing has its own profile authority, but every primary-role transition
  -- must still use the atomic role contract and preserve unrelated access.
  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  values (admin_membership_employee, guard_role_id, role_manager_employee);

  payload := public.upsert_licensing_employee(
    admin_membership_employee, 'Atomic', null, 'Additive Admin', null, null,
    'hourly', 'active', null, null, null, 'supervisor', null
  );
  assert (payload ->> 'currentEmployeeId')::uuid = role_manager_employee
    and coalesce((payload -> 'permissions' ->> 'canManage')::boolean, false)
    and (select role = 'supervisor' from public.employees where id = admin_membership_employee)
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = admin_membership_employee and role_id = extra_role_id
    )
    and not exists (
      select 1 from public.employee_access_roles
      where employee_id = admin_membership_employee and role_id in (guard_role_id, supervisor_role_id)
    ), 'Licensing did not normalize Guard to Supervisor while preserving unrelated access.';

  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  values (admin_membership_employee, supervisor_role_id, role_manager_employee);

  perform public.upsert_licensing_employee(
    admin_membership_employee, 'Atomic', null, 'Additive Admin', null, null,
    'hourly', 'active', null, null, null, 'guard', null
  );
  assert (select role = 'guard' from public.employees where id = admin_membership_employee)
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = admin_membership_employee and role_id = extra_role_id
    )
    and not exists (
      select 1 from public.employee_access_roles
      where employee_id = admin_membership_employee and role_id in (guard_role_id, supervisor_role_id)
    ), 'Licensing did not normalize Supervisor to Guard while preserving unrelated access.';

  begin
    perform public.set_employee_access_profile_with_primary_role(
      target_employee, 'admin', array[extra_role_id], array[redundant_grant_code],
      'A non-primary Admin cannot create a primary Admin.'
    );
    raise exception 'A non-primary Admin promoted a primary Admin.';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.set_employee_access_profile_with_primary_role(
      recovery_admin_employee, 'supervisor', array[]::uuid[], array[]::text[],
      'A non-primary Admin cannot demote a primary Admin.'
    );
    raise exception 'A non-primary Admin demoted a primary Admin.';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.set_employee_access_profile_with_primary_role(
      role_manager_employee, 'guard', array[role_manager_role_id, extra_role_id], array[]::text[],
      'Self access changes must be rejected.'
    );
    raise exception 'A role manager changed their own access profile.';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.set_employee_access_roles(
      role_manager_employee, array[role_manager_role_id, extra_role_id]
    );
    raise exception 'A role manager changed their own additional roles through the legacy endpoint.';
  exception when insufficient_privilege then
    null;
  end;
  assert not exists (
    select 1 from public.employee_access_roles
    where employee_id = role_manager_employee and role_id = extra_role_id
  ), 'The denied legacy self-membership change was not rolled back.';

  begin
    perform public.set_employee_permission_override(
      role_manager_employee, denied_code, 'grant', 'Self-grant must be rejected.'
    );
    raise exception 'A role manager created their own direct permission grant.';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.clear_employee_permission_override(self_override_id);
    raise exception 'A role manager cleared their own direct permission grant.';
  exception when insufficient_privilege then
    null;
  end;
  assert exists (
    select 1 from public.employee_permission_overrides
    where id = self_override_id and active
  ), 'The denied self-override clear was not rolled back.';

  begin
    perform public.set_employee_access_profile(
      role_manager_employee, array[role_manager_role_id], array[]::text[],
      'Legacy self-grant removal must be rejected.'
    );
    raise exception 'The legacy profile endpoint removed the actor direct grant.';
  exception when insufficient_privilege then
    null;
  end;
  assert exists (
    select 1 from public.employee_permission_overrides
    where id = self_override_id and active
  ), 'The legacy self-profile attempt changed the actor direct grant.';

  -- The established four-argument endpoint remains available for additive-only
  -- callers and cannot alter the primary workforce role.
  perform public.set_employee_access_profile(
    target_employee, array[extra_role_id], array[direct_grant_code, redundant_grant_code],
    'Legacy additive-only endpoint compatibility regression.'
  );
  assert (select role = 'guard' from public.employees where id = target_employee),
    'The legacy additive-only endpoint changed the primary role.';

  perform set_config('request.jwt.claim.sub', admin_auth::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', admin_auth, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);

  perform public.set_access_role_permissions(admin_role_id, admin_permission_codes);
  assert not exists (
    select 1
    from public.permission_catalog catalog
    left join public.access_role_permissions role_permission
      on role_permission.role_id = admin_role_id
     and role_permission.permission_code = catalog.code
     and role_permission.enabled
    where catalog.active
      and role_permission.role_id is null
  ), 'A primary Admin could not retain the complete protected Admin permission bundle.';

  select assignment.assigned_by, assignment.assigned_at
  into retained_assignment_actor, retained_assignment_time
  from public.employee_access_roles assignment
  where assignment.employee_id = target_employee
    and assignment.role_id = extra_role_id;

  select permission_override.id,
         permission_override.created_by,
         permission_override.reason,
         permission_override.created_at
  into retained_grant_id,
       retained_grant_actor,
       retained_grant_reason,
       retained_grant_created_at
  from public.employee_permission_overrides permission_override
  where permission_override.employee_id = target_employee
    and permission_override.permission_code = direct_grant_code
    and permission_override.effect = 'grant'
    and permission_override.active;

  assert not (effective_difference_code = any(private.employee_effective_permissions(target_employee))),
    'The Guard fixture unexpectedly inherited the Supervisor-only permission.';

  payload := public.set_employee_access_profile_with_primary_role(
    target_employee,
    'supervisor',
    array[guard_role_id, extra_role_id],
    array[direct_grant_code],
    'Rollback-only Guard to Supervisor promotion.'
  );

  assert (select role = 'supervisor' from public.employees where id = target_employee),
    'Guard to Supervisor did not update the primary workforce role.';
  assert exists (
    select 1 from public.employee_access_roles
    where employee_id = target_employee and role_id = extra_role_id
  ), 'Promotion removed an unrelated custom role.';
  assert exists (
    select 1
    from public.employee_access_roles assignment
    where assignment.employee_id = target_employee
      and assignment.role_id = extra_role_id
      and assignment.assigned_by is not distinct from retained_assignment_actor
      and assignment.assigned_at is not distinct from retained_assignment_time
  ), 'Atomic role save rewrote provenance for an unchanged membership.';
  assert not exists (
    select 1 from public.employee_access_roles
    where employee_id = target_employee and role_id in (guard_role_id, supervisor_role_id)
  ), 'Promotion retained the old or duplicated the new primary system bundle.';
  assert effective_difference_code = any(private.employee_effective_permissions(target_employee)),
    'Promotion did not add the Supervisor-only effective permission.';
  assert exists (
    select 1
    from public.employee_permission_overrides permission_override
    where permission_override.employee_id = target_employee
      and permission_override.permission_code = redundant_grant_code
      and permission_override.effect = 'grant'
      and permission_override.active
      and permission_override.reason = 'Preexisting individual grant.'
  ), 'Promotion destroyed or rewrote the now-inherited preexisting direct grant.';
  assert exists (
    select 1
    from public.employee_permission_overrides permission_override
    where permission_override.id = retained_grant_id
      and permission_override.employee_id = target_employee
      and permission_override.permission_code = direct_grant_code
      and permission_override.effect = 'grant'
      and permission_override.active
      and permission_override.created_by is not distinct from retained_grant_actor
      and permission_override.reason is not distinct from retained_grant_reason
      and permission_override.created_at is not distinct from retained_grant_created_at
  ), 'Role-only save rewrote provenance for an unchanged explicit direct grant.';
  assert exists (
    select 1
    from public.employee_permission_overrides permission_override
    where permission_override.employee_id = target_employee
      and permission_override.permission_code = denied_code
      and permission_override.effect = 'deny'
      and permission_override.active
  ), 'Promotion removed the protected direct deny.';

  payload := public.set_employee_access_profile_with_primary_role(
    target_employee,
    'guard',
    array[supervisor_role_id, extra_role_id],
    array[direct_grant_code, redundant_grant_code],
    'Rollback-only Supervisor to Guard demotion.'
  );

  assert (select role = 'guard' from public.employees where id = target_employee),
    'Supervisor to Guard did not update the primary workforce role.';
  assert not (effective_difference_code = any(private.employee_effective_permissions(target_employee))),
    'Demotion retained a Supervisor-only effective permission.';
  assert exists (
    select 1 from public.employee_access_roles
    where employee_id = target_employee and role_id = extra_role_id
  ) and not exists (
    select 1 from public.employee_access_roles
    where employee_id = target_employee and role_id in (guard_role_id, supervisor_role_id)
  ), 'Demotion did not preserve the custom extra while removing primary bundles.';
  assert exists (
    select 1 from public.employee_permission_overrides
    where employee_id = target_employee and permission_code = denied_code
      and effect = 'deny' and active
  ), 'Demotion removed an active deny.';

  select count(*) into audit_count_before
  from private.audit_events
  where table_name = 'employee_access_profile'
    and operation = 'UPDATE_WITH_PRIMARY_ROLE'
    and row_id = target_employee::text;

  begin
    perform public.set_employee_access_profile_with_primary_role(
      target_employee, 'supervisor', array[extra_role_id],
      array[direct_grant_code, redundant_grant_code, effective_difference_code],
      'This newly requested redundant permission must fail.'
    );
    raise exception 'A newly requested inherited direct grant was accepted.';
  exception when check_violation then
    null;
  end;

  assert (select role = 'guard' from public.employees where id = target_employee)
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = target_employee and role_id = extra_role_id
    )
    and (select count(*) from private.audit_events
      where table_name = 'employee_access_profile'
        and operation = 'UPDATE_WITH_PRIMARY_ROLE'
        and row_id = target_employee::text) = audit_count_before,
    'Invalid inherited-grant input did not roll back the entire access change.';

  begin
    perform public.set_employee_access_profile_with_primary_role(
      target_employee, 'guard', array[extra_role_id],
      array[direct_grant_code, redundant_grant_code, denied_code],
      'A denied permission cannot be granted.'
    );
    raise exception 'A direct grant conflicting with an active deny was accepted.';
  exception when check_violation then
    null;
  end;
  assert exists (
    select 1 from public.employee_permission_overrides
    where employee_id = target_employee and permission_code = denied_code
      and effect = 'deny' and active
  ), 'The denied grant attempt removed its protected deny.';

  -- An inactive employee remains visible with active and retired memberships,
  -- and the roles-only RPC can manage non-separated records.
  payload := public.get_access_control_center();
  assert exists (
    select 1
    from jsonb_array_elements(payload -> 'users') user_record
    where (user_record ->> 'id')::uuid = inactive_employee
      and user_record ->> 'status' = 'inactive'
      and exists (
        select 1 from jsonb_array_elements_text(user_record -> 'assignedRoleIds') role_id
        where role_id::uuid = extra_role_id
      )
      and exists (
        select 1 from jsonb_array_elements_text(user_record -> 'assignedRoleIds') role_id
        where role_id::uuid = retired_role_id
      )
      and exists (
        select 1 from jsonb_array_elements_text(user_record -> 'assignedRoleIds') role_id
        where role_id::uuid = retired_guard_role_id
      )
  ), 'Access Center hid a non-active employee or a retired membership.';

  perform public.set_employee_access_profile_with_primary_role(
    inactive_employee, 'supervisor',
    array[guard_role_id, extra_role_id, retired_role_id, retired_guard_role_id],
    array[]::text[],
    'Rollback-only inactive employee role maintenance.'
  );
  assert (select role = 'supervisor' and status = 'inactive' from public.employees where id = inactive_employee),
    'The roles-only RPC could not manage a non-separated inactive employee.';
  assert exists (
    select 1 from public.employee_access_roles
    where employee_id = inactive_employee and role_id = retired_role_id
  ) and exists (
    select 1 from public.employee_access_roles
    where employee_id = inactive_employee and role_id = retired_guard_role_id
  ), 'A role save removed a retained retired custom or historical system membership.';

  perform public.set_employee_access_profile_with_primary_role(
    inactive_employee, 'guard',
    array[supervisor_role_id, extra_role_id, retired_role_id, retired_guard_role_id],
    array[redundant_grant_code],
    'Rollback-only retired system bundle demotion regression.'
  );
  assert (select role = 'guard' from public.employees where id = inactive_employee)
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = inactive_employee and role_id = retired_guard_role_id
    )
    and not exists (
      select 1 from public.employee_access_roles
      where employee_id = inactive_employee and role_id in (guard_role_id, supervisor_role_id)
    ), 'Demotion removed the retired historical Guard bundle or retained an active primary bundle.';

  perform public.set_employee_access_profile_with_primary_role(
    inactive_employee, 'supervisor',
    array[guard_role_id, extra_role_id, retired_role_id, retired_guard_role_id],
    array[redundant_grant_code],
    'Restore inactive employee after retired system bundle demotion regression.'
  );

  perform public.set_employee_access_profile(
    inactive_employee,
    array[extra_role_id, retired_role_id, retired_guard_role_id],
    array[]::text[],
    'Legacy additive save must preserve retired roles and inherited old grants.'
  );
  assert (select role = 'supervisor' and status = 'inactive' from public.employees where id = inactive_employee)
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = inactive_employee and role_id = retired_role_id
    )
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = inactive_employee and role_id = retired_guard_role_id
    )
    and exists (
      select 1
      from public.employee_permission_overrides permission_override
      where permission_override.employee_id = inactive_employee
        and permission_override.permission_code = redundant_grant_code
        and permission_override.effect = 'grant'
        and permission_override.active
        and permission_override.reason = 'Inactive employee inherited-grant fixture.'
    ), 'Legacy additive round-trip lost retired membership, primary role, status, or inherited direct-grant provenance.';

  perform public.set_employee_access_roles(
    inactive_employee,
    array[extra_role_id, retired_role_id, retired_guard_role_id]
  );
  assert (select role = 'supervisor' and status = 'inactive' from public.employees where id = inactive_employee)
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = inactive_employee and role_id = retired_role_id
    )
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = inactive_employee and role_id = retired_guard_role_id
    )
    and exists (
      select 1
      from public.employee_permission_overrides permission_override
      where permission_override.employee_id = inactive_employee
        and permission_override.permission_code = redundant_grant_code
        and permission_override.effect = 'grant'
        and permission_override.active
        and permission_override.reason = 'Inactive employee inherited-grant fixture.'
    ), 'The two-argument legacy role endpoint lost a retired role or direct-grant provenance.';

  select permission_override.id,
         permission_override.created_by,
         permission_override.reason,
         permission_override.created_at
  into legacy_hidden_grant_id,
       legacy_hidden_grant_actor,
       legacy_hidden_grant_reason,
       legacy_hidden_grant_created_at
  from public.employee_permission_overrides permission_override
  where permission_override.employee_id = inactive_employee
    and permission_override.permission_code = direct_grant_code
    and permission_override.effect = 'grant'
    and permission_override.active;

  -- The old editor hid direct grants that were redundant under an additional
  -- role. When that role is removed, its omitted grant must re-emerge instead
  -- of being silently deactivated.
  perform public.set_employee_access_profile(
    inactive_employee,
    array[retired_role_id, retired_guard_role_id],
    array[]::text[],
    'Legacy client removed a role that had hidden an individual grant.'
  );
  assert not exists (
    select 1 from public.employee_access_roles
    where employee_id = inactive_employee and role_id = extra_role_id
  ) and exists (
    select 1
    from public.employee_permission_overrides permission_override
    where permission_override.id = legacy_hidden_grant_id
      and permission_override.employee_id = inactive_employee
      and permission_override.permission_code = direct_grant_code
      and permission_override.effect = 'grant'
      and permission_override.active
      and permission_override.created_by is not distinct from legacy_hidden_grant_actor
      and permission_override.reason is not distinct from legacy_hidden_grant_reason
      and permission_override.created_at is not distinct from legacy_hidden_grant_created_at
  ), 'The legacy four-argument endpoint destroyed or rewrote a hidden individual grant.';

  begin
    perform public.set_employee_access_profile_with_primary_role(
      target_employee, 'guard', array[extra_role_id, retired_role_id],
      array[direct_grant_code, redundant_grant_code],
      'A retired role cannot be newly assigned.'
    );
    raise exception 'A retired role was newly assigned to another employee.';
  exception when check_violation then
    null;
  end;
  assert not exists (
    select 1 from public.employee_access_roles
    where employee_id = target_employee and role_id = retired_role_id
  ), 'The denied retired-role assignment was not rolled back.';

  -- A stale User Accounts payload includes the former primary role. The wrapper
  -- must remove that bundle and retain the unrelated custom membership.
  select assignment.assigned_by, assignment.assigned_at
  into stale_assignment_actor, stale_assignment_time
  from public.employee_access_roles assignment
  where assignment.employee_id = stale_employee
    and assignment.role_id = extra_role_id;

  perform public.admin_update_employee_with_time_zone_and_access_roles(
    stale_employee, 'Atomic', null, 'Stale Client', null, 'supervisor', 'hourly', 'active',
    'SYG-9905', null, null, null, null, 'America/Chicago',
    array[guard_role_id, extra_role_id]
  );
  assert (select role = 'supervisor' from public.employees where id = stale_employee)
    and exists (
      select 1 from public.employee_access_roles
      where employee_id = stale_employee and role_id = extra_role_id
    )
    and not exists (
      select 1 from public.employee_access_roles
      where employee_id = stale_employee and role_id in (guard_role_id, supervisor_role_id)
    ) and exists (
      select 1
      from public.employee_access_roles assignment
      where assignment.employee_id = stale_employee
        and assignment.role_id = extra_role_id
        and assignment.assigned_by is not distinct from stale_assignment_actor
        and assignment.assigned_at is not distinct from stale_assignment_time
    ), 'The stale User Accounts payload retained the former primary bundle or rewrote unchanged-role provenance.';

  -- Only a primary Admin may add or remove additive system_admin. A non-Admin
  -- role manager may round-trip an unchanged assignment without losing it.
  perform public.set_employee_access_profile_with_primary_role(
    admin_membership_employee, 'guard', array[extra_role_id, admin_role_id], array[]::text[],
    'Rollback-only Admin membership fixture.'
  );

  perform public.set_employee_access_profile_with_primary_role(
    role_manager_employee, 'guard', array[role_manager_role_id, admin_role_id], array[]::text[],
    'Rollback-only non-primary Admin fixture.'
  );

  select assignment.assigned_by, assignment.assigned_at
  into retained_admin_assignment_actor, retained_admin_assignment_time
  from public.employee_access_roles assignment
  where assignment.employee_id = admin_membership_employee
    and assignment.role_id = admin_role_id;

  perform set_config('request.jwt.claim.sub', role_manager_auth::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', role_manager_auth, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);

  assert not public.is_admin(),
    'An additive system_admin membership must not become a primary Admin identity.';

  begin
    perform public.set_access_role_permissions(admin_role_id, admin_permission_codes);
    raise exception 'An additive, non-primary Admin edited the protected Admin role.';
  exception when insufficient_privilege then
    null;
  end;

  perform public.set_employee_access_roles(
    admin_membership_employee, array[extra_role_id, admin_role_id]
  );
  assert exists (
    select 1 from public.employee_access_roles assignment
    where assignment.employee_id = admin_membership_employee
      and assignment.role_id = admin_role_id
      and assignment.assigned_by is not distinct from retained_admin_assignment_actor
      and assignment.assigned_at is not distinct from retained_admin_assignment_time
  ), 'An unchanged additive Admin assignment did not round-trip.';

  begin
    perform public.set_employee_access_roles(admin_membership_employee, array[extra_role_id]);
    raise exception 'A non-primary Admin removed additive Admin access.';
  exception when insufficient_privilege then
    null;
  end;
  assert exists (
    select 1 from public.employee_access_roles
    where employee_id = admin_membership_employee and role_id = admin_role_id
  ), 'The denied additive Admin removal was not rolled back.';

  begin
    perform public.set_employee_access_roles(
      target_employee, array[extra_role_id, admin_role_id]
    );
    raise exception 'A non-primary Admin added additive Admin access.';
  exception when insufficient_privilege then
    null;
  end;
  assert not exists (
    select 1 from public.employee_access_roles
    where employee_id = target_employee and role_id = admin_role_id
  ), 'The denied additive Admin addition was not rolled back.';

  begin
    perform public.admin_update_employee(
      recovery_admin_employee, 'Atomic', null, 'Recovery Admin', null,
      'admin', 'salary', 'active', 'SYG-9908', 'Forbidden non-primary Admin edit',
      null, null, null
    );
    raise exception 'A non-primary Admin edited a primary Admin target.';
  exception when insufficient_privilege then
    null;
  end;
  assert coalesce((select job_title from public.employees where id = recovery_admin_employee), '') <> 'Forbidden non-primary Admin edit',
    'The denied non-primary Admin target edit changed the employee.';

  begin
    perform public.set_employee_access_profile_with_primary_role(
      recovery_admin_employee, 'supervisor', array[]::uuid[], array[]::text[],
      'Additive Admin cannot demote a primary Admin.'
    );
    raise exception 'An additive, non-primary Admin demoted a primary Admin.';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.set_employee_permission_override(
      recovery_admin_employee,
      denied_code,
      'grant',
      'Additive Admin cannot edit a primary Admin direct access profile.'
    );
    raise exception 'An additive, non-primary Admin edited a primary Admin permission override.';
  exception when insufficient_privilege then
    null;
  end;
  assert not exists (
    select 1 from public.employee_permission_overrides
    where employee_id = recovery_admin_employee
      and permission_code = denied_code
      and active
  ), 'The denied primary-Admin override mutation was not rolled back.';

  perform set_config('request.jwt.claim.sub', admin_auth::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', admin_auth, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);

  perform public.admin_update_employee(
    recovery_admin_employee, 'Atomic', null, 'Recovery Admin', null,
    'admin', 'salary', 'active', 'SYG-9908', 'Primary Admin approved edit',
    null, null, null
  );
  assert (select job_title = 'Primary Admin approved edit' from public.employees where id = recovery_admin_employee),
    'A primary Admin could not edit another primary Admin target.';

  -- Separated access remains visible for audit, but every interactive direct,
  -- role-only, and combined User Accounts mutation surface is read-only. The
  -- controlled hard-delete routine is intentionally not trigger-blocked.
  begin
    perform public.clear_employee_permission_override(separated_override_id);
    raise exception 'A separated employee permission override was cleared.';
  exception when no_data_found then
    null;
  end;

  begin
    perform public.set_employee_permission_override(
      separated_employee,
      denied_code,
      'grant',
      'Separated employees are read-only.'
    );
    raise exception 'A separated employee received a permission override.';
  exception when no_data_found then
    null;
  end;

  begin
    perform public.set_employee_workforce_roles(
      separated_employee,
      'supervisor',
      array[extra_role_id],
      'Separated employees are read-only.'
    );
    raise exception 'A separated employee workforce role was changed.';
  exception when no_data_found then
    null;
  end;

  begin
    perform public.admin_update_employee_with_time_zone_and_access_roles(
      separated_employee, 'Atomic', null, 'Separated', null,
      'guard', 'hourly', 'separated', 'SYG-9911', null,
      null, null, null, 'America/Denver', array[]::uuid[]
    );
    raise exception 'The combined User Accounts wrapper changed separated access.';
  exception when no_data_found then
    null;
  end;

  assert exists (
      select 1
      from public.employee_permission_overrides permission_override
      where permission_override.id = separated_override_id
        and permission_override.employee_id = separated_employee
        and permission_override.active
    )
    and exists (
      select 1
      from public.employee_access_roles assignment
      where assignment.employee_id = separated_employee
        and assignment.role_id = extra_role_id
    )
    and (select role = 'guard' and status = 'separated'
         from public.employees where id = separated_employee),
    'A denied separated-target mutation changed retained role or override history.';

  begin
    perform public.set_employee_access_profile_with_primary_role(
      admin_employee, 'supervisor', array[]::uuid[], array[]::text[],
      'Self role changes must be rejected before any return-payload reauthorization.'
    );
    raise exception 'A primary Admin changed their own access profile.';
  exception when insufficient_privilege then
    null;
  end;
  assert (select role = 'admin' from public.employees where id = admin_employee),
    'The denied self-demotion changed the Admin role.';

  begin
    perform public.set_employee_access_profile_with_primary_role(
      recovery_admin_employee, 'supervisor', array[]::uuid[], array[]::text[],
      'The final recovery-capable Admin must remain.'
    );
    raise exception 'The final recovery-capable Admin was demoted.';
  exception when check_violation then
    null;
  end;
  assert (select role = 'admin' from public.employees where id = recovery_admin_employee),
    'The denied final-recovery Admin demotion changed the Admin role.';

  begin
    perform public.set_employee_permission_override(
      recovery_admin_employee,
      'admin.roles.manage',
      'deny',
      'The final recovery-capable Admin cannot receive a critical deny.'
    );
    raise exception 'A critical deny removed the final Admin recovery path.';
  exception when check_violation then
    null;
  end;
  assert not exists (
    select 1 from public.employee_permission_overrides
    where employee_id = recovery_admin_employee
      and permission_code = 'admin.roles.manage'
      and effect = 'deny'
      and active
  ), 'The denied critical override was not rolled back.';

  begin
    perform public.admin_set_employee_account_state(recovery_admin_employee, true);
    raise exception 'The final recovery-capable Admin account was disabled.';
  exception when check_violation then
    null;
  end;
  assert exists (
    select 1 from private.employee_accounts
    where employee_id = recovery_admin_employee and disabled_at is null
  ), 'The denied final-recovery Admin disable changed the account.';

  begin
    perform public.admin_separate_employee(
      recovery_admin_employee,
      'Rollback-only final recovery Admin separation denial.',
      current_date
    );
    raise exception 'The final recovery-capable Admin was separated.';
  exception when check_violation then
    null;
  end;
  assert (select status = 'active' from public.employees where id = recovery_admin_employee),
    'The denied final-recovery Admin separation changed employment status.';

  begin
    perform public.terminate_hr_employee(
      recovery_admin_employee,
      current_date,
      'Rollback-only final recovery Admin termination denial.',
      'atomicrecoveryadmin'
    );
    raise exception 'HR termination removed the final recovery-capable Admin.';
  exception when check_violation then
    null;
  end;
  assert (select status = 'active' from public.employees where id = recovery_admin_employee),
    'The denied final-recovery Admin termination changed employment status.';

  assert position('pg_advisory_xact_lock' in pg_get_functiondef(
      'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure
    )) > 0
    and position('pg_advisory_xact_lock' in pg_get_functiondef(
      'public.admin_update_employee(uuid,text,text,text,text,public.app_role,public.employment_type,public.employee_status,text,text,text,text,text)'::regprocedure
    )) > 0
    and position('pg_advisory_xact_lock' in pg_get_functiondef(
      'public.admin_set_employee_account_state(uuid,boolean)'::regprocedure
    )) > 0
    and position('pg_advisory_xact_lock' in pg_get_functiondef(
      'private.separate_employee_account_and_future_work(uuid,uuid,text,date)'::regprocedure
    )) > 0
    and position('pg_advisory_xact_lock' in pg_get_functiondef(
      'private.active_admin_account_count()'::regprocedure
    )) > 0,
    'A last-Admin decrement path is missing the shared advisory transaction lock.';

  assert position('for update' in lower(pg_get_functiondef(
      'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure
    ))) > 0
    and position('for update' in lower(pg_get_functiondef(
      'public.set_employee_permission_override(uuid,text,text,text)'::regprocedure
    ))) > 0
    and position('for update' in lower(pg_get_functiondef(
      'public.clear_employee_permission_override(uuid)'::regprocedure
    ))) > 0
    and position('for update' in lower(pg_get_functiondef(
      'public.set_employee_access_roles(uuid,uuid[])'::regprocedure
    ))) > 0
    and position('for update' in lower(pg_get_functiondef(
      'public.set_employee_access_roles(uuid,uuid[])'::regprocedure
    ))) < position('set_employee_workforce_roles' in lower(pg_get_functiondef(
      'public.set_employee_access_roles(uuid,uuid[])'::regprocedure
    ))),
    'Role-only and direct-override writers do not share the required employee-row lock ordering.';

  assert exists (
      select 1
      from pg_catalog.pg_trigger trigger_record
      where trigger_record.tgrelid = 'public.employees'::regclass
        and trigger_record.tgname = 'employees_contextual_primary_role_creation_authority'
        and not trigger_record.tgisinternal
        and trigger_record.tgenabled <> 'D'
    )
    and position('require_primary_role_creation_authority(context_actor_id, new.role)'
      in lower(pg_get_functiondef(
        'private.enforce_contextual_primary_role_creation_authority()'::regprocedure
      ))) > 0
    and position('sygshift.role_creation_actor_id' in pg_get_functiondef(
      'public.service_review_candidate_conversion(uuid,uuid,text,text)'::regprocedure
    )) > 0
    and position('sygshift.role_creation_actor_id' in pg_get_functiondef(
      'public.service_hr_onboarding_create_prehire(uuid,jsonb,text)'::regprocedure
    )) > 0
    and position('sygshift.role_creation_actor_id' in pg_get_functiondef(
      'public.promote_import_scope(uuid,date,date,boolean,text)'::regprocedure
    )) > 0
    and position('legacy import can create Guards only' in pg_get_functiondef(
      'public.service_promote_import_people(uuid)'::regprocedure
    )) > 0,
    'A candidate, onboarding, or import final-write path is missing the contextual role-creation boundary.';

  assert has_function_privilege(
      'authenticated',
      'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.set_employee_access_profile_with_primary_role(uuid,public.app_role,uuid[],text[],text)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'public.set_employee_access_profile(uuid,uuid[],text[],text)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.set_employee_workforce_roles(uuid,public.app_role,uuid[],text)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'public.set_access_role_permissions(uuid,text[])'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.set_access_role_permissions(uuid,text[])'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'private.replace_employee_additional_access_roles(uuid,uuid,uuid[])'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.admin_create_employee(text,text,text,text,public.app_role,public.employment_type,public.employee_status,text,text,text,text,text)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.service_review_candidate_conversion(uuid,uuid,text,text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.service_review_candidate_conversion(uuid,uuid,text,text)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.service_hr_onboarding_create_prehire(uuid,jsonb,text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.service_hr_onboarding_create_prehire(uuid,jsonb,text)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'public.promote_import_scope(uuid,date,date,boolean,text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.promote_import_scope(uuid,date,date,boolean,text)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.service_promote_import_people(uuid)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.service_promote_import_people(uuid)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'private.review_candidate_conversion_legacy_body(uuid,uuid,text,text)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'private.hr_onboarding_create_prehire_legacy_body(uuid,jsonb,text)'::regprocedure,
      'EXECUTE'
    ),
    'Role/access function execute grants or revokes do not match the application boundary.';

  assert (
    select description = 'Create employees with default Guard access and edit basic profile, contact, and employment details without changing roles or access.'
    from public.permission_catalog
    where code = 'admin.users.basic'
  ), 'The admin.users.basic catalog contract still claims role-edit authority.';

  assert exists (
    select 1
    from private.audit_events event
    where event.table_name = 'employee_access_profile'
      and event.operation = 'UPDATE_WITH_PRIMARY_ROLE'
      and event.row_id = target_employee::text
      and event.new_record ->> 'primaryRole' = 'guard'
      and event.new_record ? 'roleIds'
      and event.new_record ? 'permissionAdditions'
      and nullif(event.new_record ->> 'reason', '') is not null
  ), 'The atomic role change did not write the required before/after audit contract.';
end
$atomic_primary_role_regression$;

rollback;
