-- Rollback-only regression for client/licensing cleanup backoff, quarantine,
-- and poison-row isolation. No fixture or cleanup outcome survives ROLLBACK.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $document_cleanup_quarantine_regression$
declare
  actor_id uuid;
  fixture_client_id uuid := gen_random_uuid();
  fixture_client_number text := 'CLI-' || lpad(
    (abs(hashtext(gen_random_uuid()::text)::bigint) % 1000000000)::text,
    9,
    '0'
  );
  client_poison jsonb;
  client_valid jsonb;
  client_poison_id uuid;
  client_valid_id uuid;
  client_candidates jsonb;
  credential_type_id uuid := gen_random_uuid();
  credential_id uuid := gen_random_uuid();
  licensing_poison_id uuid := gen_random_uuid();
  licensing_valid_id uuid := gen_random_uuid();
  licensing_poison_path text;
  licensing_valid_path text;
  licensing_candidates jsonb;
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
    id, client_number, legal_name, display_name, status, created_by, updated_by
  ) values (
    fixture_client_id,
    fixture_client_number,
    'Cleanup quarantine regression ' || fixture_client_id::text,
    'Cleanup quarantine regression',
    'active',
    actor_id,
    actor_id
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

  client_poison := public.service_prepare_client_document_upload(
    actor_id, fixture_client_id, gen_random_uuid(), 'report',
    'Client cleanup poison fixture', 'Rollback-only cleanup evidence.',
    'confidential', 'internal_only', current_date, null,
    'client-poison.pdf', 'application/pdf', 512, repeat('a', 64),
    'pdf', 'totp', clock_timestamp()
  );
  client_valid := public.service_prepare_client_document_upload(
    actor_id, fixture_client_id, gen_random_uuid(), 'report',
    'Client cleanup valid fixture', 'Rollback-only cleanup evidence.',
    'confidential', 'internal_only', current_date, null,
    'client-valid.pdf', 'application/pdf', 1024, repeat('b', 64),
    'pdf', 'totp', clock_timestamp()
  );
  client_poison_id := (client_poison ->> 'documentId')::uuid;
  client_valid_id := (client_valid ->> 'documentId')::uuid;

  perform public.service_reconcile_client_document_upload_failure(
    actor_id, client_poison_id, 'Permanent verification failure.'
  );
  perform public.service_reconcile_client_document_upload_failure(
    actor_id, client_valid_id, 'Transient verification failure.'
  );
  -- Keep the rollback-only fixture ahead of any pre-existing production-copy
  -- cleanup backlog so the bounded recovery query exercises this row rather
  -- than depending on unrelated queue depth.
  update public.client_documents document
  set cleanup_available_at = timestamptz '2000-01-01 00:00:00+00'
  where document.id = client_valid_id;
  update public.client_documents document
  set cleanup_attempt_count = 19,
      cleanup_available_at = clock_timestamp() - interval '1 minute'
  where document.id = client_poison_id;

  perform public.service_defer_client_document_cleanup(
    actor_id,
    client_poison_id,
    client_poison ->> 'bucket',
    client_poison ->> 'objectKey',
    (client_poison ->> 'byteSize')::bigint,
    client_poison ->> 'checksum',
    'Permanent verification failure.'
  );
  client_candidates := public.service_list_client_document_cleanup_recovery(25);

  assert (
    select document.cleanup_attempt_count = 20
      and document.cleanup_quarantined_at is not null
      and document.cleaned_at is null
    from public.client_documents document
    where document.id = client_poison_id
  ), 'The twentieth client cleanup failure quarantines without claiming deletion.';
  update public.client_documents document
  set cleanup_attempt_count = 27
  where document.id = client_poison_id;
  perform public.service_defer_client_document_cleanup(
    actor_id,
    client_poison_id,
    client_poison ->> 'bucket',
    client_poison ->> 'objectKey',
    (client_poison ->> 'byteSize')::bigint,
    client_poison ->> 'checksum',
    'Permanent verification failure after quarantine.'
  );
  assert (
    select document.cleanup_attempt_count = 27
      and document.cleanup_quarantined_at is not null
      and document.cleaned_at is null
    from public.client_documents document
    where document.id = client_poison_id
  ), 'A client retry count above the threshold remains exact while work stays quarantined.';
  assert not exists (
    select 1 from jsonb_array_elements(client_candidates) item
    where item ->> 'documentId' = client_poison_id::text
  ), 'A quarantined client cleanup cannot occupy a recovery batch slot.';
  assert exists (
    select 1 from jsonb_array_elements(client_candidates) item
    where item ->> 'documentId' = client_valid_id::text
  ), 'A later eligible client cleanup remains reachable after a poison row is quarantined.';

  insert into public.credential_types(
    id, code, name, category, expiration_required, affects_work_eligibility, active
  ) values (
    credential_type_id,
    'cleanup_' || replace(credential_type_id::text, '-', ''),
    'Cleanup Quarantine Regression Credential',
    'Regression Test',
    false,
    false,
    true
  );
  insert into public.employee_credentials(
    id, employee_id, credential_type_id, kind, status, credential_number,
    issuing_authority, valid_from
  ) values (
    credential_id, actor_id, credential_type_id, 'other', 'pending',
    'CLEANUP-REGRESSION', 'Rollback Test Authority', current_date
  );

  licensing_poison_path := actor_id::text || '/' || credential_id::text || '/' || licensing_poison_id::text || '.pdf';
  licensing_valid_path := actor_id::text || '/' || credential_id::text || '/' || licensing_valid_id::text || '.pdf';
  insert into public.employee_credential_documents(
    id, credential_id, submission_id, storage_path, original_filename, content_type,
    byte_size, uploaded_by, uploaded_at, archived_at, archived_by, archive_reason,
    upload_request_id, upload_state, sha256_checksum, stored_at, failure_detail,
    cleanup_pending_at, cleanup_attempt_count, cleanup_available_at
  ) values
  (
    licensing_poison_id, credential_id, null, licensing_poison_path,
    'licensing-poison.pdf', 'application/pdf', 512, actor_id, clock_timestamp(),
    clock_timestamp(), actor_id, 'Protected upload failed', gen_random_uuid(),
    'failed', repeat('c', 64), null, 'Permanent verification failure.',
    clock_timestamp() - interval '2 minutes', 19, clock_timestamp() - interval '1 minute'
  ),
  (
    licensing_valid_id, credential_id, null, licensing_valid_path,
    'licensing-valid.pdf', 'application/pdf', 1024, actor_id, clock_timestamp(),
    clock_timestamp(), actor_id, 'Protected upload failed', gen_random_uuid(),
    'failed', repeat('d', 64), null, 'Transient verification failure.',
    clock_timestamp() - interval '1 minute', 0, timestamptz '2000-01-01 00:00:00+00'
  );

  perform public.service_defer_licensing_document_cleanup(
    actor_id,
    licensing_poison_id,
    licensing_poison_path,
    512,
    repeat('c', 64),
    'Permanent verification failure.'
  );
  licensing_candidates := public.service_list_licensing_document_cleanup_recovery(25);

  assert (
    select document.cleanup_attempt_count = 20
      and document.cleanup_quarantined_at is not null
      and document.cleaned_at is null
    from public.employee_credential_documents document
    where document.id = licensing_poison_id
  ), 'The twentieth licensing cleanup failure quarantines without claiming deletion.';
  update public.employee_credential_documents document
  set cleanup_attempt_count = 31
  where document.id = licensing_poison_id;
  perform public.service_defer_licensing_document_cleanup(
    actor_id,
    licensing_poison_id,
    licensing_poison_path,
    512,
    repeat('c', 64),
    'Permanent verification failure after quarantine.'
  );
  assert (
    select document.cleanup_attempt_count = 31
      and document.cleanup_quarantined_at is not null
      and document.cleaned_at is null
    from public.employee_credential_documents document
    where document.id = licensing_poison_id
  ), 'A licensing retry count above the threshold remains exact while work stays quarantined.';
  assert not exists (
    select 1 from jsonb_array_elements(licensing_candidates) item
    where item ->> 'documentId' = licensing_poison_id::text
  ), 'A quarantined licensing cleanup cannot occupy a recovery batch slot.';
  assert exists (
    select 1 from jsonb_array_elements(licensing_candidates) item
    where item ->> 'documentId' = licensing_valid_id::text
  ), 'A later eligible licensing cleanup remains reachable after a poison row is quarantined.';
  assert not exists (
    select 1
    from public.employee_credential_documents document
    where document.id in (licensing_poison_id, licensing_valid_id)
      and document.cleaned_at is not null
  ), 'Queue scheduling and quarantine never claim licensing-object deletion.';
end
$document_cleanup_quarantine_regression$;

rollback;
