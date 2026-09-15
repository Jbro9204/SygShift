-- Rollback-only verification for the recoverable Licensing Center credential lifecycle.
-- No fixture created here survives the final ROLLBACK.
begin;

do $$
declare
  actor_employee_id uuid;
  actor_auth_user_id uuid;
  actor_role public.app_role;
  actor_employment_type public.employment_type;
  unauthorized_auth_user_id uuid;
  fixture_type_id uuid := gen_random_uuid();
  fixture_credential_id uuid := gen_random_uuid();
  fixture_replacement_id uuid := gen_random_uuid();
  fixture_document_id uuid := gen_random_uuid();
  result jsonb;
  center jsonb;
begin
  select employee.id, account.auth_user_id, employee.role, employee.employment_type
  into actor_employee_id, actor_auth_user_id, actor_role, actor_employment_type
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and account.auth_user_id is not null
    and coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['licensing.manage', 'directory.edit_credentials']::text[]
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  select account.auth_user_id
  into unauthorized_auth_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and account.auth_user_id is not null
    and not (
      coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['licensing.manage', 'directory.edit_credentials']::text[]
    )
  order by employee.created_at
  limit 1;

  assert actor_auth_user_id is not null, 'An active credential editor is required for the rollback-only lifecycle test.';
  assert unauthorized_auth_user_id is not null, 'An active employee without credential-edit permission is required for the rollback-only lifecycle test.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_user_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  insert into public.credential_types (
    id,
    code,
    name,
    category,
    expiration_required,
    affects_work_eligibility,
    active
  ) values (
    fixture_type_id,
    'archive_restore_' || replace(fixture_type_id::text, '-', ''),
    'Archive Restore Test Credential',
    'Test',
    false,
    true,
    true
  );

  insert into public.credential_requirements (
    credential_type_id,
    role,
    employment_type,
    required,
    active,
    notes
  ) values (
    fixture_type_id,
    actor_role,
    actor_employment_type,
    true,
    true,
    'Rollback-only credential archive and restore verification.'
  );

  insert into public.employee_credentials (
    id,
    employee_id,
    credential_type_id,
    kind,
    status,
    credential_number,
    issuing_authority,
    valid_from,
    verified_at,
    verified_by
  ) values (
    fixture_credential_id,
    actor_employee_id,
    fixture_type_id,
    'other',
    'active',
    'ROLLBACK-ONLY',
    'Rollback Test Authority',
    current_date,
    clock_timestamp(),
    actor_employee_id
  );

  insert into public.employee_credential_documents (
    id,
    credential_id,
    storage_path,
    original_filename,
    content_type,
    byte_size,
    uploaded_by,
    upload_state,
    stored_at
  ) values (
    fixture_document_id,
    fixture_credential_id,
    'rollback-only/' || fixture_document_id::text || '/credential.pdf',
    'credential.pdf',
    'application/pdf',
    512,
    actor_employee_id,
    'stored',
    clock_timestamp()
  );

  begin
    perform public.archive_licensing_credential(actor_employee_id, fixture_credential_id, '', null);
    raise exception 'Removing a credential without a reason must fail.';
  exception when check_violation then null;
  end;

  begin
    perform public.archive_licensing_credential(gen_random_uuid(), fixture_credential_id, 'duplicate', null);
    raise exception 'A mismatched employee and credential must fail.';
  exception when no_data_found then null;
  end;

  result := public.archive_licensing_credential(
    actor_employee_id,
    fixture_credential_id,
    'entered_by_mistake',
    'Rollback-only lifecycle test'
  );
  assert result ->> 'state' = 'removed', 'Archive returns the removed state.';
  assert (select credential.archived_at is not null from public.employee_credentials credential where credential.id = fixture_credential_id), 'The credential is archived.';
  assert (select credential.archived_by = actor_employee_id from public.employee_credentials credential where credential.id = fixture_credential_id), 'The archive actor is preserved.';
  assert (select credential.archive_reason_code = 'entered_by_mistake' from public.employee_credentials credential where credential.id = fixture_credential_id), 'The selected reason is preserved.';
  assert exists (select 1 from public.employee_credential_documents document where document.id = fixture_document_id and document.credential_id = fixture_credential_id), 'Credential documents are retained.';
  assert exists (
    select 1
    from jsonb_array_elements(public.get_removed_licensing_credentials()) removed
    where removed ->> 'credentialId' = fixture_credential_id::text
      and removed ->> 'documentCount' = '1'
  ), 'The removed-credentials list exposes the retained record and document count.';

  center := public.get_licensing_center();
  assert exists (
    select 1
    from jsonb_array_elements(center -> 'employees') employee,
         jsonb_array_elements(employee -> 'credentials') credential
    where employee ->> 'employeeId' = actor_employee_id::text
      and credential ->> 'credentialTypeId' = fixture_type_id::text
      and credential ->> 'status' = 'Missing'
  ), 'Removing a required credential immediately returns it as Missing.';

  assert exists (
    select 1
    from private.audit_events event
    where event.table_name = 'employee_credentials'
      and event.row_id = fixture_credential_id::text
      and event.operation = 'LICENSING_CREDENTIAL_ARCHIVED'
      and event.old_record ->> 'archived_at' is null
      and event.new_record ->> 'archive_reason_code' = 'entered_by_mistake'
  ), 'The archive audit contains before and after evidence.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', unauthorized_auth_user_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  begin
    perform public.restore_licensing_credential(actor_employee_id, fixture_credential_id);
    raise exception 'An employee without credential-edit permission must not restore a credential.';
  exception when insufficient_privilege then null;
  end;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_user_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  result := public.restore_licensing_credential(actor_employee_id, fixture_credential_id);
  assert result ->> 'state' = 'restored', 'Restore returns the restored state.';
  assert (select credential.archived_at is null and credential.archived_by is null and credential.archive_reason_code is null and credential.archive_reason is null from public.employee_credentials credential where credential.id = fixture_credential_id), 'Restore returns the same row to the active profile.';
  assert exists (select 1 from public.employee_credential_documents document where document.id = fixture_document_id), 'Restore keeps the original document relationship.';
  assert exists (
    select 1
    from private.audit_events event
    where event.table_name = 'employee_credentials'
      and event.row_id = fixture_credential_id::text
      and event.operation = 'LICENSING_CREDENTIAL_RESTORED'
      and event.old_record ->> 'archived_at' is not null
      and event.new_record ->> 'archived_at' is null
  ), 'The restore audit contains before and after evidence.';

  perform public.archive_licensing_credential(actor_employee_id, fixture_credential_id, 'duplicate', null);
  insert into public.employee_credentials (
    id,
    employee_id,
    credential_type_id,
    kind,
    status,
    credential_number
  ) values (
    fixture_replacement_id,
    actor_employee_id,
    fixture_type_id,
    'other',
    'pending',
    'ROLLBACK-REPLACEMENT'
  );

  begin
    perform public.restore_licensing_credential(actor_employee_id, fixture_credential_id);
    raise exception 'Restore must fail while an active credential of the same type exists.';
  exception when unique_violation then null;
  end;

  assert not has_function_privilege('anon', 'public.get_removed_licensing_credentials()', 'EXECUTE'), 'Anonymous removed-credential reads stay denied.';
  assert not has_function_privilege('anon', 'public.archive_licensing_credential(uuid,uuid,text,text)', 'EXECUTE'), 'Anonymous archive stays denied.';
  assert not has_function_privilege('anon', 'public.restore_licensing_credential(uuid,uuid)', 'EXECUTE'), 'Anonymous restore stays denied.';
  assert has_function_privilege('authenticated', 'public.archive_licensing_credential(uuid,uuid,text,text)', 'EXECUTE'), 'Authenticated callers may reach the permission-enforcing archive boundary.';
end
$$;

rollback;
