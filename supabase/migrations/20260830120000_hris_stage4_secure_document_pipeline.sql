begin;

-- Stage 4, run 2 adds a service-only quarantine and access pipeline. The
-- document release gate remains disabled and no employee access is changed.
create temporary table hris_stage4_run2_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.employee_accounts) as account_count,
  (select count(*) from private.hr_person_identifiers) as person_identifier_count,
  (select count(*) from private.hr_worker_identifiers) as worker_identifier_count;

create table private.hr_document_upload_operations (
  id uuid primary key default gen_random_uuid(),
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  vault_code text not null references private.hr_document_vaults(code) on delete restrict,
  storage_bucket text not null,
  object_key text not null,
  request_id text,
  idempotency_key uuid not null unique,
  state text not null default 'initialized',
  failure_code text,
  failure_detail text,
  created_at timestamptz not null default clock_timestamp(),
  quarantined_at timestamptz,
  stored_at timestamptz,
  scan_requested_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_document_upload_state check (state in (
    'initialized','quarantined','stored','scan_pending','scan_error','rejected','cancelled','clean'
  )),
  constraint hr_document_upload_failure_consistent check (
    (state in ('scan_error','rejected','cancelled') and btrim(coalesce(failure_code, '')) <> '')
    or (state not in ('scan_error','rejected','cancelled') and failure_code is null and failure_detail is null)
  ),
  unique (storage_bucket, object_key)
);

create index hr_document_upload_operations_state_index
  on private.hr_document_upload_operations(state, created_at);
create index hr_document_upload_operations_document_index
  on private.hr_document_upload_operations(document_id, created_at desc);

create table private.hr_document_access_grants (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  action text not null,
  mfa_method text not null,
  mfa_verified_at timestamptz not null,
  reason text not null,
  request_id text,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint hr_document_access_grant_token_hash check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint hr_document_access_grant_action check (action in ('preview','view','download')),
  constraint hr_document_access_grant_mfa check (mfa_method in ('authenticator','security_key')),
  constraint hr_document_access_grant_reason check (btrim(reason) <> ''),
  constraint hr_document_access_grant_expiry check (
    expires_at > created_at and expires_at <= created_at + interval '60 seconds'
  )
);

create index hr_document_access_grants_active_index
  on private.hr_document_access_grants(actor_employee_id, expires_at)
  where consumed_at is null;

create function private.hr_document_upload_transition_guard()
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
    when 'initialized' then new.state in ('quarantined','cancelled')
    when 'quarantined' then new.state in ('stored','scan_error','rejected','cancelled')
    when 'stored' then new.state in ('scan_pending','scan_error','rejected','cancelled')
    when 'scan_pending' then new.state in ('clean','scan_error','rejected','cancelled')
    -- A signed scanner callback can arrive after the request was marked as a
    -- transient scan error. Accepting that terminal result avoids stranding a
    -- clean document while still requiring scanner evidence in the service RPC.
    when 'scan_error' then new.state in ('scan_pending','clean','rejected','cancelled')
    else false
  end;

  if new.state <> old.state and not allowed then
    raise check_violation using message = format('Invalid document upload transition: %s to %s.', old.state, new.state);
  end if;
  if new.state = old.state and row(new.failure_code, new.failure_detail) is distinct from row(old.failure_code, old.failure_detail) then
    raise check_violation using message = 'Upload failure details cannot be changed without a state transition.';
  end if;

  new.updated_at := clock_timestamp();
  if new.state = 'quarantined' then new.quarantined_at := coalesce(new.quarantined_at, clock_timestamp()); end if;
  if new.state = 'stored' then new.stored_at := coalesce(new.stored_at, clock_timestamp()); end if;
  if new.state = 'scan_pending' then new.scan_requested_at := clock_timestamp(); end if;
  if new.state in ('clean','rejected','cancelled') then new.completed_at := coalesce(new.completed_at, clock_timestamp()); end if;
  return new;
end
$$;

create trigger hr_document_upload_transition_guard
before update on private.hr_document_upload_operations
for each row execute function private.hr_document_upload_transition_guard();

create function private.hr_document_access_grant_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise check_violation using message = 'Document access grants cannot be deleted.';
  end if;
  if old.consumed_at is not null or new.consumed_at is null
    or row(new.token_hash, new.actor_employee_id, new.document_id, new.version_id, new.action,
           new.mfa_method, new.mfa_verified_at, new.reason, new.request_id, new.created_at, new.expires_at)
       is distinct from
       row(old.token_hash, old.actor_employee_id, old.document_id, old.version_id, old.action,
           old.mfa_method, old.mfa_verified_at, old.reason, old.request_id, old.created_at, old.expires_at) then
    raise check_violation using message = 'Document access grants are immutable except for first use.';
  end if;
  return new;
end
$$;

create trigger hr_document_access_grant_guard
before update or delete on private.hr_document_access_grants
for each row execute function private.hr_document_access_grant_guard();

create function private.service_require_hr_document_permission(
  target_actor_id uuid,
  target_vault_code text,
  target_action text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  vault_record private.hr_document_vaults%rowtype;
  effective_permissions text[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_action not in ('view','manage') then
    raise check_violation using message = 'Unsupported document permission action.';
  end if;
  if not exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_actor_id
      and employee.status in ('active','leave')
      and account.disabled_at is null
  ) then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into vault_record
  from private.hr_document_vaults vault
  where vault.code = target_vault_code and vault.active;
  if vault_record.code is null then
    raise check_violation using message = 'The requested document vault is unavailable.';
  end if;

  effective_permissions := private.employee_effective_permissions(target_actor_id);
  if target_action = 'manage' and not ('hr.documents.manage' = any(effective_permissions)) then
    raise insufficient_privilege using message = 'Document management access is required.';
  end if;
  if target_action = 'view' and not (
    'hr.documents.view' = any(effective_permissions) or 'hr.documents.manage' = any(effective_permissions)
  ) then
    raise insufficient_privilege using message = 'Document access is required.';
  end if;
  if target_action = 'manage' and vault_record.manage_permission <> 'hr.documents.manage'
    and not (vault_record.manage_permission = any(effective_permissions)) then
    raise insufficient_privilege using message = 'Management access to this document vault is required.';
  end if;
  if target_action = 'view'
    and vault_record.view_permission not in ('hr.documents.view','hr.documents.manage')
    and not (vault_record.view_permission = any(effective_permissions))
    and not (vault_record.manage_permission = any(effective_permissions)) then
    raise insufficient_privilege using message = 'Access to this document vault is required.';
  end if;
end
$$;

create function public.service_begin_hr_document_upload(
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
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
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

  select * into vault_record from private.hr_document_vaults vault
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
    select * into document_record from private.hr_documents document
    where document.id = target_document_id and document.archived_at is null for update;
    if document_record.id is null then raise no_data_found using message = 'The document was not found.'; end if;
    if document_record.vault_code <> target_vault_code then
      raise check_violation using message = 'Replacement versions must remain in the same vault.';
    end if;
    select coalesce(max(version.version_number), 0) + 1 into version_number
    from private.hr_document_versions version where version.document_id = document_record.id;
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
    request_id, idempotency_key, state, quarantined_at
  ) values (
    target_actor_id, document_record.id, version_id, target_vault_code, vault_record.storage_bucket,
    object_key, nullif(btrim(target_request_id), ''), target_idempotency_key, 'quarantined', clock_timestamp()
  ) returning id into operation_id;

  perform private.record_hr_document_scan(version_id, 'quarantined', 'SygShift upload boundary', null, null, null, 'Awaiting malware scan.');
  insert into private.hr_document_access_events (
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    document_record.id, version_id, 'upload', target_actor_id, nullif(btrim(target_request_id), ''),
    'Quarantined upload created.', jsonb_build_object('operationId', operation_id, 'state', 'quarantined')
  );

  return jsonb_build_object(
    'operationId', operation_id, 'documentId', document_record.id, 'versionId', version_id,
    'bucket', vault_record.storage_bucket, 'objectKey', object_key, 'state', 'quarantined'
  );
end
$$;

create function public.service_mark_hr_document_upload_stored(
  target_operation_id uuid,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare operation_record private.hr_document_upload_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  update private.hr_document_upload_operations operation
  set state = 'stored', stored_at = clock_timestamp()
  where operation.id = target_operation_id and operation.state = 'quarantined'
  returning * into operation_record;
  if operation_record.id is null then raise check_violation using message = 'The upload is not ready to be stored.'; end if;
  update private.hr_document_upload_operations operation
  set state = 'scan_pending', scan_requested_at = clock_timestamp()
  where operation.id = target_operation_id;
  perform private.record_hr_document_scan(operation_record.version_id, 'scan_pending', 'SygShift malware scanner', null, null, null, 'Object stored in private quarantine.');
  return jsonb_build_object('operationId', target_operation_id, 'state', 'scan_pending', 'requestId', nullif(btrim(target_request_id), ''));
end
$$;

create function public.service_fail_hr_document_upload(
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
declare operation_record private.hr_document_upload_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if target_state not in ('scan_error','rejected','cancelled') then raise check_violation using message = 'Unsupported failure state.'; end if;
  if btrim(coalesce(target_failure_code, '')) = '' then raise check_violation using message = 'A failure code is required.'; end if;
  update private.hr_document_upload_operations operation
  set state = target_state, failure_code = target_failure_code, failure_detail = target_failure_detail
  where operation.id = target_operation_id and operation.state not in ('clean','rejected','cancelled')
  returning * into operation_record;
  if operation_record.id is null then raise check_violation using message = 'The upload can no longer be changed.'; end if;
  perform private.record_hr_document_scan(operation_record.version_id,
    case when target_state = 'rejected' then 'rejected' else 'scan_error' end,
    'SygShift malware scanner', null, null, null, target_failure_detail);
  return jsonb_build_object('operationId', target_operation_id, 'state', target_state);
end
$$;

create function public.service_record_hr_document_scan_result(
  target_operation_id uuid,
  target_state text,
  target_scanner_name text,
  target_scanner_version text,
  target_signature_reference text,
  target_evidence_sha256 text,
  target_details text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare operation_record private.hr_document_upload_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if target_state not in ('clean','rejected','scan_error') then raise check_violation using message = 'Unsupported scan result.'; end if;
  if target_state = 'clean' and target_evidence_sha256 !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'Clean scan results require SHA-256 evidence.';
  end if;
  update private.hr_document_upload_operations operation
  set state = target_state,
      failure_code = case when target_state = 'clean' then null else 'malware_scan_' || target_state end,
      failure_detail = case when target_state = 'clean' then null else target_details end
  where operation.id = target_operation_id and operation.state in ('scan_pending','scan_error')
  returning * into operation_record;
  if operation_record.id is null then raise check_violation using message = 'The upload is not awaiting a scan result.'; end if;
  perform private.record_hr_document_scan(
    operation_record.version_id, target_state, target_scanner_name, target_scanner_version,
    target_signature_reference, target_evidence_sha256, target_details
  );
  insert into private.hr_document_access_events (
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    operation_record.document_id, operation_record.version_id,
    case when target_state = 'clean' then 'scan_release' else 'scan_reject' end,
    operation_record.actor_employee_id, operation_record.request_id,
    coalesce(target_details, 'Malware scan result recorded.'),
    jsonb_build_object('operationId', target_operation_id, 'state', target_state, 'scanner', target_scanner_name)
  );
  return jsonb_build_object('operationId', target_operation_id, 'state', target_state);
end
$$;

create function public.service_verify_security_key_document_mfa(
  target_actor_id uuid,
  target_auth_session_id uuid,
  target_token_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare verified_at timestamptz;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if target_token_hash !~ '^[a-f0-9]{64}$' then raise insufficient_privilege using message = 'Security-key verification failed.'; end if;
  select security_session.created_at into verified_at
  from private.security_key_sessions security_session
  where security_session.employee_id = target_actor_id
    and security_session.auth_session_id = target_auth_session_id
    and security_session.token_hash = target_token_hash
    and security_session.revoked_at is null
    and security_session.expires_at > clock_timestamp()
    and security_session.created_at >= clock_timestamp() - interval '15 minutes'
  limit 1;
  if verified_at is null then raise insufficient_privilege using message = 'A recent security-key verification is required.'; end if;
  return jsonb_build_object('method', 'security_key', 'verifiedAt', verified_at);
end
$$;

create function public.service_issue_hr_document_access_grant(
  target_actor_id uuid,
  target_document_id uuid,
  target_action text,
  target_token_hash text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_reason text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  document_record private.hr_documents%rowtype;
  grant_id uuid;
  expires_at timestamptz := clock_timestamp() + interval '60 seconds';
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then
    raise insufficient_privilege using message = 'The HR document workspace has not been released.';
  end if;
  if target_action not in ('preview','view','download') then raise check_violation using message = 'Unsupported document access action.'; end if;
  if target_mfa_method not in ('authenticator','security_key')
    or target_mfa_verified_at < clock_timestamp() - interval '15 minutes'
    or target_mfa_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = 'A recent MFA verification is required.';
  end if;
  if target_token_hash !~ '^[a-f0-9]{64}$' then raise check_violation using message = 'The access token is invalid.'; end if;
  if btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'An access reason is required.'; end if;

  select * into document_record
  from private.hr_documents document
  where document.id = target_document_id and document.archived_at is null;
  if document_record.id is null or document_record.current_version_id is null then raise no_data_found using message = 'The document is unavailable.'; end if;
  perform private.service_require_hr_document_permission(target_actor_id, document_record.vault_code, 'view');
  if private.hr_document_latest_scan_state(document_record.current_version_id) <> 'clean' then
    raise insufficient_privilege using message = 'The document has not passed malware scanning.';
  end if;

  insert into private.hr_document_access_grants (
    token_hash, actor_employee_id, document_id, version_id, action, mfa_method,
    mfa_verified_at, reason, request_id, expires_at
  ) values (
    target_token_hash, target_actor_id, document_record.id, document_record.current_version_id,
    target_action, target_mfa_method, target_mfa_verified_at, target_reason,
    nullif(btrim(target_request_id), ''), expires_at
  ) returning id into grant_id;
  return jsonb_build_object('grantId', grant_id, 'expiresAt', expires_at);
end
$$;

create function public.service_consume_hr_document_access_grant(
  target_actor_id uuid,
  target_token_hash text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  grant_record private.hr_document_access_grants%rowtype;
  version_record private.hr_document_versions%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then
    raise insufficient_privilege using message = 'The HR document workspace has not been released.';
  end if;
  update private.hr_document_access_grants access_grant
  set consumed_at = clock_timestamp()
  where access_grant.actor_employee_id = target_actor_id
    and access_grant.token_hash = target_token_hash
    and access_grant.consumed_at is null
    and access_grant.expires_at > clock_timestamp()
  returning * into grant_record;
  if grant_record.id is null then raise insufficient_privilege using message = 'The document access link is invalid or expired.'; end if;

  if not exists (
    select 1
    from private.hr_documents document
    where document.id = grant_record.document_id
      and document.archived_at is null
      and document.current_version_id = grant_record.version_id
  ) then
    raise insufficient_privilege using message = 'The document access link is no longer current.';
  end if;
  perform private.service_require_hr_document_permission(
    grant_record.actor_employee_id,
    (select document.vault_code from private.hr_documents document where document.id = grant_record.document_id),
    'view'
  );
  select * into version_record from private.hr_document_versions version where version.id = grant_record.version_id;
  if private.hr_document_latest_scan_state(grant_record.version_id) <> 'clean' then
    raise insufficient_privilege using message = 'The document is no longer available.';
  end if;
  insert into private.hr_document_access_events (
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    grant_record.document_id, grant_record.version_id, grant_record.action,
    grant_record.actor_employee_id, coalesce(nullif(btrim(target_request_id), ''), grant_record.request_id),
    grant_record.reason, jsonb_build_object('grantId', grant_record.id, 'mfaMethod', grant_record.mfa_method)
  );
  return jsonb_build_object(
    'documentId', grant_record.document_id, 'versionId', grant_record.version_id,
    'action', grant_record.action, 'bucket', version_record.storage_bucket,
    'objectKey', version_record.object_key, 'filename', version_record.sanitized_filename,
    'mimeType', version_record.detected_mime_type
  );
end
$$;

revoke all on private.hr_document_upload_operations, private.hr_document_access_grants from public, anon, authenticated;
grant select, insert, update on private.hr_document_upload_operations, private.hr_document_access_grants to service_role;

revoke all on function private.service_require_hr_document_permission(uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_begin_hr_document_upload(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, bigint, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_mark_hr_document_upload_stored(uuid, text) from public, anon, authenticated;
revoke all on function public.service_fail_hr_document_upload(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.service_record_hr_document_scan_result(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.service_verify_security_key_document_mfa(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.service_issue_hr_document_access_grant(uuid, uuid, text, text, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.service_consume_hr_document_access_grant(uuid, text, text) from public, anon, authenticated;

grant execute on function public.service_begin_hr_document_upload(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, bigint, text, uuid, text, text) to service_role;
grant execute on function public.service_mark_hr_document_upload_stored(uuid, text) to service_role;
grant execute on function public.service_fail_hr_document_upload(uuid, text, text, text) to service_role;
grant execute on function public.service_record_hr_document_scan_result(uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.service_verify_security_key_document_mfa(uuid, uuid, text) to service_role;
grant execute on function public.service_issue_hr_document_access_grant(uuid, uuid, text, text, text, timestamptz, text, text) to service_role;
grant execute on function public.service_consume_hr_document_access_grant(uuid, text, text) to service_role;

-- Run 2 deliberately leaves production access disabled.
update private.hr_document_release_gate
set enabled = false, enabled_at = null, enabled_by = null, evidence_reference = null, updated_at = clock_timestamp()
where singleton;

do $$
declare baseline hris_stage4_run2_preservation_baseline%rowtype;
begin
  select * into baseline from hris_stage4_run2_preservation_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.account_count <> (select count(*) from private.employee_accounts)
    or baseline.person_identifier_count <> (select count(*) from private.hr_person_identifiers)
    or baseline.worker_identifier_count <> (select count(*) from private.hr_worker_identifiers) then
    raise exception 'HRIS Stage 4 run 2 changed preserved identity or access records.';
  end if;
  if exists (select 1 from private.hr_document_release_gate where singleton and enabled) then
    raise exception 'HR document release gate must remain disabled after run 2.';
  end if;
end
$$;

commit;
