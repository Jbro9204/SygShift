begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The operation key now identifies the complete normalized upload request.
-- The private intent is retained so a retry cannot substitute a different
-- employee, document, vault, classification, filename, or byte stream.
alter table private.hr_document_upload_operations
  add column if not exists upload_intent jsonb;

alter table private.hr_document_upload_operations
  drop constraint if exists hr_document_upload_intent_object;
alter table private.hr_document_upload_operations
  add constraint hr_document_upload_intent_object
  check (upload_intent is null or jsonb_typeof(upload_intent) = 'object');

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
    or new.idempotency_key <> old.idempotency_key
    or (
      old.upload_intent is not null
      and new.upload_intent is distinct from old.upload_intent
    )
  then
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
    raise check_violation using message = format(
      'Invalid document upload transition: %s to %s.',
      old.state,
      new.state
    );
  end if;
  if new.state = old.state
    and row(new.failure_code, new.failure_detail)
      is distinct from row(old.failure_code, old.failure_detail)
  then
    raise check_violation using message = 'Upload failure details cannot be changed without a state transition.';
  end if;

  new.updated_at := clock_timestamp();
  if new.state = 'quarantined' then
    new.quarantined_at := coalesce(new.quarantined_at, clock_timestamp());
  end if;
  if new.state = 'stored' then
    new.stored_at := coalesce(new.stored_at, clock_timestamp());
  end if;
  if new.state = 'scan_pending' then
    new.scan_requested_at := clock_timestamp();
  end if;
  if new.state in ('clean', 'rejected', 'cancelled') then
    new.completed_at := coalesce(new.completed_at, clock_timestamp());
  end if;
  return new;
end
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
  version_record private.hr_document_versions%rowtype;
  operation_record private.hr_document_upload_operations%rowtype;
  requested_intent jsonb;
  version_id uuid;
  operation_id uuid;
  version_number integer;
  object_key text;
  retention_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if not exists (
    select 1
    from private.hr_document_release_gate gate
    where gate.singleton
      and gate.enabled
  ) then
    raise insufficient_privilege using message = 'The HR document workspace has not been released.';
  end if;

  perform private.service_require_hr_document_permission(
    target_actor_id,
    target_vault_code,
    'manage'
  );

  select vault.*
  into vault_record
  from private.hr_document_vaults vault
  where vault.code = target_vault_code
    and vault.active;
  if not found then
    raise check_violation using message = 'The requested document vault is unavailable.';
  end if;

  if target_idempotency_key is null
    or btrim(coalesce(target_title, '')) = ''
    or btrim(coalesce(target_category, '')) = ''
    or coalesce(target_access_classification, '') not in ('confidential', 'restricted', 'highly_restricted')
    or btrim(coalesce(target_original_filename, '')) = ''
    or btrim(coalesce(target_sanitized_filename, '')) = ''
    or lower(coalesce(target_extension, '')) not in ('pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'docx', 'xlsx')
    or btrim(coalesce(target_declared_mime_type, '')) = ''
    or target_size_bytes is null
    or target_size_bytes <= 0
    or target_size_bytes > vault_record.maximum_file_size_bytes
    or lower(coalesce(target_sha256_checksum, '')) !~ '^[a-f0-9]{64}$'
    or not (coalesce(target_detected_mime_type, '') = any(vault_record.allowed_mime_types))
    or target_access_classification is distinct from vault_record.classification
  then
    raise check_violation using message = 'The document upload metadata is invalid.';
  end if;

  requested_intent := jsonb_build_object(
    'actorEmployeeId', target_actor_id,
    'employeeId', target_employee_id,
    'requestedDocumentId', target_document_id,
    'vaultCode', target_vault_code,
    'title', btrim(target_title),
    'category', btrim(target_category),
    'description', nullif(btrim(target_description), ''),
    'accessClassification', target_access_classification,
    'originalFilename', btrim(target_original_filename),
    'sanitizedFilename', btrim(target_sanitized_filename),
    'extension', lower(target_extension),
    'declaredMimeType', target_declared_mime_type,
    'detectedMimeType', target_detected_mime_type,
    'sizeBytes', target_size_bytes,
    'sha256Checksum', lower(target_sha256_checksum),
    'replacementReason', nullif(btrim(target_replacement_reason), '')
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_idempotency_key::text, 0)
  );

  select operation.*
  into operation_record
  from private.hr_document_upload_operations operation
  where operation.idempotency_key = target_idempotency_key
  for update;

  if found then
    select document.*
    into document_record
    from private.hr_documents document
    where document.id = operation_record.document_id;

    select version.*
    into version_record
    from private.hr_document_versions version
    where version.id = operation_record.version_id;

    if document_record.id is null or version_record.id is null then
      raise no_data_found using message = 'The existing document upload evidence is incomplete.';
    end if;

    if operation_record.upload_intent is null then
      if operation_record.actor_employee_id is distinct from target_actor_id
        or operation_record.vault_code is distinct from target_vault_code
        or document_record.employee_id is distinct from target_employee_id
        or document_record.title is distinct from btrim(target_title)
        or document_record.category is distinct from btrim(target_category)
        or document_record.description is distinct from nullif(btrim(target_description), '')
        or document_record.access_classification is distinct from target_access_classification
        or version_record.original_filename is distinct from btrim(target_original_filename)
        or version_record.sanitized_filename is distinct from btrim(target_sanitized_filename)
        or version_record.extension is distinct from lower(target_extension)
        or version_record.declared_mime_type is distinct from target_declared_mime_type
        or version_record.detected_mime_type is distinct from target_detected_mime_type
        or version_record.size_bytes is distinct from target_size_bytes
        or version_record.sha256_checksum is distinct from lower(target_sha256_checksum)
        or version_record.replacement_reason is distinct from nullif(btrim(target_replacement_reason), '')
        or (
          target_document_id is not null
          and operation_record.document_id is distinct from target_document_id
        )
        or (
          target_document_id is null
          and (
            version_record.version_number <> 1
            or document_record.created_by is distinct from target_actor_id
          )
        )
      then
        raise check_violation using message = 'Upload request ID was already used with different document metadata.';
      end if;

      update private.hr_document_upload_operations operation
      set upload_intent = requested_intent
      where operation.id = operation_record.id
      returning * into operation_record;
    elsif operation_record.upload_intent is distinct from requested_intent then
      raise check_violation using message = 'Upload request ID was already used with different document metadata.';
    end if;

    return jsonb_build_object(
      'operationId', operation_record.id,
      'documentId', operation_record.document_id,
      'versionId', operation_record.version_id,
      'bucket', operation_record.storage_bucket,
      'objectKey', operation_record.object_key,
      'state', operation_record.state
    );
  end if;

  select policy.id
  into retention_id
  from private.hr_document_retention_policies policy
  where policy.code = 'MANUAL_REVIEW'
    and policy.active;
  if retention_id is null then
    raise check_violation using message = 'The document retention policy is unavailable.';
  end if;

  if target_document_id is null then
    insert into private.hr_documents (
      employee_id,
      vault_code,
      title,
      category,
      description,
      access_classification,
      retention_policy_id,
      created_by
    ) values (
      target_employee_id,
      target_vault_code,
      btrim(target_title),
      btrim(target_category),
      nullif(btrim(target_description), ''),
      target_access_classification,
      retention_id,
      target_actor_id
    ) returning * into document_record;
    version_number := 1;
  else
    select document.*
    into document_record
    from private.hr_documents document
    where document.id = target_document_id
      and document.archived_at is null
    for update;
    if not found then
      raise no_data_found using message = 'The document was not found.';
    end if;
    if document_record.vault_code <> target_vault_code then
      raise check_violation using message = 'Replacement versions must remain in the same vault.';
    end if;
    if document_record.employee_id is distinct from target_employee_id then
      raise check_violation using message = 'Replacement versions must remain with the same employee record.';
    end if;
    if document_record.title is distinct from btrim(target_title)
      or document_record.category is distinct from btrim(target_category)
      or document_record.description is distinct from nullif(btrim(target_description), '')
      or document_record.access_classification is distinct from target_access_classification
    then
      raise check_violation using message = 'Document metadata must be updated separately from a replacement upload.';
    end if;

    select coalesce(max(version.version_number), 0) + 1
    into version_number
    from private.hr_document_versions version
    where version.document_id = document_record.id;
  end if;

  object_key := gen_random_uuid()::text || '/' || gen_random_uuid()::text;
  insert into private.hr_document_versions (
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
    replacement_reason,
    uploaded_by,
    idempotency_key
  ) values (
    document_record.id,
    version_number,
    vault_record.storage_bucket,
    object_key,
    btrim(target_original_filename),
    btrim(target_sanitized_filename),
    lower(target_extension),
    target_declared_mime_type,
    target_detected_mime_type,
    target_size_bytes,
    lower(target_sha256_checksum),
    nullif(btrim(target_replacement_reason), ''),
    target_actor_id,
    target_idempotency_key
  ) returning id into version_id;

  update private.hr_documents document
  set current_version_id = version_id,
      updated_at = clock_timestamp()
  where document.id = document_record.id;

  insert into private.hr_document_upload_operations (
    actor_employee_id,
    document_id,
    version_id,
    vault_code,
    storage_bucket,
    object_key,
    request_id,
    idempotency_key,
    state,
    upload_intent
  ) values (
    target_actor_id,
    document_record.id,
    version_id,
    target_vault_code,
    vault_record.storage_bucket,
    object_key,
    nullif(btrim(target_request_id), ''),
    target_idempotency_key,
    'initialized',
    requested_intent
  ) returning id into operation_id;

  insert into private.hr_document_access_events (
    document_id,
    version_id,
    action,
    actor_employee_id,
    request_id,
    reason,
    metadata
  ) values (
    document_record.id,
    version_id,
    'upload',
    target_actor_id,
    nullif(btrim(target_request_id), ''),
    'Upload accepted and awaiting protected storage verification.',
    jsonb_build_object('operationId', operation_id, 'state', 'initialized')
  );

  return jsonb_build_object(
    'operationId', operation_id,
    'documentId', document_record.id,
    'versionId', version_id,
    'bucket', vault_record.storage_bucket,
    'objectKey', object_key,
    'state', 'initialized'
  );
end
$$;

revoke all on function public.service_begin_hr_document_upload(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text,
  text, text, bigint, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.service_begin_hr_document_upload(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text,
  text, text, bigint, text, uuid, text, text
) to service_role;

comment on column private.hr_document_upload_operations.upload_intent is
  'Normalized private request identity used to reject idempotency-key reuse with different HR document metadata or bytes.';

commit;
