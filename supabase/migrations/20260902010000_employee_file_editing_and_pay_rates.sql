begin;

create temporary table employee_file_full_edit_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select coalesce(md5(string_agg(concat_ws(':', employee.id::text, employee.first_name, coalesce(employee.middle_name, ''), employee.last_name, coalesce(employee.employee_number, ''), coalesce(employee.job_title, ''), employee.employment_type::text, employee.status::text, coalesce(employee.hired_on::text, ''), coalesce(employee.separated_on::text, '')), '|' order by employee.id)), md5('')) from public.employees employee) as employee_fingerprint,
  (select count(*) from private.employee_contacts) as contact_count,
  (select coalesce(md5(string_agg(concat_ws(':', contact.employee_id::text, coalesce(contact.personal_email, ''), coalesce(contact.company_email, ''), coalesce(contact.mobile_phone, ''), coalesce(contact.emergency_contact_name, ''), coalesce(contact.emergency_contact_phone, ''), coalesce(contact.address_line_1, ''), coalesce(contact.address_line_2, ''), coalesce(contact.city, ''), coalesce(contact.region, ''), coalesce(contact.postal_code, '')), '|' order by contact.employee_id)), md5('')) from private.employee_contacts contact) as contact_fingerprint,
  (select count(*) from private.employee_accounts) as account_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.employee_permission_overrides) as permission_override_count,
  (select count(*) from public.shifts) as shift_count,
  (select count(*) from public.time_events) as time_event_count,
  (select count(*) from private.payroll_export_batches) as payroll_batch_count,
  (select count(*) from private.hr_employee_compensation_records) as compensation_record_count,
  (select count(*) from private.hr_compensation_proposals) as compensation_proposal_count,
  (select count(*) from private.hr_compensation_events) as compensation_event_count,
  (select coalesce(md5(string_agg(concat_ws(':', role_permission.role_id::text, role_permission.permission_code, role_permission.enabled::text), '|' order by role_permission.role_id, role_permission.permission_code)), md5(''))
     from public.access_role_permissions role_permission
    where role_permission.role_id not in (select role.id from public.access_roles role where role.code = 'system_admin')) as non_admin_permission_fingerprint;

alter table public.employees
  add column if not exists work_classification text;

alter table public.employees
  drop constraint if exists employees_work_classification;

alter table public.employees
  add constraint employees_work_classification
  check (work_classification is null or work_classification in ('full_time', 'part_time', 'flex'));

alter table private.employee_contacts
  add column if not exists emergency_contact_relationship text,
  add column if not exists emergency_contact_email text;

alter table private.employee_contacts
  drop constraint if exists employee_contacts_emergency_relationship_length,
  drop constraint if exists employee_contacts_emergency_email_length;

alter table private.employee_contacts
  add constraint employee_contacts_emergency_relationship_length
    check (emergency_contact_relationship is null or char_length(emergency_contact_relationship) <= 80),
  add constraint employee_contacts_emergency_email_length
    check (emergency_contact_email is null or char_length(emergency_contact_email) <= 254);

create or replace function private.require_hr_people_editor(target_restricted boolean default false)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_viewer();
begin
  if not public.has_effective_permission('hr.people.manage') then
    raise insufficient_privilege using message = 'HR employee-record management permission is required.';
  end if;

  if target_restricted and not public.has_effective_permission('hr.people.restricted') then
    raise insufficient_privilege using message = 'Restricted HR record permission is required.';
  end if;

  return actor_id;
end
$$;

revoke all on function private.require_hr_people_editor(boolean) from public, anon, authenticated;

create or replace function public.get_hr_employee_profile_editor_context(target_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_viewer();
  can_manage_profile boolean := public.has_effective_permission('hr.people.manage');
  can_view_restricted boolean := public.has_effective_permission('hr.people.restricted');
  compensation_enabled boolean := coalesce((select gate.enabled from private.hr_compensation_release_gate gate where gate.singleton), false);
  result jsonb;
begin
  perform actor_id;

  select jsonb_build_object(
    'employeeId', employee.id,
    'workClassification', employee.work_classification,
    'canManageProfile', can_manage_profile,
    'canManageRestricted', can_manage_profile and can_view_restricted,
    'canViewCompensation', compensation_enabled and (
      public.has_effective_permission('hr.compensation.view')
      or public.has_effective_permission('hr.compensation.manage')
    ),
    'canManageCompensation', compensation_enabled and public.has_effective_permission('hr.compensation.manage'),
    'canApproveCompensation', compensation_enabled and public.has_effective_permission('hr.compensation.approve'),
    'restrictedContactExtension', case when can_view_restricted then jsonb_build_object(
      'emergencyContactRelationship', contact.emergency_contact_relationship,
      'emergencyContactEmail', contact.emergency_contact_email
    ) else null end
  )
  into result
  from public.employees employee
  left join private.employee_contacts contact on contact.employee_id = employee.id
  where employee.id = target_employee_id;

  if result is null then
    raise no_data_found using message = 'Employee record not found.';
  end if;

  return result;
end
$$;

create or replace function public.update_hr_employee_identity(
  target_employee_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_employee_number text,
  target_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_editor(false);
  employee_record public.employees%rowtype;
  clean_first_name text := btrim(coalesce(target_first_name, ''));
  clean_middle_name text := nullif(btrim(coalesce(target_middle_name, '')), '');
  clean_last_name text := btrim(coalesce(target_last_name, ''));
  clean_employee_number text := nullif(upper(btrim(coalesce(target_employee_number, ''))), '');
  clean_reason text := btrim(coalesce(target_reason, ''));
  changed_at timestamptz := clock_timestamp();
begin
  if clean_first_name = '' or char_length(clean_first_name) > 100
    or clean_last_name = '' or char_length(clean_last_name) > 100
    or (clean_middle_name is not null and char_length(clean_middle_name) > 100) then
    raise check_violation using message = 'Enter valid legal names of 100 characters or fewer.';
  end if;
  if clean_employee_number is not null and (char_length(clean_employee_number) > 40 or clean_employee_number !~ '^[A-Z0-9-]+$') then
    raise check_violation using message = 'Employee number may contain letters, numbers, and hyphens only.';
  end if;
  if clean_reason = '' or char_length(clean_reason) > 1000 then
    raise check_violation using message = 'A reason of 1 to 1,000 characters is required.';
  end if;

  select employee.* into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found then raise no_data_found using message = 'Employee record not found.'; end if;
  if clean_employee_number is not null and exists (
    select 1 from public.employees employee
    where employee.employee_number = clean_employee_number and employee.id <> target_employee_id
  ) then
    raise unique_violation using message = 'That employee number is already assigned.';
  end if;
  if employee_record.first_name = clean_first_name
    and employee_record.middle_name is not distinct from clean_middle_name
    and employee_record.last_name = clean_last_name
    and employee_record.employee_number is not distinct from clean_employee_number then
    raise check_violation using message = 'No identity changes were entered.';
  end if;

  update public.employees employee
  set first_name = clean_first_name,
      middle_name = clean_middle_name,
      last_name = clean_last_name,
      employee_number = clean_employee_number,
      updated_at = changed_at
  where employee.id = target_employee_id;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record)
  values(
    (select auth.uid()), actor_id, 'public', 'employees', 'UPDATE_HR_IDENTITY', target_employee_id::text,
    jsonb_build_object('firstName', employee_record.first_name, 'middleName', employee_record.middle_name, 'lastName', employee_record.last_name, 'employeeNumber', employee_record.employee_number),
    jsonb_build_object('firstName', clean_first_name, 'middleName', clean_middle_name, 'lastName', clean_last_name, 'employeeNumber', clean_employee_number, 'reason', clean_reason)
  );

  return jsonb_build_object('employeeId', target_employee_id, 'updatedAt', changed_at);
end
$$;

create or replace function public.update_hr_employee_employment_profile(
  target_employee_id uuid,
  target_job_title text,
  target_employment_type public.employment_type,
  target_work_classification text,
  target_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_editor(false);
  employee_record public.employees%rowtype;
  clean_job_title text := nullif(btrim(coalesce(target_job_title, '')), '');
  clean_work_classification text := lower(btrim(coalesce(target_work_classification, '')));
  clean_reason text := btrim(coalesce(target_reason, ''));
  changed_at timestamptz := clock_timestamp();
begin
  if clean_job_title is not null and char_length(clean_job_title) > 160 then
    raise check_violation using message = 'Job title must be 160 characters or fewer.';
  end if;
  if clean_work_classification not in ('full_time', 'part_time', 'flex') then
    raise check_violation using message = 'Choose Full Time, Part Time, or Flex.';
  end if;
  if clean_reason = '' or char_length(clean_reason) > 1000 then
    raise check_violation using message = 'A reason of 1 to 1,000 characters is required.';
  end if;

  select employee.* into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found then raise no_data_found using message = 'Employee record not found.'; end if;
  if employee_record.job_title is not distinct from clean_job_title
    and employee_record.employment_type = target_employment_type
    and employee_record.work_classification is not distinct from clean_work_classification then
    raise check_violation using message = 'No employment-profile changes were entered.';
  end if;

  update public.employees employee
  set job_title = clean_job_title,
      employment_type = target_employment_type,
      work_classification = clean_work_classification,
      updated_at = changed_at
  where employee.id = target_employee_id;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record)
  values(
    (select auth.uid()), actor_id, 'public', 'employees', 'UPDATE_HR_EMPLOYMENT_PROFILE', target_employee_id::text,
    jsonb_build_object('jobTitle', employee_record.job_title, 'employmentType', employee_record.employment_type, 'workClassification', employee_record.work_classification),
    jsonb_build_object('jobTitle', clean_job_title, 'employmentType', target_employment_type, 'workClassification', clean_work_classification, 'reason', clean_reason)
  );

  return jsonb_build_object('employeeId', target_employee_id, 'updatedAt', changed_at);
end
$$;

create or replace function public.update_hr_employee_contact_details(
  target_employee_id uuid,
  target_personal_email text,
  target_company_email text,
  target_mobile_phone text,
  target_address_line_1 text,
  target_address_line_2 text,
  target_city text,
  target_region text,
  target_postal_code text,
  target_emergency_contact_name text,
  target_emergency_contact_relationship text,
  target_emergency_contact_phone text,
  target_emergency_contact_email text,
  target_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_editor(true);
  old_contact jsonb;
  new_contact jsonb;
  clean_personal_email text := nullif(lower(btrim(coalesce(target_personal_email, ''))), '');
  clean_company_email text := nullif(lower(btrim(coalesce(target_company_email, ''))), '');
  clean_mobile_phone text := nullif(btrim(coalesce(target_mobile_phone, '')), '');
  clean_address_line_1 text := nullif(btrim(coalesce(target_address_line_1, '')), '');
  clean_address_line_2 text := nullif(btrim(coalesce(target_address_line_2, '')), '');
  clean_city text := nullif(btrim(coalesce(target_city, '')), '');
  clean_region text := nullif(upper(btrim(coalesce(target_region, ''))), '');
  clean_postal_code text := nullif(upper(btrim(coalesce(target_postal_code, ''))), '');
  clean_emergency_name text := nullif(btrim(coalesce(target_emergency_contact_name, '')), '');
  clean_emergency_relationship text := nullif(btrim(coalesce(target_emergency_contact_relationship, '')), '');
  clean_emergency_phone text := nullif(btrim(coalesce(target_emergency_contact_phone, '')), '');
  clean_emergency_email text := nullif(lower(btrim(coalesce(target_emergency_contact_email, ''))), '');
  clean_reason text := btrim(coalesce(target_reason, ''));
  changed_at timestamptz := clock_timestamp();
begin
  if not exists (select 1 from public.employees employee where employee.id = target_employee_id) then
    raise no_data_found using message = 'Employee record not found.';
  end if;
  if clean_reason = '' or char_length(clean_reason) > 1000 then
    raise check_violation using message = 'A reason of 1 to 1,000 characters is required.';
  end if;
  if (clean_personal_email is not null and (char_length(clean_personal_email) > 254 or position('@' in clean_personal_email) <= 1))
    or (clean_company_email is not null and (char_length(clean_company_email) > 254 or position('@' in clean_company_email) <= 1))
    or (clean_emergency_email is not null and (char_length(clean_emergency_email) > 254 or position('@' in clean_emergency_email) <= 1)) then
    raise check_violation using message = 'Enter valid email addresses.';
  end if;
  if (clean_mobile_phone is not null and clean_mobile_phone !~ '^\+?[0-9 ()-]{7,24}$')
    or (clean_emergency_phone is not null and clean_emergency_phone !~ '^\+?[0-9 ()-]{7,24}$') then
    raise check_violation using message = 'Enter valid phone numbers.';
  end if;
  if clean_emergency_relationship is not null and char_length(clean_emergency_relationship) > 80 then
    raise check_violation using message = 'Emergency-contact relationship must be 80 characters or fewer.';
  end if;

  select to_jsonb(contact) into old_contact
  from private.employee_contacts contact
  where contact.employee_id = target_employee_id;

  insert into private.employee_contacts(
    employee_id, personal_email, company_email, mobile_phone,
    address_line_1, address_line_2, city, region, postal_code,
    emergency_contact_name, emergency_contact_relationship, emergency_contact_phone, emergency_contact_email
  ) values (
    target_employee_id, clean_personal_email, clean_company_email, clean_mobile_phone,
    clean_address_line_1, clean_address_line_2, clean_city, clean_region, clean_postal_code,
    clean_emergency_name, clean_emergency_relationship, clean_emergency_phone, clean_emergency_email
  )
  on conflict (employee_id) do update set
    personal_email = excluded.personal_email,
    company_email = excluded.company_email,
    mobile_phone = excluded.mobile_phone,
    address_line_1 = excluded.address_line_1,
    address_line_2 = excluded.address_line_2,
    city = excluded.city,
    region = excluded.region,
    postal_code = excluded.postal_code,
    emergency_contact_name = excluded.emergency_contact_name,
    emergency_contact_relationship = excluded.emergency_contact_relationship,
    emergency_contact_phone = excluded.emergency_contact_phone,
    emergency_contact_email = excluded.emergency_contact_email,
    updated_at = changed_at
  returning to_jsonb(employee_contacts.*) into new_contact;

  if (coalesce(old_contact, '{}'::jsonb) - array['created_at', 'updated_at', 'personal_email_verified_at']) =
     (new_contact - array['created_at', 'updated_at', 'personal_email_verified_at']) then
    raise check_violation using message = 'No contact changes were entered.';
  end if;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record)
  values(
    (select auth.uid()), actor_id, 'private', 'employee_contacts', 'UPDATE_HR_CONTACT_DETAILS', target_employee_id::text,
    old_contact - array['created_at', 'updated_at', 'personal_email_verified_at'],
    (new_contact - array['created_at', 'updated_at', 'personal_email_verified_at']) || jsonb_build_object('reason', clean_reason)
  );

  return jsonb_build_object('employeeId', target_employee_id, 'updatedAt', changed_at);
end
$$;

alter table private.hr_compensation_release_gate
  add column if not exists release_key text;

alter table private.hr_compensation_release_gate
  drop constraint if exists hr_comp_gate_consistent;

alter table private.hr_compensation_release_gate
  add constraint hr_comp_gate_consistent check (
    (not enabled and enabled_by is null and enabled_at is null and release_key is null)
    or (
      enabled
      and enabled_at is not null
      and btrim(coalesce(reason, '')) <> ''
      and (enabled_by is not null or btrim(coalesce(release_key, '')) <> '')
    )
  );

update private.hr_compensation_release_gate
set enabled = true,
    enabled_by = null,
    enabled_at = clock_timestamp(),
    reason = 'Approved protected employee pay-rate release.',
    release_key = 'employee_file_pay_rates_20260901',
    updated_at = clock_timestamp()
where singleton;

alter table private.hr_compensation_approvals
  drop constraint if exists hr_comp_approval_mfa;

alter table private.hr_compensation_approvals
  add constraint hr_comp_approval_mfa
  check (mfa_method in ('authenticator', 'totp', 'security_key', 'webauthn', 'recovery_code'));

create or replace function private.hr_compensation_require_recent_mfa(target_method text, target_verified_at timestamptz)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_method not in ('authenticator', 'totp', 'security_key', 'webauthn', 'recovery_code')
    or target_verified_at is null
    or target_verified_at < clock_timestamp() - interval '15 minutes'
    or target_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = 'Recent MFA verification is required for compensation access.';
  end if;
end
$$;

create or replace function public.service_get_hr_employee_compensation(
  target_actor_id uuid,
  target_employee_id uuid,
  target_limit integer default 10,
  target_mfa_method text default null,
  target_mfa_verified_at timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  row_limit integer := least(greatest(coalesce(target_limit, 10), 1), 10);
  actor_permissions text[];
  base_component_id uuid;
  result jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage7_assert_enabled('compensation');
  perform private.hr_stage7_require_actor_permission(target_actor_id, 'hr.compensation.view');
  perform private.hr_compensation_require_recent_mfa(target_mfa_method, target_mfa_verified_at);

  if not exists (select 1 from public.employees employee where employee.id = target_employee_id) then
    raise no_data_found using message = 'Employee record not found.';
  end if;

  actor_permissions := private.employee_effective_permissions(target_actor_id);
  select component.id into base_component_id
  from private.hr_compensation_components component
  where component.code = 'base_pay';

  select jsonb_build_object(
    'employeeId', employee.id,
    'employeeName', concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name),
    'employeeNumber', employee.employee_number,
    'canManage', 'hr.compensation.manage' = any(actor_permissions),
    'canApprove', 'hr.compensation.approve' = any(actor_permissions),
    'currentRate', (
      select jsonb_build_object(
        'id', compensation.id,
        'amountCents', compensation.amount_cents,
        'currencyCode', compensation.currency_code,
        'payFrequency', compensation.pay_frequency,
        'effectiveFrom', compensation.effective_from,
        'effectiveThrough', compensation.effective_through
      )
      from private.hr_employee_compensation_records compensation
      where compensation.employee_id = employee.id
        and compensation.component_id = base_component_id
        and compensation.effective_from <= current_date
        and (compensation.effective_through is null or compensation.effective_through >= current_date)
      order by compensation.effective_from desc
      limit 1
    ),
    'pendingProposals', coalesce((
      select jsonb_agg(proposal_record.payload order by proposal_record.proposed_at desc)
      from (
        select proposal.proposed_at, jsonb_build_object(
          'id', proposal.id,
          'amountCents', proposal.proposed_amount_cents,
          'currencyCode', proposal.currency_code,
          'payFrequency', proposal.pay_frequency,
          'effectiveFrom', proposal.effective_from,
          'reason', proposal.reason,
          'proposedBy', concat_ws(' ', proposer.first_name, proposer.last_name),
          'proposedByCurrentActor', proposal.proposed_by = target_actor_id,
          'proposedAt', proposal.proposed_at
        ) as payload
        from private.hr_compensation_proposals proposal
        join public.employees proposer on proposer.id = proposal.proposed_by
        where proposal.employee_id = employee.id
          and proposal.component_id = base_component_id
          and proposal.status = 'pending'
        order by proposal.proposed_at desc
        limit 5
      ) proposal_record
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(history_record.payload order by history_record.effective_from desc)
      from (
        select compensation.effective_from, jsonb_build_object(
          'id', compensation.id,
          'amountCents', compensation.amount_cents,
          'currencyCode', compensation.currency_code,
          'payFrequency', compensation.pay_frequency,
          'effectiveFrom', compensation.effective_from,
          'effectiveThrough', compensation.effective_through
        ) as payload
        from private.hr_employee_compensation_records compensation
        where compensation.employee_id = employee.id
          and compensation.component_id = base_component_id
        order by compensation.effective_from desc
        limit row_limit
      ) history_record
    ), '[]'::jsonb)
  ) into result
  from public.employees employee
  where employee.id = target_employee_id;

  return result;
end
$$;

create or replace function public.service_propose_hr_employee_pay_rate(
  target_actor_id uuid,
  target_employee_id uuid,
  target_amount_cents bigint,
  target_pay_frequency text,
  target_effective_from date,
  target_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_component_id uuid;
  proposal_id uuid;
  proposed_at timestamptz := clock_timestamp();
  clean_frequency text := lower(btrim(coalesce(target_pay_frequency, '')));
  clean_reason text := btrim(coalesce(target_reason, ''));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage7_assert_enabled('compensation');
  perform private.hr_stage7_require_actor_permission(target_actor_id, 'hr.compensation.manage');
  perform private.hr_compensation_require_recent_mfa(target_mfa_method, target_mfa_verified_at);

  if not exists (select 1 from public.employees employee where employee.id = target_employee_id) then
    raise no_data_found using message = 'Employee record not found.';
  end if;
  if target_amount_cents is null or target_amount_cents < 0 or target_amount_cents > 100000000000 then
    raise check_violation using message = 'Enter a valid pay rate.';
  end if;
  if clean_frequency not in ('hourly', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'annual') then
    raise check_violation using message = 'Choose a supported pay frequency.';
  end if;
  if target_effective_from is null then raise check_violation using message = 'An effective date is required.'; end if;
  if clean_reason = '' or char_length(clean_reason) > 1000 then
    raise check_violation using message = 'A reason of 1 to 1,000 characters is required.';
  end if;

  insert into private.hr_compensation_components(code, name, component_type, taxable, status, configuration, created_by)
  values('base_pay', 'Base pay', 'base_pay', true, 'active', '{"employeeFileManaged":true}'::jsonb, target_actor_id)
  on conflict(code) do nothing;

  select component.id into strict base_component_id
  from private.hr_compensation_components component
  where component.code = 'base_pay' and component.status = 'active';

  if exists (
    select 1 from private.hr_compensation_proposals proposal
    where proposal.employee_id = target_employee_id
      and proposal.component_id = base_component_id
      and proposal.status = 'pending'
  ) then
    raise check_violation using message = 'This employee already has a pending pay-rate proposal.';
  end if;

  insert into private.hr_compensation_proposals(
    employee_id, component_id, proposed_amount_cents, currency_code, pay_frequency,
    effective_from, status, reason, proposed_by, proposed_at
  ) values (
    target_employee_id, base_component_id, target_amount_cents, 'USD', clean_frequency,
    target_effective_from, 'pending', clean_reason, target_actor_id, proposed_at
  ) returning id into proposal_id;

  insert into private.hr_compensation_events(employee_id, proposal_id, action, actor_id, reason, details)
  values(target_employee_id, proposal_id, 'PAY_RATE_PROPOSED', target_actor_id, clean_reason,
    jsonb_build_object('amountCents', target_amount_cents, 'currencyCode', 'USD', 'payFrequency', clean_frequency, 'effectiveFrom', target_effective_from));

  return jsonb_build_object('proposalId', proposal_id, 'status', 'pending', 'proposedAt', proposed_at);
end
$$;

create or replace function public.service_review_hr_employee_pay_rate(
  target_actor_id uuid,
  target_proposal_id uuid,
  target_decision text,
  target_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  proposal_record private.hr_compensation_proposals%rowtype;
  clean_decision text := lower(btrim(coalesce(target_decision, '')));
  clean_reason text := btrim(coalesce(target_reason, ''));
  decided_at timestamptz := clock_timestamp();
  compensation_record_id uuid;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage7_assert_enabled('compensation');
  perform private.hr_stage7_require_actor_permission(target_actor_id, 'hr.compensation.approve');
  perform private.hr_compensation_require_recent_mfa(target_mfa_method, target_mfa_verified_at);

  if clean_decision not in ('approved', 'rejected') then
    raise check_violation using message = 'Choose Approve or Reject.';
  end if;
  if clean_reason = '' or char_length(clean_reason) > 1000 then
    raise check_violation using message = 'A review reason of 1 to 1,000 characters is required.';
  end if;

  select proposal.* into proposal_record
  from private.hr_compensation_proposals proposal
  where proposal.id = target_proposal_id
  for update;

  if not found then raise no_data_found using message = 'Pay-rate proposal not found.'; end if;
  if proposal_record.status <> 'pending' then raise check_violation using message = 'This pay-rate proposal has already been reviewed.'; end if;
  if proposal_record.proposed_by = target_actor_id then
    raise insufficient_privilege using message = 'A different authorized administrator must review this pay-rate proposal.';
  end if;

  if clean_decision = 'approved' and exists (
    select 1 from private.hr_employee_compensation_records compensation
    where compensation.employee_id = proposal_record.employee_id
      and compensation.component_id = proposal_record.component_id
      and compensation.effective_from >= proposal_record.effective_from
  ) then
    raise check_violation using message = 'A pay rate already begins on or after this effective date. Choose a later date or review the existing history.';
  end if;

  insert into private.hr_compensation_approvals(proposal_id, decision, approver_id, reason, mfa_method, mfa_verified_at, decided_at)
  values(target_proposal_id, clean_decision, target_actor_id, clean_reason, target_mfa_method, target_mfa_verified_at, decided_at);

  update private.hr_compensation_proposals proposal
  set status = clean_decision,
      resolved_by = target_actor_id,
      resolved_at = decided_at,
      resolution_reason = clean_reason
  where proposal.id = target_proposal_id;

  if clean_decision = 'approved' then
    update private.hr_employee_compensation_records compensation
    set effective_through = proposal_record.effective_from - 1
    where compensation.employee_id = proposal_record.employee_id
      and compensation.component_id = proposal_record.component_id
      and compensation.effective_from < proposal_record.effective_from
      and (compensation.effective_through is null or compensation.effective_through >= proposal_record.effective_from);

    insert into private.hr_employee_compensation_records(
      employee_id, component_id, grade_id, amount_cents, currency_code, pay_frequency,
      effective_from, source_proposal_id, created_by
    ) values (
      proposal_record.employee_id, proposal_record.component_id, proposal_record.grade_id,
      proposal_record.proposed_amount_cents, proposal_record.currency_code, proposal_record.pay_frequency,
      proposal_record.effective_from, proposal_record.id, target_actor_id
    ) returning id into compensation_record_id;
  end if;

  insert into private.hr_compensation_events(employee_id, proposal_id, action, actor_id, reason, details)
  values(proposal_record.employee_id, proposal_record.id,
    case when clean_decision = 'approved' then 'PAY_RATE_APPROVED' else 'PAY_RATE_REJECTED' end,
    target_actor_id, clean_reason,
    jsonb_build_object('compensationRecordId', compensation_record_id, 'effectiveFrom', proposal_record.effective_from));

  return jsonb_build_object(
    'proposalId', proposal_record.id,
    'employeeId', proposal_record.employee_id,
    'status', clean_decision,
    'compensationRecordId', compensation_record_id,
    'decidedAt', decided_at
  );
end
$$;

revoke all on function public.get_hr_employee_profile_editor_context(uuid) from public, anon;
revoke all on function public.update_hr_employee_identity(uuid, text, text, text, text, text) from public, anon;
revoke all on function public.update_hr_employee_employment_profile(uuid, text, public.employment_type, text, text) from public, anon;
revoke all on function public.update_hr_employee_contact_details(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.service_get_hr_employee_compensation(uuid, uuid, integer, text, timestamptz) from public, anon, authenticated;
revoke all on function public.service_propose_hr_employee_pay_rate(uuid, uuid, bigint, text, date, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.service_review_hr_employee_pay_rate(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;

grant execute on function public.get_hr_employee_profile_editor_context(uuid) to authenticated;
grant execute on function public.update_hr_employee_identity(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.update_hr_employee_employment_profile(uuid, text, public.employment_type, text, text) to authenticated;
grant execute on function public.update_hr_employee_contact_details(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.service_get_hr_employee_compensation(uuid, uuid, integer, text, timestamptz) to service_role;
grant execute on function public.service_propose_hr_employee_pay_rate(uuid, uuid, bigint, text, date, text, text, timestamptz) to service_role;
grant execute on function public.service_review_hr_employee_pay_rate(uuid, uuid, text, text, text, timestamptz) to service_role;

insert into public.access_role_permissions(role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code = 'system_admin'
  and permission.code in ('hr.compensation.view', 'hr.compensation.manage', 'hr.compensation.approve')
on conflict(role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

do $$
declare
  baseline employee_file_full_edit_baseline%rowtype;
begin
  select * into strict baseline from employee_file_full_edit_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', employee.id::text, employee.first_name, coalesce(employee.middle_name, ''), employee.last_name, coalesce(employee.employee_number, ''), coalesce(employee.job_title, ''), employee.employment_type::text, employee.status::text, coalesce(employee.hired_on::text, ''), coalesce(employee.separated_on::text, '')), '|' order by employee.id)), md5('')) from public.employees employee)
    or baseline.contact_count <> (select count(*) from private.employee_contacts)
    or baseline.contact_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', contact.employee_id::text, coalesce(contact.personal_email, ''), coalesce(contact.company_email, ''), coalesce(contact.mobile_phone, ''), coalesce(contact.emergency_contact_name, ''), coalesce(contact.emergency_contact_phone, ''), coalesce(contact.address_line_1, ''), coalesce(contact.address_line_2, ''), coalesce(contact.city, ''), coalesce(contact.region, ''), coalesce(contact.postal_code, '')), '|' order by contact.employee_id)), md5('')) from private.employee_contacts contact)
    or baseline.account_count <> (select count(*) from private.employee_accounts)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.permission_override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.shift_count <> (select count(*) from public.shifts)
    or baseline.time_event_count <> (select count(*) from public.time_events)
    or baseline.payroll_batch_count <> (select count(*) from private.payroll_export_batches)
    or baseline.compensation_record_count <> (select count(*) from private.hr_employee_compensation_records)
    or baseline.compensation_proposal_count <> (select count(*) from private.hr_compensation_proposals)
    or baseline.compensation_event_count <> (select count(*) from private.hr_compensation_events)
    or baseline.non_admin_permission_fingerprint <> (
      select coalesce(md5(string_agg(concat_ws(':', role_permission.role_id::text, role_permission.permission_code, role_permission.enabled::text), '|' order by role_permission.role_id, role_permission.permission_code)), md5(''))
      from public.access_role_permissions role_permission
      where role_permission.role_id not in (select role.id from public.access_roles role where role.code = 'system_admin')
    ) then
    raise exception 'The employee-file editing release changed protected production records and was rolled back.';
  end if;
end
$$;

select pg_notify('pgrst', 'reload schema');

commit;
