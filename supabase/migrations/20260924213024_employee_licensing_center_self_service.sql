begin;

-- Employee submissions extend the existing Licensing Center. They never replace
-- the canonical employee_credentials record until an authorized reviewer approves
-- the submission.
create table public.licensing_submissions (
  id uuid primary key,
  employee_id uuid not null references public.employees(id) on delete restrict,
  credential_type_id uuid not null references public.credential_types(id) on delete restrict,
  credential_id uuid references public.employee_credentials(id) on delete restrict,
  submission_kind text not null,
  status text not null default 'draft',
  credential_number text,
  issuing_authority text,
  issue_date date,
  expiration_date date,
  employee_message text not null,
  submitted_by uuid not null references public.employees(id) on delete restrict,
  submitted_at timestamptz,
  revision_number integer not null default 0,
  reviewed_by uuid references public.employees(id) on delete restrict,
  reviewed_at timestamptz,
  decision_reason text,
  promoted_credential_id uuid references public.employee_credentials(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint licensing_submissions_kind_check check (
    submission_kind in ('new', 'renewal', 'correction', 'renewal_in_progress')
  ),
  constraint licensing_submissions_status_check check (
    status in ('draft', 'pending_review', 'correction_required', 'rejected', 'approved', 'withdrawn')
  ),
  constraint licensing_submissions_message_check check (
    char_length(btrim(employee_message)) between 10 and 3000
  ),
  constraint licensing_submissions_dates_check check (
    expiration_date is null or issue_date is null or expiration_date >= issue_date
  ),
  constraint licensing_submissions_revision_check check (revision_number >= 0),
  constraint licensing_submissions_submission_state_check check (
    (status = 'draft' and submitted_at is null)
    or (status <> 'draft' and submitted_at is not null)
  ),
  constraint licensing_submissions_review_state_check check (
    (status in ('rejected', 'approved', 'correction_required') and reviewed_by is not null and reviewed_at is not null)
    or (status not in ('rejected', 'approved', 'correction_required'))
  )
);

create unique index licensing_submissions_one_open_type_idx
  on public.licensing_submissions(employee_id, credential_type_id)
  where status in ('draft', 'pending_review', 'correction_required');

create index licensing_submissions_review_queue_idx
  on public.licensing_submissions(status, submitted_at desc, id);

create index licensing_submissions_employee_idx
  on public.licensing_submissions(employee_id, updated_at desc, id);

create table public.licensing_submission_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.licensing_submissions(id) on delete restrict,
  event_type text not null,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint licensing_submission_events_type_check check (
    event_type in ('draft_saved', 'submitted', 'resubmitted', 'correction_requested', 'rejected', 'approved', 'withdrawn')
  )
);

create index licensing_submission_events_submission_idx
  on public.licensing_submission_events(submission_id, created_at desc, id desc);

create table public.licensing_credential_versions (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.employee_credentials(id) on delete restrict,
  version_number integer not null,
  source_submission_id uuid references public.licensing_submissions(id) on delete restrict,
  status public.credential_status not null,
  credential_number text,
  issuing_authority text,
  valid_from date,
  expires_on date,
  renewal_status text not null,
  employee_notes text,
  verified_by uuid references public.employees(id) on delete restrict,
  verified_at timestamptz,
  recorded_by uuid not null references public.employees(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint licensing_credential_versions_number_check check (version_number > 0),
  constraint licensing_credential_versions_dates_check check (
    expires_on is null or valid_from is null or expires_on >= valid_from
  ),
  unique(credential_id, version_number)
);

create index licensing_credential_versions_submission_idx
  on public.licensing_credential_versions(source_submission_id)
  where source_submission_id is not null;

alter table public.employee_credential_documents
  add column submission_id uuid references public.licensing_submissions(id) on delete restrict;

alter table public.employee_credential_documents
  alter column credential_id drop not null;

alter table public.employee_credential_documents
  add constraint employee_credential_documents_target_check
  check (credential_id is not null or submission_id is not null);

create index employee_credential_documents_submission_idx
  on public.employee_credential_documents(submission_id, uploaded_at desc)
  where submission_id is not null;

alter table public.licensing_submissions enable row level security;
alter table public.licensing_submissions force row level security;
alter table public.licensing_submission_events enable row level security;
alter table public.licensing_submission_events force row level security;
alter table public.licensing_credential_versions enable row level security;
alter table public.licensing_credential_versions force row level security;

revoke all on table public.licensing_submissions from public, anon, authenticated;
revoke all on table public.licensing_submission_events from public, anon, authenticated;
revoke all on table public.licensing_credential_versions from public, anon, authenticated;

insert into public.credential_types (
  code, legacy_kind, name, category, description, issuing_authority,
  expiration_required, standard_validity_days, affects_work_eligibility,
  warning_days, renewal_instructions, employee_email_instructions
)
values
  ('plainclothes_endorsement', 'other', 'Plainclothes Endorsement', 'endorsement', 'Authorization required for approved plainclothes assignments.', null, true, null, true, array[90, 60, 30], 'Begin renewal before the endorsement expires.', 'Upload a clear copy of the current endorsement and every page that shows its dates.'),
  ('concealed_handgun_permit', 'other', 'Concealed Handgun Permit', 'permit', 'Concealed handgun permit when required by assignment or policy.', null, true, null, true, array[90, 60, 30], 'Begin renewal before the permit expires.', 'Upload a clear front and back copy when both sides contain required information.'),
  ('aed_certification', 'other', 'AED Certification', 'certification', 'Automated external defibrillator training certification.', null, true, null, false, array[90, 60, 30], 'Renew through an approved provider before expiration.', 'Upload the complete certificate showing the provider and expiration date.'),
  ('training_certificate', 'other', 'Training Certificate', 'training', 'Externally issued training evidence that is maintained as a licensing qualification.', null, false, null, false, array[90, 60, 30], null, 'Upload the complete certificate. Internal SygShift training completion remains in Training.')
on conflict (code) do update
set
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
  updated_at = clock_timestamp();

create or replace function private.require_licensing_reviewer_mfa()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  permissions text[];
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to review licensing submissions.';
  end if;
  permissions := private.employee_effective_permissions(actor_id);
  if not (
    'licensing.manage' = any(coalesce(permissions, array[]::text[]))
    or 'directory.edit_credentials' = any(coalesce(permissions, array[]::text[]))
  ) then
    raise insufficient_privilege using message = 'Licensing review permission is required.';
  end if;
  return actor_id;
end
$$;

create or replace function private.licensing_submission_documents(target_submission_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', document.id,
    'filename', document.original_filename,
    'contentType', document.content_type,
    'byteSize', document.byte_size,
    'uploadedAt', document.uploaded_at
  ) order by document.uploaded_at, document.id), '[]'::jsonb)
  from public.employee_credential_documents document
  where document.submission_id = target_submission_id
    and document.archived_at is null
    and document.upload_state = 'stored'
$$;

create or replace function private.licensing_submission_events_payload(target_submission_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', event.id,
    'eventType', event.event_type,
    'actorName', btrim(coalesce(actor.preferred_name, actor.first_name) || ' ' || actor.last_name),
    'details', event.details,
    'createdAt', event.created_at
  ) order by event.created_at, event.id), '[]'::jsonb)
  from public.licensing_submission_events event
  join public.employees actor on actor.id = event.actor_employee_id
  where event.submission_id = target_submission_id
$$;

create or replace function private.notify_licensing_reviewers(target_submission public.licensing_submissions)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_name text;
  credential_name text;
begin
  select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name)
  into employee_name
  from public.employees employee
  where employee.id = target_submission.employee_id;

  select credential_type.name into credential_name
  from public.credential_types credential_type
  where credential_type.id = target_submission.credential_type_id;

  return private.notify_authorized_workflow_reviewers(
    'licensing_submission',
    target_submission.id,
    target_submission.employee_id,
    array['licensing.manage', 'directory.edit_credentials'],
    target_submission.employee_id,
    'Licensing submission needs review',
    concat(employee_name, ' submitted ', credential_name, ' documentation for licensing review.'),
    'important',
    concat('/licensing?submission=', target_submission.id),
    'Review submission',
    false,
    null
  );
end
$$;

create or replace function public.get_my_licensing_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  with actor as (
    select employee.*
    from public.employees employee
    where employee.id = actor_id
      and employee.status in ('onboarding', 'active', 'leave')
  ),
  scoped_types as (
    select
      credential_type.*,
      bool_or(coalesce(requirement.required, false)) as required
    from actor
    join public.credential_types credential_type on credential_type.active
    left join public.credential_requirements requirement
      on requirement.credential_type_id = credential_type.id
      and requirement.active
      and (requirement.role is null or requirement.role = actor.role)
      and (requirement.employment_type is null or requirement.employment_type = actor.employment_type)
    group by credential_type.id
  ),
  credential_payload as (
    select (
      private.credential_compliance_record(actor_id, scoped_type.id, scoped_type.required)
      - 'internalNotes'
      - 'lastEmployeeNotification'
    ) || jsonb_build_object(
      'description', scoped_type.description,
      'renewalInstructions', scoped_type.renewal_instructions,
      'employeeInstructions', scoped_type.employee_email_instructions,
      'expirationRequired', scoped_type.expiration_required
    ) as credential
    from scoped_types scoped_type
    where scoped_type.required
      or exists (
        select 1
        from public.employee_credentials credential
        where credential.employee_id = actor_id
          and credential.archived_at is null
          and (
            credential.credential_type_id = scoped_type.id
            or (credential.credential_type_id is null and credential.kind = scoped_type.legacy_kind)
          )
      )
      or exists (
        select 1
        from public.licensing_submissions submission
        where submission.employee_id = actor_id
          and submission.credential_type_id = scoped_type.id
          and submission.status <> 'withdrawn'
      )
  ),
  submissions as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', submission.id,
      'credentialTypeId', submission.credential_type_id,
      'credentialId', submission.credential_id,
      'credentialName', credential_type.name,
      'submissionKind', submission.submission_kind,
      'status', submission.status,
      'credentialNumber', submission.credential_number,
      'issuingAuthority', submission.issuing_authority,
      'issueDate', submission.issue_date,
      'expirationDate', submission.expiration_date,
      'employeeMessage', submission.employee_message,
      'submittedAt', submission.submitted_at,
      'revisionNumber', submission.revision_number,
      'reviewedAt', submission.reviewed_at,
      'decisionReason', submission.decision_reason,
      'documents', private.licensing_submission_documents(submission.id),
      'events', private.licensing_submission_events_payload(submission.id),
      'createdAt', submission.created_at,
      'updatedAt', submission.updated_at
    ) order by submission.updated_at desc, submission.id desc), '[]'::jsonb) as items
    from (
      select submission.*
      from public.licensing_submissions submission
      where submission.employee_id = actor_id
      order by submission.updated_at desc, submission.id desc
      limit 20
    ) submission
    join public.credential_types credential_type on credential_type.id = submission.credential_type_id
  ),
  credentials as (
    select coalesce(jsonb_agg(credential_payload.credential order by credential_payload.credential ->> 'credentialName'), '[]'::jsonb) as items
    from credential_payload
  )
  select jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'employee', jsonb_build_object(
      'employeeId', actor.id,
      'employeeNumber', actor.employee_number,
      'displayName', btrim(coalesce(actor.preferred_name, actor.first_name) || ' ' || actor.last_name),
      'jobTitle', actor.job_title,
      'employmentStatus', actor.status
    ),
    'credentialTypes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', scoped_type.id,
        'code', scoped_type.code,
        'name', scoped_type.name,
        'category', scoped_type.category,
        'description', scoped_type.description,
        'issuingAuthority', scoped_type.issuing_authority,
        'expirationRequired', scoped_type.expiration_required,
        'warningDays', scoped_type.warning_days,
        'renewalInstructions', scoped_type.renewal_instructions,
        'employeeInstructions', scoped_type.employee_email_instructions,
        'required', scoped_type.required
      ) order by scoped_type.required desc, scoped_type.name)
      from scoped_types scoped_type
    ), '[]'::jsonb),
    'credentials', credentials.items,
    'submissions', submissions.items,
    'summary', jsonb_build_object(
      'current', (select count(*) from jsonb_array_elements(credentials.items) item where item ->> 'status' = 'Verified'),
      'attention', (select count(*) from jsonb_array_elements(credentials.items) item where item ->> 'complianceColor' in ('red', 'yellow')),
      'pending', (select count(*) from public.licensing_submissions submission where submission.employee_id = actor_id and submission.status = 'pending_review'),
      'correctionRequired', (select count(*) from public.licensing_submissions submission where submission.employee_id = actor_id and submission.status = 'correction_required')
    )
  ) into payload
  from actor
  cross join credentials
  cross join submissions;

  if payload is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  return payload;
end
$$;

create or replace function public.save_my_licensing_submission(
  target_submission_id uuid,
  target_credential_type_id uuid,
  target_credential_id uuid,
  target_submission_kind text,
  target_credential_number text,
  target_issuing_authority text,
  target_issue_date date,
  target_expiration_date date,
  target_employee_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  credential_type public.credential_types%rowtype;
  existing_submission public.licensing_submissions%rowtype;
  existing_credential public.employee_credentials%rowtype;
  clean_kind text := lower(btrim(coalesce(target_submission_kind, '')));
  clean_message text := btrim(coalesce(target_employee_message, ''));
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if target_submission_id is null then raise check_violation using message = 'A valid submission request is required.'; end if;
  if clean_kind not in ('new', 'renewal', 'correction', 'renewal_in_progress') then
    raise check_violation using message = 'Choose a valid submission type.';
  end if;
  if char_length(clean_message) < 10 or char_length(clean_message) > 3000 then
    raise check_violation using message = 'Explain the submission in 10 to 3,000 characters.';
  end if;
  if target_expiration_date is not null and target_issue_date is not null and target_expiration_date < target_issue_date then
    raise check_violation using message = 'Expiration date cannot be before the issue date.';
  end if;

  select type.* into credential_type
  from public.credential_types type
  where type.id = target_credential_type_id and type.active;
  if not found then raise no_data_found using message = 'The selected credential type is not available.'; end if;
  if credential_type.expiration_required and target_expiration_date is null and clean_kind <> 'renewal_in_progress' then
    raise check_violation using message = 'An expiration date is required for this credential.';
  end if;

  if target_credential_id is not null then
    select credential.* into existing_credential
    from public.employee_credentials credential
    where credential.id = target_credential_id
      and credential.employee_id = actor_id
      and credential.archived_at is null
      and (
        credential.credential_type_id = credential_type.id
        or (credential.credential_type_id is null and credential.kind = credential_type.legacy_kind)
      );
    if not found then raise no_data_found using message = 'The credential selected for this submission was not found.'; end if;
  elsif clean_kind in ('renewal', 'correction', 'renewal_in_progress') then
    raise check_violation using message = 'Choose the existing credential this submission updates.';
  elsif exists (
    select 1 from public.employee_credentials credential
    where credential.employee_id = actor_id
      and credential.archived_at is null
      and credential.credential_type_id = credential_type.id
  ) then
    raise check_violation using message = 'This credential already exists. Submit a renewal or correction instead.';
  end if;

  select submission.* into existing_submission
  from public.licensing_submissions submission
  where submission.id = target_submission_id
  for update;

  if found then
    if existing_submission.employee_id <> actor_id then raise insufficient_privilege using message = 'You may update only your own submission.'; end if;
    if existing_submission.status not in ('draft', 'correction_required') then raise check_violation using message = 'This submission can no longer be edited.'; end if;
    update public.licensing_submissions submission
    set credential_type_id = credential_type.id,
        credential_id = target_credential_id,
        submission_kind = clean_kind,
        credential_number = nullif(btrim(coalesce(target_credential_number, '')), ''),
        issuing_authority = nullif(btrim(coalesce(target_issuing_authority, '')), ''),
        issue_date = target_issue_date,
        expiration_date = target_expiration_date,
        employee_message = clean_message,
        updated_at = clock_timestamp()
    where submission.id = target_submission_id;
  else
    insert into public.licensing_submissions(
      id, employee_id, credential_type_id, credential_id, submission_kind, status,
      credential_number, issuing_authority, issue_date, expiration_date, employee_message,
      submitted_by
    ) values (
      target_submission_id, actor_id, credential_type.id, target_credential_id, clean_kind, 'draft',
      nullif(btrim(coalesce(target_credential_number, '')), ''),
      nullif(btrim(coalesce(target_issuing_authority, '')), ''),
      target_issue_date, target_expiration_date, clean_message, actor_id
    );
  end if;

  insert into public.licensing_submission_events(submission_id, event_type, actor_employee_id, details)
  values(target_submission_id, 'draft_saved', actor_id, jsonb_build_object('submissionKind', clean_kind));

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values((select auth.uid()), actor_id, 'public', 'licensing_submissions', 'LICENSING_SUBMISSION_DRAFT_SAVED', target_submission_id::text,
    jsonb_build_object('credentialTypeId', credential_type.id, 'submissionKind', clean_kind));

  return public.get_my_licensing_profile();
exception
  when unique_violation then
    raise check_violation using message = 'You already have an open submission for this credential. Open that submission to continue.';
end
$$;

create or replace function public.submit_my_licensing_submission(target_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  submission public.licensing_submissions%rowtype;
  event_name text;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  select item.* into submission
  from public.licensing_submissions item
  where item.id = target_submission_id
  for update;
  if not found or submission.employee_id <> actor_id then raise no_data_found using message = 'The licensing submission was not found.'; end if;
  if submission.status not in ('draft', 'correction_required') then raise check_violation using message = 'This submission is not ready to be sent.'; end if;
  if submission.submission_kind <> 'correction' and not exists (
    select 1 from public.employee_credential_documents document
    where document.submission_id = submission.id
      and document.archived_at is null
      and document.upload_state = 'stored'
  ) then
    raise check_violation using message = 'Upload at least one complete document before submitting.';
  end if;

  event_name := case when submission.status = 'correction_required' then 'resubmitted' else 'submitted' end;
  update public.licensing_submissions item
  set status = 'pending_review',
      submitted_at = coalesce(item.submitted_at, clock_timestamp()),
      revision_number = item.revision_number + 1,
      reviewed_by = null,
      reviewed_at = null,
      decision_reason = null,
      updated_at = clock_timestamp()
  where item.id = submission.id
  returning * into submission;

  insert into public.licensing_submission_events(submission_id, event_type, actor_employee_id, details)
  values(submission.id, event_name, actor_id, jsonb_build_object('revisionNumber', submission.revision_number));

  perform private.resolve_workflow_notifications('licensing_submission_correction', submission.id, actor_id);
  perform private.notify_licensing_reviewers(submission);
  perform private.notify_workflow_status(
    actor_id,
    'licensing_submission_status',
    submission.id,
    concat('submitted-', submission.revision_number),
    'Licensing submission received',
    'Your licensing document is securely stored and waiting for authorized review.',
    concat('/licensing?submission=', submission.id),
    'View submission',
    actor_id
  );

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values((select auth.uid()), actor_id, 'public', 'licensing_submissions', 'LICENSING_SUBMISSION_SUBMITTED', submission.id::text,
    jsonb_build_object('credentialTypeId', submission.credential_type_id, 'submissionKind', submission.submission_kind,
      'revisionNumber', submission.revision_number));

  return public.get_my_licensing_profile();
end
$$;

create or replace function public.withdraw_my_licensing_submission(target_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  submission public.licensing_submissions%rowtype;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  select item.* into submission from public.licensing_submissions item where item.id = target_submission_id for update;
  if not found or submission.employee_id <> actor_id then raise no_data_found using message = 'The licensing submission was not found.'; end if;
  if submission.status not in ('draft', 'pending_review', 'correction_required') then raise check_violation using message = 'This submission can no longer be withdrawn.'; end if;

  update public.licensing_submissions set status = 'withdrawn', submitted_at = coalesce(submitted_at, clock_timestamp()),
    updated_at = clock_timestamp() where id = submission.id;
  insert into public.licensing_submission_events(submission_id, event_type, actor_employee_id)
  values(submission.id, 'withdrawn', actor_id);
  perform private.resolve_workflow_notifications('licensing_submission', submission.id);
  perform private.resolve_workflow_notifications('licensing_submission_correction', submission.id, actor_id);

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id)
  values((select auth.uid()), actor_id, 'public', 'licensing_submissions', 'LICENSING_SUBMISSION_WITHDRAWN', submission.id::text);
  return public.get_my_licensing_profile();
end
$$;

create or replace function public.get_licensing_submission_worklist(
  target_status text default 'pending_review',
  target_search text default null,
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_licensing_mfa('licensing.view');
  clean_status text := lower(btrim(coalesce(target_status, 'pending_review')));
  clean_search text := lower(btrim(coalesce(target_search, '')));
  clean_page integer := greatest(coalesce(target_page, 1), 1);
  clean_page_size integer := case when target_page_size in (5, 10, 20) then target_page_size else 10 end;
  total_count integer;
  items jsonb;
begin
  if clean_status not in ('all', 'pending_review', 'correction_required', 'rejected', 'approved') then
    raise check_violation using message = 'Choose a valid submission status.';
  end if;

  with matching as (
    select submission.id
    from public.licensing_submissions submission
    join public.employees employee on employee.id = submission.employee_id
    join public.credential_types credential_type on credential_type.id = submission.credential_type_id
    where submission.status not in ('draft', 'withdrawn')
      and (clean_status = 'all' or submission.status = clean_status)
      and (
        clean_search = ''
        or submission.id::text = clean_search
        or lower(concat_ws(' ', employee.first_name, employee.middle_name, employee.last_name, employee.preferred_name,
          employee.employee_number, employee.username, credential_type.name, credential_type.code,
          submission.credential_number, submission.issuing_authority)) like '%' || clean_search || '%'
      )
  ) select count(*)::integer into total_count from matching;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', submission.id,
    'employeeId', submission.employee_id,
    'employeeName', btrim(concat_ws(' ', employee.first_name, employee.middle_name, employee.last_name)),
    'employeeNumber', employee.employee_number,
    'username', employee.username,
    'credentialTypeId', submission.credential_type_id,
    'credentialName', credential_type.name,
    'credentialId', submission.credential_id,
    'submissionKind', submission.submission_kind,
    'status', submission.status,
    'credentialNumber', submission.credential_number,
    'issuingAuthority', submission.issuing_authority,
    'issueDate', submission.issue_date,
    'expirationDate', submission.expiration_date,
    'employeeMessage', submission.employee_message,
    'submittedAt', submission.submitted_at,
    'revisionNumber', submission.revision_number,
    'reviewedByName', case when reviewer.id is null then null else btrim(coalesce(reviewer.preferred_name, reviewer.first_name) || ' ' || reviewer.last_name) end,
    'reviewedAt', submission.reviewed_at,
    'decisionReason', submission.decision_reason,
    'documents', private.licensing_submission_documents(submission.id),
    'events', private.licensing_submission_events_payload(submission.id),
    'createdAt', submission.created_at,
    'updatedAt', submission.updated_at
  ) order by submission.submitted_at desc nulls last, submission.id desc), '[]'::jsonb)
  into items
  from (
    select item.*
    from public.licensing_submissions item
    join public.employees employee_filter on employee_filter.id = item.employee_id
    join public.credential_types credential_type_filter on credential_type_filter.id = item.credential_type_id
    where item.status not in ('draft', 'withdrawn')
      and (clean_status = 'all' or item.status = clean_status)
      and (
        clean_search = ''
        or item.id::text = clean_search
        or lower(concat_ws(' ', employee_filter.first_name, employee_filter.middle_name, employee_filter.last_name,
          employee_filter.preferred_name, employee_filter.employee_number, employee_filter.username,
          credential_type_filter.name, credential_type_filter.code, item.credential_number, item.issuing_authority)) like '%' || clean_search || '%'
      )
    order by item.submitted_at desc nulls last, item.id desc
    limit clean_page_size offset (clean_page - 1) * clean_page_size
  ) submission
  join public.employees employee on employee.id = submission.employee_id
  join public.credential_types credential_type on credential_type.id = submission.credential_type_id
  left join public.employees reviewer on reviewer.id = submission.reviewed_by;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'currentEmployeeId', actor_id,
    'canReview', (
      'licensing.manage' = any(coalesce(private.employee_effective_permissions(actor_id), array[]::text[]))
      or 'directory.edit_credentials' = any(coalesce(private.employee_effective_permissions(actor_id), array[]::text[]))
    ),
    'items', items,
    'pagination', jsonb_build_object(
      'page', clean_page,
      'pageSize', clean_page_size,
      'totalCount', total_count,
      'totalPages', case when total_count = 0 then 0 else ceil(total_count::numeric / clean_page_size)::integer end
    ),
    'summary', jsonb_build_object(
      'pendingReview', (select count(*) from public.licensing_submissions where status = 'pending_review'),
      'correctionRequired', (select count(*) from public.licensing_submissions where status = 'correction_required'),
      'approved', (select count(*) from public.licensing_submissions where status = 'approved'),
      'rejected', (select count(*) from public.licensing_submissions where status = 'rejected')
    )
  );
end
$$;

create or replace function public.review_licensing_submission(
  target_submission_id uuid,
  target_decision text,
  target_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_licensing_reviewer_mfa();
  submission public.licensing_submissions%rowtype;
  credential_type public.credential_types%rowtype;
  credential public.employee_credentials%rowtype;
  clean_decision text := lower(btrim(coalesce(target_decision, '')));
  clean_reason text := nullif(btrim(coalesce(target_reason, '')), '');
  next_version integer;
  employee_name text;
  event_name text;
begin
  if clean_decision not in ('approve', 'request_correction', 'reject') then
    raise check_violation using message = 'Choose Approve, Request correction, or Reject.';
  end if;
  if clean_decision <> 'approve' and char_length(coalesce(clean_reason, '')) < 10 then
    raise check_violation using message = 'Explain what the employee must correct in at least 10 characters.';
  end if;
  if char_length(coalesce(clean_reason, '')) > 2000 then
    raise check_violation using message = 'Review notes cannot exceed 2,000 characters.';
  end if;

  select item.* into submission
  from public.licensing_submissions item
  where item.id = target_submission_id
  for update;
  if not found then raise no_data_found using message = 'The licensing submission was not found.'; end if;
  if submission.status <> 'pending_review' then raise check_violation using message = 'This submission is no longer awaiting review.'; end if;

  select type.* into credential_type from public.credential_types type where type.id = submission.credential_type_id;
  select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name)
  into employee_name from public.employees employee where employee.id = submission.employee_id;

  if clean_decision = 'approve' then
    if submission.credential_id is not null then
      select item.* into credential
      from public.employee_credentials item
      where item.id = submission.credential_id
        and item.employee_id = submission.employee_id
        and item.archived_at is null
      for update;
      if not found then raise no_data_found using message = 'The credential selected by this submission is no longer active.'; end if;
    else
      select item.* into credential
      from public.employee_credentials item
      where item.employee_id = submission.employee_id
        and item.credential_type_id = submission.credential_type_id
        and item.archived_at is null
      for update;
    end if;

    if submission.submission_kind = 'renewal_in_progress' and credential.id is null then
      raise check_violation using message = 'Renewal-in-progress evidence requires an existing credential.';
    end if;

    if credential.id is null then
      insert into public.employee_credentials(
        employee_id, kind, status, credential_number, issuing_authority, valid_from, expires_on,
        verified_at, verified_by, credential_type_id, renewal_status, employee_notes
      ) values (
        submission.employee_id, coalesce(credential_type.legacy_kind, 'other'::public.credential_kind),
        case when submission.expiration_date is not null and submission.expiration_date < current_date then 'expired'::public.credential_status else 'active'::public.credential_status end,
        submission.credential_number, submission.issuing_authority, submission.issue_date, submission.expiration_date,
        clock_timestamp(), actor_id, credential_type.id, 'completed', submission.employee_message
      ) returning * into credential;
    elsif submission.submission_kind = 'renewal_in_progress' then
      update public.employee_credentials item
      set renewal_status = 'awaiting_issuing_authority', employee_notes = submission.employee_message,
          verified_at = clock_timestamp(), verified_by = actor_id, updated_at = clock_timestamp()
      where item.id = credential.id
      returning * into credential;
    else
      if not exists (select 1 from public.licensing_credential_versions version where version.credential_id = credential.id) then
        insert into public.licensing_credential_versions(
          credential_id, version_number, status, credential_number, issuing_authority, valid_from, expires_on,
          renewal_status, employee_notes, verified_by, verified_at, recorded_by
        ) values (
          credential.id, 1, credential.status, credential.credential_number, credential.issuing_authority,
          credential.valid_from, credential.expires_on, credential.renewal_status, credential.employee_notes,
          credential.verified_by, credential.verified_at, actor_id
        );
      end if;

      update public.employee_credentials item
      set status = case when submission.expiration_date is not null and submission.expiration_date < current_date then 'expired'::public.credential_status else 'active'::public.credential_status end,
          credential_number = submission.credential_number,
          issuing_authority = submission.issuing_authority,
          valid_from = submission.issue_date,
          expires_on = submission.expiration_date,
          verified_at = clock_timestamp(),
          verified_by = actor_id,
          credential_type_id = credential_type.id,
          renewal_status = 'completed',
          employee_notes = submission.employee_message,
          rejected_at = null,
          rejected_by = null,
          rejection_reason = null,
          updated_at = clock_timestamp()
      where item.id = credential.id
      returning * into credential;
    end if;

    select coalesce(max(version.version_number), 0) + 1 into next_version
    from public.licensing_credential_versions version
    where version.credential_id = credential.id;
    insert into public.licensing_credential_versions(
      credential_id, version_number, source_submission_id, status, credential_number, issuing_authority,
      valid_from, expires_on, renewal_status, employee_notes, verified_by, verified_at, recorded_by
    ) values (
      credential.id, next_version, submission.id, credential.status, credential.credential_number,
      credential.issuing_authority, credential.valid_from, credential.expires_on, credential.renewal_status,
      credential.employee_notes, credential.verified_by, credential.verified_at, actor_id
    );

    update public.employee_credential_documents document
    set credential_id = credential.id
    where document.submission_id = submission.id
      and document.upload_state = 'stored'
      and document.archived_at is null;

    update public.licensing_submissions item
    set status = 'approved', reviewed_by = actor_id, reviewed_at = clock_timestamp(),
        decision_reason = clean_reason, promoted_credential_id = credential.id, updated_at = clock_timestamp()
    where item.id = submission.id
    returning * into submission;
    event_name := 'approved';
  elsif clean_decision = 'request_correction' then
    update public.licensing_submissions item
    set status = 'correction_required', reviewed_by = actor_id, reviewed_at = clock_timestamp(),
        decision_reason = clean_reason, updated_at = clock_timestamp()
    where item.id = submission.id
    returning * into submission;
    event_name := 'correction_requested';
  else
    update public.licensing_submissions item
    set status = 'rejected', reviewed_by = actor_id, reviewed_at = clock_timestamp(),
        decision_reason = clean_reason, updated_at = clock_timestamp()
    where item.id = submission.id
    returning * into submission;
    event_name := 'rejected';
  end if;

  insert into public.licensing_submission_events(submission_id, event_type, actor_employee_id, details)
  values(submission.id, event_name, actor_id, jsonb_build_object('reason', clean_reason));
  perform private.resolve_workflow_notifications('licensing_submission', submission.id);

  if clean_decision = 'request_correction' then
    perform private.create_workflow_notification(
      submission.employee_id,
      'licensing_submission_correction',
      submission.id,
      'Licensing submission needs correction',
      concat('Your ', credential_type.name, ' submission needs an update: ', clean_reason),
      'important',
      concat('/licensing?submission=', submission.id),
      'Correct submission',
      actor_id
    );
  else
    perform private.notify_workflow_status(
      submission.employee_id,
      'licensing_submission_status',
      submission.id,
      submission.status,
      case when clean_decision = 'approve' then 'Licensing submission approved' else 'Licensing submission not approved' end,
      case when clean_decision = 'approve'
        then concat('Your ', credential_type.name, ' submission was approved and the verified Licensing Center record was updated.')
        else concat('Your ', credential_type.name, ' submission was rejected: ', clean_reason)
      end,
      concat('/licensing?submission=', submission.id),
      'View submission',
      actor_id
    );
  end if;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values((select auth.uid()), actor_id, 'public', 'licensing_submissions',
    case clean_decision when 'approve' then 'LICENSING_SUBMISSION_APPROVED' when 'request_correction' then 'LICENSING_SUBMISSION_CORRECTION_REQUESTED' else 'LICENSING_SUBMISSION_REJECTED' end,
    submission.id::text,
    jsonb_build_object('subjectEmployeeId', submission.employee_id, 'credentialTypeId', submission.credential_type_id,
      'promotedCredentialId', submission.promoted_credential_id, 'decisionReason', clean_reason));

  return jsonb_build_object('submissionId', submission.id, 'status', submission.status,
    'credentialId', submission.promoted_credential_id, 'reviewedAt', submission.reviewed_at);
end
$$;

create or replace function public.service_prepare_licensing_submission_document_upload(
  target_actor_id uuid,
  target_submission_id uuid,
  target_upload_request_id uuid,
  target_original_filename text,
  target_content_type text,
  target_byte_size bigint,
  target_sha256_checksum text,
  target_extension text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  submission public.licensing_submissions%rowtype;
  existing_record public.employee_credential_documents%rowtype;
  document_id uuid := gen_random_uuid();
  storage_path text;
  clean_filename text := btrim(coalesce(target_original_filename, ''));
  clean_content_type text := lower(btrim(coalesce(target_content_type, '')));
  clean_checksum text := lower(btrim(coalesce(target_sha256_checksum, '')));
  clean_extension text := lower(btrim(coalesce(target_extension, '')));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  select item.* into submission
  from public.licensing_submissions item
  where item.id = target_submission_id
  for update;
  if not found then raise no_data_found using message = 'Licensing submission was not found.'; end if;
  if submission.employee_id <> target_actor_id then raise insufficient_privilege using message = 'You may upload documents only to your own licensing submission.'; end if;
  if submission.status not in ('draft', 'correction_required') then raise check_violation using message = 'This submission is not accepting documents.'; end if;
  if target_upload_request_id is null then raise check_violation using message = 'A valid upload request is required.'; end if;
  if clean_filename = '' or char_length(clean_filename) > 255 then raise check_violation using message = 'Use a valid file name.'; end if;
  if clean_content_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then raise check_violation using message = 'Upload a PDF, PNG, JPEG, or WebP licensing document.'; end if;
  if target_byte_size is null or target_byte_size < 1 or target_byte_size > 26214400 then raise check_violation using message = 'Licensing documents must be between 1 byte and 25 MB.'; end if;
  if clean_checksum !~ '^[a-f0-9]{64}$' then raise check_violation using message = 'The licensing document checksum is invalid.'; end if;
  if clean_extension not in ('pdf', 'png', 'jpg', 'jpeg', 'webp') then raise check_violation using message = 'This licensing document file extension is not allowed.'; end if;

  select document.* into existing_record
  from public.employee_credential_documents document
  where document.upload_request_id = target_upload_request_id;
  if found then
    if existing_record.submission_id <> submission.id
      or existing_record.original_filename <> clean_filename
      or existing_record.content_type <> clean_content_type
      or existing_record.byte_size <> target_byte_size
      or existing_record.sha256_checksum <> clean_checksum
    then
      raise unique_violation using message = 'This upload request is already associated with a different licensing document.';
    end if;
    return jsonb_build_object('documentId', existing_record.id, 'bucket', 'credential-documents',
      'objectKey', existing_record.storage_path, 'state', existing_record.upload_state);
  end if;

  storage_path := submission.employee_id::text || '/submissions/' || submission.id::text || '/' || document_id::text || '.' || clean_extension;
  insert into public.employee_credential_documents(
    id, credential_id, submission_id, storage_path, original_filename, content_type, byte_size, uploaded_by,
    uploaded_at, archived_at, archived_by, archive_reason, upload_request_id, upload_state,
    sha256_checksum, stored_at, failure_detail
  ) values (
    document_id, null, submission.id, storage_path, clean_filename, clean_content_type, target_byte_size,
    target_actor_id, clock_timestamp(), clock_timestamp(), target_actor_id, 'Protected submission upload pending',
    target_upload_request_id, 'pending', clean_checksum, null, null
  );

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values(null, target_actor_id, 'public', 'employee_credential_documents', 'LICENSING_SUBMISSION_DOCUMENT_UPLOAD_STARTED', document_id::text,
    jsonb_build_object('submissionId', submission.id, 'filename', clean_filename, 'byteSize', target_byte_size));

  return jsonb_build_object('documentId', document_id, 'bucket', 'credential-documents', 'objectKey', storage_path, 'state', 'pending');
end
$$;

create or replace function public.service_remove_licensing_submission_document(
  target_actor_id uuid,
  target_submission_id uuid,
  target_document_id uuid,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  submission public.licensing_submissions%rowtype;
  document_record public.employee_credential_documents%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  select item.* into submission from public.licensing_submissions item where item.id = target_submission_id for update;
  if not found or submission.employee_id <> target_actor_id then raise no_data_found using message = 'Licensing submission was not found.'; end if;
  if submission.status not in ('draft', 'correction_required') then raise check_violation using message = 'Documents can no longer be removed from this submission.'; end if;
  select document.* into document_record
  from public.employee_credential_documents document
  where document.id = target_document_id
    and document.submission_id = submission.id
    and document.uploaded_by = target_actor_id
    and document.archived_at is null
    and document.upload_state = 'stored'
  for update;
  if not found then raise no_data_found using message = 'Licensing document was not found.'; end if;

  update public.employee_credential_documents document
  set archived_at = clock_timestamp(), archived_by = target_actor_id,
      archive_reason = 'Removed by employee before licensing review'
  where document.id = document_record.id;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values(null, target_actor_id, 'public', 'employee_credential_documents', 'LICENSING_SUBMISSION_DOCUMENT_REMOVED', document_record.id::text,
    jsonb_build_object('submissionId', submission.id, 'filename', document_record.original_filename, 'requestId', target_request_id));

  return jsonb_build_object('documentId', document_record.id, 'bucket', 'credential-documents',
    'objectKey', document_record.storage_path, 'state', 'removed');
end
$$;

-- The shared completion boundary accepts either a coordinator credential upload or
-- the owner of an editable employee submission. Storage, checksums, retries, and
-- audit behavior remain the existing protected pipeline.
create or replace function public.service_complete_licensing_document_upload(
  target_actor_id uuid,
  target_document_id uuid,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_record public.employee_credential_documents%rowtype;
  submission public.licensing_submissions%rowtype;
  actor_permissions text[];
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  select document.* into document_record from public.employee_credential_documents document where document.id = target_document_id for update;
  if not found then raise no_data_found using message = 'Licensing document upload was not found.'; end if;
  if document_record.uploaded_by <> target_actor_id then raise insufficient_privilege using message = 'The upload actor does not match.'; end if;

  if document_record.submission_id is not null then
    select item.* into submission from public.licensing_submissions item where item.id = document_record.submission_id;
    if submission.employee_id <> target_actor_id or submission.status not in ('draft', 'correction_required') then
      raise insufficient_privilege using message = 'The licensing submission is not available for this upload.';
    end if;
  else
    actor_permissions := private.employee_effective_permissions(target_actor_id);
    if not (
      'licensing.manage' = any(coalesce(actor_permissions, array[]::text[]))
      or 'directory.edit_credentials' = any(coalesce(actor_permissions, array[]::text[]))
    ) then raise insufficient_privilege using message = 'Licensing document management permission is required.'; end if;
  end if;

  if document_record.upload_state = 'stored' then
    return jsonb_build_object('documentId', document_record.id, 'state', 'stored', 'uploadedAt', document_record.stored_at);
  end if;
  if document_record.upload_state <> 'pending' then raise check_violation using message = 'This licensing document upload cannot be completed.'; end if;

  update public.employee_credential_documents document
  set upload_state = 'stored', stored_at = clock_timestamp(), archived_at = null, archived_by = null,
      archive_reason = null, failure_detail = null
  where document.id = document_record.id returning * into document_record;

  if document_record.credential_id is not null then
    update public.employee_credentials credential
    set document_path = document_record.storage_path, updated_at = clock_timestamp()
    where credential.id = document_record.credential_id;
  end if;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values(null, target_actor_id, 'public', 'employee_credential_documents', 'LICENSING_DOCUMENT_UPLOADED', document_record.id::text,
    jsonb_build_object('credentialId', document_record.credential_id, 'submissionId', document_record.submission_id,
      'filename', document_record.original_filename, 'contentType', document_record.content_type,
      'byteSize', document_record.byte_size, 'requestId', target_request_id));

  return jsonb_build_object('documentId', document_record.id, 'state', 'stored', 'uploadedAt', document_record.stored_at);
end
$$;

create or replace function public.service_get_licensing_credential_documents(
  target_actor_id uuid,
  target_credential_id uuid,
  target_page integer default 1,
  target_page_size integer default 5,
  target_mfa_method text default null,
  target_mfa_verified_at timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  credential public.employee_credentials%rowtype;
  actor_permissions text[];
  clean_page integer := greatest(coalesce(target_page, 1), 1);
  clean_page_size integer := case when target_page_size in (5, 10, 20) then target_page_size else 5 end;
  total_count integer;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  select item.* into credential from public.employee_credentials item where item.id = target_credential_id and item.archived_at is null;
  if not found then raise no_data_found using message = 'Credential was not found.'; end if;

  if credential.employee_id <> target_actor_id then
    actor_permissions := private.employee_effective_permissions(target_actor_id);
    if not (
      'licensing.view' = any(coalesce(actor_permissions, array[]::text[]))
      or 'licensing.manage' = any(coalesce(actor_permissions, array[]::text[]))
      or 'directory.edit_credentials' = any(coalesce(actor_permissions, array[]::text[]))
    ) then raise insufficient_privilege using message = 'Licensing document access is required.'; end if;
    perform private.require_recent_licensing_document_mfa(target_mfa_method, target_mfa_verified_at);
  end if;

  select count(*)::integer into total_count
  from public.employee_credential_documents document
  where document.credential_id = credential.id and document.archived_at is null and document.upload_state = 'stored';

  return jsonb_build_object(
    'credentialId', credential.id,
    'credentialName', (select type.name from public.credential_types type where type.id = credential.credential_type_id),
    'canUpload', false,
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('id', document.id, 'filename', document.original_filename,
        'contentType', document.content_type, 'byteSize', document.byte_size, 'uploadedAt', document.uploaded_at)
        order by document.uploaded_at desc, document.id desc)
      from (
        select item.* from public.employee_credential_documents item
        where item.credential_id = credential.id and item.archived_at is null and item.upload_state = 'stored'
        order by item.uploaded_at desc, item.id desc limit clean_page_size offset (clean_page - 1) * clean_page_size
      ) document
    ), '[]'::jsonb),
    'pagination', jsonb_build_object('page', clean_page, 'pageSize', clean_page_size,
      'totalCount', total_count, 'totalPages', case when total_count = 0 then 0 else ceil(total_count::numeric / clean_page_size)::integer end)
  );
end
$$;

create or replace function public.service_authorize_licensing_document_access(
  target_actor_id uuid,
  target_document_id uuid,
  target_action text,
  target_reason text,
  target_request_id uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_record record;
  actor_permissions text[];
  clean_action text := lower(btrim(coalesce(target_action, '')));
  clean_reason text := btrim(coalesce(target_reason, ''));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if clean_action not in ('preview', 'download') then raise check_violation using message = 'Choose Preview or Download.'; end if;
  if char_length(clean_reason) < 8 or char_length(clean_reason) > 500 then raise check_violation using message = 'Enter an access reason between 8 and 500 characters.'; end if;

  select document.*, coalesce(credential.employee_id, submission.employee_id) as employee_id
  into document_record
  from public.employee_credential_documents document
  left join public.employee_credentials credential on credential.id = document.credential_id
  left join public.licensing_submissions submission on submission.id = document.submission_id
  where document.id = target_document_id
    and document.archived_at is null
    and document.upload_state = 'stored'
    and (credential.id is null or credential.archived_at is null);
  if not found then raise no_data_found using message = 'Licensing document was not found.'; end if;

  if document_record.employee_id <> target_actor_id then
    actor_permissions := private.employee_effective_permissions(target_actor_id);
    if not (
      'licensing.view' = any(coalesce(actor_permissions, array[]::text[]))
      or 'licensing.manage' = any(coalesce(actor_permissions, array[]::text[]))
      or 'directory.edit_credentials' = any(coalesce(actor_permissions, array[]::text[]))
    ) then raise insufficient_privilege using message = 'Licensing document access is required.'; end if;
    perform private.require_recent_licensing_document_mfa(target_mfa_method, target_mfa_verified_at);
  end if;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values(null, target_actor_id, 'public', 'employee_credential_documents',
    case when clean_action = 'download' then 'LICENSING_DOCUMENT_DOWNLOADED' else 'LICENSING_DOCUMENT_PREVIEWED' end,
    document_record.id::text,
    jsonb_build_object('credentialId', document_record.credential_id, 'submissionId', document_record.submission_id,
      'subjectEmployeeId', document_record.employee_id, 'reason', clean_reason, 'requestId', target_request_id));

  return jsonb_build_object('bucket', 'credential-documents', 'objectKey', document_record.storage_path,
    'filename', document_record.original_filename, 'mimeType', document_record.content_type, 'action', clean_action);
end
$$;

revoke all on function private.require_licensing_reviewer_mfa() from public, anon, authenticated;
revoke all on function private.licensing_submission_documents(uuid) from public, anon, authenticated;
revoke all on function private.licensing_submission_events_payload(uuid) from public, anon, authenticated;
revoke all on function private.notify_licensing_reviewers(public.licensing_submissions) from public, anon, authenticated;
revoke all on function public.get_my_licensing_profile() from public, anon;
revoke all on function public.save_my_licensing_submission(uuid, uuid, uuid, text, text, text, date, date, text) from public, anon;
revoke all on function public.submit_my_licensing_submission(uuid) from public, anon;
revoke all on function public.withdraw_my_licensing_submission(uuid) from public, anon;
revoke all on function public.get_licensing_submission_worklist(text, text, integer, integer) from public, anon;
revoke all on function public.review_licensing_submission(uuid, text, text) from public, anon;
revoke all on function public.service_prepare_licensing_submission_document_upload(uuid, uuid, uuid, text, text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.service_remove_licensing_submission_document(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_complete_licensing_document_upload(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_get_licensing_credential_documents(uuid, uuid, integer, integer, text, timestamptz) from public, anon, authenticated;
revoke all on function public.service_authorize_licensing_document_access(uuid, uuid, text, text, uuid, text, timestamptz) from public, anon, authenticated;

grant execute on function public.get_my_licensing_profile() to authenticated;
grant execute on function public.save_my_licensing_submission(uuid, uuid, uuid, text, text, text, date, date, text) to authenticated;
grant execute on function public.submit_my_licensing_submission(uuid) to authenticated;
grant execute on function public.withdraw_my_licensing_submission(uuid) to authenticated;
grant execute on function public.get_licensing_submission_worklist(text, text, integer, integer) to authenticated;
grant execute on function public.review_licensing_submission(uuid, text, text) to authenticated;
grant execute on function public.service_prepare_licensing_submission_document_upload(uuid, uuid, uuid, text, text, bigint, text, text) to service_role;
grant execute on function public.service_remove_licensing_submission_document(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.service_complete_licensing_document_upload(uuid, uuid, uuid) to service_role;
grant execute on function public.service_get_licensing_credential_documents(uuid, uuid, integer, integer, text, timestamptz) to service_role;
grant execute on function public.service_authorize_licensing_document_access(uuid, uuid, text, text, uuid, text, timestamptz) to service_role;

commit;
