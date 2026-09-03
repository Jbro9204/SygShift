begin;

do $$
declare
  release_actor_id uuid;
  release_canary_id uuid;
  retention_id uuid;
begin
  select account.employee_id into release_actor_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where lower(account.username) = 'jbrown'
    and account.disabled_at is null
    and employee.status in ('active','leave')
  limit 1;

  if release_actor_id is null then
    raise check_violation using message = 'The authorized document release owner was not found.';
  end if;

  select evidence.canary_run_id into release_canary_id
  from private.document_pipeline_release_evidence evidence
  where evidence.expires_at > clock_timestamp()
    and evidence.verified_at >= clock_timestamp() - interval '2 hours'
  group by evidence.canary_run_id
  having count(*) filter (where evidence.evidence_type = 'scanner_clean') = 1
     and count(*) filter (where evidence.evidence_type = 'scanner_reject') = 1
     and count(*) filter (where evidence.evidence_type = 'storage_recovery') = 1
  order by max(evidence.verified_at) desc
  limit 1;

  if release_canary_id is null then
    raise check_violation using message = 'A current clean-file, malware-rejection, and private-storage recovery canary is required.';
  end if;

  update private.hr_document_release_gate
  set enabled = true,
      enabled_at = clock_timestamp(),
      enabled_by = release_actor_id,
      evidence_reference = 'document-pipeline-canary:' || release_canary_id::text,
      updated_at = clock_timestamp()
  where singleton;

  update private.document_studio_release_gate
  set enabled = true,
      enabled_at = clock_timestamp(),
      enabled_by = release_actor_id,
      evidence_reference = 'document-pipeline-canary:' || release_canary_id::text,
      updated_at = clock_timestamp()
  where gate in ('workspace','processing','signatures');

  -- These capabilities remain fail-closed until their distinct legal,
  -- rendering, and identity controls exist. Core Document Studio does not
  -- imply that these future capabilities have been released.
  update private.document_studio_release_gate
  set enabled = false,
      enabled_at = null,
      enabled_by = null,
      evidence_reference = null,
      updated_at = clock_timestamp()
  where gate in ('advanced_editing','regulated_documents','external_signers','organizational_seal');

  select policy.id into retention_id
  from private.hr_document_retention_policies policy
  where policy.code = 'MANUAL_REVIEW' and policy.active
  limit 1;

  if retention_id is null then
    raise check_violation using message = 'The document retention policy is unavailable.';
  end if;

  insert into private.document_policies (
    policy_code,
    version_number,
    name,
    document_category,
    jurisdiction,
    execution_method,
    electronic_signature_permitted,
    authentication_tier,
    routing_mode,
    consent_text,
    consent_version,
    signer_roles,
    reminder_schedule,
    expiration_days,
    retention_policy_id,
    requires_initials,
    requires_witness,
    requires_countersignature,
    allows_external_signers,
    allows_decline,
    allows_correction_request,
    completed_pdf_required,
    audit_certificate_required,
    organizational_seal_required,
    download_restricted,
    printing_restricted,
    regulated,
    active,
    published_at,
    created_by
  ) values (
    'STANDARD_EMPLOYEE_ELECTRONIC_SIGNATURE',
    1,
    'Standard employee electronic signature',
    'general_hr',
    'US',
    'electronic',
    true,
    'standard',
    'sequential',
    'I agree to use an electronic signature for this document and understand that it has the same effect as my handwritten signature.',
    '1.0',
    '[{"code":"employee","name":"Employee"}]'::jsonb,
    '[1,3,7]'::jsonb,
    30,
    retention_id,
    false,
    false,
    false,
    false,
    true,
    true,
    true,
    true,
    false,
    false,
    false,
    true,
    clock_timestamp(),
    release_actor_id
  )
  on conflict (organization_code, policy_code, version_number) do nothing;
end
$$;

commit;
