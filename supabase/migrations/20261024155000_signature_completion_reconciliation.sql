begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Read the authoritative recipient/event state before allocating a new
-- appearance and after a possibly lost action response. This lets the Worker
-- distinguish the appearance referenced by the completed event from an
-- unreferenced concurrent upload without guessing.
create or replace function public.service_get_signature_action_state(
  target_actor_id uuid,
  target_recipient_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  recipient_record private.signature_recipients%rowtype;
  envelope_record private.signature_envelopes%rowtype;
  event_record private.signature_events%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select recipient.*
  into recipient_record
  from private.signature_recipients recipient
  where recipient.id = target_recipient_id
    and recipient.employee_id = target_actor_id;
  if not found then
    raise no_data_found using message = 'The assigned signature action was not found.';
  end if;

  select envelope.*
  into envelope_record
  from private.signature_envelopes envelope
  where envelope.id = recipient_record.envelope_id;

  select event.*
  into event_record
  from private.signature_events event
  where event.recipient_id = recipient_record.id
    and event.signature_method is not null
  order by event.occurred_at desc, event.id desc
  limit 1;

  return jsonb_build_object(
    'recipientId', recipient_record.id,
    'envelopeId', envelope_record.id,
    'recipientStatus', recipient_record.status,
    'status', envelope_record.status,
    'completed', recipient_record.status = 'completed',
    'finalizationRequired', envelope_record.status = 'finalizing',
    'eventId', event_record.id,
    'appearanceBucket', event_record.appearance_bucket,
    'appearanceObjectKey', event_record.appearance_object_key,
    'appearanceChecksum', event_record.appearance_checksum
  );
end
$$;

-- Finalization storage is written before the database transaction. A response
-- can be lost after commit, so expose the immutable database references needed
-- to prove whether the exact PDF and certificate became authoritative.
create or replace function public.service_get_signature_finalization_state(
  target_envelope_id uuid,
  target_job_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  envelope_record private.signature_envelopes%rowtype;
  job_record private.document_processing_jobs%rowtype;
  version_record private.hr_document_versions%rowtype;
  certificate_record private.signature_audit_certificates%rowtype;
begin
  perform private.document_studio_require_service();

  select envelope.*
  into envelope_record
  from private.signature_envelopes envelope
  where envelope.id = target_envelope_id;
  if not found then
    raise no_data_found using message = 'The signature envelope was not found.';
  end if;

  select job.*
  into job_record
  from private.document_processing_jobs job
  where job.id = target_job_id
    and job.envelope_id = envelope_record.id;
  if not found then
    raise no_data_found using message = 'The signature finalization job was not found.';
  end if;

  if envelope_record.final_document_version_id is not null then
    select version.*
    into version_record
    from private.hr_document_versions version
    where version.id = envelope_record.final_document_version_id;
  end if;

  select certificate.*
  into certificate_record
  from private.signature_audit_certificates certificate
  where certificate.envelope_id = envelope_record.id
  order by certificate.generated_at desc, certificate.id desc
  limit 1;

  return jsonb_build_object(
    'envelopeId', envelope_record.id,
    'envelopeStatus', envelope_record.status,
    'jobId', job_record.id,
    'jobStatus', job_record.status,
    'finalVersionId', envelope_record.final_document_version_id,
    'finalBucket', version_record.storage_bucket,
    'finalObjectKey', version_record.object_key,
    'finalChecksum', version_record.sha256_checksum,
    'auditBucket', certificate_record.storage_bucket,
    'auditObjectKey', certificate_record.object_key,
    'auditChecksum', certificate_record.checksum
  );
end
$$;

revoke all on function public.service_get_signature_action_state(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_get_signature_finalization_state(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.service_get_signature_action_state(uuid, uuid)
  to service_role;
grant execute on function public.service_get_signature_finalization_state(uuid, uuid)
  to service_role;

commit;
