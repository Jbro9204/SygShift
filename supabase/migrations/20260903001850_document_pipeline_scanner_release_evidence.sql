begin;

-- Production document scanning is asynchronous. These columns provide a
-- bounded retry audit without weakening the existing state-transition guard.
alter table private.hr_document_upload_operations
  add column scan_attempt_count integer not null default 0,
  add column last_scan_attempt_at timestamptz,
  add constraint hr_document_upload_scan_attempt_count_nonnegative
    check (scan_attempt_count >= 0);

create table private.document_pipeline_release_evidence (
  id uuid primary key default gen_random_uuid(),
  canary_run_id uuid not null,
  evidence_type text not null,
  evidence_sha256 text not null,
  scanner_name text,
  scanner_version text,
  details jsonb not null default '{}'::jsonb,
  verified_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  created_at timestamptz not null default clock_timestamp(),
  constraint document_pipeline_release_evidence_type check (
    evidence_type in ('scanner_clean','scanner_reject','storage_recovery')
  ),
  constraint document_pipeline_release_evidence_digest check (
    evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint document_pipeline_release_evidence_scanner check (
    evidence_type = 'storage_recovery'
    or (
      btrim(coalesce(scanner_name, '')) <> ''
      and btrim(coalesce(scanner_version, '')) <> ''
    )
  ),
  constraint document_pipeline_release_evidence_expiry check (expires_at > verified_at),
  unique (canary_run_id, evidence_type)
);

create index document_pipeline_release_evidence_current_idx
  on private.document_pipeline_release_evidence(canary_run_id, expires_at desc, verified_at desc);

create trigger document_pipeline_release_evidence_append_only
before update or delete on private.document_pipeline_release_evidence
for each row execute function private.prevent_append_only_change();

create or replace function public.service_claim_hr_document_scan(
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
  version_record private.hr_document_versions%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select * into operation_record
  from private.hr_document_upload_operations operation
  where operation.id = target_operation_id
  for update;

  if operation_record.id is null then
    raise no_data_found using message = 'The document scan operation was not found.';
  end if;

  if operation_record.state in ('clean','rejected','cancelled') then
    return jsonb_build_object(
      'operationId', operation_record.id,
      'state', operation_record.state,
      'terminal', true
    );
  end if;

  if operation_record.state not in ('scan_pending','scan_error') then
    raise check_violation using message = 'The upload is not ready for malware scanning.';
  end if;

  if operation_record.state = 'scan_error' then
    update private.hr_document_upload_operations operation
    set state = 'scan_pending', failure_code = null, failure_detail = null
    where operation.id = target_operation_id;
  end if;

  update private.hr_document_upload_operations operation
  set scan_attempt_count = operation.scan_attempt_count + 1,
      last_scan_attempt_at = clock_timestamp(),
      request_id = coalesce(nullif(btrim(target_request_id), ''), operation.request_id)
  where operation.id = target_operation_id
  returning * into operation_record;

  select * into version_record
  from private.hr_document_versions version
  where version.id = operation_record.version_id;

  return jsonb_build_object(
    'operationId', operation_record.id,
    'documentId', operation_record.document_id,
    'versionId', operation_record.version_id,
    'bucket', operation_record.storage_bucket,
    'objectKey', operation_record.object_key,
    'state', operation_record.state,
    'terminal', false,
    'attemptCount', operation_record.scan_attempt_count,
    'expectedChecksum', version_record.sha256_checksum,
    'expectedSizeBytes', version_record.size_bytes,
    'mimeType', version_record.detected_mime_type
  );
end
$$;

create or replace function public.service_record_document_pipeline_release_evidence(
  target_canary_run_id uuid,
  target_evidence_type text,
  target_evidence_sha256 text,
  target_scanner_name text default null,
  target_scanner_version text default null,
  target_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare evidence_record private.document_pipeline_release_evidence%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_evidence_type not in ('scanner_clean','scanner_reject','storage_recovery') then
    raise check_violation using message = 'Unsupported document release evidence type.';
  end if;
  if target_evidence_sha256 !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'Release evidence requires a SHA-256 digest.';
  end if;

  insert into private.document_pipeline_release_evidence (
    canary_run_id, evidence_type, evidence_sha256, scanner_name, scanner_version, details
  ) values (
    target_canary_run_id,
    target_evidence_type,
    target_evidence_sha256,
    nullif(btrim(target_scanner_name), ''),
    nullif(btrim(target_scanner_version), ''),
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

alter table private.document_pipeline_release_evidence enable row level security;
revoke all on private.document_pipeline_release_evidence from public, anon, authenticated;
grant select, insert on private.document_pipeline_release_evidence to service_role;

revoke all on function public.service_claim_hr_document_scan(uuid,text) from public, anon, authenticated;
revoke all on function public.service_record_document_pipeline_release_evidence(uuid,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.service_claim_hr_document_scan(uuid,text) to service_role;
grant execute on function public.service_record_document_pipeline_release_evidence(uuid,text,text,text,text,jsonb) to service_role;

comment on table private.document_pipeline_release_evidence is
  'Append-only scanner and private-storage recovery canary evidence required before the protected document workspace can be released.';

commit;
