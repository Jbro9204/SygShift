begin;

create table if not exists public.role_permissions (
  role public.app_role not null,
  permission text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (role, permission),
  constraint role_permissions_permission_present check (btrim(permission) <> '')
);

create table if not exists public.credential_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  legacy_kind public.credential_kind,
  name text not null,
  category text not null default 'license',
  description text,
  issuing_authority text,
  expiration_required boolean not null default true,
  standard_validity_days integer,
  affects_work_eligibility boolean not null default true,
  warning_days integer[] not null default array[90, 60, 30],
  renewal_instructions text,
  employee_email_instructions text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credential_types_code_format check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint credential_types_name_present check (btrim(name) <> ''),
  constraint credential_types_category_present check (btrim(category) <> ''),
  constraint credential_types_standard_validity_positive check (standard_validity_days is null or standard_validity_days > 0)
);

create table if not exists public.credential_requirements (
  id uuid primary key default gen_random_uuid(),
  credential_type_id uuid not null references public.credential_types(id) on delete restrict,
  role public.app_role,
  employment_type public.employment_type,
  site_id uuid references public.sites(id) on delete restrict,
  post_id uuid references public.posts(id) on delete restrict,
  jurisdiction text,
  required boolean not null default true,
  override_allowed boolean not null default false,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credential_requirements_scope_present check (
    role is not null
    or employment_type is not null
    or site_id is not null
    or post_id is not null
    or nullif(btrim(coalesce(jurisdiction, '')), '') is not null
  )
);

alter table public.employee_credentials
  add column if not exists credential_type_id uuid references public.credential_types(id) on delete restrict,
  add column if not exists renewal_status text not null default 'not_started',
  add column if not exists employee_notes text,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid references public.employees(id) on delete restrict,
  add column if not exists rejection_reason text,
  add column if not exists archived_at timestamptz;

alter table public.employee_credentials
  drop constraint if exists employee_credentials_renewal_status_check;

alter table public.employee_credentials
  add constraint employee_credentials_renewal_status_check
  check (renewal_status in (
    'not_started',
    'started',
    'submitted',
    'awaiting_issuing_authority',
    'approved',
    'rejected',
    'completed'
  ));

create table if not exists public.employee_credential_documents (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.employee_credentials(id) on delete restrict,
  storage_path text not null unique,
  original_filename text not null,
  content_type text,
  byte_size bigint,
  uploaded_by uuid references public.employees(id) on delete restrict,
  uploaded_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.employees(id) on delete restrict,
  archive_reason text,
  constraint employee_credential_documents_path_present check (btrim(storage_path) <> ''),
  constraint employee_credential_documents_filename_present check (btrim(original_filename) <> ''),
  constraint employee_credential_documents_size_positive check (byte_size is null or byte_size > 0)
);

create index if not exists credential_requirements_type_idx on public.credential_requirements(credential_type_id);
create index if not exists employee_credentials_type_employee_idx on public.employee_credentials(employee_id, credential_type_id);
create index if not exists employee_credentials_archived_idx on public.employee_credentials(archived_at);
create index if not exists employee_credential_documents_credential_idx on public.employee_credential_documents(credential_id, uploaded_at desc);

create table if not exists public.licensing_communications (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  credential_id uuid references public.employee_credentials(id) on delete set null,
  communication_type text not null,
  recipient_email text not null,
  subject text not null,
  body text not null,
  template_code text,
  sent_by uuid references public.employees(id) on delete restrict,
  sent_at timestamptz not null default now(),
  delivery_status text not null default 'recorded',
  automated boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  constraint licensing_communications_type_present check (btrim(communication_type) <> ''),
  constraint licensing_communications_recipient_email_present check (btrim(recipient_email) <> ''),
  constraint licensing_communications_subject_present check (btrim(subject) <> ''),
  constraint licensing_communications_body_present check (btrim(body) <> '')
);

create index if not exists licensing_communications_employee_idx on public.licensing_communications(employee_id, sent_at desc);
create index if not exists licensing_communications_credential_idx on public.licensing_communications(credential_id, sent_at desc);

create table if not exists public.licensing_email_templates (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  communication_type text not null,
  subject_template text not null,
  body_template text not null,
  approved boolean not null default false,
  editable_before_send boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint licensing_email_templates_code_format check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint licensing_email_templates_name_present check (btrim(name) <> ''),
  constraint licensing_email_templates_subject_present check (btrim(subject_template) <> ''),
  constraint licensing_email_templates_body_present check (btrim(body_template) <> '')
);

create table if not exists public.employee_work_eligibility_overrides (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  status text not null,
  reason text not null,
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint employee_work_eligibility_overrides_status_check check (status in ('eligible', 'eligible_with_warning', 'restricted', 'ineligible', 'pending_review')),
  constraint employee_work_eligibility_overrides_reason_present check (btrim(reason) <> ''),
  constraint employee_work_eligibility_overrides_dates check (ends_at is null or ends_at > starts_at)
);

create index if not exists employee_work_eligibility_overrides_active_idx
  on public.employee_work_eligibility_overrides(employee_id)
  where active;

create index if not exists credential_types_active_idx on public.credential_types(active, name);
create index if not exists licensing_email_templates_active_idx on public.licensing_email_templates(active, communication_type);

alter table public.role_permissions enable row level security;
alter table public.credential_types enable row level security;
alter table public.credential_requirements enable row level security;
alter table public.employee_credential_documents enable row level security;
alter table public.licensing_communications enable row level security;
alter table public.licensing_email_templates enable row level security;
alter table public.employee_work_eligibility_overrides enable row level security;

insert into public.role_permissions (role, permission)
values
  ('admin', 'licensing.view'),
  ('admin', 'licensing.manage'),
  ('admin', 'licensing.configure'),
  ('admin', 'licensing.communicate'),
  ('recruiting_licensing', 'licensing.view'),
  ('recruiting_licensing', 'licensing.manage'),
  ('recruiting_licensing', 'licensing.communicate')
on conflict (role, permission) do update
set enabled = excluded.enabled,
    updated_at = now();

insert into public.credential_types (
  code,
  legacy_kind,
  name,
  category,
  description,
  issuing_authority,
  expiration_required,
  standard_validity_days,
  affects_work_eligibility,
  warning_days,
  renewal_instructions,
  employee_email_instructions
)
values
  ('denver_security_guard_license', 'guard_license', 'Denver Security Guard License', 'license', 'City and County of Denver security guard license.', 'City and County of Denver', true, 365, true, array[90, 60, 30], 'Begin renewal before the 90-day window and upload the renewed license when issued.', 'Upload a clear copy of the renewed Denver guard license.'),
  ('armed_security_guard_credential', 'armed_guard', 'Armed Security Guard Credential', 'license', 'Armed endorsement or qualifying firearm authorization used for armed posts.', 'City and County of Denver / approved issuing authority', true, 365, true, array[90, 60, 30], 'Confirm renewal or firearm endorsement status before the expiration window becomes critical.', 'Upload current armed credential or firearm endorsement documentation.'),
  ('driver_license', 'driver_license', 'Driver''s License', 'license', 'Driver license for patrol, vehicle, or driving-required assignments.', null, true, null, true, array[90, 60, 30], 'Renew before expiration if assigned to driving duties.', 'Upload a current driver license if your assignment requires driving.'),
  ('first_aid_cpr', 'first_aid_cpr', 'First Aid / CPR Certification', 'certification', 'First Aid and CPR readiness for sites requiring medical-response certification.', null, true, null, true, array[90, 60, 30], 'Renew through an approved provider and upload the new certificate.', 'Upload a clear copy of your current First Aid / CPR certification.'),
  ('site_specific_training', 'site_training', 'Site-Specific Training', 'training', 'Client, site, or post-order training required for certain assignments.', null, false, null, true, array[90, 60, 30], 'Complete the assigned training and attach proof if applicable.', 'Complete the required site training before accepting the assignment.'),
  ('other_required_credential', 'other', 'Other Required Credential', 'other', 'Configurable credential placeholder for requirements not covered by the standard categories.', null, false, null, false, array[90, 60, 30], null, null)
on conflict (code) do update
set
  legacy_kind = excluded.legacy_kind,
  name = excluded.name,
  category = excluded.category,
  description = excluded.description,
  issuing_authority = excluded.issuing_authority,
  expiration_required = excluded.expiration_required,
  standard_validity_days = excluded.standard_validity_days,
  affects_work_eligibility = excluded.affects_work_eligibility,
  warning_days = excluded.warning_days,
  renewal_instructions = excluded.renewal_instructions,
  employee_email_instructions = excluded.employee_email_instructions,
  active = true,
  updated_at = now();

insert into public.credential_requirements (credential_type_id, role, required, override_allowed, notes)
select credential_type.id, 'guard'::public.app_role, true, false, 'Every active guard must have a current guard license.'
from public.credential_types credential_type
where credential_type.code = 'denver_security_guard_license'
on conflict do nothing;

insert into public.licensing_email_templates (
  code,
  name,
  communication_type,
  subject_template,
  body_template,
  approved,
  editable_before_send
)
values
  (
    'credential_90_day_reminder',
    '90-Day Credential Reminder',
    '90_day_reminder',
    '{{credentialName}} expires in 90 days',
    'Hello {{employeeFirstName}},\n\nOur records show your {{credentialName}} is approaching the renewal window. Current expiration date on file: {{expirationDate}}.\n\nPlease begin the renewal process and send the updated document to the licensing team once received.\n\nThank you,\nSygShift Licensing',
    true,
    true
  ),
  (
    'credential_60_day_warning',
    '60-Day Credential Warning',
    '60_day_warning',
    '{{credentialName}} renewal follow-up needed',
    'Hello {{employeeFirstName}},\n\nThis is a follow-up that your {{credentialName}} is due for renewal. Current expiration date on file: {{expirationDate}}.\n\nPlease send the updated credential or your renewal status so your work eligibility can stay current.\n\nThank you,\nSygShift Licensing',
    true,
    true
  ),
  (
    'credential_30_day_final_warning',
    '30-Day Final Credential Warning',
    '30_day_final_warning',
    'Final warning: {{credentialName}} expires soon',
    'Hello {{employeeFirstName}},\n\nYour {{credentialName}} is in the final renewal window. Current expiration date on file: {{expirationDate}}.\n\nPlease provide updated documentation immediately. Expired or missing required credentials may restrict scheduling eligibility.\n\nThank you,\nSygShift Licensing',
    true,
    true
  ),
  (
    'credential_missing_or_rejected',
    'Missing or Rejected Credential Notice',
    'missing_or_rejected_credential',
    '{{credentialName}} documentation needed',
    'Hello {{employeeFirstName}},\n\nWe need updated documentation for your {{credentialName}}. The current record is missing, incomplete, or could not be approved.\n\nPlease send a clear copy of the credential or contact the licensing team if you need help.\n\nThank you,\nSygShift Licensing',
    true,
    true
  )
on conflict (code) do update
set
  name = excluded.name,
  communication_type = excluded.communication_type,
  subject_template = excluded.subject_template,
  body_template = excluded.body_template,
  approved = excluded.approved,
  editable_before_send = excluded.editable_before_send,
  active = true,
  updated_at = now();

update public.employee_credentials credential
set credential_type_id = credential_type.id
from public.credential_types credential_type
where credential.credential_type_id is null
  and credential_type.legacy_kind = credential.kind;

create or replace function public.has_role_permission(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.role_permissions permission
    where permission.role = public.current_app_role()
      and permission.permission = required_permission
      and permission.enabled
  ), false)
$$;

create or replace function public.can_manage_licensing()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_mfa()
    and (
      public.current_app_role() = 'admin'
      or public.has_role_permission('licensing.manage')
    )
$$;

create or replace function private.require_credential_editor_mfa()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_role public.app_role := public.current_app_role();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to update credentials.';
  end if;

  if actor_role not in ('scheduler', 'supervisor', 'admin', 'recruiting_licensing')
    and not public.has_role_permission('licensing.manage')
  then
    raise insufficient_privilege using message = 'Credential editor access with MFA is required.';
  end if;

  return actor_id;
end
$$;

create or replace function private.require_licensing_mfa(required_permission text default 'licensing.view')
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required for licensing records.';
  end if;

  if public.current_app_role() <> 'admin' and not public.has_role_permission(required_permission) then
    raise insufficient_privilege using message = 'Licensing Center access is required.';
  end if;

  return actor_id;
end
$$;

create or replace function private.credential_compliance_record(
  target_employee_id uuid,
  target_credential_type_id uuid,
  target_required boolean,
  target_as_of date default current_date
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with selected_type as (
    select credential_type.*
    from public.credential_types credential_type
    where credential_type.id = target_credential_type_id
  ),
  latest_credential as (
    select credential.*
    from public.employee_credentials credential
    join selected_type credential_type on credential_type.id = target_credential_type_id
    where credential.employee_id = target_employee_id
      and credential.archived_at is null
      and (
        credential.credential_type_id = credential_type.id
        or (credential.credential_type_id is null and credential.kind = credential_type.legacy_kind)
      )
    order by credential.created_at desc
    limit 1
  ),
  document_summary as (
    select
      count(*)::integer as document_count,
      max(document.uploaded_at) as latest_document_at
    from public.employee_credential_documents document
    join latest_credential credential on credential.id = document.credential_id
    where document.archived_at is null
  ),
  communication_summary as (
    select
      max(communication.sent_at) as last_sent_at
    from public.licensing_communications communication
    join latest_credential credential on credential.id = communication.credential_id
  ),
  calculated as (
    select
      credential.id as credential_id,
      credential.kind,
      credential.status,
      credential.credential_number,
      credential.issuing_authority,
      credential.valid_from,
      credential.expires_on,
      credential.verified_at,
      credential.verified_by,
      credential.renewal_status,
      credential.notes,
      credential.employee_notes,
      credential.rejection_reason,
      case when credential.expires_on is null then null else (credential.expires_on - target_as_of) end as days_remaining,
      coalesce(document_summary.document_count, 0) as document_count,
      document_summary.latest_document_at,
      communication_summary.last_sent_at
    from latest_credential credential
    left join document_summary on true
    left join communication_summary on true
  )
  select jsonb_build_object(
    'credentialId', calculated.credential_id,
    'credentialTypeId', selected_type.id,
    'credentialTypeCode', selected_type.code,
    'credentialName', selected_type.name,
    'category', selected_type.category,
    'required', target_required,
    'affectsWorkEligibility', selected_type.affects_work_eligibility,
    'status', case
      when calculated.credential_id is null and target_required then 'Missing'
      when calculated.credential_id is null then 'Not Applicable'
      when calculated.status = 'pending' then 'Under Review'
      when calculated.status = 'revoked' then 'Revoked'
      when calculated.status = 'suspended' then 'Suspended'
      when calculated.status = 'expired' or (calculated.expires_on is not null and calculated.expires_on < target_as_of) then 'Expired'
      when calculated.rejection_reason is not null then 'Rejected'
      when calculated.renewal_status = 'submitted' then 'Renewal Submitted'
      when calculated.renewal_status in ('started', 'awaiting_issuing_authority') then 'Renewal In Progress'
      when calculated.expires_on is not null and calculated.expires_on - target_as_of <= 30 then 'Renewal Needed'
      when calculated.expires_on is not null and calculated.expires_on - target_as_of <= 90 then 'Expiring'
      when calculated.status = 'active' then 'Verified'
      else initcap(replace(coalesce(calculated.status::text, 'not_applicable'), '_', ' '))
    end,
    'complianceColor', case
      when calculated.credential_id is null and target_required and selected_type.affects_work_eligibility then 'red'
      when calculated.status in ('revoked', 'suspended', 'expired') then 'red'
      when calculated.rejection_reason is not null then 'red'
      when calculated.expires_on is not null and calculated.expires_on < target_as_of then 'red'
      when calculated.expires_on is not null and calculated.expires_on - target_as_of <= 30 then 'red'
      when calculated.status = 'pending' then 'yellow'
      when calculated.renewal_status in ('started', 'submitted', 'awaiting_issuing_authority') then 'yellow'
      when calculated.expires_on is not null and calculated.expires_on - target_as_of <= 90 then 'yellow'
      when calculated.credential_id is null then 'gray'
      when calculated.status = 'active' then 'green'
      else 'gray'
    end,
    'statusLabel', case
      when calculated.credential_id is null and target_required then 'Missing Required Credential'
      when calculated.credential_id is null then 'Not Required'
      when calculated.status in ('revoked', 'suspended') then initcap(calculated.status::text)
      when calculated.rejection_reason is not null then 'Rejected'
      when calculated.expires_on is not null and calculated.expires_on < target_as_of then 'Expired'
      when calculated.expires_on is not null and calculated.expires_on - target_as_of <= 30 then 'Expires in ' || greatest(calculated.expires_on - target_as_of, 0)::text || ' Days'
      when calculated.expires_on is not null and calculated.expires_on - target_as_of <= 60 then '60-Day Warning'
      when calculated.expires_on is not null and calculated.expires_on - target_as_of <= 90 then '90-Day Warning'
      when calculated.renewal_status = 'submitted' then 'Renewal Submitted'
      when calculated.renewal_status in ('started', 'awaiting_issuing_authority') then 'Renewal In Progress'
      when calculated.status = 'pending' then 'Awaiting Review'
      when calculated.status = 'active' then 'Compliant'
      else initcap(replace(coalesce(calculated.status::text, 'not_applicable'), '_', ' '))
    end,
    'credentialNumber', calculated.credential_number,
    'issuingAuthority', coalesce(calculated.issuing_authority, selected_type.issuing_authority),
    'issueDate', calculated.valid_from,
    'expirationDate', calculated.expires_on,
    'daysRemaining', calculated.days_remaining,
    'renewalStatus', calculated.renewal_status,
    'internalNotes', calculated.notes,
    'employeeNotes', calculated.employee_notes,
    'rejectionReason', calculated.rejection_reason,
    'documentCount', coalesce(calculated.document_count, 0),
    'latestDocumentAt', calculated.latest_document_at,
    'lastEmployeeNotification', calculated.last_sent_at
  )
  from selected_type
  left join calculated on true
$$;

create or replace function private.calculate_employee_work_eligibility(target_employee_id uuid, records jsonb)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with active_override as (
    select override.status
    from public.employee_work_eligibility_overrides override
    where override.employee_id = target_employee_id
      and override.active
      and override.starts_at <= now()
      and (override.ends_at is null or override.ends_at > now())
    order by override.created_at desc
    limit 1
  ),
  red_required as (
    select count(*)::integer as count
    from jsonb_array_elements(records) item
    where item ->> 'required' = 'true'
      and item ->> 'affectsWorkEligibility' = 'true'
      and item ->> 'complianceColor' = 'red'
  ),
  pending_required as (
    select count(*)::integer as count
    from jsonb_array_elements(records) item
    where item ->> 'required' = 'true'
      and item ->> 'affectsWorkEligibility' = 'true'
      and item ->> 'status' in ('Under Review', 'Renewal In Progress', 'Renewal Submitted')
  ),
  yellow_required as (
    select count(*)::integer as count
    from jsonb_array_elements(records) item
    where item ->> 'required' = 'true'
      and item ->> 'affectsWorkEligibility' = 'true'
      and item ->> 'complianceColor' = 'yellow'
  )
  select coalesce(
    (select status from active_override),
    case
      when (select count from red_required) > 0 then 'ineligible'
      when (select count from pending_required) > 0 then 'pending_review'
      when (select count from yellow_required) > 0 then 'eligible_with_warning'
      else 'eligible'
    end
  )
$$;

create or replace function public.get_licensing_center()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  payload jsonb;
begin
  actor_id := private.require_licensing_mfa('licensing.view');

  with employee_base as (
    select
      employee.id,
      employee.employee_number,
      employee.username,
      employee.first_name,
      employee.middle_name,
      employee.last_name,
      employee.preferred_name,
      employee.role,
      employee.employment_type,
      employee.status,
      employee.job_title,
      employee.hired_on,
      contact.personal_email,
      contact.company_email,
      contact.mobile_phone,
      profile.location_text
    from public.employees employee
    left join private.employee_contacts contact on contact.employee_id = employee.id
    left join private.employee_operational_profiles profile on profile.employee_id = employee.id
    where employee.status in ('onboarding', 'active', 'leave', 'inactive', 'separated')
  ),
  scoped_requirements as (
    select
      employee_base.id as employee_id,
      credential_type.id as credential_type_id,
      bool_or(coalesce(requirement.required, false)) as required
    from employee_base
    join public.credential_types credential_type on credential_type.active
    left join public.credential_requirements requirement
      on requirement.credential_type_id = credential_type.id
      and requirement.active
      and (requirement.role is null or requirement.role = employee_base.role)
      and (requirement.employment_type is null or requirement.employment_type = employee_base.employment_type)
    group by employee_base.id, credential_type.id
  ),
  credential_records as (
    select
      employee_base.*,
      private.credential_compliance_record(
        employee_base.id,
        scoped_requirements.credential_type_id,
        scoped_requirements.required
      ) as credential_record
    from employee_base
    join scoped_requirements on scoped_requirements.employee_id = employee_base.id
    where scoped_requirements.required
      or exists (
        select 1
        from public.employee_credentials credential
        where credential.employee_id = employee_base.id
          and credential.archived_at is null
          and (
            credential.credential_type_id = scoped_requirements.credential_type_id
            or exists (
              select 1
              from public.credential_types credential_type
              where credential_type.id = scoped_requirements.credential_type_id
                and credential_type.legacy_kind = credential.kind
            )
          )
      )
  ),
  employee_rollup as (
    select
      credential_records.id,
      jsonb_agg(credential_records.credential_record order by credential_records.credential_record ->> 'credentialName') as credentials,
      count(*) filter (where credential_records.credential_record ->> 'required' = 'true')::integer as required_count,
      count(*) filter (where credential_records.credential_record ->> 'status' = 'Verified')::integer as verified_count,
      count(*) filter (where credential_records.credential_record ->> 'status' = 'Missing')::integer as missing_count,
      min((credential_records.credential_record ->> 'expirationDate')::date) filter (where credential_records.credential_record ->> 'expirationDate' is not null) as closest_expiration,
      max(case
        when credential_records.credential_record ->> 'complianceColor' = 'red' then 3
        when credential_records.credential_record ->> 'complianceColor' = 'yellow' then 2
        when credential_records.credential_record ->> 'complianceColor' = 'green' then 1
        else 0
      end) as severity
    from credential_records
    group by credential_records.id
  ),
  employee_payload as (
    select
      jsonb_build_object(
        'employeeId', employee_base.id,
        'employeeNumber', employee_base.employee_number,
        'username', employee_base.username,
        'firstName', employee_base.first_name,
        'middleName', employee_base.middle_name,
        'lastName', employee_base.last_name,
        'preferredName', employee_base.preferred_name,
        'displayName', btrim(coalesce(employee_base.preferred_name, employee_base.first_name) || ' ' || employee_base.last_name),
        'role', employee_base.role,
        'employmentType', employee_base.employment_type,
        'employmentStatus', employee_base.status,
        'jobTitle', employee_base.job_title,
        'hiredOn', employee_base.hired_on,
        'primaryLocation', employee_base.location_text,
        'personalEmail', employee_base.personal_email,
        'companyEmail', employee_base.company_email,
        'mobilePhone', employee_base.mobile_phone,
        'credentials', coalesce(employee_rollup.credentials, '[]'::jsonb),
        'overallCompliance', case
          when coalesce(employee_rollup.severity, 0) >= 3 then 'red'
          when coalesce(employee_rollup.severity, 0) = 2 then 'yellow'
          when coalesce(employee_rollup.severity, 0) = 1 then 'green'
          else 'gray'
        end,
        'workEligibility', private.calculate_employee_work_eligibility(employee_base.id, coalesce(employee_rollup.credentials, '[]'::jsonb)),
        'requiredCredentialCount', coalesce(employee_rollup.required_count, 0),
        'verifiedCredentialCount', coalesce(employee_rollup.verified_count, 0),
        'missingCredentialCount', coalesce(employee_rollup.missing_count, 0),
        'closestExpirationDate', employee_rollup.closest_expiration,
        'lastEmployeeNotification', (
          select max(communication.sent_at)
          from public.licensing_communications communication
          where communication.employee_id = employee_base.id
        ),
        'affectedFutureShiftCount', (
          select count(distinct shift.id)::integer
          from public.shifts shift
          join public.shift_assignments assignment on assignment.shift_id = shift.id
          where assignment.employee_id = employee_base.id
            and assignment.status in ('assigned', 'confirmed')
            and shift.starts_at >= now()
            and shift.requires_armed
            and not public.has_valid_credential(employee_base.id, 'armed_guard', (shift.starts_at at time zone shift.time_zone)::date)
        )
      ) as employee
    from employee_base
    left join employee_rollup on employee_rollup.id = employee_base.id
  ),
  all_employees as (
    select jsonb_agg(employee_payload.employee order by employee_payload.employee ->> 'displayName') as employees
    from employee_payload
  ),
  all_credential_records as (
    select jsonb_agg(
      credential_records.credential_record
      || jsonb_build_object(
        'employeeId', credential_records.id,
        'employeeName', btrim(coalesce(credential_records.preferred_name, credential_records.first_name) || ' ' || credential_records.last_name),
        'employeeNumber', credential_records.employee_number,
        'role', credential_records.role,
        'employmentStatus', credential_records.status,
        'jobTitle', credential_records.job_title,
        'primaryLocation', credential_records.location_text,
        'contactEmail', coalesce(credential_records.company_email, credential_records.personal_email)
      )
      order by
        nullif(credential_records.credential_record ->> 'expirationDate', '')::date nulls last,
        credential_records.last_name,
        credential_records.first_name
    ) as records
    from credential_records
  ),
  summary as (
    select jsonb_build_object(
      'fullyCompliantEmployees', count(*) filter (where employee ->> 'overallCompliance' = 'green'),
      'expiring90', (
        select count(*) from credential_records
        where (credential_record ->> 'daysRemaining')::integer between 61 and 90
      ),
      'expiring60', (
        select count(*) from credential_records
        where (credential_record ->> 'daysRemaining')::integer between 31 and 60
      ),
      'expiring30', (
        select count(*) from credential_records
        where (credential_record ->> 'daysRemaining')::integer between 0 and 30
      ),
      'expired', (
        select count(*) from credential_records
        where credential_record ->> 'statusLabel' = 'Expired'
      ),
      'missingRequired', (
        select count(*) from credential_records
        where credential_record ->> 'statusLabel' = 'Missing Required Credential'
      ),
      'awaitingReview', (
        select count(*) from credential_records
        where credential_record ->> 'status' = 'Under Review'
      ),
      'rejected', (
        select count(*) from credential_records
        where credential_record ->> 'status' = 'Rejected'
      ),
      'renewalsInProgress', (
        select count(*) from credential_records
        where credential_record ->> 'status' in ('Renewal In Progress', 'Renewal Submitted')
      ),
      'ineligibleEmployees', count(*) filter (where employee ->> 'workEligibility' = 'ineligible')
    ) as totals
    from employee_payload
  )
  select jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'currentEmployeeId', actor_id,
    'permissions', jsonb_build_object(
      'canManage', public.has_role_permission('licensing.manage') or public.current_app_role() = 'admin',
      'canConfigure', public.has_role_permission('licensing.configure') or public.current_app_role() = 'admin',
      'canCommunicate', public.has_role_permission('licensing.communicate') or public.current_app_role() = 'admin'
    ),
    'summary', summary.totals,
    'credentialTypes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', credential_type.id,
        'code', credential_type.code,
        'legacyKind', credential_type.legacy_kind,
        'name', credential_type.name,
        'category', credential_type.category,
        'description', credential_type.description,
        'issuingAuthority', credential_type.issuing_authority,
        'expirationRequired', credential_type.expiration_required,
        'affectsWorkEligibility', credential_type.affects_work_eligibility,
        'warningDays', credential_type.warning_days,
        'renewalInstructions', credential_type.renewal_instructions,
        'employeeEmailInstructions', credential_type.employee_email_instructions,
        'active', credential_type.active
      ) order by credential_type.name)
      from public.credential_types credential_type
      where credential_type.active
    ), '[]'::jsonb),
    'records', coalesce((select records from all_credential_records), '[]'::jsonb),
    'employees', coalesce((select employees from all_employees), '[]'::jsonb)
  )
  into payload
  from summary;

  return payload;
end
$$;

create or replace function public.upsert_licensing_employee(
  target_employee_id uuid default null,
  target_first_name text default null,
  target_middle_name text default null,
  target_last_name text default null,
  target_preferred_name text default null,
  target_job_title text default null,
  target_employment_type public.employment_type default 'hourly',
  target_status public.employee_status default 'onboarding',
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null,
  target_role public.app_role default 'guard'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  actor_role public.app_role := public.current_app_role();
  employee_id uuid := target_employee_id;
  existing_role public.app_role;
begin
  actor_id := private.require_licensing_mfa('licensing.manage');

  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;

  if employee_id is null and actor_role <> 'admin' then
    target_role := 'guard';
  end if;

  if target_personal_email is not null
    and btrim(target_personal_email) <> ''
    and btrim(target_personal_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The personal email address is invalid.';
  end if;

  if target_company_email is not null
    and btrim(target_company_email) <> ''
    and btrim(target_company_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The company email address is invalid.';
  end if;

  if employee_id is null then
    insert into public.employees (
      username,
      first_name,
      middle_name,
      last_name,
      preferred_name,
      role,
      employment_type,
      status,
      job_title
    ) values (
      private.generate_username(target_first_name, target_last_name),
      btrim(target_first_name),
      nullif(btrim(coalesce(target_middle_name, '')), ''),
      btrim(target_last_name),
      nullif(btrim(coalesce(target_preferred_name, '')), ''),
      target_role,
      target_employment_type,
      target_status,
      nullif(btrim(coalesce(target_job_title, '')), '')
    )
    returning id into employee_id;

    insert into private.employee_contacts (
      employee_id,
      personal_email,
      company_email,
      mobile_phone
    ) values (
      employee_id,
      nullif(btrim(coalesce(target_personal_email, '')), ''),
      nullif(btrim(coalesce(target_company_email, '')), ''),
      nullif(btrim(coalesce(target_mobile_phone, '')), '')
    );
  else
    select employee.role into existing_role
    from public.employees employee
    where employee.id = employee_id;

    if existing_role is null then
      raise no_data_found using message = 'Employee was not found.';
    end if;

    if actor_role <> 'admin' then
      target_role := existing_role;
    end if;

    update public.employees
    set
      first_name = btrim(target_first_name),
      middle_name = nullif(btrim(coalesce(target_middle_name, '')), ''),
      last_name = btrim(target_last_name),
      preferred_name = nullif(btrim(coalesce(target_preferred_name, '')), ''),
      role = target_role,
      employment_type = target_employment_type,
      status = target_status,
      job_title = nullif(btrim(coalesce(target_job_title, '')), ''),
      updated_at = now()
    where id = employee_id;

    insert into private.employee_contacts (
      employee_id,
      personal_email,
      company_email,
      mobile_phone
    ) values (
      employee_id,
      nullif(btrim(coalesce(target_personal_email, '')), ''),
      nullif(btrim(coalesce(target_company_email, '')), ''),
      nullif(btrim(coalesce(target_mobile_phone, '')), '')
    )
    on conflict (employee_id) do update
    set
      personal_email = excluded.personal_email,
      company_email = excluded.company_email,
      mobile_phone = excluded.mobile_phone,
      updated_at = now();
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employees',
    case when target_employee_id is null then 'LICENSING_EMPLOYEE_CREATE' else 'LICENSING_EMPLOYEE_UPDATE' end,
    employee_id::text,
    jsonb_build_object(
      'employeeId', employee_id,
      'firstName', btrim(target_first_name),
      'lastName', btrim(target_last_name),
      'role', target_role,
      'employmentType', target_employment_type,
      'employmentStatus', target_status
    )
  );

  return public.get_licensing_center();
end
$$;

create or replace function public.upsert_licensing_credential(
  target_employee_id uuid,
  target_credential_type_id uuid,
  target_status public.credential_status,
  target_credential_number text default null,
  target_issuing_authority text default null,
  target_valid_from date default null,
  target_expires_on date default null,
  target_renewal_status text default 'not_started',
  target_notes text default null,
  target_employee_notes text default null,
  target_rejection_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  credential_id uuid;
  credential_type_record public.credential_types%rowtype;
  clean_number text := nullif(btrim(coalesce(target_credential_number, '')), '');
  clean_notes text := nullif(btrim(coalesce(target_notes, '')), '');
  clean_employee_notes text := nullif(btrim(coalesce(target_employee_notes, '')), '');
  clean_rejection_reason text := nullif(btrim(coalesce(target_rejection_reason, '')), '');
begin
  actor_id := private.require_licensing_mfa('licensing.manage');

  select * into credential_type_record
  from public.credential_types credential_type
  where credential_type.id = target_credential_type_id
    and credential_type.active;

  if credential_type_record.id is null then
    raise no_data_found using message = 'Credential type was not found.';
  end if;

  if not exists (select 1 from public.employees employee where employee.id = target_employee_id) then
    raise no_data_found using message = 'Employee was not found.';
  end if;

  if target_expires_on is not null and target_valid_from is not null and target_expires_on < target_valid_from then
    raise check_violation using message = 'Credential expiration cannot be before the issue date.';
  end if;

  if credential_type_record.expiration_required and target_status = 'active' and target_expires_on is null then
    raise check_violation using message = 'An active credential of this type requires an expiration date.';
  end if;

  if target_renewal_status not in ('not_started', 'started', 'submitted', 'awaiting_issuing_authority', 'approved', 'rejected', 'completed') then
    raise check_violation using message = 'The renewal status is not valid.';
  end if;

  select credential.id into credential_id
  from public.employee_credentials credential
  where credential.employee_id = target_employee_id
    and credential.archived_at is null
    and (
      credential.credential_type_id = target_credential_type_id
      or (credential.credential_type_id is null and credential.kind = credential_type_record.legacy_kind)
    )
  order by credential.created_at desc
  limit 1;

  if credential_id is null then
    insert into public.employee_credentials (
      employee_id,
      credential_type_id,
      kind,
      status,
      credential_number,
      issuing_authority,
      valid_from,
      expires_on,
      verified_at,
      verified_by,
      renewal_status,
      notes,
      employee_notes,
      rejected_at,
      rejected_by,
      rejection_reason
    ) values (
      target_employee_id,
      target_credential_type_id,
      coalesce(credential_type_record.legacy_kind, 'other'::public.credential_kind),
      target_status,
      clean_number,
      nullif(btrim(coalesce(target_issuing_authority, '')), ''),
      target_valid_from,
      target_expires_on,
      case when target_status = 'active' then clock_timestamp() else null end,
      case when target_status = 'active' then actor_id else null end,
      target_renewal_status,
      clean_notes,
      clean_employee_notes,
      case when clean_rejection_reason is not null then clock_timestamp() else null end,
      case when clean_rejection_reason is not null then actor_id else null end,
      clean_rejection_reason
    )
    returning id into credential_id;
  else
    update public.employee_credentials
    set
      credential_type_id = target_credential_type_id,
      kind = coalesce(credential_type_record.legacy_kind, kind),
      status = target_status,
      credential_number = clean_number,
      issuing_authority = nullif(btrim(coalesce(target_issuing_authority, '')), ''),
      valid_from = target_valid_from,
      expires_on = target_expires_on,
      verified_at = case when target_status = 'active' then coalesce(verified_at, clock_timestamp()) else verified_at end,
      verified_by = case when target_status = 'active' then coalesce(verified_by, actor_id) else verified_by end,
      renewal_status = target_renewal_status,
      notes = clean_notes,
      employee_notes = clean_employee_notes,
      rejected_at = case when clean_rejection_reason is not null then coalesce(rejected_at, clock_timestamp()) else null end,
      rejected_by = case when clean_rejection_reason is not null then coalesce(rejected_by, actor_id) else null end,
      rejection_reason = clean_rejection_reason,
      updated_at = now()
    where id = credential_id;
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employee_credentials',
    'LICENSING_CREDENTIAL_UPSERT',
    credential_id::text,
    (
      select to_jsonb(credential)
      from public.employee_credentials credential
      where credential.id = credential_id
    )
  );

  return public.get_licensing_center();
end
$$;

create or replace function public.record_licensing_credential_document(
  target_credential_id uuid,
  target_storage_path text,
  target_original_filename text,
  target_content_type text default null,
  target_byte_size bigint default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  target_employee_id uuid;
  document_id uuid;
begin
  actor_id := private.require_licensing_mfa('licensing.manage');

  select credential.employee_id into target_employee_id
  from public.employee_credentials credential
  where credential.id = target_credential_id
    and credential.archived_at is null;

  if target_employee_id is null then
    raise no_data_found using message = 'Credential was not found.';
  end if;

  insert into public.employee_credential_documents (
    credential_id,
    storage_path,
    original_filename,
    content_type,
    byte_size,
    uploaded_by
  ) values (
    target_credential_id,
    btrim(target_storage_path),
    btrim(target_original_filename),
    nullif(btrim(coalesce(target_content_type, '')), ''),
    target_byte_size,
    actor_id
  )
  returning id into document_id;

  update public.employee_credentials
  set document_path = btrim(target_storage_path),
      updated_at = now()
  where id = target_credential_id;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employee_credential_documents',
    'LICENSING_DOCUMENT_UPLOAD',
    document_id::text,
    jsonb_build_object(
      'credentialId', target_credential_id,
      'employeeId', target_employee_id,
      'storagePath', target_storage_path,
      'originalFilename', target_original_filename
    )
  );

  return public.get_licensing_center();
end
$$;

create or replace function public.record_licensing_communication(
  target_employee_id uuid,
  target_credential_id uuid,
  target_communication_type text,
  target_recipient_email text,
  target_subject text,
  target_body text,
  target_template_code text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  communication_id uuid;
begin
  actor_id := private.require_licensing_mfa('licensing.communicate');

  insert into public.licensing_communications (
    employee_id,
    credential_id,
    communication_type,
    recipient_email,
    subject,
    body,
    template_code,
    sent_by,
    delivery_status,
    automated
  ) values (
    target_employee_id,
    target_credential_id,
    btrim(target_communication_type),
    btrim(target_recipient_email),
    btrim(target_subject),
    btrim(target_body),
    nullif(btrim(coalesce(target_template_code, '')), ''),
    actor_id,
    'recorded',
    false
  )
  returning id into communication_id;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'licensing_communications',
    'LICENSING_COMMUNICATION_RECORDED',
    communication_id::text,
    jsonb_build_object(
      'employeeId', target_employee_id,
      'credentialId', target_credential_id,
      'communicationType', target_communication_type,
      'recipientEmail', target_recipient_email,
      'subject', target_subject
    )
  );

  return public.get_licensing_center();
end
$$;

do $$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists sygshift_credential_documents_privileged_access on storage.objects;

    create policy sygshift_credential_documents_privileged_access
    on storage.objects
    for all
    to authenticated
    using (
      bucket_id = 'credential-documents'
      and (
        public.can_manage_licensing()
        or (public.is_supervisor_or_admin() and public.has_mfa())
      )
    )
    with check (
      bucket_id = 'credential-documents'
      and (
        public.can_manage_licensing()
        or (public.is_supervisor_or_admin() and public.has_mfa())
      )
    );
  end if;
end
$$;

revoke all on function public.has_role_permission(text) from public, anon;
revoke all on function public.can_manage_licensing() from public, anon;
revoke all on function private.require_credential_editor_mfa() from public, anon, authenticated;
revoke all on function private.require_licensing_mfa(text) from public, anon, authenticated;
revoke all on function private.credential_compliance_record(uuid, uuid, boolean, date) from public, anon, authenticated;
revoke all on function private.calculate_employee_work_eligibility(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.get_licensing_center() from public, anon;
revoke all on function public.upsert_licensing_employee(uuid, text, text, text, text, text, public.employment_type, public.employee_status, text, text, text, public.app_role) from public, anon;
revoke all on function public.upsert_licensing_credential(uuid, uuid, public.credential_status, text, text, date, date, text, text, text, text) from public, anon;
revoke all on function public.record_licensing_credential_document(uuid, text, text, text, bigint) from public, anon;
revoke all on function public.record_licensing_communication(uuid, uuid, text, text, text, text, text) from public, anon;

grant execute on function public.has_role_permission(text) to authenticated;
grant execute on function public.can_manage_licensing() to authenticated;
grant execute on function public.get_licensing_center() to authenticated;
grant execute on function public.upsert_licensing_employee(uuid, text, text, text, text, text, public.employment_type, public.employee_status, text, text, text, public.app_role) to authenticated;
grant execute on function public.upsert_licensing_credential(uuid, uuid, public.credential_status, text, text, date, date, text, text, text, text) to authenticated;
grant execute on function public.record_licensing_credential_document(uuid, text, text, text, bigint) to authenticated;
grant execute on function public.record_licensing_communication(uuid, uuid, text, text, text, text, text) to authenticated;

commit;
