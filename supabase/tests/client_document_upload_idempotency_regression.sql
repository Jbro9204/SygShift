-- Rollback-only regression for the serialized outcome of concurrent/retried
-- client-document uploads that share one idempotency key.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $client_document_upload_idempotency$
declare
  actor_id uuid;
  fixture_client_id uuid := gen_random_uuid();
  upload_request_id uuid := gen_random_uuid();
  first_prepare jsonb;
  retry_prepare jsonb;
  first_complete jsonb;
  retry_complete jsonb;
  cleanup_decision jsonb;
  fixture_document_id uuid;
  mismatched_replay_rejected boolean := false;
  fixture_client_number text := 'CLI-' || lpad(
    (abs(hashtext(gen_random_uuid()::text)::bigint) % 1000000000)::text,
    9,
    '0'
  );
begin
  select employee.id
  into actor_id
  from public.employees employee
  where employee.status in ('onboarding', 'active', 'leave')
    and (
      'clients.manage' = any(coalesce(private.employee_effective_permissions(employee.id), array[]::text[]))
      or 'clients.documents.manage' = any(coalesce(private.employee_effective_permissions(employee.id), array[]::text[]))
    )
  order by employee.created_at, employee.id
  limit 1;

  assert actor_id is not null,
    'An active Client Files document manager is required for this regression.';

  insert into public.clients(
    id,
    client_number,
    legal_name,
    display_name,
    status,
    created_by,
    updated_by
  ) values (
    fixture_client_id,
    fixture_client_number,
    'Client upload idempotency regression ' || fixture_client_id::text,
    'Client upload idempotency regression',
    'active',
    actor_id,
    actor_id
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

  first_prepare := public.service_prepare_client_document_upload(
    actor_id,
    fixture_client_id,
    upload_request_id,
    'report',
    'Idempotent upload regression',
    'Rollback-only regression evidence.',
    'confidential',
    'internal_only',
    current_date,
    null,
    'idempotent-upload.pdf',
    'application/pdf',
    512,
    repeat('a', 64),
    'pdf',
    'totp',
    clock_timestamp()
  );
  retry_prepare := public.service_prepare_client_document_upload(
    actor_id,
    fixture_client_id,
    upload_request_id,
    'report',
    'Idempotent upload regression',
    'Rollback-only regression evidence.',
    'confidential',
    'internal_only',
    current_date,
    null,
    'idempotent-upload.pdf',
    'application/pdf',
    512,
    repeat('a', 64),
    'pdf',
    'totp',
    clock_timestamp()
  );

  fixture_document_id := (first_prepare ->> 'documentId')::uuid;
  assert retry_prepare ->> 'documentId' = fixture_document_id::text,
    'The same idempotency key reuses one upload operation.';
  assert retry_prepare ->> 'objectKey' = first_prepare ->> 'objectKey',
    'The retry reuses the exact protected object identity.';

  begin
    perform public.service_prepare_client_document_upload(
      actor_id,
      fixture_client_id,
      upload_request_id,
      'report',
      'Different title must be a different operation',
      'Rollback-only regression evidence.',
      'confidential',
      'internal_only',
      current_date,
      null,
      'idempotent-upload.pdf',
      'application/pdf',
      512,
      repeat('a', 64),
      'pdf',
      'totp',
      clock_timestamp()
    );
  exception
    when check_violation then
      mismatched_replay_rejected := true;
  end;
  assert mismatched_replay_rejected,
    'One idempotency key cannot silently return a document with different metadata.';

  -- Row locking serializes real concurrent completion calls. Calling twice in
  -- sequence exercises the state observed by the transaction that waited for
  -- the first transaction to commit, which was the destructive failure case.
  first_complete := public.service_complete_client_document_upload(
    actor_id,
    fixture_document_id,
    gen_random_uuid()
  );
  retry_complete := public.service_complete_client_document_upload(
    actor_id,
    fixture_document_id,
    gen_random_uuid()
  );

  assert first_complete ->> 'state' = 'stored',
    'The first completion stores the client document.';
  assert retry_complete ->> 'state' = 'stored',
    'The serialized concurrent/retry completion returns the stored result idempotently.';
  assert retry_complete ->> 'documentId' = fixture_document_id::text,
    'The retry returns the same stored document.';
  assert (
    select count(*)
    from private.audit_events event
    where event.schema_name = 'public'
      and event.table_name = 'client_documents'
      and event.operation = 'CLIENT_DOCUMENT_STORED'
      and event.row_id = fixture_document_id::text
  ) = 1,
    'Idempotent completion does not duplicate the stored audit event.';

  cleanup_decision := public.service_reconcile_client_document_upload_failure(
    actor_id,
    fixture_document_id,
    'A retry received the former pending-not-found response.'
  );

  assert cleanup_decision ->> 'state' = 'stored',
    'Failure reconciliation observes the committed document.';
  assert (cleanup_decision ->> 'cleanupAllowed')::boolean is false,
    'A committed object is never authorized for cleanup.';
  assert cleanup_decision ->> 'objectKey' = first_prepare ->> 'objectKey',
    'The cleanup decision remains bound to the exact object identity.';
  assert exists (
    select 1
    from public.client_documents document
    where document.id = fixture_document_id
      and document.upload_state = 'stored'
      and document.archived_at is null
      and document.object_key = first_prepare ->> 'objectKey'
      and document.sha256_checksum = repeat('a', 64)
      and document.byte_size = 512
  ),
    'The committed database/object reference survives a competing cleanup path.';
end
$client_document_upload_idempotency$;

rollback;
