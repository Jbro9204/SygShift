create or replace function public.get_hr_people_record(target_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_viewer();
  can_view_restricted boolean := public.has_effective_permission('hr.people.restricted');
  can_view_documents boolean :=
    (public.has_effective_permission('hr.documents.view') or public.has_effective_permission('hr.documents.manage'))
    and coalesce((select gate.enabled from private.hr_document_release_gate gate where gate.singleton), false);
  can_view_onboarding boolean :=
    (public.has_effective_permission('hr.onboarding.view') or public.has_effective_permission('hr.onboarding.manage'))
    and coalesce((select gate.enabled from private.hr_onboarding_release_gate gate where gate.singleton), false);
  can_view_leave boolean :=
    (public.has_effective_permission('hr.leave.view') or public.has_effective_permission('hr.leave.manage'))
    and coalesce((select gate.enabled from private.hr_leave_release_gate gate where gate.singleton), false);
  can_view_benefits boolean :=
    (public.has_effective_permission('hr.benefits.view') or public.has_effective_permission('hr.benefits.manage'))
    and coalesce((select gate.enabled from private.hr_benefits_release_gate gate where gate.singleton), false);
  can_view_compensation boolean :=
    (public.has_effective_permission('hr.compensation.view') or public.has_effective_permission('hr.compensation.manage'))
    and coalesce((select gate.enabled from private.hr_compensation_release_gate gate where gate.singleton), false);
  can_view_talent boolean :=
    (public.has_effective_permission('hr.talent.view') or public.has_effective_permission('hr.talent.manage'))
    and coalesce((select gate.enabled from private.hr_stage8_release_gates gate where gate.module = 'talent'), false);
  can_view_learning boolean :=
    (public.has_effective_permission('hr.learning.view') or public.has_effective_permission('hr.learning.manage'))
    and coalesce((select gate.enabled from private.hr_stage8_release_gates gate where gate.module = 'learning'), false);
  can_view_cases boolean :=
    (public.has_effective_permission('hr.cases.view') or public.has_effective_permission('hr.cases.manage'))
    and coalesce((select gate.enabled from private.hr_stage8_release_gates gate where gate.module = 'cases'), false);
  can_view_safety boolean :=
    (public.has_effective_permission('hr.safety.view') or public.has_effective_permission('hr.safety.manage'))
    and coalesce((select gate.enabled from private.hr_stage8_release_gates gate where gate.module = 'safety'), false);
  can_view_assets boolean :=
    (public.has_effective_permission('hr.assets.view') or public.has_effective_permission('hr.assets.manage'))
    and coalesce((select gate.enabled from private.hr_stage8_release_gates gate where gate.module = 'assets'), false);
  can_view_offboarding boolean :=
    (public.has_effective_permission('hr.offboarding.view') or public.has_effective_permission('hr.offboarding.manage'))
    and coalesce((select gate.enabled from private.hr_stage9_release_gates gate where gate.module = 'offboarding'), false);
  can_view_self_service boolean :=
    (public.has_effective_permission('hr.self_service.view') or public.has_effective_permission('hr.self_service.manage'))
    and coalesce((select gate.enabled from private.hr_stage9_release_gates gate where gate.module = 'self_service'), false);
  result jsonb;
begin
  perform actor_id;

  select jsonb_build_object(
    'employeeId', employee.id,
    'legalName', concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name),
    'firstName', employee.first_name,
    'middleName', employee.middle_name,
    'lastName', employee.last_name,
    'employeeNumber', employee.employee_number,
    'username', employee.username,
    'jobTitle', employee.job_title,
    'status', employee.status::text,
    'employmentType', employee.employment_type::text,
    'primaryRole', employee.role::text,
    'hiredOn', employee.hired_on,
    'separatedOn', employee.separated_on,
    'account', jsonb_build_object(
      'status', case
        when account.disabled_at is not null then 'disabled'
        when account.activated_at is not null then 'active'
        when account.employee_id is not null then 'pending'
        else 'not_created'
      end,
      'invitedAt', account.invited_at,
      'activatedAt', account.activated_at,
      'disabledAt', account.disabled_at,
      'lastSignInAt', account.last_sign_in_at
    ),
    'contacts', case when can_view_restricted then jsonb_build_object(
      'personalEmail', contact.personal_email,
      'companyEmail', contact.company_email,
      'mobilePhone', contact.mobile_phone,
      'emergencyContactName', contact.emergency_contact_name,
      'emergencyContactPhone', contact.emergency_contact_phone,
      'addressLine1', contact.address_line_1,
      'addressLine2', contact.address_line_2,
      'city', contact.city,
      'region', contact.region,
      'postalCode', contact.postal_code
    ) else null end,
    'canViewRestricted', can_view_restricted,
    'readinessSignals', array_remove(array[
      case when employee.employee_number is null then 'employee_number_missing' end,
      case when employee.hired_on is null and employee.status::text in ('active', 'onboarding', 'leave') then 'hire_date_missing' end,
      case when employee.status::text = 'separated' and employee.separated_on is null then 'separation_date_missing' end
    ], null)::text[],
    'moduleAccess', jsonb_build_object(
      'documents', can_view_documents,
      'onboarding', can_view_onboarding,
      'leave', can_view_leave,
      'benefits', can_view_benefits,
      'compensation', can_view_compensation,
      'talent', can_view_talent,
      'learning', can_view_learning,
      'cases', can_view_cases,
      'safety', can_view_safety,
      'assets', can_view_assets,
      'offboarding', can_view_offboarding,
      'selfService', can_view_self_service
    ),
    'connectedRecords', jsonb_build_object(
      'activeCredentials', (
        select count(*) from public.employee_credentials credential
        where credential.employee_id = employee.id
          and credential.status::text = 'active'
          and (credential.expires_on is null or credential.expires_on >= current_date)
      ),
      'expiredCredentials', (
        select count(*) from public.employee_credentials credential
        where credential.employee_id = employee.id
          and (credential.status::text = 'expired' or credential.expires_on < current_date)
      ),
      'upcomingAvailability', (
        select count(*) from public.employee_availability availability
        where availability.employee_id = employee.id
          and availability.ends_on >= current_date
          and availability.approval_status::text = 'approved'
      ),
      'pendingTimeOff', (
        select count(*) from public.time_off_requests request
        where request.employee_id = employee.id and request.status::text = 'pending'
      ),
      'documents', case when can_view_documents then jsonb_build_object(
        'total', (select count(*) from private.hr_documents document where document.employee_id = employee.id and document.archived_at is null),
        'expiring', (select count(*) from private.hr_documents document where document.employee_id = employee.id and document.archived_at is null and document.expiration_date between current_date and current_date + 60)
      ) else null end,
      'onboarding', case when can_view_onboarding then jsonb_build_object(
        'status', (select onboarding.status::text from private.hr_onboarding_cases onboarding where onboarding.employee_id = employee.id),
        'openTasks', (select count(*) from private.hr_onboarding_tasks task join private.hr_onboarding_cases onboarding on onboarding.id = task.case_id where onboarding.employee_id = employee.id and task.status::text in ('not_started', 'in_progress')),
        'blockedTasks', (select count(*) from private.hr_onboarding_tasks task join private.hr_onboarding_cases onboarding on onboarding.id = task.case_id where onboarding.employee_id = employee.id and task.status::text = 'blocked')
      ) else null end,
      'leave', case when can_view_leave then jsonb_build_object(
        'open', (select count(*) from private.hr_leave_cases leave_case where leave_case.employee_id = employee.id and leave_case.status::text in ('open', 'under_review', 'approved')),
        'upcoming', (select count(*) from private.hr_leave_cases leave_case where leave_case.employee_id = employee.id and leave_case.status::text = 'approved' and leave_case.start_on >= current_date)
      ) else null end,
      'benefits', case when can_view_benefits then jsonb_build_object(
        'active', (select count(*) from private.hr_benefit_employee_enrollments enrollment where enrollment.employee_id = employee.id and enrollment.status::text = 'active'),
        'pending', (select count(*) from private.hr_benefit_employee_enrollments enrollment where enrollment.employee_id = employee.id and enrollment.status::text = 'pending')
      ) else null end,
      'compensation', case when can_view_compensation then jsonb_build_object(
        'activeRecords', (select count(*) from private.hr_employee_compensation_records compensation where compensation.employee_id = employee.id and compensation.effective_from <= current_date and (compensation.effective_through is null or compensation.effective_through >= current_date))
      ) else null end,
      'talent', case when can_view_talent then jsonb_build_object(
        'openGoals', (select count(*) from private.hr_talent_goals goal where goal.employee_id = employee.id and goal.status::text in ('draft', 'active')),
        'pendingReviews', (select count(*) from private.hr_talent_reviews review where review.employee_id = employee.id and review.status::text in ('draft', 'in_progress', 'submitted')),
        'activePlans', (select count(*) from private.hr_talent_development_plans plan where plan.employee_id = employee.id and plan.status::text in ('draft', 'active'))
      ) else null end,
      'learning', case when can_view_learning then jsonb_build_object(
        'assigned', (select count(*) from private.hr_learning_assignments assignment where assignment.employee_id = employee.id and assignment.status::text in ('assigned', 'in_progress')),
        'overdue', (select count(*) from private.hr_learning_assignments assignment where assignment.employee_id = employee.id and assignment.status::text = 'overdue')
      ) else null end,
      'employeeCases', case when can_view_cases then jsonb_build_object(
        'open', (select count(*) from private.hr_cases employee_case where employee_case.subject_employee_id = employee.id and employee_case.status::text in ('open', 'triage', 'investigating', 'pending')),
        'highPriority', (select count(*) from private.hr_cases employee_case where employee_case.subject_employee_id = employee.id and employee_case.status::text in ('open', 'triage', 'investigating', 'pending') and employee_case.priority::text in ('high', 'urgent'))
      ) else null end,
      'safety', case when can_view_safety then jsonb_build_object(
        'open', (select count(*) from private.hr_safety_cases safety_case where safety_case.employee_id = employee.id and safety_case.status::text not in ('closed', 'canceled'))
      ) else null end,
      'assets', case when can_view_assets then jsonb_build_object(
        'assigned', (select count(*) from private.hr_asset_assignments assignment where assignment.employee_id = employee.id and assignment.status::text = 'active')
      ) else null end,
      'lifecycle', case when can_view_offboarding then jsonb_build_object(
        'open', (select count(*) from private.hr_lifecycle_cases lifecycle where lifecycle.employee_id = employee.id and lifecycle.status::text not in ('completed', 'canceled'))
      ) else null end,
      'selfService', case when can_view_self_service then jsonb_build_object(
        'pending', (select count(*) from private.hr_service_requests request where request.subject_employee_id = employee.id and request.status::text in ('submitted', 'under_review', 'approved'))
      ) else null end
    )
  )
  into result
  from public.employees employee
  left join private.employee_accounts account on account.employee_id = employee.id
  left join private.employee_contacts contact on contact.employee_id = employee.id
  where employee.id = target_employee_id;

  if result is null then
    raise no_data_found using message = 'Employee record not found.';
  end if;

  return result;
end
$$;

revoke all on function public.get_hr_people_record(uuid) from public, anon;
grant execute on function public.get_hr_people_record(uuid) to authenticated;
