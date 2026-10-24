-- Rollback-only regression for scheduled Licensing upload availability recovery
-- and durable email operation identities. No fixture survives the final ROLLBACK.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $licensing_availability_and_email_source_regression$
declare
  actor_id uuid;
  actor_auth_user_id uuid;
  credential_type_id uuid := gen_random_uuid();
  credential_id uuid := gen_random_uuid();
  submission_id uuid := gen_random_uuid();
  credential_document_id uuid := gen_random_uuid();
  submission_document_id uuid := gen_random_uuid();
  policy_rejected_document_id uuid := gen_random_uuid();
  password_claim_zero uuid := gen_random_uuid();
  password_claim_one uuid := gen_random_uuid();
  password_claim_two uuid := gen_random_uuid();
  username_claim_zero uuid := gen_random_uuid();
  username_claim_one uuid := gen_random_uuid();
  username_claim_two uuid := gen_random_uuid();
  credential_path text;
  submission_path text;
  policy_rejected_path text;
  payload jsonb;
  source_id uuid;
  verification_id uuid;
  verification_operation_id uuid := gen_random_uuid();
  verification_next_operation_id uuid := gen_random_uuid();
  stale_operation_id uuid := gen_random_uuid();
  newer_operation_id uuid := gen_random_uuid();
  stale_verification_id uuid := gen_random_uuid();
  newer_verification_id uuid;
  verification_expires_at text;
  dispatch_source_id uuid := gen_random_uuid();
  mismatch_rejected boolean := false;
  verification_binding_rejected boolean := false;
  verification_retry_rejected boolean := false;
  stale_replay_rejected boolean := false;
  stale_binding_rejected boolean := false;
  superseded_token_rejected boolean := false;
  second_current_rejected boolean := false;
  verification_confirmed_at text;
  verification_function_definition text;
  manifest_removal_rejected boolean := false;
  manifest_addition_rejected boolean := false;
  manifest_address_change_rejected boolean := false;
begin
  select employee.id, account.auth_user_id
  into actor_id, actor_auth_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and account.auth_user_id is not null
    and coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['licensing.manage', 'directory.edit_credentials']::text[]
  order by employee.created_at, employee.id
  limit 1;

  assert actor_id is not null and actor_auth_user_id is not null,
    'An active employee with an account is required for this rollback-only regression.';

  credential_path := actor_id::text || '/' || credential_id::text || '/' || credential_document_id::text || '.pdf';
  submission_path := actor_id::text || '/submissions/' || submission_id::text || '/' || submission_document_id::text || '.pdf';
  policy_rejected_path := actor_id::text || '/submissions/' || submission_id::text || '/' || policy_rejected_document_id::text || '.pdf';

  insert into public.credential_types(
    id, code, name, category, expiration_required, affects_work_eligibility, active
  ) values (
    credential_type_id,
    'availability_' || replace(credential_type_id::text, '-', ''),
    'Availability Recovery Regression Credential',
    'Regression Test',
    false,
    false,
    true
  );

  insert into public.employee_credentials(
    id, employee_id, credential_type_id, kind, status, credential_number, issuing_authority, valid_from
  ) values (
    credential_id,
    actor_id,
    credential_type_id,
    'other',
    'pending',
    'AVAILABILITY-RECOVERY',
    'Rollback Test Authority',
    current_date
  );

  insert into public.licensing_submissions(
    id, employee_id, credential_type_id, credential_id, submission_kind, status,
    employee_message, submitted_by
  ) values (
    submission_id,
    actor_id,
    credential_type_id,
    credential_id,
    'correction',
    'draft',
    'Rollback-only scheduled availability recovery evidence.',
    actor_id
  );

  insert into public.employee_credential_documents(
    id, credential_id, submission_id, storage_path, original_filename, content_type,
    byte_size, uploaded_by, uploaded_at, archived_at, archived_by, archive_reason,
    upload_request_id, upload_state, sha256_checksum, stored_at, failure_detail
  ) values
  (
    credential_document_id, credential_id, null, credential_path, 'credential.pdf', 'application/pdf',
    512, actor_id, timestamptz '2000-01-01 00:00:00+00', clock_timestamp(), actor_id,
    'Protected upload pending', gen_random_uuid(), 'pending', repeat('a', 64), null, null
  ),
  (
    submission_document_id, null, submission_id, submission_path, 'submission.pdf', 'application/pdf',
    1024, actor_id, timestamptz '2000-01-01 00:00:00+00', clock_timestamp(), actor_id,
    'Protected submission upload pending', gen_random_uuid(), 'pending', repeat('b', 64), null, null
  ),
  (
    policy_rejected_document_id, null, submission_id, policy_rejected_path, 'closed-submission.pdf', 'application/pdf',
    2048, actor_id, timestamptz '2000-01-01 00:00:00+00', clock_timestamp(), actor_id,
    'Protected submission upload pending', gen_random_uuid(), 'pending', repeat('c', 64), null, null
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_user_id, 'role', 'service_role', 'aal', 'aal2')::text,
    true
  );

  payload := public.service_list_licensing_document_availability_recovery(25);
  assert exists(
    select 1 from jsonb_array_elements(payload) item
    where item ->> 'documentId' = credential_document_id::text
      and item ->> 'objectKey' = credential_path
      and item ->> 'sizeBytes' = '512'
      and item ->> 'checksum' = repeat('a', 64)
  ), 'A pending credential upload is selected with its exact protected object identity.';
  assert exists(
    select 1 from jsonb_array_elements(payload) item
    where item ->> 'documentId' = submission_document_id::text
      and item ->> 'objectKey' = submission_path
      and item ->> 'sizeBytes' = '1024'
      and item ->> 'checksum' = repeat('b', 64)
  ), 'A pending employee-submission upload is selected by the same recovery lane.';

  begin
    perform public.service_complete_licensing_document_upload_recovery(
      actor_id, credential_document_id, credential_path, 512, repeat('c', 64)
    );
  exception when check_violation then
    mismatch_rejected := true;
  end;
  assert mismatch_rejected,
    'Recovery refuses to complete a row when the verified checksum does not match.';

  payload := public.service_complete_licensing_document_upload_recovery(
    actor_id, credential_document_id, credential_path, 512, repeat('a', 64)
  );
  assert payload ->> 'state' = 'stored', 'Exact verification completes the credential document.';
  assert exists(
    select 1 from public.employee_credential_documents document
    where document.id = credential_document_id
      and document.upload_state = 'stored'
      and document.stored_at is not null
      and document.archived_at is null
  ), 'Recovered credential evidence is active and stored.';
  assert (
    select credential.document_path = credential_path
    from public.employee_credentials credential
    where credential.id = credential_id
  ), 'Credential recovery restores the canonical credential document path.';

  payload := public.service_fail_licensing_document_upload_recovery(
    actor_id,
    submission_document_id,
    submission_path,
    1024,
    repeat('b', 64),
    'Protected storage object was missing during scheduled verification.'
  );
  assert payload ->> 'state' = 'failed', 'A missing submission object is safely failed.';
  assert exists(
    select 1 from public.employee_credential_documents document
    where document.id = submission_document_id
      and document.upload_state = 'failed'
      and document.cleanup_pending_at is not null
      and document.cleaned_at is null
      and document.archived_at is not null
  ), 'Failed evidence is archived and queued for idempotent object cleanup.';

  payload := public.service_complete_licensing_document_cleanup(
    actor_id, submission_document_id, submission_path, 1024, repeat('b', 64)
  );
  assert payload ->> 'state' = 'failed' and payload ->> 'cleanedAt' is not null,
    'A confirmed absent/deleted object completes the cleanup state without deleting audit history.';

  update public.licensing_submissions
  set status = 'pending_review', submitted_at = clock_timestamp()
  where id = submission_id;
  payload := public.service_complete_licensing_document_upload_recovery(
    actor_id, policy_rejected_document_id, policy_rejected_path, 2048, repeat('c', 64)
  );
  assert payload ->> 'state' = 'failed'
    and (payload ->> 'cleanupAllowed')::boolean
    and payload ->> 'objectKey' = policy_rejected_path,
    'Scheduled recovery applies the interactive submission-state policy and returns an exact cleanup decision.';
  assert exists(
    select 1 from public.employee_credential_documents document
    where document.id = policy_rejected_document_id
      and document.upload_state = 'failed'
      and document.cleanup_pending_at is not null
  ), 'A closed-submission upload is failed instead of bypassing policy and becoming stored.';
  perform public.service_complete_licensing_document_cleanup(
    actor_id, policy_rejected_document_id, policy_rejected_path, 2048, repeat('c', 64)
  );

  insert into private.employee_self_service_password_reset_requests(
    id, username_hash, request_fingerprint_hash, employee_id, outcome, request_id, requested_at
  ) values
  (
    password_claim_zero, repeat('1', 64), repeat('2', 64), actor_id, 'claimed',
    'password-transport-zero-' || password_claim_zero::text, clock_timestamp() - interval '9 minutes'
  ),
  (
    password_claim_one, repeat('1', 64), repeat('2', 64), actor_id, 'claimed',
    'password-transport-one-' || password_claim_one::text, clock_timestamp() - interval '5 minutes'
  ),
  (
    password_claim_two, repeat('1', 64), repeat('2', 64), actor_id, 'claimed',
    'password-transport-two-' || password_claim_two::text, clock_timestamp() - interval '1 minute'
  );

  source_id := public.service_get_password_reset_claim_source(
    'password-transport-two-' || password_claim_two::text
  );
  assert source_id = password_claim_zero,
    'A chained password-reset retry reuses the canonical earliest domain operation beyond the direct lookback.';

  insert into private.employee_self_service_username_requests(
    id, email_hash, request_fingerprint_hash, employee_id, matched_account_count,
    outcome, request_id, requested_at
  ) values
  (
    username_claim_zero, repeat('3', 64), repeat('4', 64), actor_id, 1, 'claimed',
    'username-transport-zero-' || username_claim_zero::text, clock_timestamp() - interval '9 minutes'
  ),
  (
    username_claim_one, repeat('3', 64), repeat('4', 64), actor_id, 1, 'claimed',
    'username-transport-one-' || username_claim_one::text, clock_timestamp() - interval '5 minutes'
  ),
  (
    username_claim_two, repeat('3', 64), repeat('4', 64), actor_id, 1, 'claimed',
    'username-transport-two-' || username_claim_two::text, clock_timestamp() - interval '1 minute'
  );

  source_id := public.service_get_username_recovery_claim_source(
    'username-transport-two-' || username_claim_two::text
  );
  assert source_id = username_claim_zero,
    'A chained username-recovery retry reuses the canonical earliest domain operation beyond the direct lookback.';

  update private.employee_email_verifications
  set superseded_at = clock_timestamp()
  where employee_id = actor_id
    and verified_at is null
    and superseded_at is null;
  payload := public.service_create_email_verification_operation(
    verification_operation_id,
    actor_id,
    'availability-regression@example.invalid',
    'personal_email_verification',
    repeat('5', 64),
    clock_timestamp() + interval '1 hour'
  );
  verification_id := (payload ->> 'verificationId')::uuid;
  verification_expires_at := payload ->> 'expiresAt';
  assert (payload ->> 'operationId')::uuid = verification_operation_id
    and payload ->> 'employeeId' = actor_id::text
    and payload ->> 'requestedEmail' = 'availability-regression@example.invalid'
    and payload ->> 'purpose' = 'personal_email_verification'
    and not (payload ->> 'replayed')::boolean,
    'Personal-email verification returns the complete immutable operation binding.';
  assert exists(
    select 1 from private.employee_email_verifications verification
    where verification.id = verification_id
      and verification.operation_id = verification_operation_id
      and verification.employee_id = actor_id
      and verification.requested_email = 'availability-regression@example.invalid'
      and verification.purpose = 'personal_email_verification'
      and verification.token_hash = repeat('5', 64)
  ), 'Personal-email verification returns the durable verification operation identity.';

  payload := public.service_create_email_verification_operation(
    verification_operation_id,
    actor_id,
    ' AVAILABILITY-REGRESSION@example.invalid ',
    'personal_email_verification',
    repeat('5', 64),
    clock_timestamp() + interval '2 hours'
  );
  assert (payload ->> 'verificationId')::uuid = verification_id
    and (payload ->> 'operationId')::uuid = verification_operation_id
    and payload ->> 'expiresAt' = verification_expires_at
    and (payload ->> 'replayed')::boolean,
    'An exact response-loss replay recovers the same verification id and original expiration.';

  begin
    perform public.service_create_email_verification_operation(
      verification_operation_id,
      actor_id,
      'different-recipient@example.invalid',
      'personal_email_verification',
      repeat('5', 64),
      clock_timestamp() + interval '1 hour'
    );
  exception when check_violation then
    verification_binding_rejected := true;
  end;
  assert verification_binding_rejected,
    'A verification operation UUID cannot be reused with a different recipient binding.';

  assert not exists (
    select 1
    from information_schema.columns column_record
    where column_record.table_schema = 'private'
      and column_record.table_name = 'employee_email_verifications'
      and column_record.column_name in ('token', 'raw_token', 'plaintext_token')
  ), 'The verification operation persists only a token fingerprint, never plaintext link material.';
  assert to_regprocedure(
    'public.service_create_email_verification_operation(uuid,text,text,timestamptz)'
  ) is null, 'The response-loss-vulnerable legacy verification overload is retired.';

  verification_function_definition := pg_get_functiondef(
    'public.service_create_email_verification_operation(uuid,uuid,text,text,text,timestamptz)'::regprocedure
  );
  assert position('employee-email-verification-operation:' in verification_function_definition) > 0
    and position('employee-email-verification:' in verification_function_definition) > 0
    and position('where verification.operation_id = target_operation_id' in verification_function_definition)
      < position('if exists (' in verification_function_definition)
    and position('if exists (' in verification_function_definition)
      < position('update private.employee_email_verifications' in verification_function_definition)
    and position('update private.employee_email_verifications' in verification_function_definition)
      < position('insert into private.employee_email_verifications' in verification_function_definition),
    'Email verification creation serializes each employee before cooldown, supersession, and insert.';

  begin
    perform public.service_create_email_verification_operation(
      verification_next_operation_id,
      actor_id,
      'replacement-that-must-not-send@example.invalid',
      'personal_email_verification',
      repeat('6', 64),
      clock_timestamp() + interval '1 hour'
    );
  exception when check_violation then
    verification_retry_rejected := true;
  end;
  assert verification_retry_rejected,
    'A serialized request inside the cooldown cannot replace the verification token being emailed.';
  assert exists(
    select 1 from private.employee_email_verifications verification
    where verification.id = verification_id
      and verification.token_hash = repeat('5', 64)
      and verification.verified_at is null
  ) and not exists(
    select 1 from private.employee_email_verifications verification
    where verification.employee_id = actor_id
      and verification.token_hash = repeat('6', 64)
  ), 'A rejected retry preserves the original pending verification and its token.';

  payload := public.service_prepare_email_recipient_dispatch_batch(
    'inline_email',
    verification_id,
    '["availability-regression@example.invalid"]'::jsonb,
    'personal_email_verification',
    'employee',
    actor_id
  );
  assert jsonb_array_length(payload) = 1
    and (payload -> 0 ->> 'sendAllowed')::boolean,
    'The verification record is the durable source for exactly one initial email send.';
  payload := public.service_prepare_email_recipient_dispatch_batch(
    'inline_email',
    verification_id,
    '["availability-regression@example.invalid"]'::jsonb,
    'personal_email_verification',
    'employee',
    actor_id
  );
  assert not (payload -> 0 ->> 'sendAllowed')::boolean
    and (
      select count(*) = 1
      from private.email_recipient_dispatches dispatch
      where dispatch.source_kind = 'inline_email'
        and dispatch.source_id = verification_id
        and dispatch.notification_type = 'personal_email_verification'
    ), 'A response-loss replay cannot create a duplicate verification email operation.';

  payload := public.service_confirm_email_verification(repeat('5', 64), actor_id);
  verification_confirmed_at := payload ->> 'verifiedAt';
  assert not (payload ->> 'replayed')::boolean,
    'The first valid confirmation records the personal-email change.';
  payload := public.service_confirm_email_verification(repeat('5', 64), actor_id);
  assert (payload ->> 'replayed')::boolean
    and payload ->> 'verifiedAt' = verification_confirmed_at,
    'A committed-but-response-lost confirmation returns its original durable receipt.';

  -- Retained supersession history prevents A -> B -> delayed A from restoring
  -- A or minting a new verification/email source after its cooldown has aged.
  update private.employee_email_verifications
  set superseded_at = clock_timestamp()
  where id = verification_id;
  insert into private.employee_email_verifications(
    id, operation_id, employee_id, requested_email, purpose, token_hash,
    expires_at, created_at
  ) values (
    stale_verification_id, stale_operation_id, actor_id,
    'stale-operation@example.invalid', 'personal_email_verification', repeat('7', 64),
    clock_timestamp() + interval '1 hour', clock_timestamp() - interval '2 minutes'
  );

  payload := public.service_create_email_verification_operation(
    newer_operation_id,
    actor_id,
    'newer-operation@example.invalid',
    'personal_email_verification',
    repeat('8', 64),
    clock_timestamp() + interval '1 hour'
  );
  newer_verification_id := (payload ->> 'verificationId')::uuid;
  assert exists(
    select 1 from private.employee_email_verifications verification
    where verification.id = stale_verification_id
      and verification.operation_id = stale_operation_id
      and verification.superseded_at is not null
  ) and exists(
    select 1 from private.employee_email_verifications verification
    where verification.id = newer_verification_id
      and verification.operation_id = newer_operation_id
      and verification.superseded_at is null
  ), 'A newer operation tombstones A and remains the sole current verification.';

  begin
    insert into private.employee_email_verifications(
      id, operation_id, employee_id, requested_email, purpose, token_hash, expires_at
    ) values (
      gen_random_uuid(), gen_random_uuid(), actor_id,
      'concurrent-loser@example.invalid', 'personal_email_verification', repeat('9', 64),
      clock_timestamp() + interval '1 hour'
    );
  exception when unique_violation then
    second_current_rejected := true;
  end;
  assert second_current_rejected and (
    select count(*) = 1
    from private.employee_email_verifications verification
    where verification.employee_id = actor_id
      and verification.verified_at is null
      and verification.superseded_at is null
  ), 'The database fence rejects a concurrent distinct operation and preserves exactly one current authority.';

  begin
    perform public.service_create_email_verification_operation(
      stale_operation_id,
      actor_id,
      'stale-operation@example.invalid',
      'personal_email_verification',
      repeat('7', 64),
      clock_timestamp() + interval '1 hour'
    );
  exception when check_violation then
    stale_replay_rejected := true;
  end;
  assert stale_replay_rejected,
    'A delayed exact replay of superseded A cannot become current again.';

  begin
    perform public.service_create_email_verification_operation(
      stale_operation_id,
      actor_id,
      'drifted-stale-operation@example.invalid',
      'personal_email_verification',
      repeat('7', 64),
      clock_timestamp() + interval '1 hour'
    );
  exception when check_violation then
    stale_binding_rejected := true;
  end;
  assert stale_binding_rejected,
    'A superseded operation UUID remains permanently bound to its original recipient.';

  begin
    perform public.service_confirm_email_verification(repeat('7', 64), actor_id);
  exception when others then
    superseded_token_rejected := true;
  end;
  assert superseded_token_rejected,
    'A superseded verification link cannot update the employee contact record.';
  assert (
    select count(*) = 1
    from private.employee_email_verifications verification
    where verification.operation_id = stale_operation_id
  ) and exists(
    select 1 from private.employee_email_verifications verification
    where verification.id = newer_verification_id
      and verification.superseded_at is null
  ), 'Delayed A neither creates a new verification source nor displaces B.';

  payload := public.service_prepare_email_recipient_dispatch_batch(
    'inline_email',
    dispatch_source_id,
    '[" SECOND@example.invalid ", "FIRST@example.invalid"]'::jsonb,
    'rollback_manifest_test',
    'employee',
    actor_id
  );
  assert jsonb_array_length(payload) = 2,
    'The complete recipient manifest is created by one transactional operation.';
  assert (
    select count(*) = 2
    from private.email_recipient_dispatches dispatch
    where dispatch.source_kind = 'inline_email'
      and dispatch.source_id = dispatch_source_id
      and dispatch.state = 'dispatching'
  ), 'Every expected recipient fence exists before provider delivery can begin.';
  payload := public.service_prepare_email_recipient_dispatch_batch(
    'inline_email',
    dispatch_source_id,
    '["first@example.invalid", "second@example.invalid"]'::jsonb,
    'rollback_manifest_test',
    'employee',
    actor_id
  );
  assert not exists(
    select 1 from jsonb_array_elements(payload) decision
    where (decision ->> 'sendAllowed')::boolean
  ), 'A retry cannot recreate send permission for an already-fenced manifest.';

  begin
    perform public.service_prepare_email_recipient_dispatch_batch(
      'inline_email',
      dispatch_source_id,
      '["first@example.invalid"]'::jsonb,
      'rollback_manifest_test',
      'employee',
      actor_id
    );
  exception when check_violation then
    manifest_removal_rejected := true;
  end;
  assert manifest_removal_rejected,
    'A retry cannot remove a recipient from the immutable source manifest.';

  begin
    perform public.service_prepare_email_recipient_dispatch_batch(
      'inline_email',
      dispatch_source_id,
      '["first@example.invalid", "second@example.invalid", "third@example.invalid"]'::jsonb,
      'rollback_manifest_test',
      'employee',
      actor_id
    );
  exception when check_violation then
    manifest_addition_rejected := true;
  end;
  assert manifest_addition_rejected,
    'A retry cannot add a recipient to the immutable source manifest.';

  begin
    perform public.service_prepare_email_recipient_dispatch_batch(
      'inline_email',
      dispatch_source_id,
      '["first@example.invalid", "replacement@example.invalid"]'::jsonb,
      'rollback_manifest_test',
      'employee',
      actor_id
    );
  exception when check_violation then
    manifest_address_change_rejected := true;
  end;
  assert manifest_address_change_rejected,
    'A retry cannot substitute an address in the immutable source manifest.';
  assert (
    select manifest.intended_recipients = array['first@example.invalid', 'second@example.invalid']::text[]
    from private.email_recipient_dispatch_manifests manifest
    where manifest.source_kind = 'inline_email'
      and manifest.source_id = dispatch_source_id
  ), 'Rejected manifest changes preserve the first complete normalized recipient set.';
  assert (
    select count(*) = 2
    from private.email_recipient_dispatches dispatch
    where dispatch.source_kind = 'inline_email'
      and dispatch.source_id = dispatch_source_id
  ), 'Rejected manifest changes cannot create unresolved or newly-added recipient fences.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_user_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  execute 'set local role authenticated';
  begin
    perform public.service_list_licensing_document_availability_recovery(25);
    raise exception 'An authenticated browser session called the service-only recovery listing.';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.service_get_password_reset_claim_source(
      'password-transport-two-' || password_claim_two::text
    );
    raise exception 'An authenticated browser session read a private password-reset claim identity.';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';

  assert has_function_privilege(
    'service_role',
    'public.service_complete_licensing_document_upload_recovery(uuid,uuid,text,bigint,text)',
    'EXECUTE'
  ), 'The service role can complete verified Licensing recovery.';
  assert not has_function_privilege(
    'authenticated',
    'public.service_complete_licensing_document_upload_recovery(uuid,uuid,text,bigint,text)',
    'EXECUTE'
  ), 'Authenticated browser sessions cannot complete Licensing recovery.';
  assert not has_function_privilege(
    'authenticated',
    'public.service_fail_licensing_document_upload_recovery(uuid,uuid,text,bigint,text,text)',
    'EXECUTE'
  ), 'Authenticated browser sessions cannot fail Licensing recovery.';
  assert not has_function_privilege(
    'authenticated',
    'public.service_create_email_verification_operation(uuid,uuid,text,text,text,timestamptz)',
    'EXECUTE'
  ), 'Authenticated browser sessions cannot create service-owned verification operations.';
  assert not has_function_privilege(
    'authenticated',
    'public.service_prepare_email_recipient_dispatch_batch(text,uuid,jsonb,text,text,uuid)',
    'EXECUTE'
  ), 'Authenticated browser sessions cannot create provider dispatch manifests.';
end
$licensing_availability_and_email_source_regression$;

rollback;
