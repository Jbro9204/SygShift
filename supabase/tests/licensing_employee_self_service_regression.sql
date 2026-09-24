-- Rollback-only verification for employee licensing self-service, protected
-- document ownership, reviewer decisions, and canonical credential promotion.
begin;

do $$
declare
  fixture_employee_id uuid;
  employee_auth_id uuid;
  reviewer_id uuid;
  reviewer_auth_id uuid;
  fixture_credential_type_id uuid := gen_random_uuid();
  fixture_submission_id uuid := gen_random_uuid();
  upload_request_id uuid := gen_random_uuid();
  fixture_document_id uuid;
  fixture_credential_id uuid;
  payload jsonb;
begin
  select employee.id, account.auth_user_id
  into fixture_employee_id, employee_auth_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and account.auth_user_id is not null
    and not (
      coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['licensing.view', 'licensing.manage', 'directory.edit_credentials']::text[]
    )
  order by employee.created_at
  limit 1;

  select employee.id, account.auth_user_id
  into reviewer_id, reviewer_auth_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and account.auth_user_id is not null
    and coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['licensing.manage', 'directory.edit_credentials']::text[]
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  assert employee_auth_id is not null, 'An active employee without Licensing management access is required.';
  assert reviewer_auth_id is not null, 'An active Licensing reviewer is required.';

  insert into public.credential_types(
    id, code, name, category, expiration_required, affects_work_eligibility, active
  ) values (
    fixture_credential_type_id,
    'employee_self_service_' || replace(fixture_credential_type_id::text, '-', ''),
    'Employee Self-Service Test Credential',
    'Regression Test',
    true,
    false,
    true
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth_id, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );

  payload := public.save_my_licensing_submission(
    fixture_submission_id,
    fixture_credential_type_id,
    null,
    'new',
    'SELF-SERVICE-TEST',
    'Regression Authority',
    current_date,
    current_date + 365,
    'Rollback-only employee self-service licensing submission.'
  );
  assert exists(
    select 1 from jsonb_array_elements(payload -> 'submissions') item
    where item ->> 'id' = fixture_submission_id::text and item ->> 'status' = 'draft'
  ), 'Employee can create and read only their own draft submission.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', reviewer_auth_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  begin
    perform public.save_my_licensing_submission(
      fixture_submission_id,
      fixture_credential_type_id,
      null,
      'new',
      'CROSS-EMPLOYEE',
      'Regression Authority',
      current_date,
      current_date + 365,
      'This cross-employee edit must be rejected by the database.'
    );
    raise exception 'Cross-employee draft editing was accepted.';
  exception when insufficient_privilege then null;
  end;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth_id, 'role', 'service_role', 'aal', 'aal2')::text,
    true
  );
  payload := public.service_prepare_licensing_submission_document_upload(
    fixture_employee_id,
    fixture_submission_id,
    upload_request_id,
    'credential.pdf',
    'application/pdf',
    512,
    repeat('a', 64),
    'pdf'
  );
  fixture_document_id := (payload ->> 'documentId')::uuid;
  payload := public.service_complete_licensing_document_upload(fixture_employee_id, fixture_document_id, gen_random_uuid());
  assert payload ->> 'state' = 'stored', 'Submission document completes through the protected service boundary.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth_id, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );
  payload := public.submit_my_licensing_submission(fixture_submission_id);
  assert exists(
    select 1 from jsonb_array_elements(payload -> 'submissions') item
    where item ->> 'id' = fixture_submission_id::text and item ->> 'status' = 'pending_review'
  ), 'Stored evidence can be submitted for authorized review.';
  assert exists(
    select 1 from public.employee_notifications notification
    where notification.source_type = 'licensing_submission'
      and notification.source_id = fixture_submission_id
      and notification.recipient_employee_id = reviewer_id
      and notification.action_required
      and notification.resolved_at is null
  ), 'Authorized reviewer receives an actionable Licensing notification.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', reviewer_auth_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  payload := public.review_licensing_submission(fixture_submission_id, 'approve', 'Verified against the attached issuer document.');
  fixture_credential_id := (payload ->> 'credentialId')::uuid;
  assert payload ->> 'status' = 'approved', 'Reviewer approval closes the submission.';
  assert exists(
    select 1 from public.employee_credentials credential
    where credential.id = fixture_credential_id
      and credential.employee_id = fixture_employee_id
      and credential.credential_type_id = fixture_credential_type_id
      and credential.status = 'active'
  ), 'Approval promotes the submission into the canonical credential record.';
  assert exists(
    select 1 from public.licensing_credential_versions version
    where version.credential_id = fixture_credential_id
      and version.source_submission_id = fixture_submission_id
  ), 'Approval records an immutable source-linked credential version.';
  assert exists(
    select 1 from public.employee_credential_documents document
    where document.id = fixture_document_id
      and document.credential_id = fixture_credential_id
      and document.submission_id = fixture_submission_id
  ), 'Protected evidence remains linked to both its submission and canonical credential.';
  assert exists(
    select 1 from public.employee_notifications notification
    where notification.source_type = 'licensing_submission_status'
      and notification.source_id = fixture_submission_id
      and notification.recipient_employee_id = fixture_employee_id
      and notification.title = 'Licensing submission approved'
  ), 'Employee receives a privacy-safe approval notification.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth_id, 'role', 'service_role', 'aal', 'aal1')::text,
    true
  );
  payload := public.service_authorize_licensing_document_access(
    fixture_employee_id,
    fixture_document_id,
    'preview',
    'Employee views own licensing document.',
    gen_random_uuid(),
    null,
    null
  );
  assert payload ->> 'bucket' = 'credential-documents', 'Employee may access their own protected document without management permission.';

  begin
    perform public.service_authorize_licensing_document_access(
      reviewer_id,
      fixture_document_id,
      'preview',
      'Reviewer cross-employee access without recent MFA.',
      gen_random_uuid(),
      null,
      null
    );
    raise exception 'Cross-employee protected access without recent MFA was accepted.';
  exception when insufficient_privilege then null;
  end;

  assert has_function_privilege('authenticated', 'public.get_my_licensing_profile()', 'EXECUTE'),
    'Authenticated employees can reach the ownership-enforcing profile boundary.';
  assert not has_function_privilege('anon', 'public.get_my_licensing_profile()', 'EXECUTE'),
    'Anonymous callers cannot read employee Licensing profiles.';
  assert not has_table_privilege('authenticated', 'public.licensing_submissions', 'SELECT'),
    'Authenticated users cannot bypass the ownership-enforcing RPC with direct table reads.';
  assert not has_function_privilege('authenticated', 'public.service_prepare_licensing_submission_document_upload(uuid,uuid,uuid,text,text,bigint,text,text)', 'EXECUTE'),
    'Browser sessions cannot call the storage preparation boundary directly.';
end
$$;

rollback;
