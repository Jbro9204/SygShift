begin;

-- The enterprise Document Studio extends the existing private HR document
-- vault, immutable version, quarantine, one-time access, and audit controls.
-- It intentionally does not enable the document release gate or the Worker
-- feature switch. Production upload remains closed until the external malware
-- scanner, restore drill, and controlled canary have been completed.

create temporary table document_studio_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.employee_permission_overrides) as permission_override_count,
  (select count(*) from private.hr_documents) as document_count,
  (select count(*) from private.hr_document_versions) as document_version_count,
  (select count(*) from private.hr_document_access_events) as document_access_event_count;

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  ('documents.workspace.view', 'Documents & Signatures', 'View Document Studio', 'Open Document Studio and view authorized document, template, workflow, and signature summaries.', 'sensitive', true, true, true),
  ('documents.upload', 'Documents & Signatures', 'Upload documents', 'Upload approved source documents through the protected quarantine pipeline.', 'critical', true, true, true),
  ('documents.create', 'Documents & Signatures', 'Create documents', 'Create controlled Document Studio records and working versions.', 'critical', true, true, true),
  ('documents.edit.responses', 'Documents & Signatures', 'Edit document responses', 'Complete and correct assigned document fields before finalization.', 'sensitive', true, true, true),
  ('documents.edit.pdf', 'Documents & Signatures', 'Edit PDF content', 'Use approved PDF content and page-editing operations.', 'critical', true, true, true),
  ('documents.templates.manage', 'Documents & Signatures', 'Manage document templates', 'Create, version, test, publish, and deactivate document templates and mapped fields.', 'critical', true, true, true),
  ('documents.link.manage', 'Documents & Signatures', 'Link documents to records', 'Associate one canonical document with authorized employee, client, site, post, shift, patrol, and workflow records.', 'critical', true, true, true),
  ('documents.download', 'Documents & Signatures', 'Download documents', 'Download authorized originals, working versions, signed copies, and audit certificates.', 'sensitive', true, true, true),
  ('documents.print', 'Documents & Signatures', 'Print documents', 'Print authorized protected documents with an audited business reason.', 'sensitive', true, true, true),
  ('documents.comments.manage', 'Documents & Signatures', 'Manage document comments', 'Create, reply to, mention, and resolve document review comments.', 'sensitive', true, true, true),
  ('documents.redact', 'Documents & Signatures', 'Apply document redactions', 'Apply verified irreversible redactions through an approved processing engine.', 'critical', true, true, true),
  ('documents.signatures.request', 'Documents & Signatures', 'Request signatures', 'Prepare and send signature envelopes to authorized recipients.', 'critical', true, true, true),
  ('documents.signatures.sign_own', 'Documents & Signatures', 'Sign assigned documents', 'Review and sign only document fields assigned to the signed-in person.', 'sensitive', false, true, true),
  ('documents.signatures.manage', 'Documents & Signatures', 'Manage signature envelopes', 'Send reminders, correct recipient assignments, void envelopes, and review execution status.', 'critical', true, true, true),
  ('documents.review', 'Documents & Signatures', 'Review documents', 'Review assigned documents and return them for correction.', 'sensitive', true, true, true),
  ('documents.approve', 'Documents & Signatures', 'Approve documents', 'Record an assigned document approval with required evidence.', 'critical', true, true, true),
  ('documents.versions.manage', 'Documents & Signatures', 'Manage document versions', 'Create named versions, compare versions, and restore an earlier version as a new controlled version.', 'critical', true, true, true),
  ('documents.archive', 'Documents & Signatures', 'Archive documents', 'Archive or deactivate documents without destroying history.', 'critical', true, true, true),
  ('documents.audit.view', 'Documents & Signatures', 'View document audit history', 'Review document, signature, access, lifecycle, and retention evidence.', 'critical', true, true, true),
  ('documents.audit.export', 'Documents & Signatures', 'Export document audit evidence', 'Export authorized signature certificates and document audit packages.', 'critical', true, true, true),
  ('documents.retention.manage', 'Documents & Signatures', 'Manage document retention', 'Manage retention policies and disposition review.', 'critical', true, true, true),
  ('documents.legal_hold.manage', 'Documents & Signatures', 'Manage document legal holds', 'Apply and release legal holds with protected approval evidence.', 'critical', true, true, true),
  ('documents.policies.manage', 'Documents & Signatures', 'Manage document policies', 'Version document execution, authentication, signer, retention, and jurisdiction policies.', 'critical', true, true, true),
  ('documents.regulated.manage', 'Documents & Signatures', 'Manage regulated documents', 'Access approved regulated-document workflows after compliance release.', 'critical', true, true, true),
  ('documents.seals.manage', 'Documents & Signatures', 'Manage organizational seals', 'Manage approved organizational signing certificate configuration without exposing private keys.', 'critical', true, true, true)
on conflict (code) do update set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  locked = excluded.locked,
  active = true,
  updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code = 'system_admin'
  and permission.code like 'documents.%'
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code = 'human_resources'
  and permission.code like 'documents.%'
  and permission.code <> 'documents.seals.manage'
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code = 'human_resources_employee'
  and permission.code in (
    'documents.workspace.view', 'documents.upload', 'documents.create', 'documents.edit.responses',
    'documents.templates.manage', 'documents.link.manage', 'documents.download', 'documents.print',
    'documents.comments.manage', 'documents.signatures.request', 'documents.signatures.sign_own',
    'documents.signatures.manage', 'documents.review', 'documents.approve',
    'documents.versions.manage', 'documents.archive', 'documents.audit.view'
  )
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, 'documents.signatures.sign_own', true
from public.access_roles role
where role.code in (
  'system_guard', 'system_dispatcher', 'system_scheduler', 'system_recruiting_licensing',
  'system_supervisor', 'operations_manager'
)
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

create table private.document_studio_release_gate (
  gate text primary key,
  enabled boolean not null default false,
  enabled_at timestamptz,
  enabled_by uuid references public.employees(id) on delete restrict,
  evidence_reference text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint document_studio_gate_name check (gate in ('workspace','processing','signatures','advanced_editing','regulated_documents','external_signers','organizational_seal')),
  constraint document_studio_gate_evidence check (
    (not enabled and enabled_at is null and enabled_by is null)
    or (enabled and enabled_at is not null and enabled_by is not null and btrim(coalesce(evidence_reference,'')) <> '')
  )
);

insert into private.document_studio_release_gate(gate, enabled)
values
  ('workspace', false), ('processing', false), ('signatures', false),
  ('advanced_editing', false), ('regulated_documents', false),
  ('external_signers', false), ('organizational_seal', false);

create table private.document_policies (
  id uuid primary key default gen_random_uuid(),
  organization_code text not null default 'guardianship-security',
  policy_code text not null,
  version_number integer not null,
  name text not null,
  document_category text not null,
  jurisdiction text not null default 'US',
  execution_method text not null default 'electronic',
  electronic_signature_permitted boolean not null default true,
  authentication_tier text not null default 'standard',
  routing_mode text not null default 'sequential',
  consent_text text not null,
  consent_version text not null,
  signer_roles jsonb not null default '[]'::jsonb,
  reminder_schedule jsonb not null default '[]'::jsonb,
  expiration_days integer,
  retention_policy_id uuid not null references private.hr_document_retention_policies(id) on delete restrict,
  requires_initials boolean not null default false,
  requires_witness boolean not null default false,
  requires_countersignature boolean not null default false,
  allows_external_signers boolean not null default false,
  allows_decline boolean not null default true,
  allows_correction_request boolean not null default true,
  completed_pdf_required boolean not null default true,
  audit_certificate_required boolean not null default true,
  organizational_seal_required boolean not null default false,
  download_restricted boolean not null default false,
  printing_restricted boolean not null default false,
  regulated boolean not null default false,
  active boolean not null default true,
  published_at timestamptz,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint document_policy_code_format check (policy_code ~ '^[A-Z][A-Z0-9_-]{2,79}$'),
  constraint document_policy_version_positive check (version_number > 0),
  constraint document_policy_name_present check (btrim(name) <> '' and char_length(name) <= 160),
  constraint document_policy_category_present check (btrim(document_category) <> '' and char_length(document_category) <= 100),
  constraint document_policy_execution_method check (execution_method in ('fill_only','review','acknowledge','approve','certify','electronic','external','paper','not_eligible')),
  constraint document_policy_authentication_tier check (authentication_tier in ('standard','elevated','specialized')),
  constraint document_policy_routing_mode check (routing_mode in ('sequential','parallel')),
  constraint document_policy_expiration_days check (expiration_days is null or expiration_days between 1 and 3650),
  unique (organization_code, policy_code, version_number)
);

create unique index document_policy_one_active_version_idx
  on private.document_policies(organization_code, policy_code)
  where active;

create table private.document_templates (
  id uuid primary key default gen_random_uuid(),
  organization_code text not null default 'guardianship-security',
  template_code text not null,
  name text not null,
  description text,
  category text not null,
  status text not null default 'draft',
  current_version_id uuid,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deactivated_at timestamptz,
  deactivated_by uuid references public.employees(id) on delete restrict,
  constraint document_template_code_format check (template_code ~ '^[A-Z][A-Z0-9_-]{2,79}$'),
  constraint document_template_name_present check (btrim(name) <> '' and char_length(name) <= 180),
  constraint document_template_category_present check (btrim(category) <> '' and char_length(category) <= 100),
  constraint document_template_status check (status in ('draft','published','deactivated')),
  unique (organization_code, template_code)
);

create table private.document_template_versions (
  id uuid primary key default gen_random_uuid(),
  organization_code text not null default 'guardianship-security',
  template_id uuid not null references private.document_templates(id) on delete restrict,
  version_number integer not null,
  source_document_id uuid not null references private.hr_documents(id) on delete restrict,
  source_version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  policy_id uuid not null references private.document_policies(id) on delete restrict,
  status text not null default 'draft',
  change_reason text not null,
  checksum text not null,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  constraint document_template_version_positive check (version_number > 0),
  constraint document_template_version_status check (status in ('draft','published','superseded')),
  constraint document_template_version_reason check (btrim(change_reason) <> ''),
  constraint document_template_version_checksum check (checksum ~ '^[a-f0-9]{64}$'),
  unique (template_id, version_number)
);

alter table private.document_templates
  add constraint document_templates_current_version_fk
  foreign key (current_version_id) references private.document_template_versions(id) on delete restrict;

create table private.document_field_definitions (
  id uuid primary key default gen_random_uuid(),
  template_version_id uuid not null references private.document_template_versions(id) on delete restrict,
  field_key text not null,
  field_type text not null,
  label text not null,
  description text,
  page_number integer not null,
  x_ratio numeric(8,6) not null,
  y_ratio numeric(8,6) not null,
  width_ratio numeric(8,6) not null,
  height_ratio numeric(8,6) not null,
  tab_order integer not null,
  required boolean not null default false,
  read_only boolean not null default false,
  signer_role_code text,
  semantic_mapping text,
  display_format text,
  authoritative boolean not null default false,
  sensitive boolean not null default false,
  downloadable boolean not null default true,
  validation_rules jsonb not null default '{}'::jsonb,
  options jsonb not null default '[]'::jsonb,
  conditional_rules jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint document_field_key_format check (field_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  constraint document_field_type check (field_type in ('text','multiline','number','currency','date','time','email','phone','address','checkbox','radio','dropdown','initials','signature','signer_date','employee','client','site','post','shift_assignment','file_attachment','acknowledgment','system_value')),
  constraint document_field_label_present check (btrim(label) <> '' and char_length(label) <= 180),
  constraint document_field_page_positive check (page_number > 0),
  constraint document_field_ratios check (x_ratio between 0 and 1 and y_ratio between 0 and 1 and width_ratio > 0 and width_ratio <= 1 and height_ratio > 0 and height_ratio <= 1 and x_ratio + width_ratio <= 1.000001 and y_ratio + height_ratio <= 1.000001),
  constraint document_field_tab_order_positive check (tab_order > 0),
  unique (template_version_id, field_key),
  unique (template_version_id, tab_order)
);

create table private.document_associations (
  id uuid primary key default gen_random_uuid(),
  organization_code text not null default 'guardianship-security',
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  entity_type text not null,
  entity_id uuid not null,
  relationship_type text not null default 'related',
  primary_association boolean not null default false,
  visibility_classification text not null,
  linked_by uuid not null references public.employees(id) on delete restrict,
  linked_at timestamptz not null default clock_timestamp(),
  unlinked_at timestamptz,
  unlinked_by uuid references public.employees(id) on delete restrict,
  unlink_reason text,
  constraint document_association_entity_type check (entity_type in ('employee','client','site','post','shift','assignment','credential','patrol_route','patrol_hit','event','time_off','payroll','case','training','contract','other')),
  constraint document_association_relationship check (relationship_type in ('primary','related','evidence','source','attachment','completion','audit')),
  constraint document_association_visibility check (visibility_classification in ('confidential','restricted','highly_restricted')),
  constraint document_association_unlink_consistent check ((unlinked_at is null and unlinked_by is null and unlink_reason is null) or (unlinked_at is not null and unlinked_by is not null and btrim(coalesce(unlink_reason,'')) <> ''))
);

create unique index document_association_active_unique_idx
  on private.document_associations(document_id, entity_type, entity_id, relationship_type)
  where unlinked_at is null;

create unique index document_association_primary_unique_idx
  on private.document_associations(document_id)
  where primary_association and unlinked_at is null;

create table private.signature_adoptions (
  id uuid primary key default gen_random_uuid(),
  organization_code text not null default 'guardianship-security',
  employee_id uuid not null references public.employees(id) on delete restrict,
  method text not null,
  style_code text,
  display_name text not null,
  appearance_bucket text,
  appearance_object_key text,
  appearance_checksum text,
  verified_at timestamptz not null,
  authentication_method text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  replaced_at timestamptz,
  constraint signature_adoption_method check (method in ('typed','drawn','uploaded')),
  constraint signature_adoption_style check ((method = 'typed' and style_code in ('executive','modern','classic','simple')) or (method <> 'typed' and style_code is null)),
  constraint signature_adoption_display_name check (btrim(display_name) <> '' and char_length(display_name) <= 200),
  constraint signature_adoption_authentication check (authentication_method in ('authenticator','security_key')),
  constraint signature_adoption_object_consistent check ((method = 'typed' and appearance_bucket is null and appearance_object_key is null and appearance_checksum is null) or (method in ('drawn','uploaded') and appearance_bucket is not null and appearance_object_key is not null and appearance_checksum ~ '^[a-f0-9]{64}$'))
);

create unique index signature_adoption_active_employee_idx
  on private.signature_adoptions(employee_id)
  where active;

create table private.signature_envelopes (
  id uuid primary key default gen_random_uuid(),
  organization_code text not null default 'guardianship-security',
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  document_version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  template_version_id uuid references private.document_template_versions(id) on delete restrict,
  policy_id uuid not null references private.document_policies(id) on delete restrict,
  title text not null,
  status text not null default 'draft',
  routing_mode text not null,
  message text,
  expires_at timestamptz,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  completed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  voided_by uuid references public.employees(id) on delete restrict,
  void_reason text,
  final_document_version_id uuid references private.hr_document_versions(id) on delete restrict,
  final_package_checksum text,
  idempotency_key uuid not null unique,
  constraint signature_envelope_title_present check (btrim(title) <> '' and char_length(title) <= 180),
  constraint signature_envelope_status check (status in ('draft','ready_to_send','sent','delivered','viewed','in_progress','waiting','finalizing','completed','declined','correction_requested','expired','voided','superseded','archived','on_legal_hold','external_process_required')),
  constraint signature_envelope_routing_mode check (routing_mode in ('sequential','parallel')),
  constraint signature_envelope_void_consistent check ((status <> 'voided') or (voided_at is not null and voided_by is not null and btrim(coalesce(void_reason,'')) <> '')),
  constraint signature_envelope_final_consistent check ((status <> 'completed') or (completed_at is not null and final_document_version_id is not null and final_package_checksum ~ '^[a-f0-9]{64}$'))
);

create table private.signature_recipients (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references private.signature_envelopes(id) on delete restrict,
  employee_id uuid references public.employees(id) on delete restrict,
  external_email text,
  external_name text,
  recipient_role text not null,
  required_action text not null,
  routing_order integer not null default 1,
  authentication_tier text not null,
  status text not null default 'pending',
  assigned_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  viewed_at timestamptz,
  acted_at timestamptz,
  decline_reason text,
  correction_reason text,
  reassigned_from uuid references private.signature_recipients(id) on delete restrict,
  constraint signature_recipient_identity check (num_nonnulls(employee_id, external_email) = 1),
  constraint signature_recipient_external_name check (employee_id is not null or btrim(coalesce(external_name,'')) <> ''),
  constraint signature_recipient_action check (required_action in ('fill','review','acknowledge','approve','certify','initial','sign','countersign','witness')),
  constraint signature_recipient_authentication_tier check (authentication_tier in ('standard','elevated','specialized')),
  constraint signature_recipient_status check (status in ('pending','blocked','delivered','viewed','in_progress','completed','declined','correction_requested','expired','voided','reassigned')),
  constraint signature_recipient_order_positive check (routing_order > 0),
  unique (envelope_id, employee_id, recipient_role)
);

create table private.signature_authentication_evidence (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references private.signature_envelopes(id) on delete restrict,
  recipient_id uuid not null references private.signature_recipients(id) on delete restrict,
  employee_id uuid references public.employees(id) on delete restrict,
  authentication_tier text not null,
  authentication_method text not null,
  verified_at timestamptz not null,
  session_reference_hash text,
  request_id text,
  created_at timestamptz not null default clock_timestamp(),
  constraint signature_auth_tier check (authentication_tier in ('standard','elevated','specialized')),
  constraint signature_auth_method check (authentication_method in ('session','authenticator','security_key','external_verification')),
  constraint signature_auth_session_hash check (session_reference_hash is null or session_reference_hash ~ '^[a-f0-9]{64}$')
);

create table private.signature_consent_records (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references private.signature_envelopes(id) on delete restrict,
  recipient_id uuid not null references private.signature_recipients(id) on delete restrict,
  consent_text text not null,
  consent_version text not null,
  shown_at timestamptz not null,
  accepted_at timestamptz not null,
  confirmation_action text not null,
  document_version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  request_id text,
  constraint signature_consent_text_present check (btrim(consent_text) <> ''),
  constraint signature_consent_action_present check (btrim(confirmation_action) <> '')
);

create table private.signature_field_values (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references private.signature_envelopes(id) on delete restrict,
  recipient_id uuid not null references private.signature_recipients(id) on delete restrict,
  field_definition_id uuid references private.document_field_definitions(id) on delete restrict,
  field_key text not null,
  value_text text,
  value_json jsonb,
  authoritative_source text,
  completed_at timestamptz not null default clock_timestamp(),
  constraint signature_field_value_present check (num_nonnulls(value_text, value_json) = 1),
  unique (envelope_id, recipient_id, field_key)
);

create table private.signature_events (
  id uuid primary key default gen_random_uuid(),
  organization_code text not null default 'guardianship-security',
  envelope_id uuid not null references private.signature_envelopes(id) on delete restrict,
  recipient_id uuid references private.signature_recipients(id) on delete restrict,
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  document_version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  actor_employee_id uuid references public.employees(id) on delete restrict,
  event_type text not null,
  event_reason text,
  authentication_evidence_id uuid references private.signature_authentication_evidence(id) on delete restrict,
  consent_record_id uuid references private.signature_consent_records(id) on delete restrict,
  signature_method text,
  signature_style text,
  display_name text,
  appearance_bucket text,
  appearance_object_key text,
  appearance_checksum text,
  source_checksum text not null,
  field_values_checksum text,
  request_id text,
  occurred_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint signature_event_type check (event_type in ('created','recipient_assigned','sent','delivered','viewed','authenticated','consented','field_completed','signed','initialed','acknowledged','approved','certified','declined','correction_requested','reassigned','reminded','expired','voided','superseded','finalization_started','completed','downloaded','printed')),
  constraint signature_event_appearance_consistent check (
    (signature_method is null and appearance_bucket is null and appearance_object_key is null and appearance_checksum is null)
    or (signature_method in ('typed','drawn','uploaded','saved') and appearance_bucket is not null and appearance_object_key is not null and appearance_checksum ~ '^[a-f0-9]{64}$')
  ),
  constraint signature_event_source_checksum check (source_checksum ~ '^[a-f0-9]{64}$'),
  constraint signature_event_field_checksum check (field_values_checksum is null or field_values_checksum ~ '^[a-f0-9]{64}$')
);

create table private.signature_audit_certificates (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null unique references private.signature_envelopes(id) on delete restrict,
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  final_document_version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  storage_bucket text not null,
  object_key text not null,
  filename text not null,
  checksum text not null,
  final_package_checksum text not null,
  seal_status text not null default 'not_configured',
  generated_at timestamptz not null default clock_timestamp(),
  generated_by_service text not null,
  constraint signature_certificate_checksum check (checksum ~ '^[a-f0-9]{64}$' and final_package_checksum ~ '^[a-f0-9]{64}$'),
  constraint signature_certificate_seal_status check (seal_status in ('not_configured','not_required','applied','failed')),
  unique (storage_bucket, object_key)
);

create table private.document_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_code text not null default 'guardianship-security',
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  envelope_id uuid references private.signature_envelopes(id) on delete restrict,
  job_type text not null,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  available_at timestamptz not null default clock_timestamp(),
  leased_at timestamptz,
  lease_owner text,
  completed_at timestamptz,
  failed_at timestamptz,
  last_error_code text,
  result jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  constraint document_processing_job_type check (job_type in ('malware_scan','metadata','form_detection','text_detection','ocr','preview','thumbnail','sanitize','finalize_signature','audit_certificate','redaction','conversion')),
  constraint document_processing_job_status check (status in ('queued','processing','completed','failed','dead_letter','cancelled')),
  constraint document_processing_attempts_nonnegative check (attempt_count >= 0)
);

create table private.document_comments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  parent_comment_id uuid references private.document_comments(id) on delete restrict,
  page_number integer,
  annotation_type text not null default 'comment',
  position jsonb,
  body text not null,
  author_employee_id uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid references public.employees(id) on delete restrict,
  resolution_note text,
  constraint document_comment_type check (annotation_type in ('comment','highlight','underline','strikethrough','drawing','shape','callout','stamp')),
  constraint document_comment_body_present check (btrim(body) <> '' and char_length(body) <= 5000),
  constraint document_comment_page_positive check (page_number is null or page_number > 0),
  constraint document_comment_resolution check ((resolved_at is null and resolved_by is null and resolution_note is null) or (resolved_at is not null and resolved_by is not null and btrim(coalesce(resolution_note,'')) <> ''))
);

create table private.document_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  version_id uuid references private.hr_document_versions(id) on delete restrict,
  actor_employee_id uuid references public.employees(id) on delete restrict,
  from_state text,
  to_state text not null,
  reason text not null,
  request_id text,
  occurred_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint document_lifecycle_to_state check (to_state in ('uploaded','processing','draft','in_review','awaiting_approval','awaiting_signature','completed','locked_final','archived','rejected','returned_for_changes','expired','superseded','quarantined','on_legal_hold','deactivated')),
  constraint document_lifecycle_reason_present check (btrim(reason) <> '')
);

alter table private.hr_documents
  add column reference_number text,
  add column lifecycle_state text not null default 'uploaded',
  add column document_policy_id uuid references private.document_policies(id) on delete restrict,
  add column template_version_id uuid references private.document_template_versions(id) on delete restrict,
  add column record_owner_employee_id uuid references public.employees(id) on delete restrict,
  add column tags text[] not null default '{}'::text[];

alter table private.hr_documents
  add constraint hr_documents_lifecycle_state_check check (lifecycle_state in ('uploaded','processing','draft','in_review','awaiting_approval','awaiting_signature','completed','locked_final','archived','rejected','returned_for_changes','expired','superseded','quarantined','on_legal_hold','deactivated'));

create unique index hr_documents_reference_number_unique_idx
  on private.hr_documents(reference_number)
  where reference_number is not null;

alter table private.hr_document_access_grants
  drop constraint hr_document_access_grant_authorization_source,
  drop constraint hr_document_access_grant_assignment_consistent,
  add column signature_recipient_id uuid references private.signature_recipients(id) on delete restrict,
  add constraint hr_document_access_grant_authorization_source check (authorization_source in ('permission','assignment','signature_recipient')),
  add constraint hr_document_access_grant_subject_consistent check (
    (authorization_source = 'permission' and assignment_id is null and signature_recipient_id is null)
    or (authorization_source = 'assignment' and assignment_id is not null and signature_recipient_id is null)
    or (authorization_source = 'signature_recipient' and assignment_id is null and signature_recipient_id is not null)
  );

create index document_templates_status_idx on private.document_templates(status, updated_at desc);
create index document_template_versions_template_idx on private.document_template_versions(template_id, version_number desc);
create index document_fields_template_page_idx on private.document_field_definitions(template_version_id, page_number, tab_order);
create index document_associations_entity_idx on private.document_associations(entity_type, entity_id, linked_at desc) where unlinked_at is null;
create index signature_envelopes_status_idx on private.signature_envelopes(status, created_at desc);
create index signature_recipients_employee_status_idx on private.signature_recipients(employee_id, status, assigned_at desc) where employee_id is not null;
create index signature_events_envelope_idx on private.signature_events(envelope_id, occurred_at);
create index document_processing_jobs_queue_idx on private.document_processing_jobs(status, available_at) where status in ('queued','failed');
create index document_comments_document_idx on private.document_comments(document_id, version_id, created_at);
create index document_lifecycle_events_document_idx on private.document_lifecycle_events(document_id, occurred_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signature-appearances', 'signature-appearances', false, 1048576, array['image/png','image/jpeg'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create trigger document_templates_updated_at
before update on private.document_templates
for each row execute function private.set_updated_at();

create or replace function private.document_studio_prevent_append_only_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise check_violation using message = format('%s is append-only.', tg_table_name);
end
$$;

create or replace function private.document_studio_guard_template_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise check_violation using message = 'Document template versions cannot be deleted.';
  end if;
  if old.status = 'draft' and new.status = 'published'
    and new.published_at is not null
    and row(new.id,new.organization_code,new.template_id,new.version_number,new.source_document_id,new.source_version_id,
      new.policy_id,new.change_reason,new.checksum,new.created_by,new.created_at)
      is not distinct from
      row(old.id,old.organization_code,old.template_id,old.version_number,old.source_document_id,old.source_version_id,
      old.policy_id,old.change_reason,old.checksum,old.created_by,old.created_at) then
    return new;
  end if;
  raise check_violation using message = 'Published document template versions are immutable.';
end
$$;

create trigger document_template_versions_immutable
before update or delete on private.document_template_versions
for each row execute function private.document_studio_guard_template_version();
create trigger signature_authentication_evidence_immutable
before update or delete on private.signature_authentication_evidence
for each row execute function private.document_studio_prevent_append_only_change();
create trigger signature_consent_records_immutable
before update or delete on private.signature_consent_records
for each row execute function private.document_studio_prevent_append_only_change();
create trigger signature_events_immutable
before update or delete on private.signature_events
for each row execute function private.document_studio_prevent_append_only_change();
create trigger signature_audit_certificates_immutable
before update or delete on private.signature_audit_certificates
for each row execute function private.document_studio_prevent_append_only_change();
create trigger document_lifecycle_events_immutable
before update or delete on private.document_lifecycle_events
for each row execute function private.document_studio_prevent_append_only_change();

do $$
declare relation_name text;
begin
  foreach relation_name in array array[
    'document_studio_release_gate','document_policies','document_templates','document_template_versions',
    'document_field_definitions','document_associations','signature_adoptions','signature_envelopes',
    'signature_recipients','signature_authentication_evidence','signature_consent_records',
    'signature_field_values','signature_events','signature_audit_certificates','document_processing_jobs',
    'document_comments','document_lifecycle_events'
  ] loop
    execute format('alter table private.%I enable row level security', relation_name);
    execute format('revoke all on private.%I from public, anon, authenticated', relation_name);
    execute format('grant select, insert, update on private.%I to service_role', relation_name);
    execute format('create trigger %I after insert or update or delete on private.%I for each row execute function private.write_audit_event()', relation_name || '_audit', relation_name);
  end loop;
end
$$;

create or replace function private.document_studio_require_service()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
end
$$;

create or replace function private.document_studio_require_actor(target_actor_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare effective_permissions text[];
begin
  perform private.document_studio_require_service();
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
  effective_permissions := private.employee_effective_permissions(target_actor_id);
  return effective_permissions;
end
$$;

create or replace function private.document_studio_require_permission(target_actor_id uuid, target_permission text)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare effective_permissions text[] := private.document_studio_require_actor(target_actor_id);
begin
  if target_permission = 'documents.workspace.view' then
    if not (
      target_permission = any(effective_permissions)
      or 'hr.documents.view' = any(effective_permissions)
      or 'hr.documents.manage' = any(effective_permissions)
    ) then
      raise insufficient_privilege using message = 'Document Studio access is required.';
    end if;
  elsif not (target_permission = any(effective_permissions)) then
    raise insufficient_privilege using message = 'The required Document Studio permission is missing.';
  end if;
  return effective_permissions;
end
$$;

create or replace function private.document_studio_require_recent_mfa(
  target_method text,
  target_verified_at timestamptz,
  target_maximum_age interval default interval '15 minutes'
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_method not in ('authenticator','security_key')
    or target_verified_at is null
    or target_verified_at < clock_timestamp() - target_maximum_age
    or target_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = 'A recent identity verification is required.';
  end if;
end
$$;

create or replace function private.document_studio_can_view_document(
  target_actor_id uuid,
  target_document_id uuid,
  target_permissions text[] default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  effective_permissions text[] := coalesce(target_permissions, private.document_studio_require_actor(target_actor_id));
  document_vault private.hr_document_vaults%rowtype;
begin
  select vault.* into document_vault
  from private.hr_documents document
  join private.hr_document_vaults vault on vault.code = document.vault_code and vault.active
  where document.id = target_document_id and document.archived_at is null;
  if document_vault.code is null then return false; end if;
  if not (
    'documents.workspace.view' = any(effective_permissions)
    or 'hr.documents.view' = any(effective_permissions)
    or 'hr.documents.manage' = any(effective_permissions)
  ) then return false; end if;
  return (
    document_vault.view_permission in ('hr.documents.view','hr.documents.manage')
    or document_vault.view_permission = any(effective_permissions)
    or document_vault.manage_permission = any(effective_permissions)
  );
end
$$;

create or replace function public.service_get_document_studio_workspace(
  target_actor_id uuid,
  target_page_size integer default 10,
  target_offset integer default 0,
  target_search text default null,
  target_status text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  effective_permissions text[] := private.document_studio_require_permission(target_actor_id, 'documents.workspace.view');
  bounded_page_size integer := case when target_page_size in (5,10,20) then target_page_size else 10 end;
  bounded_offset integer := greatest(0, least(coalesce(target_offset,0), 10000));
  clean_search text := nullif(btrim(coalesce(target_search,'')), '');
  clean_status text := nullif(btrim(coalesce(target_status,'')), '');
begin
  return jsonb_build_object(
    'releaseState', jsonb_build_object(
      'documentPipeline', exists(select 1 from private.hr_document_release_gate where singleton and enabled),
      'workspace', exists(select 1 from private.document_studio_release_gate where gate='workspace' and enabled),
      'processing', exists(select 1 from private.document_studio_release_gate where gate='processing' and enabled),
      'signatures', exists(select 1 from private.document_studio_release_gate where gate='signatures' and enabled),
      'advancedEditing', exists(select 1 from private.document_studio_release_gate where gate='advanced_editing' and enabled),
      'regulatedDocuments', exists(select 1 from private.document_studio_release_gate where gate='regulated_documents' and enabled),
      'externalSigners', exists(select 1 from private.document_studio_release_gate where gate='external_signers' and enabled),
      'organizationalSeal', exists(select 1 from private.document_studio_release_gate where gate='organizational_seal' and enabled)
    ),
    'permissions', jsonb_build_object(
      'canUpload', 'documents.upload' = any(effective_permissions) or 'hr.documents.manage' = any(effective_permissions),
      'canCreate', 'documents.create' = any(effective_permissions),
      'canManageTemplates', 'documents.templates.manage' = any(effective_permissions),
      'canRequestSignatures', 'documents.signatures.request' = any(effective_permissions),
      'canManageSignatures', 'documents.signatures.manage' = any(effective_permissions),
      'canViewAudit', 'documents.audit.view' = any(effective_permissions),
      'canManagePolicies', 'documents.policies.manage' = any(effective_permissions),
      'canManageRetention', 'documents.retention.manage' = any(effective_permissions),
      'canManageLegalHold', 'documents.legal_hold.manage' = any(effective_permissions)
    ),
    'summary', jsonb_build_object(
      'documents', (select count(*) from private.hr_documents document where private.document_studio_can_view_document(target_actor_id, document.id, effective_permissions)),
      'templates', (select count(*) from private.document_templates template where template.status <> 'deactivated'),
      'awaitingAction', (select count(*) from private.signature_envelopes envelope where envelope.status in ('sent','delivered','viewed','in_progress','waiting','correction_requested','finalizing') and private.document_studio_can_view_document(target_actor_id, envelope.document_id, effective_permissions)),
      'completed', (select count(*) from private.signature_envelopes envelope where envelope.status='completed' and private.document_studio_can_view_document(target_actor_id, envelope.document_id, effective_permissions)),
      'exceptions', (select count(*) from private.document_processing_jobs job where job.status in ('failed','dead_letter') and private.document_studio_can_view_document(target_actor_id, job.document_id, effective_permissions)),
      'legalHolds', (select count(*) from private.hr_document_legal_holds hold where hold.released_at is null and private.document_studio_can_view_document(target_actor_id, hold.document_id, effective_permissions))
    ),
    'templates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', row_data.id, 'code', row_data.template_code, 'name', row_data.name,
        'category', row_data.category, 'status', row_data.status,
        'currentVersionId', row_data.current_version_id, 'updatedAt', row_data.updated_at,
        'versionNumber', row_data.version_number, 'fieldCount', row_data.field_count,
        'sourceDocumentTitle', row_data.source_document_title, 'policyName', row_data.policy_name
      ) order by row_data.updated_at desc)
      from (
        select template.*, version.version_number, document.title source_document_title,
          policy.name policy_name,
          (select count(*) from private.document_field_definitions field where field.template_version_id=version.id) field_count
        from private.document_templates template
        left join private.document_template_versions version on version.id=template.current_version_id
        left join private.hr_documents document on document.id=version.source_document_id
        left join private.document_policies policy on policy.id=version.policy_id
        where template.status <> 'deactivated'
          and (clean_search is null or template.name ilike '%'||clean_search||'%' or template.template_code ilike '%'||clean_search||'%')
          and (version.source_document_id is null or private.document_studio_can_view_document(target_actor_id, version.source_document_id, effective_permissions))
        order by template.updated_at desc
        limit bounded_page_size offset bounded_offset
      ) row_data
    ), '[]'::jsonb),
    'envelopes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', row_data.id, 'title', row_data.title, 'status', row_data.status,
        'routingMode', row_data.routing_mode, 'createdAt', row_data.created_at,
        'sentAt', row_data.sent_at, 'completedAt', row_data.completed_at,
        'expiresAt', row_data.expires_at, 'documentId', row_data.document_id,
        'documentTitle', row_data.document_title, 'policyName', row_data.policy_name,
        'recipientCount', row_data.recipient_count, 'completedRecipientCount', row_data.completed_recipient_count
      ) order by row_data.created_at desc)
      from (
        select envelope.*, document.title document_title, policy.name policy_name,
          (select count(*) from private.signature_recipients recipient where recipient.envelope_id=envelope.id) recipient_count,
          (select count(*) from private.signature_recipients recipient where recipient.envelope_id=envelope.id and recipient.status='completed') completed_recipient_count
        from private.signature_envelopes envelope
        join private.hr_documents document on document.id=envelope.document_id
        join private.document_policies policy on policy.id=envelope.policy_id
        where private.document_studio_can_view_document(target_actor_id, envelope.document_id, effective_permissions)
          and (clean_search is null or envelope.title ilike '%'||clean_search||'%' or document.title ilike '%'||clean_search||'%')
          and (clean_status is null or envelope.status=clean_status)
        order by envelope.created_at desc
        limit bounded_page_size offset bounded_offset
      ) row_data
    ), '[]'::jsonb),
    'policies', case when 'documents.policies.manage'=any(effective_permissions) then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', policy.id, 'code', policy.policy_code, 'versionNumber', policy.version_number,
        'name', policy.name, 'category', policy.document_category, 'jurisdiction', policy.jurisdiction,
        'executionMethod', policy.execution_method, 'authenticationTier', policy.authentication_tier,
        'routingMode', policy.routing_mode, 'regulated', policy.regulated, 'active', policy.active,
        'publishedAt', policy.published_at
      ) order by policy.policy_code, policy.version_number desc)
      from private.document_policies policy
      where clean_search is null or policy.name ilike '%'||clean_search||'%' or policy.policy_code ilike '%'||clean_search||'%'
    ), '[]'::jsonb) else '[]'::jsonb end,
    'processing', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', row_data.id, 'documentId', row_data.document_id, 'documentTitle', row_data.document_title,
        'jobType', row_data.job_type, 'status', row_data.status, 'attemptCount', row_data.attempt_count,
        'availableAt', row_data.available_at, 'completedAt', row_data.completed_at, 'failedAt', row_data.failed_at,
        'lastErrorCode', row_data.last_error_code
      ) order by row_data.created_at desc)
      from (
        select job.*, document.title document_title
        from private.document_processing_jobs job
        join private.hr_documents document on document.id=job.document_id
        where private.document_studio_can_view_document(target_actor_id, job.document_id, effective_permissions)
          and (clean_status is null or job.status=clean_status)
        order by job.created_at desc
        limit bounded_page_size
      ) row_data
    ), '[]'::jsonb),
    'pagination', jsonb_build_object('pageSize', bounded_page_size, 'offset', bounded_offset)
  );
end
$$;

create or replace function public.service_create_document_policy(
  target_actor_id uuid,
  target_configuration jsonb,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  effective_permissions text[] := private.document_studio_require_permission(target_actor_id, 'documents.policies.manage');
  clean_code text := upper(btrim(coalesce(target_configuration->>'policyCode','')));
  next_version integer;
  policy_id uuid;
  retention_id uuid;
  is_regulated boolean := coalesce((target_configuration->>'regulated')::boolean, false);
begin
  perform private.document_studio_require_recent_mfa(target_mfa_method, target_mfa_verified_at);
  if clean_code !~ '^[A-Z][A-Z0-9_-]{2,79}$' then raise check_violation using message='Use a valid policy code.'; end if;
  if is_regulated and not ('documents.regulated.manage'=any(effective_permissions)) then
    raise insufficient_privilege using message='Regulated-document permission is required.';
  end if;
  select policy.id into retention_id
  from private.hr_document_retention_policies policy
  where policy.code=coalesce(nullif(target_configuration->>'retentionPolicyCode',''),'MANUAL_REVIEW') and policy.active;
  if retention_id is null then raise check_violation using message='Choose an active retention policy.'; end if;
  select coalesce(max(policy.version_number),0)+1 into next_version
  from private.document_policies policy
  where policy.organization_code='guardianship-security' and policy.policy_code=clean_code;
  update private.document_policies policy
  set active=false
  where policy.organization_code='guardianship-security' and policy.policy_code=clean_code and policy.active;
  insert into private.document_policies(
    policy_code,version_number,name,document_category,jurisdiction,execution_method,
    electronic_signature_permitted,authentication_tier,routing_mode,consent_text,consent_version,
    signer_roles,reminder_schedule,expiration_days,retention_policy_id,requires_initials,
    requires_witness,requires_countersignature,allows_external_signers,allows_decline,
    allows_correction_request,completed_pdf_required,audit_certificate_required,
    organizational_seal_required,download_restricted,printing_restricted,regulated,
    active,published_at,created_by
  ) values (
    clean_code,next_version,btrim(target_configuration->>'name'),btrim(target_configuration->>'documentCategory'),
    coalesce(nullif(btrim(target_configuration->>'jurisdiction'),''),'US'),
    coalesce(nullif(target_configuration->>'executionMethod',''),'electronic'),
    coalesce((target_configuration->>'electronicSignaturePermitted')::boolean,true),
    coalesce(nullif(target_configuration->>'authenticationTier',''),'standard'),
    coalesce(nullif(target_configuration->>'routingMode',''),'sequential'),
    btrim(target_configuration->>'consentText'),btrim(target_configuration->>'consentVersion'),
    coalesce(target_configuration->'signerRoles','[]'::jsonb),coalesce(target_configuration->'reminderSchedule','[]'::jsonb),
    nullif(target_configuration->>'expirationDays','')::integer,retention_id,
    coalesce((target_configuration->>'requiresInitials')::boolean,false),
    coalesce((target_configuration->>'requiresWitness')::boolean,false),
    coalesce((target_configuration->>'requiresCountersignature')::boolean,false),
    coalesce((target_configuration->>'allowsExternalSigners')::boolean,false),
    coalesce((target_configuration->>'allowsDecline')::boolean,true),
    coalesce((target_configuration->>'allowsCorrectionRequest')::boolean,true),
    coalesce((target_configuration->>'completedPdfRequired')::boolean,true),
    coalesce((target_configuration->>'auditCertificateRequired')::boolean,true),
    coalesce((target_configuration->>'organizationalSealRequired')::boolean,false),
    coalesce((target_configuration->>'downloadRestricted')::boolean,false),
    coalesce((target_configuration->>'printingRestricted')::boolean,false),
    is_regulated,true,clock_timestamp(),target_actor_id
  ) returning id into policy_id;
  return jsonb_build_object('id',policy_id,'policyCode',clean_code,'versionNumber',next_version,'status','published');
end
$$;

create or replace function public.service_create_document_template(
  target_actor_id uuid,
  target_document_id uuid,
  target_policy_id uuid,
  target_template_code text,
  target_name text,
  target_description text,
  target_category text,
  target_change_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  effective_permissions text[] := private.document_studio_require_permission(target_actor_id, 'documents.templates.manage');
  source_document private.hr_documents%rowtype;
  source_version private.hr_document_versions%rowtype;
  template_id uuid;
  template_version_id uuid;
  clean_code text := upper(btrim(target_template_code));
begin
  perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at);
  if not private.document_studio_can_view_document(target_actor_id,target_document_id,effective_permissions) then
    raise insufficient_privilege using message='The source document is unavailable.';
  end if;
  select * into source_document from private.hr_documents where id=target_document_id and archived_at is null;
  select * into source_version from private.hr_document_versions where id=source_document.current_version_id;
  if source_version.id is null or private.hr_document_latest_scan_state(source_version.id) <> 'clean' then
    raise insufficient_privilege using message='Only a current security-reviewed document can become a template.';
  end if;
  if source_version.detected_mime_type <> 'application/pdf' then
    raise check_violation using message='Document Studio templates currently require a security-reviewed PDF source.';
  end if;
  if not exists(select 1 from private.document_policies policy where policy.id=target_policy_id and policy.active) then
    raise check_violation using message='Choose an active document policy.';
  end if;
  insert into private.document_templates(template_code,name,description,category,created_by)
  values(clean_code,btrim(target_name),nullif(btrim(target_description),''),btrim(target_category),target_actor_id)
  returning id into template_id;
  insert into private.document_template_versions(
    template_id,version_number,source_document_id,source_version_id,policy_id,status,change_reason,checksum,created_by
  ) values (
    template_id,1,source_document.id,source_version.id,target_policy_id,'draft',btrim(target_change_reason),source_version.sha256_checksum,target_actor_id
  ) returning id into template_version_id;
  update private.document_templates set current_version_id=template_version_id where id=template_id;
  insert into private.document_lifecycle_events(document_id,version_id,actor_employee_id,from_state,to_state,reason,request_id,metadata)
  values(source_document.id,source_version.id,target_actor_id,source_document.lifecycle_state,source_document.lifecycle_state,
    'Reusable template created from immutable source version.',nullif(btrim(target_request_id),''),
    jsonb_build_object('templateId',template_id,'templateVersionId',template_version_id));
  return jsonb_build_object('id',template_id,'versionId',template_version_id,'status','draft');
end
$$;

create or replace function public.service_add_document_template_field(
  target_actor_id uuid,
  target_template_version_id uuid,
  target_field jsonb,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare field_id uuid;
begin
  perform private.document_studio_require_permission(target_actor_id,'documents.templates.manage');
  perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at);
  if not exists(
    select 1 from private.document_template_versions version
    join private.document_templates template on template.id=version.template_id
    where version.id=target_template_version_id and version.status='draft' and template.status='draft'
  ) then raise check_violation using message='Only a draft template version can be changed.'; end if;
  insert into private.document_field_definitions(
    template_version_id,field_key,field_type,label,description,page_number,x_ratio,y_ratio,width_ratio,height_ratio,
    tab_order,required,read_only,signer_role_code,semantic_mapping,display_format,authoritative,sensitive,
    downloadable,validation_rules,options,conditional_rules,created_by
  ) values (
    target_template_version_id,btrim(target_field->>'fieldKey'),btrim(target_field->>'fieldType'),btrim(target_field->>'label'),
    nullif(btrim(target_field->>'description'),''),coalesce((target_field->>'pageNumber')::integer,1),
    (target_field->>'xRatio')::numeric,(target_field->>'yRatio')::numeric,(target_field->>'widthRatio')::numeric,(target_field->>'heightRatio')::numeric,
    (target_field->>'tabOrder')::integer,coalesce((target_field->>'required')::boolean,false),coalesce((target_field->>'readOnly')::boolean,false),
    nullif(btrim(target_field->>'signerRoleCode'),''),nullif(btrim(target_field->>'semanticMapping'),''),nullif(btrim(target_field->>'displayFormat'),''),
    coalesce((target_field->>'authoritative')::boolean,false),coalesce((target_field->>'sensitive')::boolean,false),coalesce((target_field->>'downloadable')::boolean,true),
    coalesce(target_field->'validationRules','{}'::jsonb),coalesce(target_field->'options','[]'::jsonb),coalesce(target_field->'conditionalRules','{}'::jsonb),target_actor_id
  ) returning id into field_id;
  return jsonb_build_object('id',field_id,'status','created');
end
$$;

create or replace function public.service_publish_document_template(
  target_actor_id uuid,
  target_template_id uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare version_id uuid;
begin
  perform private.document_studio_require_permission(target_actor_id,'documents.templates.manage');
  perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at);
  select current_version_id into version_id from private.document_templates where id=target_template_id and status='draft' for update;
  if version_id is null then raise no_data_found using message='The draft template was not found.'; end if;
  if not exists(select 1 from private.document_field_definitions field where field.template_version_id=version_id) then
    raise check_violation using message='Add at least one accessible field before publishing the template.';
  end if;
  update private.document_template_versions set status='published', published_at=clock_timestamp() where id=version_id;
  update private.document_templates set status='published' where id=target_template_id;
  return jsonb_build_object('id',target_template_id,'versionId',version_id,'status','published');
end
$$;

create or replace function private.document_studio_assert_association_target(target_entity_type text,target_entity_id uuid)
returns void
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if target_entity_type='employee' and not exists(select 1 from public.employees where id=target_entity_id) then raise no_data_found using message='The employee record was not found.';
  elsif target_entity_type='client' and not exists(select 1 from public.clients where id=target_entity_id and archived_at is null) then raise no_data_found using message='The client record was not found.';
  elsif target_entity_type='site' and not exists(select 1 from public.sites where id=target_entity_id) then raise no_data_found using message='The site record was not found.';
  elsif target_entity_type='post' and not exists(select 1 from public.posts where id=target_entity_id) then raise no_data_found using message='The post record was not found.';
  elsif target_entity_type='shift' and not exists(select 1 from public.shifts where id=target_entity_id) then raise no_data_found using message='The shift record was not found.';
  elsif target_entity_type='assignment' and not exists(select 1 from public.shift_assignments where id=target_entity_id) then raise no_data_found using message='The assignment record was not found.';
  elsif target_entity_type='credential' and not exists(select 1 from public.employee_credentials where id=target_entity_id) then raise no_data_found using message='The credential record was not found.';
  elsif target_entity_type='event' and not exists(select 1 from public.events where id=target_entity_id) then raise no_data_found using message='The event record was not found.';
  elsif target_entity_type='time_off' and not exists(select 1 from public.time_off_requests where id=target_entity_id) then raise no_data_found using message='The time-off record was not found.';
  elsif target_entity_type='patrol_route' and not exists(select 1 from public.patrol_routes where id=target_entity_id) then raise no_data_found using message='The patrol route was not found.';
  elsif target_entity_type='patrol_hit' and not exists(select 1 from public.patrol_hits where id=target_entity_id) then raise no_data_found using message='The patrol hit was not found.';
  end if;
end
$$;

create or replace function public.service_link_document_record(
  target_actor_id uuid,
  target_document_id uuid,
  target_entity_type text,
  target_entity_id uuid,
  target_relationship_type text,
  target_primary boolean,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  effective_permissions text[] := private.document_studio_require_permission(target_actor_id,'documents.link.manage');
  document_record private.hr_documents%rowtype;
  association_id uuid;
begin
  perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at);
  if not private.document_studio_can_view_document(target_actor_id,target_document_id,effective_permissions) then raise insufficient_privilege using message='The document is unavailable.'; end if;
  perform private.document_studio_assert_association_target(target_entity_type,target_entity_id);
  select * into document_record from private.hr_documents where id=target_document_id and archived_at is null;
  if target_primary then update private.document_associations set primary_association=false where document_id=target_document_id and unlinked_at is null and primary_association; end if;
  insert into private.document_associations(document_id,entity_type,entity_id,relationship_type,primary_association,visibility_classification,linked_by)
  values(target_document_id,target_entity_type,target_entity_id,target_relationship_type,target_primary,document_record.access_classification,target_actor_id)
  on conflict (document_id,entity_type,entity_id,relationship_type) where unlinked_at is null
  do update set primary_association=excluded.primary_association
  returning id into association_id;
  insert into private.hr_document_access_events(document_id,version_id,action,actor_employee_id,request_id,reason,metadata)
  values(target_document_id,document_record.current_version_id,'share',target_actor_id,nullif(btrim(target_request_id),''),'Canonical document linked to an authorized record.',jsonb_build_object('associationId',association_id,'entityType',target_entity_type,'entityId',target_entity_id,'relationshipType',target_relationship_type));
  return jsonb_build_object('id',association_id,'status','linked');
end
$$;

create or replace function public.service_create_signature_envelope(
  target_actor_id uuid,
  target_document_id uuid,
  target_template_version_id uuid,
  target_policy_id uuid,
  target_title text,
  target_message text,
  target_expires_at timestamptz,
  target_recipients jsonb,
  target_idempotency_key uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  effective_permissions text[] := private.document_studio_require_permission(target_actor_id,'documents.signatures.request');
  document_record private.hr_documents%rowtype;
  version_record private.hr_document_versions%rowtype;
  policy_record private.document_policies%rowtype;
  template_record private.document_template_versions%rowtype;
  envelope_id uuid;
  recipient_value jsonb;
  employee_id uuid;
  external_email text;
  initial_status text;
begin
  perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at);
  if not exists(select 1 from private.document_studio_release_gate where gate='signatures' and enabled) then raise insufficient_privilege using message='Signature workflows have not been released.'; end if;
  if not private.document_studio_can_view_document(target_actor_id,target_document_id,effective_permissions) then raise insufficient_privilege using message='The document is unavailable.'; end if;
  select * into document_record from private.hr_documents where id=target_document_id and archived_at is null for update;
  select * into version_record from private.hr_document_versions where id=document_record.current_version_id;
  if version_record.id is null or private.hr_document_latest_scan_state(version_record.id)<>'clean' then raise insufficient_privilege using message='Only the current security-reviewed document version can be sent.'; end if;
  select * into policy_record from private.document_policies where id=target_policy_id and active;
  if policy_record.id is null then raise check_violation using message='Choose an active document policy.'; end if;
  if policy_record.regulated and not exists(select 1 from private.document_studio_release_gate where gate='regulated_documents' and enabled) then raise insufficient_privilege using message='This regulated-document policy has not completed compliance release.'; end if;
  if policy_record.execution_method in ('external','paper','not_eligible') then initial_status := 'external_process_required'; else initial_status := 'draft'; end if;
  if target_template_version_id is not null then
    select * into template_record from private.document_template_versions where id=target_template_version_id and status='published';
    if template_record.id is null or template_record.source_document_id<>document_record.id or template_record.source_version_id<>version_record.id or template_record.policy_id<>policy_record.id then
      raise check_violation using message='The published template does not match this document version and policy.';
    end if;
  end if;
  if jsonb_typeof(target_recipients)<>'array' or jsonb_array_length(target_recipients)<1 or jsonb_array_length(target_recipients)>25 then raise check_violation using message='Add between one and 25 recipients.'; end if;
  select envelope.id into envelope_id from private.signature_envelopes envelope where envelope.idempotency_key=target_idempotency_key;
  if envelope_id is not null then return jsonb_build_object('id',envelope_id,'status',(select status from private.signature_envelopes where id=envelope_id)); end if;
  insert into private.signature_envelopes(document_id,document_version_id,template_version_id,policy_id,title,status,routing_mode,message,expires_at,created_by,idempotency_key)
  values(document_record.id,version_record.id,target_template_version_id,policy_record.id,btrim(target_title),initial_status,policy_record.routing_mode,nullif(btrim(target_message),''),coalesce(target_expires_at,case when policy_record.expiration_days is null then null else clock_timestamp()+make_interval(days=>policy_record.expiration_days) end),target_actor_id,target_idempotency_key)
  returning id into envelope_id;
  for recipient_value in select value from jsonb_array_elements(target_recipients) loop
    employee_id := nullif(recipient_value->>'employeeId','')::uuid;
    external_email := nullif(lower(btrim(recipient_value->>'externalEmail')),'');
    if num_nonnulls(employee_id,external_email)<>1 then raise check_violation using message='Each recipient must identify one employee or approved external signer.'; end if;
    if external_email is not null then
      if not policy_record.allows_external_signers or not exists(select 1 from private.document_studio_release_gate where gate='external_signers' and enabled) then raise insufficient_privilege using message='External signing has not been approved for this policy.'; end if;
    elsif not exists(select 1 from public.employees employee join private.employee_accounts account on account.employee_id=employee.id where employee.id=employee_id and employee.status in ('active','leave') and account.disabled_at is null) then
      raise check_violation using message='Choose an active employee recipient.';
    end if;
    insert into private.signature_recipients(envelope_id,employee_id,external_email,external_name,recipient_role,required_action,routing_order,authentication_tier,status)
    values(envelope_id,employee_id,external_email,nullif(btrim(recipient_value->>'externalName'),''),btrim(recipient_value->>'recipientRole'),coalesce(nullif(recipient_value->>'requiredAction',''),'sign'),coalesce((recipient_value->>'routingOrder')::integer,1),coalesce(nullif(recipient_value->>'authenticationTier',''),policy_record.authentication_tier),case when initial_status='external_process_required' then 'blocked' else 'pending' end);
  end loop;
  insert into private.signature_events(envelope_id,document_id,document_version_id,actor_employee_id,event_type,event_reason,source_checksum,request_id,metadata)
  values(envelope_id,document_record.id,version_record.id,target_actor_id,'created','Signature envelope prepared.',version_record.sha256_checksum,nullif(btrim(target_request_id),''),jsonb_build_object('recipientCount',jsonb_array_length(target_recipients),'routingMode',policy_record.routing_mode));
  insert into private.signature_events(envelope_id,recipient_id,document_id,document_version_id,actor_employee_id,event_type,event_reason,source_checksum,request_id,metadata)
  select envelope_id,recipient.id,document_record.id,version_record.id,target_actor_id,'recipient_assigned','Recipient assigned to protected envelope.',version_record.sha256_checksum,nullif(btrim(target_request_id),''),jsonb_build_object('recipientRole',recipient.recipient_role,'routingOrder',recipient.routing_order,'requiredAction',recipient.required_action)
  from private.signature_recipients recipient where recipient.envelope_id=envelope_id;
  update private.hr_documents set lifecycle_state=case when initial_status='external_process_required' then lifecycle_state else 'draft' end,document_policy_id=policy_record.id,template_version_id=target_template_version_id where id=document_record.id;
  return jsonb_build_object('id',envelope_id,'status',initial_status,'recipientCount',jsonb_array_length(target_recipients));
end
$$;

create or replace function public.service_send_signature_envelope(
  target_actor_id uuid,
  target_envelope_id uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  envelope_record private.signature_envelopes%rowtype;
  version_record private.hr_document_versions%rowtype;
begin
  perform private.document_studio_require_permission(target_actor_id,'documents.signatures.request');
  perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at);
  select * into envelope_record from private.signature_envelopes where id=target_envelope_id for update;
  if envelope_record.id is null then raise no_data_found using message='The signature envelope was not found.'; end if;
  if envelope_record.status<>'draft' then raise check_violation using message='Only a draft envelope can be sent.'; end if;
  if envelope_record.expires_at is not null and envelope_record.expires_at<=clock_timestamp() then raise check_violation using message='Choose an expiration time in the future.'; end if;
  select * into version_record from private.hr_document_versions where id=envelope_record.document_version_id;
  if private.hr_document_latest_scan_state(version_record.id)<>'clean' then raise insufficient_privilege using message='The document version is no longer available.'; end if;
  if not exists(select 1 from private.hr_documents document where document.id=envelope_record.document_id and document.archived_at is null and document.current_version_id=envelope_record.document_version_id) then
    raise check_violation using message='The document changed after this envelope was prepared. Create a new envelope from the current version.';
  end if;
  if envelope_record.template_version_id is not null and exists(
    select 1 from private.document_field_definitions field
    where field.template_version_id=envelope_record.template_version_id and field.required and field.signer_role_code is not null
      and not exists(select 1 from private.signature_recipients recipient where recipient.envelope_id=envelope_record.id and recipient.recipient_role=field.signer_role_code)
  ) then raise check_violation using message='Every required signer field must have an assigned recipient role.'; end if;
  update private.signature_envelopes set status='sent',sent_at=clock_timestamp() where id=envelope_record.id;
  update private.hr_documents set lifecycle_state='awaiting_signature' where id=envelope_record.document_id;
  insert into private.signature_events(envelope_id,document_id,document_version_id,actor_employee_id,event_type,event_reason,source_checksum,request_id,metadata)
  values(envelope_record.id,envelope_record.document_id,envelope_record.document_version_id,target_actor_id,'sent','Signature envelope sent.',version_record.sha256_checksum,nullif(btrim(target_request_id),''),'{}'::jsonb);
  insert into private.notification_outbox(message_type,aggregate_type,aggregate_id,recipient_employee_id,payload,idempotency_key)
  select 'document_signature_required','signature_envelope',envelope_record.id,recipient.employee_id,
    jsonb_build_object('subject','Document action required','message',envelope_record.title,'envelopeId',envelope_record.id,'path','/my-documents','expiresAt',envelope_record.expires_at),
    'signature-envelope-sent:'||envelope_record.id::text||':'||recipient.id::text
  from private.signature_recipients recipient
  where recipient.envelope_id=envelope_record.id and recipient.employee_id is not null
  on conflict (idempotency_key) do nothing;
  return jsonb_build_object('id',envelope_record.id,'status','sent','sentAt',clock_timestamp());
end
$$;

create or replace function public.service_get_my_signature_workspace(target_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare effective_permissions text[] := private.document_studio_require_actor(target_actor_id);
begin
  if not ('documents.signatures.sign_own'=any(effective_permissions)) then raise insufficient_privilege using message='Document-signing access is required.'; end if;
  if not exists(select 1 from private.hr_document_release_gate where singleton and enabled)
    or not exists(select 1 from private.document_studio_release_gate where gate='signatures' and enabled) then
    return jsonb_build_object('releaseState','unavailable','adoption',null,'recipients','[]'::jsonb);
  end if;
  return jsonb_build_object(
    'releaseState','released',
    'adoption',(select jsonb_build_object('id',adoption.id,'method',adoption.method,'styleCode',adoption.style_code,'displayName',adoption.display_name,'createdAt',adoption.created_at) from private.signature_adoptions adoption where adoption.employee_id=target_actor_id and adoption.active limit 1),
    'recipients',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',recipient.id,'envelopeId',envelope.id,'documentId',envelope.document_id,'documentVersionId',envelope.document_version_id,
        'documentTitle',document.title,'envelopeTitle',envelope.title,'status',recipient.status,'envelopeStatus',envelope.status,
        'recipientRole',recipient.recipient_role,'requiredAction',recipient.required_action,'routingOrder',recipient.routing_order,
        'authenticationTier',recipient.authentication_tier,'expiresAt',envelope.expires_at,'sentAt',envelope.sent_at,
        'completedAt',envelope.completed_at,'sourceChecksum',version.sha256_checksum,'versionNumber',version.version_number,
        'consentText',policy.consent_text,'consentVersion',policy.consent_version,'allowsDecline',policy.allows_decline,
        'allowsCorrectionRequest',policy.allows_correction_request,'remainingRecipients',(select count(*) from private.signature_recipients remaining where remaining.envelope_id=envelope.id and remaining.status not in ('completed','voided','reassigned')),
        'canAct',recipient.status in ('pending','delivered','viewed','in_progress') and envelope.status in ('sent','delivered','viewed','in_progress','waiting') and (envelope.expires_at is null or envelope.expires_at>clock_timestamp()) and (envelope.routing_mode='parallel' or not exists(select 1 from private.signature_recipients prior where prior.envelope_id=envelope.id and prior.routing_order<recipient.routing_order and prior.status<>'completed')),
        'fields',coalesce((select jsonb_agg(jsonb_build_object('id',field.id,'fieldKey',field.field_key,'fieldType',field.field_type,'label',field.label,'description',field.description,'pageNumber',field.page_number,'xRatio',field.x_ratio,'yRatio',field.y_ratio,'widthRatio',field.width_ratio,'heightRatio',field.height_ratio,'tabOrder',field.tab_order,'required',field.required,'readOnly',field.read_only,'semanticMapping',field.semantic_mapping,'authoritative',field.authoritative,'sensitive',field.sensitive,'validationRules',field.validation_rules,'options',field.options) order by field.tab_order) from private.document_field_definitions field where field.template_version_id=envelope.template_version_id and (field.signer_role_code is null or field.signer_role_code=recipient.recipient_role)),'[]'::jsonb)
      ) order by coalesce(envelope.expires_at,'infinity'::timestamptz),envelope.created_at desc)
      from private.signature_recipients recipient
      join private.signature_envelopes envelope on envelope.id=recipient.envelope_id
      join private.hr_documents document on document.id=envelope.document_id
      join private.hr_document_versions version on version.id=envelope.document_version_id
      join private.document_policies policy on policy.id=envelope.policy_id
      where recipient.employee_id=target_actor_id and recipient.status<>'reassigned'
    ),'[]'::jsonb)
  );
end
$$;

create or replace function public.service_get_my_document_action_count(target_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare effective_permissions text[] := private.document_studio_require_actor(target_actor_id);
begin
  if not ('documents.signatures.sign_own'=any(effective_permissions))
    or not exists(select 1 from private.hr_document_release_gate where singleton and enabled)
    or not exists(select 1 from private.document_studio_release_gate where gate='signatures' and enabled) then
    return jsonb_build_object('pendingCount',0,'available',false);
  end if;
  return jsonb_build_object('pendingCount',(
    select count(*) from private.signature_recipients recipient
    join private.signature_envelopes envelope on envelope.id=recipient.envelope_id
    where recipient.employee_id=target_actor_id and recipient.status in ('pending','delivered','viewed','in_progress')
      and envelope.status in ('sent','delivered','viewed','in_progress','waiting') and (envelope.expires_at is null or envelope.expires_at>clock_timestamp())
  ) + (select count(*) from private.hr_document_assignments assignment where assignment.employee_id=target_actor_id and assignment.status='pending'),'available',true);
end
$$;

create or replace function public.service_get_my_signature_adoption_access(
  target_actor_id uuid,target_mfa_method text,target_mfa_verified_at timestamptz,target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare effective_permissions text[]:=private.document_studio_require_actor(target_actor_id); adoption_record private.signature_adoptions%rowtype;
begin
  if not ('documents.signatures.sign_own'=any(effective_permissions)) then raise insufficient_privilege using message='Document-signing access is required.'; end if;
  if not exists(select 1 from private.hr_document_release_gate where singleton and enabled)
    or not exists(select 1 from private.document_studio_release_gate where gate='signatures' and enabled) then raise insufficient_privilege using message='Signature workflows have not been released.'; end if;
  perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at,interval '10 minutes');
  select * into adoption_record from private.signature_adoptions where employee_id=target_actor_id and active for update;
  if adoption_record.id is null or adoption_record.method not in ('drawn','uploaded')
    or adoption_record.appearance_bucket is null or adoption_record.appearance_object_key is null or adoption_record.appearance_checksum is null then
    raise no_data_found using message='A reusable stored signature image was not found.';
  end if;
  insert into private.audit_events(employee_id,request_id,schema_name,table_name,operation,row_id,new_record)
  values(target_actor_id,nullif(btrim(target_request_id),''),'private','signature_adoptions','READ_APPEARANCE',adoption_record.id::text,
    jsonb_build_object('method',adoption_record.method,'mfaMethod',target_mfa_method,'checksum',adoption_record.appearance_checksum));
  return jsonb_build_object('bucket',adoption_record.appearance_bucket,'objectKey',adoption_record.appearance_object_key,
    'checksum',adoption_record.appearance_checksum,'method',adoption_record.method,'displayName',adoption_record.display_name);
end
$$;

create or replace function public.service_record_signature_action(
  target_actor_id uuid,
  target_recipient_id uuid,
  target_action text,
  target_field_values jsonb,
  target_consent_version text,
  target_consent_shown_at timestamptz,
  target_signature_method text,
  target_signature_style text,
  target_display_name text,
  target_appearance_bucket text,
  target_appearance_object_key text,
  target_appearance_checksum text,
  target_save_adoption boolean,
  target_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_session_reference_hash text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  effective_permissions text[] := private.document_studio_require_actor(target_actor_id);
  recipient_record private.signature_recipients%rowtype;
  envelope_record private.signature_envelopes%rowtype;
  policy_record private.document_policies%rowtype;
  version_record private.hr_document_versions%rowtype;
  legal_name text;
  auth_evidence_id uuid;
  consent_id uuid;
  event_id uuid;
  event_type text;
  remaining_count integer;
  field_value record;
  fields_checksum text;
  needs_signature_appearance boolean;
begin
  if not ('documents.signatures.sign_own'=any(effective_permissions)) then raise insufficient_privilege using message='Document-signing access is required.'; end if;
  if not exists(select 1 from private.hr_document_release_gate where singleton and enabled)
    or not exists(select 1 from private.document_studio_release_gate where gate='signatures' and enabled) then raise insufficient_privilege using message='Signature workflows have not been released.'; end if;
  select * into recipient_record from private.signature_recipients where id=target_recipient_id and employee_id=target_actor_id for update;
  if recipient_record.id is null then raise no_data_found using message='The assigned signature action was not found.'; end if;
  select * into envelope_record from private.signature_envelopes where id=recipient_record.envelope_id for update;
  select * into policy_record from private.document_policies where id=envelope_record.policy_id;
  select * into version_record from private.hr_document_versions where id=envelope_record.document_version_id;
  if recipient_record.status='completed' then
    return jsonb_build_object('recipientId',recipient_record.id,'envelopeId',envelope_record.id,'status',envelope_record.status,'idempotent',true,'finalizationRequired',envelope_record.status='finalizing');
  end if;
  if recipient_record.status not in ('pending','delivered','viewed','in_progress') or envelope_record.status not in ('sent','delivered','viewed','in_progress','waiting') then raise check_violation using message='This document action is no longer available.'; end if;
  if envelope_record.expires_at is not null and envelope_record.expires_at<=clock_timestamp() then
    update private.signature_envelopes set status='expired' where id=envelope_record.id;
    update private.signature_recipients set status='expired' where envelope_id=envelope_record.id and status not in ('completed','declined','correction_requested','voided','reassigned');
    raise check_violation using message='This signature request has expired.';
  end if;
  if envelope_record.routing_mode='sequential' and exists(select 1 from private.signature_recipients prior where prior.envelope_id=envelope_record.id and prior.routing_order<recipient_record.routing_order and prior.status<>'completed') then raise check_violation using message='This document is waiting for an earlier signer.'; end if;
  if target_action='decline' then
    if not policy_record.allows_decline then raise insufficient_privilege using message='This document policy does not allow decline.'; end if;
    if btrim(coalesce(target_reason,''))='' then raise check_violation using message='A decline reason is required.'; end if;
    update private.signature_recipients set status='declined',acted_at=clock_timestamp(),decline_reason=btrim(target_reason) where id=recipient_record.id;
    update private.signature_envelopes set status='declined',declined_at=clock_timestamp() where id=envelope_record.id;
    event_type := 'declined';
  elsif target_action='request_correction' then
    if not policy_record.allows_correction_request then raise insufficient_privilege using message='This document policy does not allow correction requests.'; end if;
    if btrim(coalesce(target_reason,''))='' then raise check_violation using message='Explain the correction that is needed.'; end if;
    update private.signature_recipients set status='correction_requested',acted_at=clock_timestamp(),correction_reason=btrim(target_reason) where id=recipient_record.id;
    update private.signature_envelopes set status='correction_requested' where id=envelope_record.id;
    event_type := 'correction_requested';
  else
    if target_action<>recipient_record.required_action then raise check_violation using message='The submitted action does not match the assigned action.'; end if;
    if target_consent_version is distinct from policy_record.consent_version then raise check_violation using message='The consent statement changed. Review the current statement before continuing.'; end if;
    if target_consent_shown_at is null or target_consent_shown_at>clock_timestamp()+interval '1 minute' or target_consent_shown_at<clock_timestamp()-interval '2 hours' then raise check_violation using message='Reopen the document and review the consent statement before continuing.'; end if;
    if recipient_record.authentication_tier in ('elevated','specialized') then perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at,interval '10 minutes');
    elsif target_mfa_method in ('authenticator','security_key') then perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at,interval '15 minutes');
    end if;
    if recipient_record.authentication_tier='specialized' then raise insufficient_privilege using message='This document requires an approved specialized execution process.'; end if;
    needs_signature_appearance := target_action in ('sign','initial','countersign','witness');
    if needs_signature_appearance and (
      target_signature_method not in ('typed','drawn','uploaded','saved')
      or target_appearance_bucket<>'signature-appearances'
      or btrim(coalesce(target_appearance_object_key,''))=''
      or target_appearance_checksum !~ '^[a-f0-9]{64}$'
      or btrim(coalesce(target_display_name,''))=''
    ) then raise check_violation using message='Choose and confirm a valid signature appearance.'; end if;
    if envelope_record.template_version_id is not null and exists(
      select 1 from private.document_field_definitions field
      where field.template_version_id=envelope_record.template_version_id
        and (field.signer_role_code is null or field.signer_role_code=recipient_record.recipient_role)
        and field.required and field.field_type not in ('signature','initials','signer_date','system_value')
        and not (coalesce(target_field_values,'{}'::jsonb) ? field.field_key)
    ) then raise check_violation using message='Complete every required assigned field before submitting.'; end if;
    select btrim(concat_ws(' ',employee.first_name,employee.middle_name,employee.last_name)) into legal_name from public.employees employee where employee.id=target_actor_id;
    insert into private.signature_authentication_evidence(envelope_id,recipient_id,employee_id,authentication_tier,authentication_method,verified_at,session_reference_hash,request_id)
    values(envelope_record.id,recipient_record.id,target_actor_id,recipient_record.authentication_tier,case when target_mfa_method in ('authenticator','security_key') then target_mfa_method else 'session' end,coalesce(target_mfa_verified_at,clock_timestamp()),nullif(target_session_reference_hash,''),nullif(btrim(target_request_id),''))
    returning id into auth_evidence_id;
    insert into private.signature_consent_records(envelope_id,recipient_id,consent_text,consent_version,shown_at,accepted_at,confirmation_action,document_version_id,request_id)
    values(envelope_record.id,recipient_record.id,policy_record.consent_text,policy_record.consent_version,target_consent_shown_at,clock_timestamp(),'Adopt & Sign',envelope_record.document_version_id,nullif(btrim(target_request_id),''))
    returning id into consent_id;
    if jsonb_typeof(coalesce(target_field_values,'{}'::jsonb))<>'object' then raise check_violation using message='Document field values are invalid.'; end if;
    for field_value in select key,value from jsonb_each(coalesce(target_field_values,'{}'::jsonb)) loop
      if envelope_record.template_version_id is null or not exists(select 1 from private.document_field_definitions field where field.template_version_id=envelope_record.template_version_id and field.field_key=field_value.key and (field.signer_role_code is null or field.signer_role_code=recipient_record.recipient_role) and not field.read_only) then raise insufficient_privilege using message='A submitted document field is not assigned to you.'; end if;
      insert into private.signature_field_values(envelope_id,recipient_id,field_definition_id,field_key,value_text,value_json,authoritative_source)
      select envelope_record.id,recipient_record.id,field.id,field.field_key,case when jsonb_typeof(field_value.value)='string' then field_value.value#>>'{}' else null end,case when jsonb_typeof(field_value.value)<>'string' then field_value.value else null end,null
      from private.document_field_definitions field where field.template_version_id=envelope_record.template_version_id and field.field_key=field_value.key;
    end loop;
    fields_checksum := encode(digest(convert_to(coalesce(target_field_values,'{}'::jsonb)::text,'UTF8'),'sha256'),'hex');
    event_type := case target_action when 'sign' then 'signed' when 'initial' then 'initialed' when 'acknowledge' then 'acknowledged' when 'approve' then 'approved' when 'certify' then 'certified' when 'countersign' then 'signed' when 'witness' then 'signed' else 'field_completed' end;
    insert into private.signature_events(envelope_id,recipient_id,document_id,document_version_id,actor_employee_id,event_type,event_reason,authentication_evidence_id,consent_record_id,signature_method,signature_style,display_name,appearance_bucket,appearance_object_key,appearance_checksum,source_checksum,field_values_checksum,request_id,metadata)
    values(envelope_record.id,recipient_record.id,envelope_record.document_id,envelope_record.document_version_id,target_actor_id,event_type,'Assigned document action completed.',auth_evidence_id,consent_id,case when needs_signature_appearance then target_signature_method else null end,case when needs_signature_appearance then nullif(target_signature_style,'') else null end,case when needs_signature_appearance then btrim(target_display_name) else null end,case when needs_signature_appearance then target_appearance_bucket else null end,case when needs_signature_appearance then target_appearance_object_key else null end,case when needs_signature_appearance then target_appearance_checksum else null end,version_record.sha256_checksum,fields_checksum,nullif(btrim(target_request_id),''),jsonb_build_object('verifiedLegalName',legal_name,'employeeId',target_actor_id,'recipientRole',recipient_record.recipient_role,'authenticationTier',recipient_record.authentication_tier))
    returning id into event_id;
    update private.signature_recipients set status='completed',acted_at=clock_timestamp() where id=recipient_record.id;
    if target_save_adoption and needs_signature_appearance and target_signature_method<>'saved' then
      update private.signature_adoptions set active=false,replaced_at=clock_timestamp() where employee_id=target_actor_id and active;
      insert into private.signature_adoptions(employee_id,method,style_code,display_name,appearance_bucket,appearance_object_key,appearance_checksum,verified_at,authentication_method)
      values(target_actor_id,case when target_signature_method='saved' then 'typed' else target_signature_method end,case when target_signature_method in ('typed','saved') then coalesce(nullif(target_signature_style,''),'simple') else null end,btrim(target_display_name),case when target_signature_method in ('typed','saved') then null else target_appearance_bucket end,case when target_signature_method in ('typed','saved') then null else target_appearance_object_key end,case when target_signature_method in ('typed','saved') then null else target_appearance_checksum end,coalesce(target_mfa_verified_at,clock_timestamp()),case when target_mfa_method in ('authenticator','security_key') then target_mfa_method else 'authenticator' end);
    end if;
    select count(*) into remaining_count from private.signature_recipients recipient where recipient.envelope_id=envelope_record.id and recipient.status not in ('completed','voided','reassigned');
    if remaining_count=0 then
      update private.signature_envelopes set status='finalizing' where id=envelope_record.id;
      insert into private.document_processing_jobs(document_id,version_id,envelope_id,job_type,status,idempotency_key)
      values(envelope_record.document_id,envelope_record.document_version_id,envelope_record.id,'finalize_signature','queued','finalize-signature:'||envelope_record.id::text)
      on conflict(idempotency_key) do nothing;
      insert into private.signature_events(envelope_id,document_id,document_version_id,actor_employee_id,event_type,event_reason,source_checksum,request_id,metadata)
      values(envelope_record.id,envelope_record.document_id,envelope_record.document_version_id,target_actor_id,'finalization_started','All required recipient actions are complete.',version_record.sha256_checksum,nullif(btrim(target_request_id),''),'{}'::jsonb);
    else
      update private.signature_envelopes set status='waiting' where id=envelope_record.id;
      if envelope_record.routing_mode='sequential' then
        insert into private.notification_outbox(message_type,aggregate_type,aggregate_id,recipient_employee_id,payload,idempotency_key)
        select 'document_signature_required','signature_envelope',envelope_record.id,next_recipient.employee_id,jsonb_build_object('subject','Document action required','message',envelope_record.title,'envelopeId',envelope_record.id,'path','/my-documents','expiresAt',envelope_record.expires_at),'signature-envelope-advanced:'||envelope_record.id::text||':'||next_recipient.id::text
        from private.signature_recipients next_recipient
        where next_recipient.envelope_id=envelope_record.id and next_recipient.status='pending' and next_recipient.employee_id is not null
        order by next_recipient.routing_order limit 1
        on conflict(idempotency_key) do nothing;
      end if;
    end if;
  end if;
  if event_type in ('declined','correction_requested') then
    insert into private.signature_events(envelope_id,recipient_id,document_id,document_version_id,actor_employee_id,event_type,event_reason,source_checksum,request_id,metadata)
    values(envelope_record.id,recipient_record.id,envelope_record.document_id,envelope_record.document_version_id,target_actor_id,event_type,btrim(target_reason),version_record.sha256_checksum,nullif(btrim(target_request_id),''),'{}'::jsonb)
    returning id into event_id;
  end if;
  return jsonb_build_object('recipientId',recipient_record.id,'envelopeId',envelope_record.id,'eventId',event_id,'status',(select status from private.signature_envelopes where id=envelope_record.id),'finalizationRequired',remaining_count=0 and event_type not in ('declined','correction_requested'));
end
$$;

create or replace function public.service_void_signature_envelope(
  target_actor_id uuid,target_envelope_id uuid,target_reason text,target_mfa_method text,target_mfa_verified_at timestamptz,target_request_id text default null
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare envelope_record private.signature_envelopes%rowtype; version_checksum text;
begin
  perform private.document_studio_require_permission(target_actor_id,'documents.signatures.manage');
  perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at);
  if btrim(coalesce(target_reason,''))='' then raise check_violation using message='A void reason is required.'; end if;
  select * into envelope_record from private.signature_envelopes where id=target_envelope_id for update;
  if envelope_record.id is null then raise no_data_found using message='The signature envelope was not found.'; end if;
  if envelope_record.status in ('completed','voided','archived') then raise check_violation using message='This envelope can no longer be voided.'; end if;
  select sha256_checksum into version_checksum from private.hr_document_versions where id=envelope_record.document_version_id;
  update private.signature_envelopes set status='voided',voided_at=clock_timestamp(),voided_by=target_actor_id,void_reason=btrim(target_reason) where id=envelope_record.id;
  update private.signature_recipients set status='voided',acted_at=clock_timestamp() where envelope_id=envelope_record.id and status not in ('completed','declined','correction_requested','reassigned');
  update private.document_processing_jobs set status='cancelled',completed_at=clock_timestamp() where envelope_id=envelope_record.id and status in ('queued','failed');
  insert into private.signature_events(envelope_id,document_id,document_version_id,actor_employee_id,event_type,event_reason,source_checksum,request_id,metadata)
  values(envelope_record.id,envelope_record.document_id,envelope_record.document_version_id,target_actor_id,'voided',btrim(target_reason),version_checksum,nullif(btrim(target_request_id),''),'{}'::jsonb);
  return jsonb_build_object('id',envelope_record.id,'status','voided');
end $$;

create or replace function public.service_issue_my_signature_document_access_grant(
  target_actor_id uuid,target_recipient_id uuid,target_action text,target_token_hash text,target_mfa_method text,target_mfa_verified_at timestamptz,target_reason text,target_request_id text default null
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare recipient_record private.signature_recipients%rowtype; envelope_record private.signature_envelopes%rowtype; version_id uuid; grant_id uuid; grant_expires_at timestamptz:=clock_timestamp()+interval '60 seconds';
begin
  perform private.document_studio_require_actor(target_actor_id);
  perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at);
  if target_action not in ('preview','view','download') then raise check_violation using message='Choose preview, view, or download.'; end if;
  select * into recipient_record from private.signature_recipients where id=target_recipient_id and employee_id=target_actor_id;
  if recipient_record.id is null or recipient_record.status in ('voided','reassigned') then raise insufficient_privilege using message='The assigned document is unavailable.'; end if;
  select * into envelope_record from private.signature_envelopes where id=recipient_record.envelope_id;
  version_id:=case when envelope_record.status='completed' then envelope_record.final_document_version_id else envelope_record.document_version_id end;
  if version_id is null then raise insufficient_privilege using message='The assigned document version is unavailable.'; end if;
  insert into private.hr_document_access_grants(token_hash,actor_employee_id,document_id,version_id,action,mfa_method,mfa_verified_at,reason,request_id,expires_at,authorization_source,signature_recipient_id)
  values(target_token_hash,target_actor_id,envelope_record.document_id,version_id,target_action,target_mfa_method,target_mfa_verified_at,btrim(target_reason),nullif(btrim(target_request_id),''),grant_expires_at,'signature_recipient',recipient_record.id)
  returning id into grant_id;
  return jsonb_build_object('grantId',grant_id,'expiresAt',grant_expires_at);
end $$;

create or replace function private.hr_document_access_grant_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise check_violation using message = 'Document access grants cannot be deleted.';
  end if;
  if old.consumed_at is not null or new.consumed_at is null
    or row(new.token_hash,new.actor_employee_id,new.document_id,new.version_id,new.action,
      new.mfa_method,new.mfa_verified_at,new.reason,new.request_id,new.created_at,new.expires_at,
      new.authorization_source,new.assignment_id,new.signature_recipient_id)
      is distinct from
      row(old.token_hash,old.actor_employee_id,old.document_id,old.version_id,old.action,
      old.mfa_method,old.mfa_verified_at,old.reason,old.request_id,old.created_at,old.expires_at,
      old.authorization_source,old.assignment_id,old.signature_recipient_id) then
    raise check_violation using message = 'Document access grants are immutable except for first use.';
  end if;
  return new;
end
$$;

create or replace function public.service_consume_hr_document_access_grant(
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
  document_record private.hr_documents%rowtype;
begin
  perform private.document_studio_require_service();
  if not exists(select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then
    raise insufficient_privilege using message = 'The HR document workspace has not been released.';
  end if;
  update private.hr_document_access_grants access_grant
  set consumed_at=clock_timestamp()
  where access_grant.actor_employee_id=target_actor_id and access_grant.token_hash=target_token_hash
    and access_grant.consumed_at is null and access_grant.expires_at>clock_timestamp()
  returning * into grant_record;
  if grant_record.id is null then raise insufficient_privilege using message='The document access link is invalid or expired.'; end if;
  select * into document_record from private.hr_documents where id=grant_record.document_id and archived_at is null;
  if document_record.id is null then raise insufficient_privilege using message='The document access link is no longer available.'; end if;
  if grant_record.authorization_source='permission' then
    if document_record.current_version_id<>grant_record.version_id then raise insufficient_privilege using message='The document access link is no longer current.'; end if;
    perform private.service_require_hr_document_permission(grant_record.actor_employee_id,document_record.vault_code,'view');
  elsif grant_record.authorization_source='assignment' then
    if document_record.current_version_id<>grant_record.version_id or not exists(
      select 1 from private.hr_document_assignments assignment
      where assignment.id=grant_record.assignment_id and assignment.employee_id=grant_record.actor_employee_id
        and assignment.document_id=grant_record.document_id and assignment.version_id=grant_record.version_id
        and assignment.status in ('pending','completed')
    ) then raise insufficient_privilege using message='The assigned document is no longer available.'; end if;
  elsif grant_record.authorization_source='signature_recipient' then
    if not exists(
      select 1
      from private.signature_recipients recipient
      join private.signature_envelopes envelope on envelope.id=recipient.envelope_id
      where recipient.id=grant_record.signature_recipient_id and recipient.employee_id=grant_record.actor_employee_id
        and envelope.document_id=grant_record.document_id
        and (
          (envelope.status='completed' and envelope.final_document_version_id=grant_record.version_id)
          or (envelope.status in ('sent','delivered','viewed','in_progress','waiting','finalizing','correction_requested','declined') and envelope.document_version_id=grant_record.version_id)
        )
    ) then raise insufficient_privilege using message='The signature document is no longer available.'; end if;
  else
    raise insufficient_privilege using message='The document authorization source is invalid.';
  end if;
  select * into version_record from private.hr_document_versions where id=grant_record.version_id;
  if version_record.id is null or private.hr_document_latest_scan_state(version_record.id)<>'clean' then
    raise insufficient_privilege using message='The document is no longer available.';
  end if;
  insert into private.hr_document_access_events(document_id,version_id,action,actor_employee_id,request_id,reason,metadata)
  values(grant_record.document_id,grant_record.version_id,grant_record.action,grant_record.actor_employee_id,
    coalesce(nullif(btrim(target_request_id),''),grant_record.request_id),grant_record.reason,
    jsonb_build_object('grantId',grant_record.id,'mfaMethod',grant_record.mfa_method,
      'authorizationSource',grant_record.authorization_source,'assignmentId',grant_record.assignment_id,
      'signatureRecipientId',grant_record.signature_recipient_id));
  return jsonb_build_object('documentId',grant_record.document_id,'versionId',grant_record.version_id,
    'action',grant_record.action,'bucket',version_record.storage_bucket,'objectKey',version_record.object_key,
    'filename',version_record.sanitized_filename,'mimeType',version_record.detected_mime_type);
end
$$;

create or replace function public.service_get_signature_finalization_payload(target_envelope_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare envelope_record private.signature_envelopes%rowtype; version_record private.hr_document_versions%rowtype; document_record private.hr_documents%rowtype; job_record private.document_processing_jobs%rowtype;
begin
  perform private.document_studio_require_service();
  select * into envelope_record from private.signature_envelopes where id=target_envelope_id for update;
  if envelope_record.id is null or envelope_record.status<>'finalizing' then raise check_violation using message='The signature envelope is not ready for finalization.'; end if;
  if exists(select 1 from private.signature_recipients recipient where recipient.envelope_id=envelope_record.id and recipient.status<>'completed') then raise check_violation using message='All required recipients must complete their assigned actions.'; end if;
  select * into job_record from private.document_processing_jobs where envelope_id=envelope_record.id and job_type='finalize_signature' for update;
  if job_record.id is null then raise no_data_found using message='The finalization job was not found.'; end if;
  if job_record.status='completed' then return jsonb_build_object('state','completed','envelopeId',envelope_record.id,'finalVersionId',envelope_record.final_document_version_id); end if;
  if job_record.status not in ('queued','failed','processing')
    or (job_record.status in ('queued','failed') and job_record.available_at>clock_timestamp())
    or (job_record.status='processing' and job_record.leased_at>clock_timestamp()-interval '10 minutes') then
    raise check_violation using message='The signature finalization job is not available for processing.';
  end if;
  update private.document_processing_jobs set status='processing',attempt_count=attempt_count+1,leased_at=clock_timestamp(),lease_owner='sygshift-worker',last_error_code=null where id=job_record.id;
  select * into document_record from private.hr_documents where id=envelope_record.document_id;
  select * into version_record from private.hr_document_versions where id=envelope_record.document_version_id;
  return jsonb_build_object(
    'state','processing','jobId',job_record.id,'envelopeId',envelope_record.id,'documentId',document_record.id,
    'documentTitle',document_record.title,'sourceVersionId',version_record.id,'sourceVersionNumber',version_record.version_number,
    'sourceBucket',version_record.storage_bucket,'sourceObjectKey',version_record.object_key,'sourceFilename',version_record.sanitized_filename,
    'sourceMimeType',version_record.detected_mime_type,'sourceChecksum',version_record.sha256_checksum,
    'nextVersionNumber',(select coalesce(max(version.version_number),0)+1 from private.hr_document_versions version where version.document_id=document_record.id),
    'policy',(select jsonb_build_object('id',policy.id,'name',policy.name,'code',policy.policy_code,'versionNumber',policy.version_number,'consentText',policy.consent_text,'consentVersion',policy.consent_version,'organizationalSealRequired',policy.organizational_seal_required,'auditCertificateRequired',policy.audit_certificate_required) from private.document_policies policy where policy.id=envelope_record.policy_id),
    'recipients',coalesce((select jsonb_agg(jsonb_build_object(
      'id',recipient.id,'employeeId',recipient.employee_id,'role',recipient.recipient_role,'requiredAction',recipient.required_action,'routingOrder',recipient.routing_order,
      'legalName',btrim(concat_ws(' ',employee.first_name,employee.middle_name,employee.last_name)),'actedAt',recipient.acted_at,
      'authentication',(select jsonb_build_object('method',evidence.authentication_method,'tier',evidence.authentication_tier,'verifiedAt',evidence.verified_at,'requestId',evidence.request_id) from private.signature_authentication_evidence evidence where evidence.recipient_id=recipient.id order by evidence.created_at desc limit 1),
      'consent',(select jsonb_build_object('text',consent.consent_text,'version',consent.consent_version,'shownAt',consent.shown_at,'acceptedAt',consent.accepted_at,'action',consent.confirmation_action) from private.signature_consent_records consent where consent.recipient_id=recipient.id order by consent.accepted_at desc limit 1),
      'signature',(select jsonb_build_object('method',event.signature_method,'style',event.signature_style,'displayName',event.display_name,'bucket',event.appearance_bucket,'objectKey',event.appearance_object_key,'checksum',event.appearance_checksum,'occurredAt',event.occurred_at) from private.signature_events event where event.recipient_id=recipient.id and event.signature_method is not null order by event.occurred_at desc limit 1),
      'fields',coalesce((select jsonb_agg(jsonb_build_object('fieldKey',field.field_key,'valueText',value.value_text,'valueJson',value.value_json,'pageNumber',field.page_number,'xRatio',field.x_ratio,'yRatio',field.y_ratio,'widthRatio',field.width_ratio,'heightRatio',field.height_ratio,'fieldType',field.field_type,'label',field.label,'required',field.required) order by field.tab_order) from private.document_field_definitions field left join private.signature_field_values value on value.field_definition_id=field.id and value.recipient_id=recipient.id where field.template_version_id=envelope_record.template_version_id and (field.signer_role_code is null or field.signer_role_code=recipient.recipient_role)),'[]'::jsonb)
    ) order by recipient.routing_order,recipient.assigned_at) from private.signature_recipients recipient left join public.employees employee on employee.id=recipient.employee_id where recipient.envelope_id=envelope_record.id),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(jsonb_build_object('eventType',event.event_type,'occurredAt',event.occurred_at,'actorEmployeeId',event.actor_employee_id,'recipientId',event.recipient_id,'reason',event.event_reason,'requestId',event.request_id,'sourceChecksum',event.source_checksum) order by event.occurred_at,event.id) from private.signature_events event where event.envelope_id=envelope_record.id),'[]'::jsonb)
  );
end
$$;

create or replace function public.service_list_signature_finalization_jobs(target_limit integer default 2)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare safe_limit integer:=greatest(1,least(coalesce(target_limit,2),5));
begin
  perform private.document_studio_require_service();
  if not exists(select 1 from private.hr_document_release_gate where singleton and enabled)
    or not exists(select 1 from private.document_studio_release_gate where gate='processing' and enabled)
    or not exists(select 1 from private.document_studio_release_gate where gate='signatures' and enabled) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('envelopeId',candidate.envelope_id) order by candidate.available_at,candidate.created_at)
    from (
      select job.envelope_id,job.available_at,job.created_at
      from private.document_processing_jobs job
      join private.signature_envelopes envelope on envelope.id=job.envelope_id
      where job.job_type='finalize_signature'
        and envelope.status='finalizing'
        and (
          (job.status in ('queued','failed') and job.available_at<=clock_timestamp())
          or (job.status='processing' and job.leased_at<=clock_timestamp()-interval '10 minutes')
        )
      order by job.available_at,job.created_at
      limit safe_limit
    ) candidate
  ),'[]'::jsonb);
end
$$;

create or replace function public.service_commit_signature_finalization(
  target_envelope_id uuid,target_job_id uuid,target_final_bucket text,target_final_object_key text,target_final_filename text,
  target_final_size_bytes bigint,target_final_checksum text,target_audit_bucket text,target_audit_object_key text,
  target_audit_filename text,target_audit_size_bytes bigint,target_audit_checksum text,target_package_checksum text,
  target_generated_by_service text,target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare envelope_record private.signature_envelopes%rowtype; source_version private.hr_document_versions%rowtype; final_version_id uuid; next_version integer; prior_state text;
begin
  perform private.document_studio_require_service();
  if target_final_checksum !~ '^[a-f0-9]{64}$' or target_audit_checksum !~ '^[a-f0-9]{64}$' or target_package_checksum !~ '^[a-f0-9]{64}$' then raise check_violation using message='Finalization checksums are invalid.'; end if;
  if target_final_object_key !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$' or target_audit_object_key !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$' then raise check_violation using message='Finalization storage keys are invalid.'; end if;
  select * into envelope_record from private.signature_envelopes where id=target_envelope_id for update;
  if envelope_record.id is null then raise no_data_found using message='The signature envelope was not found.'; end if;
  if envelope_record.status='completed' then return jsonb_build_object('id',envelope_record.id,'status','completed','finalVersionId',envelope_record.final_document_version_id,'idempotent',true); end if;
  if envelope_record.status<>'finalizing' or not exists(select 1 from private.document_processing_jobs job where job.id=target_job_id and job.envelope_id=envelope_record.id and job.status='processing') then raise check_violation using message='The signature finalization lease is not active.'; end if;
  select * into source_version from private.hr_document_versions where id=envelope_record.document_version_id;
  select coalesce(max(version.version_number),0)+1 into next_version from private.hr_document_versions version where version.document_id=envelope_record.document_id;
  insert into private.hr_document_versions(document_id,version_number,storage_bucket,object_key,original_filename,sanitized_filename,extension,declared_mime_type,detected_mime_type,size_bytes,sha256_checksum,replacement_reason,uploaded_by,upload_source,idempotency_key)
  values(envelope_record.document_id,next_version,target_final_bucket,target_final_object_key,target_final_filename,target_final_filename,'pdf','application/pdf','application/pdf',target_final_size_bytes,target_final_checksum,'Final immutable signed copy generated from signature envelope '||envelope_record.id::text,envelope_record.created_by,'signature_service',gen_random_uuid())
  returning id into final_version_id;
  insert into private.hr_document_scan_events(version_id,state,scanner_name,scanner_version,evidence_sha256,details,recorded_by)
  values(final_version_id,'clean','SygShift trusted PDF finalizer','1',target_final_checksum,'Generated only from a clean immutable source plus recorded form and signature evidence.',envelope_record.created_by);
  insert into private.signature_audit_certificates(envelope_id,document_id,final_document_version_id,storage_bucket,object_key,filename,checksum,final_package_checksum,seal_status,generated_by_service)
  values(envelope_record.id,envelope_record.document_id,final_version_id,target_audit_bucket,target_audit_object_key,target_audit_filename,target_audit_checksum,target_package_checksum,'not_required',target_generated_by_service);
  select lifecycle_state into prior_state from private.hr_documents where id=envelope_record.document_id for update;
  update private.hr_documents set current_version_id=final_version_id,lifecycle_state='locked_final',updated_at=clock_timestamp() where id=envelope_record.document_id;
  update private.signature_envelopes set status='completed',completed_at=clock_timestamp(),final_document_version_id=final_version_id,final_package_checksum=target_package_checksum where id=envelope_record.id;
  update private.document_processing_jobs set status='completed',completed_at=clock_timestamp(),result=jsonb_build_object('finalVersionId',final_version_id,'finalChecksum',target_final_checksum,'auditChecksum',target_audit_checksum,'packageChecksum',target_package_checksum) where id=target_job_id;
  insert into private.signature_events(envelope_id,document_id,document_version_id,actor_employee_id,event_type,event_reason,source_checksum,request_id,metadata)
  values(envelope_record.id,envelope_record.document_id,final_version_id,envelope_record.created_by,'completed','Immutable signed PDF and audit certificate generated.',target_final_checksum,nullif(btrim(target_request_id),''),jsonb_build_object('sourceVersionId',source_version.id,'sourceChecksum',source_version.sha256_checksum,'auditChecksum',target_audit_checksum,'packageChecksum',target_package_checksum));
  insert into private.document_lifecycle_events(document_id,version_id,actor_employee_id,from_state,to_state,reason,request_id,metadata)
  values(envelope_record.document_id,final_version_id,envelope_record.created_by,prior_state,'locked_final','Signature workflow completed and the final evidence package was locked.',nullif(btrim(target_request_id),''),jsonb_build_object('envelopeId',envelope_record.id,'sourceVersionId',source_version.id,'sourceChecksum',source_version.sha256_checksum,'finalChecksum',target_final_checksum));
  return jsonb_build_object('id',envelope_record.id,'status','completed','finalVersionId',final_version_id,'completedAt',clock_timestamp());
end
$$;

create or replace function public.service_fail_signature_finalization(target_envelope_id uuid,target_job_id uuid,target_error_code text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare attempts integer;
begin
  perform private.document_studio_require_service();
  update private.document_processing_jobs set status=case when attempt_count>=5 then 'dead_letter' else 'failed' end,
    available_at=case when attempt_count>=5 then available_at else clock_timestamp()+make_interval(secs=>least(3600,30*(2^greatest(0,attempt_count-1))::integer)) end,
    failed_at=clock_timestamp(),last_error_code=left(coalesce(nullif(btrim(target_error_code),''),'finalization_failed'),120),lease_owner=null,leased_at=null
  where id=target_job_id and envelope_id=target_envelope_id and status='processing' returning attempt_count into attempts;
  if attempts is null then raise check_violation using message='The signature finalization lease is not active.'; end if;
  return jsonb_build_object('envelopeId',target_envelope_id,'status',case when attempts>=5 then 'dead_letter' else 'failed' end,'attemptCount',attempts);
end $$;

create or replace function public.service_get_signature_audit_certificate_access(
  target_actor_id uuid,target_envelope_id uuid,target_reason text,target_mfa_method text,target_mfa_verified_at timestamptz,target_request_id text default null
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare effective_permissions text[]:=private.document_studio_require_actor(target_actor_id); certificate_record private.signature_audit_certificates%rowtype; envelope_record private.signature_envelopes%rowtype;
begin
  perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at);
  if btrim(coalesce(target_reason,''))='' then raise check_violation using message='An access reason is required.'; end if;
  select * into envelope_record from private.signature_envelopes where id=target_envelope_id and status='completed';
  if envelope_record.id is null then raise no_data_found using message='The completed signature envelope was not found.'; end if;
  if not ('documents.audit.view'=any(effective_permissions) or exists(select 1 from private.signature_recipients recipient where recipient.envelope_id=envelope_record.id and recipient.employee_id=target_actor_id)) then raise insufficient_privilege using message='The signature audit certificate is unavailable.'; end if;
  select * into certificate_record from private.signature_audit_certificates where envelope_id=envelope_record.id;
  if certificate_record.id is null then raise no_data_found using message='The signature audit certificate has not been generated.'; end if;
  insert into private.hr_document_access_events(document_id,version_id,action,actor_employee_id,request_id,reason,metadata)
  values(envelope_record.document_id,envelope_record.final_document_version_id,'download',target_actor_id,nullif(btrim(target_request_id),''),btrim(target_reason),jsonb_build_object('artifact','signature_audit_certificate','envelopeId',envelope_record.id,'certificateId',certificate_record.id,'mfaMethod',target_mfa_method));
  return jsonb_build_object('bucket',certificate_record.storage_bucket,'objectKey',certificate_record.object_key,'filename',certificate_record.filename,'mimeType','application/pdf','checksum',certificate_record.checksum);
end $$;

revoke all on function private.document_studio_prevent_append_only_change() from public,anon,authenticated;
revoke all on function private.document_studio_guard_template_version() from public,anon,authenticated;
revoke all on function private.document_studio_require_service() from public,anon,authenticated;
revoke all on function private.document_studio_require_actor(uuid) from public,anon,authenticated;
revoke all on function private.document_studio_require_permission(uuid,text) from public,anon,authenticated;
revoke all on function private.document_studio_require_recent_mfa(text,timestamptz,interval) from public,anon,authenticated;
revoke all on function private.document_studio_can_view_document(uuid,uuid,text[]) from public,anon,authenticated;
revoke all on function private.document_studio_assert_association_target(text,uuid) from public,anon,authenticated;
revoke all on function public.service_get_document_studio_workspace(uuid,integer,integer,text,text) from public,anon,authenticated;
revoke all on function public.service_create_document_policy(uuid,jsonb,text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.service_create_document_template(uuid,uuid,uuid,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.service_add_document_template_field(uuid,uuid,jsonb,text,timestamptz) from public,anon,authenticated;
revoke all on function public.service_publish_document_template(uuid,uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function public.service_link_document_record(uuid,uuid,text,uuid,text,boolean,text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.service_create_signature_envelope(uuid,uuid,uuid,uuid,text,text,timestamptz,jsonb,uuid,text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.service_send_signature_envelope(uuid,uuid,text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.service_get_my_signature_workspace(uuid) from public,anon,authenticated;
revoke all on function public.service_get_my_document_action_count(uuid) from public,anon,authenticated;
revoke all on function public.service_get_my_signature_adoption_access(uuid,text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.service_record_signature_action(uuid,uuid,text,jsonb,text,timestamptz,text,text,text,text,text,text,boolean,text,text,timestamptz,text,text) from public,anon,authenticated;
revoke all on function public.service_void_signature_envelope(uuid,uuid,text,text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.service_issue_my_signature_document_access_grant(uuid,uuid,text,text,text,timestamptz,text,text) from public,anon,authenticated;
revoke all on function public.service_get_signature_finalization_payload(uuid) from public,anon,authenticated;
revoke all on function public.service_list_signature_finalization_jobs(integer) from public,anon,authenticated;
revoke all on function public.service_commit_signature_finalization(uuid,uuid,text,text,text,bigint,text,text,text,text,bigint,text,text,text,text) from public,anon,authenticated;
revoke all on function public.service_fail_signature_finalization(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.service_get_signature_audit_certificate_access(uuid,uuid,text,text,timestamptz,text) from public,anon,authenticated;

grant execute on function public.service_get_document_studio_workspace(uuid,integer,integer,text,text) to service_role;
grant execute on function public.service_create_document_policy(uuid,jsonb,text,timestamptz,text) to service_role;
grant execute on function public.service_create_document_template(uuid,uuid,uuid,text,text,text,text,text,text,timestamptz,text) to service_role;
grant execute on function public.service_add_document_template_field(uuid,uuid,jsonb,text,timestamptz) to service_role;
grant execute on function public.service_publish_document_template(uuid,uuid,text,timestamptz) to service_role;
grant execute on function public.service_link_document_record(uuid,uuid,text,uuid,text,boolean,text,timestamptz,text) to service_role;
grant execute on function public.service_create_signature_envelope(uuid,uuid,uuid,uuid,text,text,timestamptz,jsonb,uuid,text,timestamptz,text) to service_role;
grant execute on function public.service_send_signature_envelope(uuid,uuid,text,timestamptz,text) to service_role;
grant execute on function public.service_get_my_signature_workspace(uuid) to service_role;
grant execute on function public.service_get_my_document_action_count(uuid) to service_role;
grant execute on function public.service_get_my_signature_adoption_access(uuid,text,timestamptz,text) to service_role;
grant execute on function public.service_record_signature_action(uuid,uuid,text,jsonb,text,timestamptz,text,text,text,text,text,text,boolean,text,text,timestamptz,text,text) to service_role;
grant execute on function public.service_void_signature_envelope(uuid,uuid,text,text,timestamptz,text) to service_role;
grant execute on function public.service_issue_my_signature_document_access_grant(uuid,uuid,text,text,text,timestamptz,text,text) to service_role;
grant execute on function public.service_get_signature_finalization_payload(uuid) to service_role;
grant execute on function public.service_list_signature_finalization_jobs(integer) to service_role;
grant execute on function public.service_commit_signature_finalization(uuid,uuid,text,text,text,bigint,text,text,text,text,bigint,text,text,text,text) to service_role;
grant execute on function public.service_fail_signature_finalization(uuid,uuid,text) to service_role;
grant execute on function public.service_get_signature_audit_certificate_access(uuid,uuid,text,text,timestamptz,text) to service_role;

update private.document_studio_release_gate
set enabled=false,enabled_at=null,enabled_by=null,evidence_reference=null,updated_at=clock_timestamp();

do $$
declare baseline document_studio_preservation_baseline%rowtype;
begin
  select * into baseline from document_studio_preservation_baseline;
  if baseline.employee_count<>(select count(*) from public.employees)
    or baseline.employee_role_count<>(select count(*) from public.employee_access_roles)
    or baseline.permission_override_count<>(select count(*) from public.employee_permission_overrides)
    or baseline.document_count<>(select count(*) from private.hr_documents)
    or baseline.document_version_count<>(select count(*) from private.hr_document_versions)
    or baseline.document_access_event_count<>(select count(*) from private.hr_document_access_events) then
    raise exception 'Document Studio migration changed protected production records.';
  end if;
end
$$;

commit;
