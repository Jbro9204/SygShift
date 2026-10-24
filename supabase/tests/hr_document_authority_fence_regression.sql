-- Rollback-only regression for HR document upload authority. A replacement
-- must not displace the last verified version until protected completion, and
-- retries must preserve that exact authority decision.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $hr_document_authority_fence_regression$
declare
  actor_id uuid;
  vault_code text;
  storage_bucket text;
  access_classification text;
  retention_id uuid;
  target_document_id uuid := gen_random_uuid();
  original_version_id uuid := gen_random_uuid();
  original_object_key text := gen_random_uuid()::text || '/' || gen_random_uuid()::text;
  replacement_request_id uuid := gen_random_uuid();
  replacement_prepare jsonb;
  replacement_retry jsonb;
  replacement_operation_id uuid;
  replacement_version_id uuid;
  replacement_object_key text;
  first_completion jsonb;
  retry_completion jsonb;
  new_request_id uuid := gen_random_uuid();
  new_prepare jsonb;
  new_operation_id uuid;
  new_document_id uuid;
  new_version_id uuid;
  new_object_key text;
  stale_version_id uuid := gen_random_uuid();
  stale_version_number integer;
  stale_operation_id uuid := gen_random_uuid();
  stale_object_key text := gen_random_uuid()::text || '/' || gen_random_uuid()::text;
  newer_version_id uuid := gen_random_uuid();
  newer_version_number integer;
  newer_object_key text := gen_random_uuid()::text || '/' || gen_random_uuid()::text;
  competing_a_request_id uuid := gen_random_uuid();
  competing_a_prepare jsonb;
  competing_a_operation_id uuid;
  competing_a_version_id uuid;
  competing_a_object_key text;
  competing_b_request_id uuid := gen_random_uuid();
  competing_b_prepare jsonb;
  competing_b_operation_id uuid;
  competing_b_version_id uuid;
  competing_b_object_key text;
  competing_b_completion jsonb;
  recovery_candidates jsonb;
  changed_title_rejected boolean := false;
  changed_checksum_rejected boolean := false;
  superseded_completion_rejected boolean := false;
begin
  assert not has_function_privilege(
    'service_role',
    'private.service_begin_hr_document_upload_pre_authority_fence(uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,bigint,text,uuid,text,text)',
    'execute'
  ), 'The service role must not bypass the public HR document authority wrapper.';

  select employee.id, vault.code, vault.storage_bucket, vault.classification
  into actor_id, vault_code, storage_bucket, access_classification
  from public.employees employee
  join private.employee_accounts account
    on account.employee_id = employee.id
   and account.disabled_at is null
  cross join private.hr_document_vaults vault
  where employee.status in ('active', 'leave')
    and vault.active
    and 'application/pdf' = any(vault.allowed_mime_types)
    and 'documents.workspace.view' = any(coalesce(private.employee_effective_permissions(employee.id), array[]::text[]))
    and 'hr.documents.manage' = any(coalesce(private.employee_effective_permissions(employee.id), array[]::text[]))
    and (
      vault.manage_permission = 'hr.documents.manage'
      or vault.manage_permission = any(coalesce(private.employee_effective_permissions(employee.id), array[]::text[]))
    )
  order by employee.created_at, employee.id, vault.code
  limit 1;

  select policy.id
  into retention_id
  from private.hr_document_retention_policies policy
  where policy.code = 'MANUAL_REVIEW'
    and policy.active
  limit 1;

  assert actor_id is not null and vault_code is not null and storage_bucket is not null
    and access_classification is not null,
    'An active HR document manager and PDF vault are required for this regression.';
  assert retention_id is not null,
    'The manual-review retention policy is required for this regression.';

  update private.hr_document_release_gate
  set enabled = true,
      enabled_at = coalesce(enabled_at, clock_timestamp()),
      enabled_by = coalesce(enabled_by, actor_id),
      evidence_reference = coalesce(nullif(btrim(evidence_reference), ''), 'rollback-only-hr-authority-regression'),
      updated_at = clock_timestamp()
  where singleton;

  insert into private.hr_documents (
    id,
    employee_id,
    vault_code,
    title,
    category,
    description,
    access_classification,
    retention_policy_id,
    created_by
  ) values (
    target_document_id,
    actor_id,
    vault_code,
    'Authority fence regression',
    'Regression',
    'Rollback-only HR document authority evidence.',
    access_classification,
    retention_id,
    actor_id
  );

  insert into private.hr_document_versions (
    id,
    document_id,
    version_number,
    storage_bucket,
    object_key,
    original_filename,
    sanitized_filename,
    extension,
    declared_mime_type,
    detected_mime_type,
    size_bytes,
    sha256_checksum,
    uploaded_by,
    upload_source,
    idempotency_key
  ) values (
    original_version_id,
    target_document_id,
    1,
    storage_bucket,
    original_object_key,
    'authority-original.pdf',
    'authority-original.pdf',
    'pdf',
    'application/pdf',
    'application/pdf',
    512,
    repeat('a', 64),
    actor_id,
    'hr_workspace',
    gen_random_uuid()
  );

  update private.hr_documents
  set current_version_id = original_version_id
  where id = target_document_id;

  insert into private.hr_document_access_events (
    document_id,
    version_id,
    action,
    actor_employee_id,
    reason,
    metadata
  ) values (
    target_document_id,
    original_version_id,
    'upload_available',
    actor_id,
    'Rollback-only verified predecessor.',
    jsonb_build_object('fixture', true)
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

  replacement_prepare := public.service_begin_hr_document_upload(
    actor_id,
    actor_id,
    target_document_id,
    vault_code,
    'Authority fence regression',
    'Regression',
    'Rollback-only HR document authority evidence.',
    access_classification,
    'authority-replacement.pdf',
    'authority-replacement.pdf',
    'pdf',
    'application/pdf',
    'application/pdf',
    640,
    repeat('b', 64),
    replacement_request_id,
    'authority-fence-prepare',
    'Authority-fence regression replacement'
  );
  replacement_operation_id := (replacement_prepare ->> 'operationId')::uuid;
  replacement_version_id := (replacement_prepare ->> 'versionId')::uuid;
  replacement_object_key := replacement_prepare ->> 'objectKey';

  assert (
    select document.current_version_id
    from private.hr_documents document
    where document.id = target_document_id
  ) = original_version_id,
    'Preparing a replacement must keep the prior verified version authoritative.';
  assert exists (
    select 1
    from private.hr_document_upload_operations operation
    where operation.id = replacement_operation_id
      and operation.version_id = replacement_version_id
      and operation.prior_current_version_id = original_version_id
      and operation.authority_intent_bound
  ), 'The replacement operation must durably bind its exact predecessor.';

  perform public.service_fail_hr_document_upload(
    replacement_operation_id,
    'storage_error',
    'regression_failure',
    'Simulated protected-storage failure.'
  );
  assert (
    select document.current_version_id
    from private.hr_documents document
    where document.id = target_document_id
  ) = original_version_id,
    'A failed replacement must not displace the prior verified version.';

  replacement_retry := public.service_begin_hr_document_upload(
    actor_id,
    actor_id,
    target_document_id,
    vault_code,
    'Authority fence regression',
    'Regression',
    'Rollback-only HR document authority evidence.',
    access_classification,
    'authority-replacement.pdf',
    'authority-replacement.pdf',
    'pdf',
    'application/pdf',
    'application/pdf',
    640,
    repeat('b', 64),
    replacement_request_id,
    'authority-fence-retry',
    'Authority-fence regression replacement'
  );
  assert replacement_retry ->> 'operationId' = replacement_operation_id::text
    and replacement_retry ->> 'versionId' = replacement_version_id::text,
    'An exact retry must reuse the same operation and version.';
  assert (
    select document.current_version_id
    from private.hr_documents document
    where document.id = target_document_id
  ) = original_version_id,
    'Retrying a failed replacement must still preserve the verified predecessor.';

  begin
    perform public.service_begin_hr_document_upload(
      actor_id,
      actor_id,
      target_document_id,
      vault_code,
      'Changed title must be rejected',
      'Regression',
      'Rollback-only HR document authority evidence.',
      access_classification,
      'authority-replacement.pdf',
      'authority-replacement.pdf',
      'pdf',
      'application/pdf',
      'application/pdf',
      640,
      repeat('b', 64),
      replacement_request_id,
      'authority-fence-title-mismatch',
      'Authority-fence regression replacement'
    );
  exception
    when check_violation then
      changed_title_rejected := true;
  end;
  assert changed_title_rejected,
    'The same idempotency key must reject a changed title.';

  begin
    perform public.service_begin_hr_document_upload(
      actor_id,
      actor_id,
      target_document_id,
      vault_code,
      'Authority fence regression',
      'Regression',
      'Rollback-only HR document authority evidence.',
      access_classification,
      'authority-replacement.pdf',
      'authority-replacement.pdf',
      'pdf',
      'application/pdf',
      'application/pdf',
      640,
      repeat('d', 64),
      replacement_request_id,
      'authority-fence-checksum-mismatch',
      'Authority-fence regression replacement'
    );
  exception
    when check_violation then
      changed_checksum_rejected := true;
  end;
  assert changed_checksum_rejected,
    'The same idempotency key must reject changed bytes/checksum.';

  insert into storage.objects(bucket_id, name, metadata)
  values (
    storage_bucket,
    replacement_object_key,
    jsonb_build_object('size', 640, 'mimetype', 'application/pdf')
  );

  first_completion := public.service_mark_hr_document_upload_stored(
    replacement_operation_id,
    'authority-fence-complete'
  );
  retry_completion := public.service_mark_hr_document_upload_stored(
    replacement_operation_id,
    'authority-fence-complete-retry'
  );

  assert first_completion ->> 'state' = 'clean'
    and retry_completion ->> 'state' = 'clean',
    'Completion and its retry must both report the durable clean state.';
  assert (
    select document.current_version_id
    from private.hr_documents document
    where document.id = target_document_id
  ) = replacement_version_id,
    'Only verified completion may make the replacement authoritative.';
  assert (
    select count(*)
    from private.hr_document_access_events access_event
    where access_event.document_id = target_document_id
      and access_event.version_id = replacement_version_id
      and access_event.action = 'upload_available'
  ) = 1,
    'Idempotent completion must not duplicate availability audit evidence.';

  -- Two independently keyed replacement requests may both be prepared while
  -- the same verified version is current. Once B wins, A must be terminalized
  -- in B's completion transaction and must disappear from automatic recovery.
  competing_a_prepare := public.service_begin_hr_document_upload(
    actor_id,
    actor_id,
    target_document_id,
    vault_code,
    'Authority fence regression',
    'Regression',
    'Rollback-only HR document authority evidence.',
    access_classification,
    'concurrent-replacement-a.pdf',
    'concurrent-replacement-a.pdf',
    'pdf',
    'application/pdf',
    'application/pdf',
    736,
    repeat('1', 64),
    competing_a_request_id,
    'authority-fence-concurrent-a',
    'Concurrent authority regression A'
  );
  competing_a_operation_id := (competing_a_prepare ->> 'operationId')::uuid;
  competing_a_version_id := (competing_a_prepare ->> 'versionId')::uuid;
  competing_a_object_key := competing_a_prepare ->> 'objectKey';

  competing_b_prepare := public.service_begin_hr_document_upload(
    actor_id,
    actor_id,
    target_document_id,
    vault_code,
    'Authority fence regression',
    'Regression',
    'Rollback-only HR document authority evidence.',
    access_classification,
    'concurrent-replacement-b.pdf',
    'concurrent-replacement-b.pdf',
    'pdf',
    'application/pdf',
    'application/pdf',
    768,
    repeat('2', 64),
    competing_b_request_id,
    'authority-fence-concurrent-b',
    'Concurrent authority regression B'
  );
  competing_b_operation_id := (competing_b_prepare ->> 'operationId')::uuid;
  competing_b_version_id := (competing_b_prepare ->> 'versionId')::uuid;
  competing_b_object_key := competing_b_prepare ->> 'objectKey';

  assert (
    select count(*)
    from private.hr_document_upload_operations operation
    where operation.id in (competing_a_operation_id, competing_b_operation_id)
      and operation.prior_current_version_id = replacement_version_id
      and operation.authority_intent_bound
      and not operation.authority_superseded
      and operation.state not in ('clean', 'rejected', 'cancelled')
  ) = 2,
    'Both live replacements must bind the same verified predecessor before either completes.';

  insert into storage.objects(bucket_id, name, metadata)
  values
    (
      storage_bucket,
      competing_a_object_key,
      jsonb_build_object('size', 736, 'mimetype', 'application/pdf')
    ),
    (
      storage_bucket,
      competing_b_object_key,
      jsonb_build_object('size', 768, 'mimetype', 'application/pdf')
    );

  competing_b_completion := public.service_mark_hr_document_upload_stored(
    competing_b_operation_id,
    'authority-fence-concurrent-b-complete'
  );
  assert competing_b_completion ->> 'state' = 'clean',
    'The first verified competing completion must win cleanly.';
  assert (
    select document.current_version_id
    from private.hr_documents document
    where document.id = target_document_id
  ) = competing_b_version_id,
    'The winning replacement must become authoritative.';
  assert exists (
    select 1
    from private.hr_document_upload_operations operation
    where operation.id = competing_a_operation_id
      and operation.version_id = competing_a_version_id
      and operation.state = 'rejected'
      and operation.authority_superseded
      and operation.failure_code = 'authority_superseded'
      and operation.completed_at is not null
  ), 'The competing loser must atomically become terminal and superseded.';

  recovery_candidates := public.service_list_hr_document_availability_recovery(100);
  assert not exists (
    select 1
    from jsonb_array_elements(recovery_candidates) candidate
    where candidate ->> 'operationId' = competing_a_operation_id::text
  ), 'A superseded competing upload must never remain eligible for automatic recovery.';

  new_prepare := public.service_begin_hr_document_upload(
    actor_id,
    actor_id,
    null,
    vault_code,
    'Failed new upload regression',
    'Regression',
    'A failed new upload must never become authoritative.',
    access_classification,
    'failed-new-upload.pdf',
    'failed-new-upload.pdf',
    'pdf',
    'application/pdf',
    'application/pdf',
    384,
    repeat('c', 64),
    new_request_id,
    'authority-fence-new',
    'New document authority regression'
  );
  new_operation_id := (new_prepare ->> 'operationId')::uuid;
  new_document_id := (new_prepare ->> 'documentId')::uuid;
  new_version_id := (new_prepare ->> 'versionId')::uuid;
  new_object_key := new_prepare ->> 'objectKey';

  assert (
    select document.current_version_id is null
    from private.hr_documents document
    where document.id = new_document_id
  ), 'A new document has no authoritative version before protected completion.';
  assert exists (
    select 1
    from private.hr_documents document
    where document.id = new_document_id
      and document.archived_at is not null
      and document.archived_by = actor_id
      and document.archive_reason = 'Upload pending protected storage verification.'
  ), 'A pending first upload must stay hidden from the ordinary document workspace.';

  perform public.service_fail_hr_document_upload(
    new_operation_id,
    'storage_error',
    'regression_failure',
    'Simulated new-document storage failure.'
  );
  assert (
    select document.current_version_id is null
    from private.hr_documents document
    where document.id = new_document_id
  ), 'A failed new upload must remain non-authoritative.';
  assert not exists (
    select 1
    from private.hr_documents document
    where document.id = new_document_id
      and document.current_version_id = new_version_id
  ), 'The failed bytes must never be exposed as the document current version.';
  assert exists (
    select 1
    from private.hr_documents document
    where document.id = new_document_id
      and document.archived_at is not null
      and document.archive_reason = 'Upload pending protected storage verification.'
  ), 'A failed first upload must remain hidden rather than expose an empty shell.';

  insert into storage.objects(bucket_id, name, metadata)
  values (
    storage_bucket,
    new_object_key,
    jsonb_build_object('size', 384, 'mimetype', 'application/pdf')
  );
  perform public.service_mark_hr_document_upload_stored(
    new_operation_id,
    'authority-fence-new-retry-complete'
  );
  assert exists (
    select 1
    from private.hr_documents document
    where document.id = new_document_id
      and document.current_version_id = new_version_id
      and document.archived_at is null
      and document.archived_by is null
      and document.archive_reason is null
  ), 'An exact verified retry makes the first version authoritative and visible.';

  -- A historical candidate that lost the authority slot to a later version
  -- cannot treat that later version as its predecessor and CAS-downgrade it.
  select coalesce(max(version.version_number), 0) + 1
  into stale_version_number
  from private.hr_document_versions version
  where version.document_id = target_document_id;
  newer_version_number := stale_version_number + 1;

  insert into private.hr_document_versions (
    id, document_id, version_number, storage_bucket, object_key,
    original_filename, sanitized_filename, extension, declared_mime_type,
    detected_mime_type, size_bytes, sha256_checksum, uploaded_by,
    upload_source, idempotency_key
  ) values
  (
    stale_version_id, target_document_id, stale_version_number, storage_bucket, stale_object_key,
    'stale-v3.pdf', 'stale-v3.pdf', 'pdf', 'application/pdf',
    'application/pdf', 700, repeat('e', 64), actor_id,
    'hr_workspace', gen_random_uuid()
  ),
  (
    newer_version_id, target_document_id, newer_version_number, storage_bucket, newer_object_key,
    'current-v5.pdf', 'current-v5.pdf', 'pdf', 'application/pdf',
    'application/pdf', 720, repeat('f', 64), actor_id,
    'hr_workspace', gen_random_uuid()
  );

  update private.hr_documents
  set current_version_id = newer_version_id
  where id = target_document_id;

  insert into private.hr_document_upload_operations (
    id, actor_employee_id, document_id, version_id, vault_code,
    storage_bucket, object_key, idempotency_key, state, failure_code,
    upload_intent, prior_current_version_id, authority_intent_bound,
    authority_superseded
  ) values (
    stale_operation_id, actor_id, target_document_id, stale_version_id, vault_code,
    storage_bucket, stale_object_key, gen_random_uuid(), 'storage_error',
    'precutover_failure', jsonb_build_object('fixture', 'superseded-v3'),
    null, true, true
  );

  insert into storage.objects(bucket_id, name, metadata)
  values (
    storage_bucket,
    stale_object_key,
    jsonb_build_object('size', 700, 'mimetype', 'application/pdf')
  );

  begin
    perform public.service_mark_hr_document_upload_stored(
      stale_operation_id,
      'authority-fence-superseded-completion'
    );
  exception
    when serialization_failure then
      superseded_completion_rejected := true;
  end;
  assert superseded_completion_rejected,
    'A superseded historical candidate must reject late completion.';
  assert (
    select document.current_version_id
    from private.hr_documents document
    where document.id = target_document_id
  ) = newer_version_id,
    'A stale historical completion must not downgrade a newer authoritative version.';
end
$hr_document_authority_fence_regression$;

rollback;
