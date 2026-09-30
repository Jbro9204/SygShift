begin;

-- Accepted documents become available immediately after the Worker has
-- completed the existing type, size, active-content, checksum, and protected
-- storage checks.  `clean` remains the compatibility availability marker for
-- the established document-access contracts; no new scan evidence is created.
set local lock_timeout = '5s';

alter table private.hr_document_access_events
  drop constraint hr_document_access_action;

alter table private.hr_document_access_events
  add constraint hr_document_access_action check (action in (
    'upload', 'preview', 'view', 'download', 'bulk_download', 'replace',
    'archive', 'restore', 'reclassify', 'share', 'sign', 'acknowledge',
    'retention_change', 'legal_hold_change', 'scan_release', 'scan_reject',
    'upload_available', 'upload_storage_failure'
  ));

-- `storage_error` is the current, non-scanner failure state. The legacy
-- states remain temporarily so an already-running pre-release Worker cannot
-- corrupt an in-flight request during the short database-to-Worker rollout.
alter table private.hr_document_upload_operations
  drop constraint hr_document_upload_state;

alter table private.hr_document_upload_operations
  add constraint hr_document_upload_state check (state in (
    'initialized', 'quarantined', 'stored', 'scan_pending', 'scan_error',
    'storage_error', 'rejected', 'cancelled', 'clean'
  ));

alter table private.hr_document_upload_operations
  drop constraint hr_document_upload_failure_consistent;

alter table private.hr_document_upload_operations
  add constraint hr_document_upload_failure_consistent check (
    (
      state in ('scan_error', 'storage_error', 'rejected', 'cancelled')
      and btrim(coalesce(failure_code, '')) <> ''
    )
    or (
      state not in ('scan_error', 'storage_error', 'rejected', 'cancelled')
      and failure_code is null
      and failure_detail is null
    )
  );

create or replace function private.hr_document_upload_transition_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed boolean := false;
begin
  if new.actor_employee_id <> old.actor_employee_id
    or new.document_id <> old.document_id
    or new.version_id <> old.version_id
    or new.vault_code <> old.vault_code
    or new.storage_bucket <> old.storage_bucket
    or new.object_key <> old.object_key
    or new.idempotency_key <> old.idempotency_key then
    raise check_violation using message = 'Document upload identity fields are immutable.';
  end if;

  allowed := case old.state
    when 'initialized' then new.state in ('quarantined', 'stored', 'scan_error', 'storage_error', 'rejected', 'cancelled')
    when 'quarantined' then new.state in ('stored', 'clean', 'scan_error', 'storage_error', 'rejected', 'cancelled')
    when 'stored' then new.state in ('scan_pending', 'clean', 'scan_error', 'storage_error', 'rejected', 'cancelled')
    when 'scan_pending' then new.state in ('clean', 'scan_error', 'storage_error', 'rejected', 'cancelled')
    when 'scan_error' then new.state in ('stored', 'scan_pending', 'clean', 'storage_error', 'rejected', 'cancelled')
    when 'storage_error' then new.state in ('stored', 'clean', 'rejected', 'cancelled')
    else false
  end;

  if new.state <> old.state and not allowed then
    raise check_violation using message = format('Invalid document upload transition: %s to %s.', old.state, new.state);
  end if;
  if new.state = old.state
    and row(new.failure_code, new.failure_detail) is distinct from row(old.failure_code, old.failure_detail) then
    raise check_violation using message = 'Upload failure details cannot be changed without a state transition.';
  end if;

  new.updated_at := clock_timestamp();
  if new.state = 'quarantined' then new.quarantined_at := coalesce(new.quarantined_at, clock_timestamp()); end if;
  if new.state = 'stored' then new.stored_at := coalesce(new.stored_at, clock_timestamp()); end if;
  if new.state = 'scan_pending' then new.scan_requested_at := clock_timestamp(); end if;
  if new.state in ('clean', 'rejected', 'cancelled') then new.completed_at := coalesce(new.completed_at, clock_timestamp()); end if;
  return new;
end
$$;

-- Availability is now determined by the protected storage/integrity handoff.
-- Historical scan rows remain audit history only; they are used solely to keep
-- already-released historical versions readable during this forward migration.
create or replace function private.hr_document_latest_availability_state(target_version_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select case operation.state
        when 'clean' then 'clean'
        when 'rejected' then 'rejected'
        else 'storage_error'
      end
      from private.hr_document_upload_operations operation
      where operation.version_id = target_version_id
      order by operation.created_at desc, operation.id desc
      limit 1
    ),
    (
      select 'clean'
      from private.signature_audit_certificates certificate
      where certificate.final_document_version_id = target_version_id
      limit 1
    ),
    (
      select case when event.state = 'clean' then 'clean' else 'storage_error' end
      from private.hr_document_scan_events event
      where event.version_id = target_version_id
      order by event.scanned_at desc, event.id desc
      limit 1
    ),
    'storage_error'
  )
$$;

-- Retain the old private symbol until every previously released service
-- function has been replaced. It now delegates to availability state and has
-- no scan or quarantine behavior.
create or replace function private.hr_document_latest_scan_state(target_version_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.hr_document_latest_availability_state(target_version_id)
$$;

-- The Worker performs the byte-level SHA-256 verification.  This separate
-- database boundary prevents a completion RPC from marking a row available
-- unless the exact private Storage object, its durable size, and its MIME type
-- also match the approved record.  It deliberately does not expose storage
-- object details to callers.
create or replace function private.require_private_storage_object(
  target_bucket text,
  target_object_key text,
  target_size_bytes bigint,
  target_mime_type text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored_size_bytes bigint;
  stored_mime_type text;
  expected_mime_type text;
begin
  expected_mime_type := nullif(
    pg_catalog.lower(pg_catalog.btrim(pg_catalog.split_part(coalesce(target_mime_type, ''), ';', 1))),
    ''
  );
  if nullif(pg_catalog.btrim(coalesce(target_bucket, '')), '') is null
    or nullif(pg_catalog.btrim(coalesce(target_object_key, '')), '') is null
    or target_size_bytes is null
    or target_size_bytes < 1
    or expected_mime_type is null then
    raise check_violation using message = 'The approved private storage record is incomplete.';
  end if;

  select
    case
      when coalesce(stored_object.metadata->>'size', stored_object.metadata->>'contentLength') ~ '^[0-9]+$'
        then coalesce(stored_object.metadata->>'size', stored_object.metadata->>'contentLength')::bigint
    end,
    nullif(
      pg_catalog.lower(pg_catalog.btrim(pg_catalog.split_part(
        coalesce(stored_object.metadata->>'mimetype', stored_object.metadata->>'contentType', ''),
        ';',
        1
      ))),
      ''
    )
  into stored_size_bytes, stored_mime_type
  from storage.objects stored_object
  where stored_object.bucket_id = target_bucket
    and stored_object.name = target_object_key
    and stored_object.archived_at is null
    and not stored_object.is_delete_marker
  order by stored_object.updated_at desc nulls last, stored_object.id desc
  limit 1;

  if stored_size_bytes is distinct from target_size_bytes
    or stored_mime_type is distinct from expected_mime_type then
    raise check_violation using message = 'The protected storage object does not match its approved file record.';
  end if;
end
$$;

revoke all on function private.require_private_storage_object(text, text, bigint, text)
  from public, anon, authenticated;

-- The inventory function used to read the scan-event table directly, bypassing
-- the compatibility wrapper above. Adapt its exact reviewed body in-place so
-- newly stored documents appear immediately without fabricating scan evidence.
do $$
declare
  workspace_definition text;
  old_lateral_join constant text :=
    'left join lateral (' || chr(10) ||
    '    select event.state' || chr(10) ||
    '    from private.hr_document_scan_events event' || chr(10) ||
    '    where event.version_id = version.id' || chr(10) ||
    '    order by event.scanned_at desc, event.id desc' || chr(10) ||
    '    limit 1' || chr(10) ||
    '  ) scan on true;';
  new_lateral_join constant text :=
    'left join lateral (' || chr(10) ||
    '    select private.hr_document_latest_availability_state(version.id) as state' || chr(10) ||
    '  ) availability on true;';
begin
  workspace_definition := pg_get_functiondef(
    'public.service_get_hr_document_workspace(uuid,text,uuid,text,boolean,integer,integer)'::regprocedure
  );
  if position(old_lateral_join in workspace_definition) = 0
    or position('and scan.state = ''clean''' in workspace_definition) = 0
    or position('coalesce(scan.state, ''quarantined'')' in workspace_definition) = 0 then
    raise exception 'The HR document workspace does not match the reviewed availability boundary.';
  end if;
  workspace_definition := replace(workspace_definition, old_lateral_join, new_lateral_join);
  workspace_definition := replace(workspace_definition, 'and scan.state = ''clean''', 'and availability.state = ''clean''');
  workspace_definition := replace(workspace_definition, 'coalesce(scan.state, ''quarantined'')', 'coalesce(availability.state, ''storage_error'')');
  execute workspace_definition;
end;
$$;

-- Move every active document, assignment, template, signature, and access
-- routine to the availability contract. The compatibility wrapper remains
-- only for old, already-recorded database artifacts during this release.
do $$
declare
  target_function regprocedure;
  function_definition text;
begin
  foreach target_function in array array[
    'private.hr_template_library_catalog(uuid,text,text,text,integer,integer)'::regprocedure,
    'public.get_hr_document_vault_readiness()'::regprocedure,
    'public.service_authorize_assigned_training_document(uuid,uuid,text,text)'::regprocedure,
    'public.service_complete_hr_document_assignment(uuid,uuid,text,text,boolean,text,timestamp with time zone,text)'::regprocedure,
    'public.service_consume_hr_document_access_grant(uuid,text,text)'::regprocedure,
    'public.service_create_document_template(uuid,uuid,uuid,text,text,text,text,text,text,timestamp with time zone,text)'::regprocedure,
    'public.service_create_hr_document_assignment(uuid,uuid,uuid,text,text,date,text)'::regprocedure,
    'public.service_create_signature_envelope(uuid,uuid,uuid,uuid,text,text,timestamp with time zone,jsonb,uuid,text,timestamp with time zone,text)'::regprocedure,
    'public.service_get_hr_system_library(uuid,text,text,text,integer,integer)'::regprocedure,
    'public.service_get_my_hr_document_workspace(uuid)'::regprocedure,
    'public.service_issue_hr_document_access_grant(uuid,uuid,text,text,text,timestamp with time zone,text,text)'::regprocedure,
    'public.service_issue_my_hr_document_access_grant(uuid,uuid,text,text,text,timestamp with time zone,text,text)'::regprocedure,
    'public.service_send_signature_envelope(uuid,uuid,text,timestamp with time zone,text)'::regprocedure
  ] loop
    function_definition := pg_get_functiondef(target_function::oid);
    if position('private.hr_document_latest_scan_state' in function_definition) = 0 then
      raise exception 'The document availability reference is absent from %.', target_function::text;
    end if;
    function_definition := replace(
      function_definition,
      'private.hr_document_latest_scan_state',
      'private.hr_document_latest_availability_state'
    );
    function_definition := replace(
      function_definition,
      'The document has not passed malware scanning.',
      'The document is not available because protected storage verification did not complete.'
    );
    execute function_definition;
  end loop;
end;
$$;

create or replace function public.service_begin_hr_document_upload(
  target_actor_id uuid,
  target_employee_id uuid,
  target_document_id uuid,
  target_vault_code text,
  target_title text,
  target_category text,
  target_description text,
  target_access_classification text,
  target_original_filename text,
  target_sanitized_filename text,
  target_extension text,
  target_declared_mime_type text,
  target_detected_mime_type text,
  target_size_bytes bigint,
  target_sha256_checksum text,
  target_idempotency_key uuid,
  target_request_id text default null,
  target_replacement_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  vault_record private.hr_document_vaults%rowtype;
  document_record private.hr_documents%rowtype;
  version_id uuid;
  operation_id uuid;
  version_number integer;
  object_key text;
  existing_result jsonb;
  retention_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then
    raise insufficient_privilege using message = 'The HR document workspace has not been released.';
  end if;
  perform private.service_require_hr_document_permission(target_actor_id, target_vault_code, 'manage');

  select jsonb_build_object(
    'operationId', operation.id, 'documentId', operation.document_id, 'versionId', operation.version_id,
    'bucket', operation.storage_bucket, 'objectKey', operation.object_key, 'state', operation.state
  ) into existing_result
  from private.hr_document_upload_operations operation
  where operation.idempotency_key = target_idempotency_key;
  if existing_result is not null then return existing_result; end if;

  select * into vault_record
  from private.hr_document_vaults vault
  where vault.code = target_vault_code and vault.active;
  if target_size_bytes <= 0 or target_size_bytes > vault_record.maximum_file_size_bytes then
    raise check_violation using message = 'The document file size is not allowed.';
  end if;
  if not (target_detected_mime_type = any(vault_record.allowed_mime_types)) then
    raise check_violation using message = 'The detected file type is not allowed in this vault.';
  end if;

  select policy.id into retention_id
  from private.hr_document_retention_policies policy
  where policy.code = 'MANUAL_REVIEW' and policy.active;

  if target_document_id is null then
    insert into private.hr_documents (
      employee_id, vault_code, title, category, description, access_classification,
      retention_policy_id, created_by
    ) values (
      target_employee_id, target_vault_code, target_title, target_category, target_description,
      target_access_classification, retention_id, target_actor_id
    ) returning * into document_record;
    version_number := 1;
  else
    select * into document_record
    from private.hr_documents document
    where document.id = target_document_id and document.archived_at is null
    for update;
    if document_record.id is null then raise no_data_found using message = 'The document was not found.'; end if;
    if document_record.vault_code <> target_vault_code then
      raise check_violation using message = 'Replacement versions must remain in the same vault.';
    end if;
    select coalesce(max(version.version_number), 0) + 1 into version_number
    from private.hr_document_versions version
    where version.document_id = document_record.id;
  end if;

  object_key := gen_random_uuid()::text || '/' || gen_random_uuid()::text;
  insert into private.hr_document_versions (
    document_id, version_number, storage_bucket, object_key, original_filename, sanitized_filename,
    extension, declared_mime_type, detected_mime_type, size_bytes, sha256_checksum,
    replacement_reason, uploaded_by, idempotency_key
  ) values (
    document_record.id, version_number, vault_record.storage_bucket, object_key,
    target_original_filename, target_sanitized_filename, target_extension, target_declared_mime_type,
    target_detected_mime_type, target_size_bytes, target_sha256_checksum,
    target_replacement_reason, target_actor_id, target_idempotency_key
  ) returning id into version_id;

  update private.hr_documents document
  set current_version_id = version_id, updated_at = clock_timestamp()
  where document.id = document_record.id;

  insert into private.hr_document_upload_operations (
    actor_employee_id, document_id, version_id, vault_code, storage_bucket, object_key,
    request_id, idempotency_key, state
  ) values (
    target_actor_id, document_record.id, version_id, target_vault_code, vault_record.storage_bucket,
    object_key, nullif(btrim(target_request_id), ''), target_idempotency_key, 'initialized'
  ) returning id into operation_id;

  insert into private.hr_document_access_events (
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    document_record.id, version_id, 'upload', target_actor_id, nullif(btrim(target_request_id), ''),
    'Upload accepted and awaiting protected storage verification.',
    jsonb_build_object('operationId', operation_id, 'state', 'initialized')
  );

  return jsonb_build_object(
    'operationId', operation_id, 'documentId', document_record.id, 'versionId', version_id,
    'bucket', vault_record.storage_bucket, 'objectKey', object_key, 'state', 'initialized'
  );
end
$$;

create or replace function public.service_mark_hr_document_upload_stored(
  target_operation_id uuid,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation_record private.hr_document_upload_operations%rowtype;
  previous_state text;
  approved_size_bytes bigint;
  approved_mime_type text;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select * into operation_record
  from private.hr_document_upload_operations operation
  where operation.id = target_operation_id
  for update;
  if operation_record.id is null then
    raise no_data_found using message = 'The upload operation was not found.';
  end if;
  if operation_record.state = 'clean' then
    return jsonb_build_object('operationId', operation_record.id, 'state', 'clean', 'requestId', operation_record.request_id);
  end if;
  if operation_record.state in ('rejected', 'cancelled') then
    raise check_violation using message = 'The upload cannot be made available.';
  end if;
  if operation_record.state not in ('initialized', 'quarantined', 'stored', 'scan_pending', 'scan_error', 'storage_error') then
    raise check_violation using message = 'The upload is not ready for protected storage completion.';
  end if;

  select version.size_bytes, version.detected_mime_type
  into approved_size_bytes, approved_mime_type
  from private.hr_document_versions version
  where version.id = operation_record.version_id;
  if not found then
    raise no_data_found using message = 'The approved document version was not found.';
  end if;
  perform private.require_private_storage_object(
    operation_record.storage_bucket,
    operation_record.object_key,
    approved_size_bytes,
    approved_mime_type
  );

  previous_state := operation_record.state;
  if operation_record.state in ('initialized', 'quarantined', 'scan_error', 'storage_error') then
    update private.hr_document_upload_operations operation
    set state = 'stored',
        stored_at = coalesce(operation.stored_at, clock_timestamp()),
        failure_code = null,
        failure_detail = null
    where operation.id = target_operation_id
    returning * into operation_record;
  end if;

  update private.hr_document_upload_operations operation
  set state = 'clean',
      stored_at = coalesce(operation.stored_at, clock_timestamp()),
      completed_at = coalesce(operation.completed_at, clock_timestamp()),
      request_id = coalesce(nullif(btrim(target_request_id), ''), operation.request_id),
      failure_code = null,
      failure_detail = null
  where operation.id = target_operation_id
  returning * into operation_record;

  insert into private.hr_document_access_events (
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    operation_record.document_id, operation_record.version_id, 'upload_available', operation_record.actor_employee_id,
    coalesce(nullif(btrim(target_request_id), ''), operation_record.request_id),
    'Upload completed after protected storage and checksum verification.',
    jsonb_build_object('operationId', operation_record.id, 'previousState', previous_state, 'state', 'clean')
  );

  return jsonb_build_object('operationId', operation_record.id, 'state', 'clean', 'requestId', operation_record.request_id);
end
$$;

create or replace function public.service_fail_hr_document_upload(
  target_operation_id uuid,
  target_state text,
  target_failure_code text,
  target_failure_detail text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation_record private.hr_document_upload_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if target_state not in ('scan_error', 'storage_error', 'rejected', 'cancelled') then
    raise check_violation using message = 'Unsupported upload failure state.';
  end if;
  if btrim(coalesce(target_failure_code, '')) = '' then
    raise check_violation using message = 'A failure code is required.';
  end if;

  select * into operation_record
  from private.hr_document_upload_operations operation
  where operation.id = target_operation_id
  for update;
  if operation_record.id is null then raise no_data_found using message = 'The upload operation was not found.'; end if;
  if operation_record.state in ('clean', 'rejected', 'cancelled') then
    return jsonb_build_object('operationId', operation_record.id, 'state', operation_record.state);
  end if;

  update private.hr_document_upload_operations operation
  set state = target_state,
      failure_code = target_failure_code,
      failure_detail = nullif(left(btrim(coalesce(target_failure_detail, '')), 1000), '')
  where operation.id = target_operation_id
  returning * into operation_record;

  insert into private.hr_document_access_events (
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    operation_record.document_id, operation_record.version_id, 'upload_storage_failure', operation_record.actor_employee_id,
    operation_record.request_id, 'Protected storage verification did not complete.',
    jsonb_build_object('operationId', operation_record.id, 'state', operation_record.state, 'failureCode', target_failure_code)
  );
  return jsonb_build_object('operationId', operation_record.id, 'state', operation_record.state);
end
$$;

-- Pre-cutover workers can have already written an object while leaving the
-- operation in a retired availability state.  Return only rows whose immutable
-- operation identity still matches a complete, checksum-bound version.  The
-- scheduled Worker re-reads that exact private object before calling the
-- normal availability transition.
create or replace function public.service_list_hr_document_availability_recovery(target_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  recovery_candidates jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'operationId', candidate.operation_id,
    'bucket', candidate.storage_bucket,
    'objectKey', candidate.object_key,
    'sizeBytes', candidate.size_bytes,
    'checksum', candidate.sha256_checksum
  ) order by candidate.created_at, candidate.operation_id), '[]'::jsonb)
  into recovery_candidates
  from (
    select
      operation.id as operation_id,
      operation.created_at,
      operation.storage_bucket,
      operation.object_key,
      version.size_bytes,
      version.sha256_checksum
    from private.hr_document_upload_operations operation
    join private.hr_document_versions version
      on version.id = operation.version_id
      and version.document_id = operation.document_id
      and version.storage_bucket = operation.storage_bucket
      and version.object_key = operation.object_key
    where operation.state in ('quarantined', 'stored', 'scan_pending', 'scan_error')
      and nullif(pg_catalog.btrim(operation.storage_bucket), '') is not null
      and version.object_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'
      and version.size_bytes between 1 and 26214400
      and version.sha256_checksum ~ '^[a-f0-9]{64}$'
    order by operation.created_at, operation.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) candidate;

  return recovery_candidates;
end
$$;

create or replace function public.service_commit_signature_finalization(
  target_envelope_id uuid,
  target_job_id uuid,
  target_final_bucket text,
  target_final_object_key text,
  target_final_filename text,
  target_final_size_bytes bigint,
  target_final_checksum text,
  target_audit_bucket text,
  target_audit_object_key text,
  target_audit_filename text,
  target_audit_size_bytes bigint,
  target_audit_checksum text,
  target_package_checksum text,
  target_generated_by_service text,
  target_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  envelope_record private.signature_envelopes%rowtype;
  source_version private.hr_document_versions%rowtype;
  final_version_id uuid;
  next_version integer;
  prior_state text;
begin
  perform private.document_studio_require_service();
  if target_final_checksum !~ '^[a-f0-9]{64}$'
    or target_audit_checksum !~ '^[a-f0-9]{64}$'
    or target_package_checksum !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'Finalization checksums are invalid.';
  end if;
  if target_final_object_key !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'
    or target_audit_object_key !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$' then
    raise check_violation using message = 'Finalization storage keys are invalid.';
  end if;

  select * into envelope_record
  from private.signature_envelopes
  where id = target_envelope_id
  for update;
  if envelope_record.id is null then
    raise no_data_found using message = 'The signature envelope was not found.';
  end if;
  if envelope_record.status = 'completed' then
    return jsonb_build_object(
      'id', envelope_record.id,
      'status', 'completed',
      'finalVersionId', envelope_record.final_document_version_id,
      'idempotent', true
    );
  end if;
  if envelope_record.status <> 'finalizing'
    or not exists (
      select 1
      from private.document_processing_jobs job
      where job.id = target_job_id
        and job.envelope_id = envelope_record.id
        and job.status = 'processing'
    ) then
    raise check_violation using message = 'The signature finalization lease is not active.';
  end if;

  select * into source_version
  from private.hr_document_versions
  where id = envelope_record.document_version_id;
  if source_version.id is null then
    raise no_data_found using message = 'The signed source document version was not found.';
  end if;
  if target_final_bucket <> source_version.storage_bucket
    or target_audit_bucket <> source_version.storage_bucket then
    raise check_violation using message = 'Finalization files must remain in the approved private vault.';
  end if;

  perform private.require_private_storage_object(
    target_final_bucket,
    target_final_object_key,
    target_final_size_bytes,
    'application/pdf'
  );
  perform private.require_private_storage_object(
    target_audit_bucket,
    target_audit_object_key,
    target_audit_size_bytes,
    'application/pdf'
  );

  select coalesce(max(version.version_number), 0) + 1 into next_version
  from private.hr_document_versions version
  where version.document_id = envelope_record.document_id;

  insert into private.hr_document_versions(
    document_id, version_number, storage_bucket, object_key, original_filename, sanitized_filename,
    extension, declared_mime_type, detected_mime_type, size_bytes, sha256_checksum,
    replacement_reason, uploaded_by, upload_source, idempotency_key
  ) values (
    envelope_record.document_id, next_version, target_final_bucket, target_final_object_key,
    target_final_filename, target_final_filename, 'pdf', 'application/pdf', 'application/pdf',
    target_final_size_bytes, target_final_checksum,
    'Final immutable signed copy generated from signature envelope ' || envelope_record.id::text,
    envelope_record.created_by, 'signature_service', gen_random_uuid()
  ) returning id into final_version_id;

  insert into private.signature_audit_certificates(
    envelope_id, document_id, final_document_version_id, storage_bucket, object_key, filename,
    checksum, final_package_checksum, seal_status, generated_by_service
  ) values (
    envelope_record.id, envelope_record.document_id, final_version_id,
    target_audit_bucket, target_audit_object_key, target_audit_filename,
    target_audit_checksum, target_package_checksum, 'not_required', target_generated_by_service
  );

  select lifecycle_state into prior_state
  from private.hr_documents
  where id = envelope_record.document_id
  for update;
  update private.hr_documents
  set current_version_id = final_version_id,
      lifecycle_state = 'locked_final',
      updated_at = clock_timestamp()
  where id = envelope_record.document_id;
  update private.signature_envelopes
  set status = 'completed',
      completed_at = clock_timestamp(),
      final_document_version_id = final_version_id,
      final_package_checksum = target_package_checksum
  where id = envelope_record.id;
  update private.document_processing_jobs
  set status = 'completed',
      completed_at = clock_timestamp(),
      result = jsonb_build_object(
        'finalVersionId', final_version_id,
        'finalChecksum', target_final_checksum,
        'auditChecksum', target_audit_checksum,
        'packageChecksum', target_package_checksum
      )
  where id = target_job_id;
  insert into private.hr_document_access_events(
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    envelope_record.document_id, final_version_id, 'upload_available', envelope_record.created_by,
    nullif(btrim(target_request_id), ''),
    'Signed final PDF and audit certificate completed after protected storage and checksum verification.',
    jsonb_build_object(
      'envelopeId', envelope_record.id,
      'sourceVersionId', source_version.id,
      'sourceChecksum', source_version.sha256_checksum,
      'finalChecksum', target_final_checksum,
      'auditChecksum', target_audit_checksum,
      'packageChecksum', target_package_checksum
    )
  );
  insert into private.signature_events(
    envelope_id, document_id, document_version_id, actor_employee_id, event_type, event_reason,
    source_checksum, request_id, metadata
  ) values (
    envelope_record.id, envelope_record.document_id, final_version_id, envelope_record.created_by,
    'completed', 'Immutable signed PDF and audit certificate generated.', target_final_checksum,
    nullif(btrim(target_request_id), ''),
    jsonb_build_object(
      'sourceVersionId', source_version.id,
      'sourceChecksum', source_version.sha256_checksum,
      'auditChecksum', target_audit_checksum,
      'packageChecksum', target_package_checksum
    )
  );
  insert into private.document_lifecycle_events(
    document_id, version_id, actor_employee_id, from_state, to_state, reason, request_id, metadata
  ) values (
    envelope_record.document_id, final_version_id, envelope_record.created_by, prior_state,
    'locked_final', 'Signature workflow completed and the final evidence package was locked.',
    nullif(btrim(target_request_id), ''),
    jsonb_build_object(
      'envelopeId', envelope_record.id,
      'sourceVersionId', source_version.id,
      'sourceChecksum', source_version.sha256_checksum,
      'finalChecksum', target_final_checksum
    )
  );
  return jsonb_build_object(
    'id', envelope_record.id,
    'status', 'completed',
    'finalVersionId', final_version_id,
    'completedAt', clock_timestamp()
  );
end
$$;

create or replace function public.service_sygsphere_file(action text, target_actor_id uuid, input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item private.sygsphere_files%rowtype;
  cid uuid := (input->>'conversationId')::uuid;
  fid uuid := (input->>'fileId')::uuid;
  mid uuid;
  prior_state text;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  if not exists(select 1 from private.sygsphere_gate where enabled)
    or not exists(
      select 1
      from private.employee_accounts account
      join public.employees employee on employee.id = account.employee_id
      where employee.id = target_actor_id and employee.status = 'active' and account.disabled_at is null
    ) then
    raise insufficient_privilege;
  end if;
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('sygsphere-file:' || fid::text, 0));
  select * into item from private.sygsphere_files where id = fid for update;
  if found then
    cid := item.conversation_id;
    if item.author_id <> target_actor_id then raise insufficient_privilege; end if;
  end if;
  perform 1 from private.sygsphere_conversations where id = cid and not archived for update;
  if not found or not exists(
    select 1 from private.sygsphere_members
    where conversation_id = cid and employee_id = target_actor_id and removed_at is null
  ) then
    raise insufficient_privilege;
  end if;

  if action = 'begin' then
    if item.id is not null then
      if item.checksum <> input->>'checksum'
        or item.conversation_id <> (input->>'conversationId')::uuid
        or item.parent_id is distinct from nullif(input->>'parentId', '')::uuid then
        raise check_violation using message = 'Upload retry does not match the original file.';
      end if;
      if item.state = 'rejected' then
        raise check_violation using message = 'This file is not available.';
      end if;
      return jsonb_build_object('state', item.state, 'id', item.id, 'messageId', item.message_id);
    end if;
    if (select count(*) from private.sygsphere_files where author_id = target_actor_id and created_at > clock_timestamp() - interval '1 hour') >= 50 then
      raise check_violation using message = 'Hourly file sharing limit reached. Try again later.';
    end if;
    if nullif(input->>'parentId', '') is not null and not exists(
      select 1 from private.sygsphere_messages
      where id = (input->>'parentId')::uuid and conversation_id = cid and parent_id is null and deleted_at is null
    ) then
      raise check_violation using message = 'Thread is not available.';
    end if;
    insert into private.sygsphere_files(
      id, conversation_id, author_id, parent_id, filename, mime_type, size_bytes, checksum
    ) values(
      fid, cid, target_actor_id, nullif(input->>'parentId', '')::uuid, input->>'filename', input->>'mimeType',
      (input->>'sizeBytes')::integer, input->>'checksum'
    ) returning * into item;
  elsif action = 'complete' then
    if item.id is null then raise check_violation using message = 'File upload not found.'; end if;
    if item.state = 'clean' then
      return jsonb_build_object('state', 'clean', 'id', item.id, 'messageId', item.message_id);
    end if;
    if input->>'state' not in ('clean', 'rejected', 'error') or item.state = 'rejected' then
      raise check_violation;
    end if;
    prior_state := item.state;
    if input->>'state' = 'clean' then
      if input->>'checksum' is distinct from item.checksum then
        raise check_violation using message = 'The stored file does not match the approved upload.';
      end if;
      perform private.require_private_storage_object(
        'sygsphere-files',
        cid::text || '/' || fid::text,
        item.size_bytes,
        item.mime_type
      );
      insert into private.sygsphere_messages(conversation_id, author_id, client_id, parent_id, body)
      values(cid, target_actor_id, fid, item.parent_id, 'Shared file: ' || item.filename)
      returning id into mid;
      update private.sygsphere_conversations set updated_at = clock_timestamp() where id = cid;
    end if;
    update private.sygsphere_files
    set state = input->>'state',
        message_id = coalesce(mid, item.message_id)
    where id = fid
    returning * into item;
    if item.state = 'clean' then
      insert into private.audit_events(employee_id, request_id, schema_name, table_name, operation, row_id, old_record, new_record)
      values(
        target_actor_id, null, 'private', 'sygsphere_files', 'UPLOAD_AVAILABLE', item.id::text,
        jsonb_build_object('state', prior_state),
        jsonb_build_object('state', item.state, 'messageId', item.message_id, 'integrity', 'checksum-verified')
      );
    end if;
    perform private.sygsphere_signal(cid);
  else
    raise check_violation;
  end if;
  return jsonb_build_object('state', item.state, 'id', item.id, 'messageId', item.message_id);
end
$$;

create or replace function public.service_complete_sygsphere_resumable_upload_available(
  target_actor_id uuid,
  target_upload_id uuid,
  target_checksum text,
  target_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item private.sygsphere_resumable_uploads%rowtype;
  result jsonb;
  prior_state text;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  if coalesce(target_checksum, '') !~ '^[0-9a-f]{64}$' then
    raise check_violation using message = 'A SHA-256 checksum is required.';
  end if;
  select * into item
  from private.sygsphere_resumable_uploads upload
  where upload.id = target_upload_id
  for update;
  if item.id is null or item.author_id <> target_actor_id then raise insufficient_privilege; end if;
  if item.state = 'clean' then
    return jsonb_build_object('uploadId', item.id, 'state', item.state, 'messageId', item.message_id);
  end if;
  if item.state not in ('uploaded', 'scanning', 'error') or item.expires_at <= clock_timestamp() then
    raise object_not_in_prerequisite_state using message = 'This protected upload is not available for completion.';
  end if;
  if item.checksum is not null and item.checksum <> target_checksum then
    raise check_violation using message = 'The stored file checksum no longer matches its upload record.';
  end if;

  prior_state := item.state;
  result := public.service_sygsphere_file('begin', item.author_id, jsonb_build_object(
    'fileId', item.id, 'conversationId', item.conversation_id, 'parentId', item.parent_id,
    'filename', item.filename, 'mimeType', item.mime_type, 'sizeBytes', item.size_bytes,
    'checksum', target_checksum
  ));
  result := public.service_sygsphere_file('complete', item.author_id, jsonb_build_object(
    'fileId', item.id, 'conversationId', item.conversation_id, 'parentId', item.parent_id,
    'filename', item.filename, 'mimeType', item.mime_type, 'sizeBytes', item.size_bytes,
    'checksum', target_checksum, 'state', 'clean'
  ));

  update private.sygsphere_resumable_uploads
  set state = 'clean',
      checksum = target_checksum,
      message_id = nullif(result->>'messageId', '')::uuid,
      lease_id = null,
      last_error = null,
      failure_stage = null,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      last_request_id = coalesce(
        case
          when nullif(btrim(target_request_id), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then nullif(btrim(target_request_id), '')::uuid
        end,
        last_request_id
      )
  where id = item.id
  returning * into item;

  insert into private.audit_events(employee_id, request_id, schema_name, table_name, operation, row_id, old_record, new_record)
  values(
    item.author_id, nullif(btrim(target_request_id), ''), 'private', 'sygsphere_resumable_uploads', 'UPLOAD_AVAILABLE', item.id::text,
    jsonb_build_object('state', prior_state),
    jsonb_build_object('state', item.state, 'messageId', item.message_id, 'integrity', 'checksum-verified')
  );
  perform private.create_employee_notification(
    item.author_id, 'sygsphere_file', item.id, concat('sygsphere-file-ready:', item.id),
    'SygSphere file is ready', 'Your file is available in SygSphere.', 'routine', false,
    concat('/sygsphere?conversation=', item.conversation_id, '&message=', item.message_id), 'Open file'
  );
  return jsonb_build_object('uploadId', item.id, 'state', item.state, 'messageId', item.message_id);
end
$$;

create or replace function public.service_list_sygsphere_file_availability_recovery(target_limit integer default 25)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'fileId', file.id,
    'conversationId', file.conversation_id,
    'authorId', file.author_id,
    'parentId', file.parent_id,
    'filename', file.filename,
    'mimeType', file.mime_type,
    'sizeBytes', file.size_bytes,
    'checksum', file.checksum,
    'objectKey', file.conversation_id::text || '/' || file.id::text
  ) order by file.created_at, file.id), '[]'::jsonb)
  from (
    select *
    from private.sygsphere_files
    where state = 'error' and message_id is null
    order by created_at, id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) file
  where (select auth.role()) = 'service_role'
$$;

create or replace function public.service_list_sygsphere_resumable_availability_recovery(target_limit integer default 25)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'uploadId', upload.id,
    'authorId', upload.author_id,
    'objectKey', upload.object_key,
    'sizeBytes', upload.size_bytes,
    'state', upload.state
  ) order by upload.created_at, upload.id), '[]'::jsonb)
  from (
    select *
    from private.sygsphere_resumable_uploads
    where state in ('uploaded', 'scanning', 'error')
      and message_id is null
      and purged_at is null
      and expires_at > clock_timestamp()
    order by created_at, id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) upload
  where (select auth.role()) = 'service_role'
$$;

revoke all on function public.service_complete_sygsphere_resumable_upload_available(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_list_hr_document_availability_recovery(integer) from public, anon, authenticated;
revoke all on function public.service_list_sygsphere_file_availability_recovery(integer) from public, anon, authenticated;
revoke all on function public.service_list_sygsphere_resumable_availability_recovery(integer) from public, anon, authenticated;
grant execute on function public.service_complete_sygsphere_resumable_upload_available(uuid, uuid, text, text) to service_role;
grant execute on function public.service_list_hr_document_availability_recovery(integer) to service_role;
grant execute on function public.service_list_sygsphere_file_availability_recovery(integer) to service_role;
grant execute on function public.service_list_sygsphere_resumable_availability_recovery(integer) to service_role;

comment on function public.service_complete_sygsphere_resumable_upload_available(uuid, uuid, text, text) is
  'Completes a protected SygSphere upload after the Worker has verified durable storage, approved type and size, and SHA-256 integrity.';

-- Release canaries now record storage/integrity evidence directly. Retain the
-- old evidence rows and schema values as historical audit data, but make the
-- current Worker independent of scanner-named arguments and evidence types.
alter table private.document_pipeline_release_evidence
  drop constraint document_pipeline_release_evidence_scanner;

alter table private.document_pipeline_release_evidence
  drop constraint document_pipeline_release_evidence_type;

alter table private.document_pipeline_release_evidence
  add constraint document_pipeline_release_evidence_type
    check (evidence_type in ('scanner_clean', 'scanner_reject', 'storage_recovery', 'storage_integrity')),
  add constraint document_pipeline_release_evidence_availability
    check (
      evidence_type in ('storage_recovery', 'storage_integrity')
      or (
        btrim(coalesce(scanner_name, '')) <> ''
        and btrim(coalesce(scanner_version, '')) <> ''
      )
    );

create or replace function public.service_record_document_pipeline_availability_evidence(
  target_canary_run_id uuid,
  target_evidence_type text,
  target_evidence_sha256 text,
  target_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  evidence_record private.document_pipeline_release_evidence%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_evidence_type not in ('storage_recovery', 'storage_integrity') then
    raise check_violation using message = 'Unsupported document availability evidence type.';
  end if;
  if target_evidence_sha256 !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'Availability evidence requires a SHA-256 digest.';
  end if;

  insert into private.document_pipeline_release_evidence (
    canary_run_id, evidence_type, evidence_sha256, scanner_name, scanner_version, details
  ) values (
    target_canary_run_id, target_evidence_type, target_evidence_sha256, null, null,
    coalesce(target_details, '{}'::jsonb)
  )
  on conflict (canary_run_id, evidence_type) do nothing
  returning * into evidence_record;

  if evidence_record.id is null then
    select * into evidence_record
    from private.document_pipeline_release_evidence evidence
    where evidence.canary_run_id = target_canary_run_id
      and evidence.evidence_type = target_evidence_type;
  end if;

  return jsonb_build_object(
    'evidenceId', evidence_record.id,
    'canaryRunId', evidence_record.canary_run_id,
    'evidenceType', evidence_record.evidence_type,
    'verifiedAt', evidence_record.verified_at,
    'expiresAt', evidence_record.expires_at
  );
end
$$;

revoke all on function public.service_record_document_pipeline_availability_evidence(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_record_document_pipeline_availability_evidence(uuid, text, text, jsonb)
  to service_role;

-- Retire every live scanner entrypoint once all active access routines above
-- use the availability boundary. Historical scan-event rows remain immutable
-- audit history, but nothing can enqueue, claim, retry, or record a scan.
do $$
begin
  if exists (
    select 1
    from pg_proc function_record
    join pg_namespace function_schema on function_schema.oid = function_record.pronamespace
    where function_record.prokind = 'f'
      and function_schema.nspname in ('public', 'private')
      and function_record.oid <> 'private.hr_document_latest_scan_state(uuid)'::regprocedure
      and pg_get_functiondef(function_record.oid) like '%private.hr_document_latest_scan_state%'
  ) then
    raise exception 'A live document function still depends on the retired scan-state helper.';
  end if;
end
$$;

drop function if exists public.service_record_hr_document_scan_result(uuid, text, text, text, text, text, text);
drop function if exists public.service_claim_hr_document_scan(uuid, text);
drop function if exists private.record_hr_document_scan(uuid, text, text, text, text, text, text);
drop function if exists private.hr_document_latest_scan_state(uuid);
drop function if exists public.service_complete_sygsphere_resumable_scan(uuid, uuid, text, text, text, text);
drop function if exists public.service_defer_sygsphere_resumable_scan(uuid, uuid, text);
drop function if exists public.service_claim_sygsphere_resumable_scan(uuid);
drop function if exists public.service_retry_sygsphere_resumable_scan(uuid, uuid, uuid);
drop function if exists public.service_record_document_pipeline_release_evidence(uuid, text, text, text, text, jsonb);

notify pgrst, 'reload schema';

commit;
