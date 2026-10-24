-- Rollback-only regression for Licensing credential-document authority.
-- Delayed interactive completions and scheduled recovery must preserve the
-- newest stored upload as the credential pointer without losing document or
-- audit history.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $licensing_document_authority_fence_regression$
declare
  actor_id uuid;
  actor_auth_user_id uuid;
  credential_type_id uuid := gen_random_uuid();
  credential_id uuid := gen_random_uuid();
  interactive_a_id uuid := gen_random_uuid();
  interactive_b_id uuid := gen_random_uuid();
  recovery_a_id uuid := gen_random_uuid();
  recovery_b_id uuid := gen_random_uuid();
  interactive_a_path text;
  interactive_b_path text;
  recovery_a_path text;
  recovery_b_path text;
  interactive_a_result jsonb;
  interactive_b_result jsonb;
  interactive_a_retry jsonb;
  recovery_a_result jsonb;
  recovery_b_result jsonb;
  recovery_a_retry jsonb;
begin
  assert not has_function_privilege(
    'service_role',
    'private.reconcile_licensing_credential_document_authority(uuid,uuid,uuid,text,text)',
    'execute'
  ), 'The service role must not bypass the public Licensing completion boundaries.';
  assert not has_function_privilege(
    'authenticated',
    'public.record_licensing_credential_document(uuid,text,text,text,bigint)',
    'execute'
  ), 'The legacy direct-path writer must not bypass checksum-verified document authority.';

  select employee.id, account.auth_user_id
  into actor_id, actor_auth_user_id
  from public.employees employee
  join private.employee_accounts account
    on account.employee_id = employee.id
   and account.disabled_at is null
  where employee.status = 'active'
    and account.auth_user_id is not null
    and coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['licensing.manage', 'directory.edit_credentials']::text[]
  order by employee.created_at, employee.id
  limit 1;

  assert actor_id is not null and actor_auth_user_id is not null,
    'An active Licensing document manager is required for this rollback-only regression.';

  interactive_a_path := actor_id::text || '/' || credential_id::text || '/' || interactive_a_id::text || '.pdf';
  interactive_b_path := actor_id::text || '/' || credential_id::text || '/' || interactive_b_id::text || '.pdf';
  recovery_a_path := actor_id::text || '/' || credential_id::text || '/' || recovery_a_id::text || '.pdf';
  recovery_b_path := actor_id::text || '/' || credential_id::text || '/' || recovery_b_id::text || '.pdf';

  insert into public.credential_types(
    id, code, name, category, expiration_required, affects_work_eligibility, active
  ) values (
    credential_type_id,
    'authority_' || replace(credential_type_id::text, '-', ''),
    'Document Authority Regression Credential',
    'Regression Test',
    false,
    false,
    true
  );

  insert into public.employee_credentials(
    id, employee_id, credential_type_id, kind, status, credential_number,
    issuing_authority, valid_from
  ) values (
    credential_id,
    actor_id,
    credential_type_id,
    'other',
    'pending',
    'AUTHORITY-FENCE',
    'Rollback Test Authority',
    current_date
  );

  insert into public.employee_credential_documents(
    id, credential_id, storage_path, original_filename, content_type,
    byte_size, uploaded_by, uploaded_at, archived_at, archived_by,
    archive_reason, upload_request_id, upload_state, sha256_checksum,
    stored_at, failure_detail
  ) values
  (
    interactive_a_id, credential_id, interactive_a_path, 'interactive-a.pdf', 'application/pdf',
    501, actor_id, clock_timestamp() - interval '20 minutes', clock_timestamp(), actor_id,
    'Protected upload pending', gen_random_uuid(), 'pending', repeat('a', 64), null, null
  ),
  (
    interactive_b_id, credential_id, interactive_b_path, 'interactive-b.pdf', 'application/pdf',
    502, actor_id, clock_timestamp() - interval '19 minutes', clock_timestamp(), actor_id,
    'Protected upload pending', gen_random_uuid(), 'pending', repeat('b', 64), null, null
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_user_id, 'role', 'service_role', 'aal', 'aal2')::text,
    true
  );

  -- B is newer but completes first. A's delayed completion must become stored
  -- history without rolling the credential pointer backward.
  interactive_b_result := public.service_complete_licensing_document_upload(
    actor_id, interactive_b_id, gen_random_uuid()
  );
  interactive_a_result := public.service_complete_licensing_document_upload(
    actor_id, interactive_a_id, gen_random_uuid()
  );
  interactive_a_retry := public.service_complete_licensing_document_upload(
    actor_id, interactive_a_id, gen_random_uuid()
  );

  assert (interactive_b_result ->> 'authorityApplied')::boolean,
    'The newest interactive upload must become authoritative.';
  assert not (interactive_a_result ->> 'authorityApplied')::boolean
    and not (interactive_a_retry ->> 'authorityApplied')::boolean,
    'A delayed older completion and its exact retry must remain non-authoritative.';
  assert interactive_a_result ->> 'authoritativeDocumentId' = interactive_b_id::text
    and interactive_a_retry ->> 'authoritativeDocumentId' = interactive_b_id::text,
    'Interactive completion and retry must report the same newer authority.';
  assert (
    select credential.document_path
    from public.employee_credentials credential
    where credential.id = credential_id
  ) = interactive_b_path,
    'Out-of-order interactive completion must preserve the newest document path.';
  assert (
    select count(*)
    from public.employee_credential_documents document
    where document.id in (interactive_a_id, interactive_b_id)
      and document.upload_state = 'stored'
      and document.archived_at is null
  ) = 2,
    'Both verified immutable documents must remain stored as history.';
  assert (
    select count(*)
    from private.audit_events event
    where event.table_name = 'employee_credential_documents'
      and event.operation = 'LICENSING_DOCUMENT_UPLOADED'
      and event.row_id = interactive_a_id::text
  ) = 1,
    'An exact retry must not duplicate the interactive upload audit event.';

  insert into public.employee_credential_documents(
    id, credential_id, storage_path, original_filename, content_type,
    byte_size, uploaded_by, uploaded_at, archived_at, archived_by,
    archive_reason, upload_request_id, upload_state, sha256_checksum,
    stored_at, failure_detail
  ) values
  (
    recovery_a_id, credential_id, recovery_a_path, 'recovery-a.pdf', 'application/pdf',
    503, actor_id, clock_timestamp() - interval '18 minutes', clock_timestamp(), actor_id,
    'Protected upload pending', gen_random_uuid(), 'pending', repeat('c', 64), null, null
  ),
  (
    recovery_b_id, credential_id, recovery_b_path, 'recovery-b.pdf', 'application/pdf',
    504, actor_id, clock_timestamp() - interval '17 minutes', clock_timestamp(), actor_id,
    'Protected upload pending', gen_random_uuid(), 'pending', repeat('d', 64), null, null
  );

  -- Simulate an interactive B completion overlapping with a delayed scheduled
  -- recovery of A. Recovery may preserve A, but it cannot regain authority.
  recovery_b_result := public.service_complete_licensing_document_upload(
    actor_id, recovery_b_id, gen_random_uuid()
  );
  recovery_a_result := public.service_complete_licensing_document_upload_recovery(
    actor_id, recovery_a_id, recovery_a_path, 503, repeat('c', 64)
  );
  recovery_a_retry := public.service_complete_licensing_document_upload_recovery(
    actor_id, recovery_a_id, recovery_a_path, 503, repeat('c', 64)
  );

  assert (recovery_b_result ->> 'authorityApplied')::boolean,
    'The newer interactive completion in a recovery overlap must become authoritative.';
  assert not (recovery_a_result ->> 'authorityApplied')::boolean
    and not (recovery_a_retry ->> 'authorityApplied')::boolean,
    'Delayed scheduled recovery and its retry must not roll authority backward.';
  assert recovery_a_result ->> 'authoritativeDocumentId' = recovery_b_id::text
    and recovery_a_retry ->> 'authoritativeDocumentId' = recovery_b_id::text,
    'Recovery must report the exact newer authority after overlap.';
  assert (
    select credential.document_path
    from public.employee_credentials credential
    where credential.id = credential_id
  ) = recovery_b_path,
    'Recovery overlap must preserve the newest stored document path.';
  assert (
    select count(*)
    from private.audit_events event
    where event.table_name = 'employee_credential_documents'
      and event.operation = 'LICENSING_DOCUMENT_UPLOAD_RECOVERED'
      and event.row_id = recovery_a_id::text
  ) = 1,
    'An exact recovery retry must not duplicate the recovered audit event.';

  -- Complete an even newer upload through recovery to prove the same lane can
  -- legitimately advance authority and not merely block changes.
  update public.employee_credential_documents document
  set upload_state = 'pending',
      archived_at = clock_timestamp(),
      archived_by = actor_id,
      archive_reason = 'Protected upload pending',
      stored_at = null
  where document.id = recovery_b_id;
  update public.employee_credentials credential
  set document_path = interactive_b_path
  where credential.id = credential_id;

  recovery_b_result := public.service_complete_licensing_document_upload_recovery(
    actor_id, recovery_b_id, recovery_b_path, 504, repeat('d', 64)
  );
  assert (recovery_b_result ->> 'authorityApplied')::boolean
    and recovery_b_result ->> 'authoritativeDocumentId' = recovery_b_id::text,
    'Exact scheduled recovery must be able to advance authority to its newer document.';
  assert (
    select credential.document_path
    from public.employee_credentials credential
    where credential.id = credential_id
  ) = recovery_b_path,
    'The newer recovered document must become the canonical credential path.';
end
$licensing_document_authority_fence_regression$;

rollback;
