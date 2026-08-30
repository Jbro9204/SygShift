begin;

-- Stage 6, run 1: a dormant, service-only recruiting foundation. This migration
-- is additive and does not assign permissions, create employees, or enable access.
create temporary table hris_stage6_run1_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.employee_accounts) as account_count;

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  ('hr.recruiting.view', 'HR & Finance', 'View recruiting', 'View requisitions, applicants, interviews, and offers.', 'sensitive', true, true, true),
  ('hr.recruiting.manage', 'HR & Finance', 'Manage recruiting', 'Maintain recruiting records and candidate stages.', 'critical', true, true, true),
  ('hr.recruiting.approve', 'HR & Finance', 'Approve hiring decisions', 'Approve offers and candidate conversion into onboarding.', 'critical', true, true, true)
on conflict (code) do nothing;

create table private.hr_recruiting_release_gate (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  enabled_at timestamptz,
  enabled_by uuid references public.employees(id) on delete restrict,
  reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_recruiting_gate_consistent check (
    (not enabled and enabled_at is null and enabled_by is null)
    or (enabled and enabled_at is not null and enabled_by is not null and btrim(coalesce(reason, '')) <> '')
  )
);
insert into private.hr_recruiting_release_gate(singleton, enabled) values (true, false) on conflict (singleton) do nothing;

create table private.hr_requisitions (
  id uuid primary key default gen_random_uuid(),
  requisition_number bigint generated always as identity unique,
  title text not null,
  position_id uuid references private.hr_positions(id) on delete restrict,
  organization_unit_id uuid references private.hr_organization_units(id) on delete restrict,
  location_id uuid references private.hr_work_locations(id) on delete restrict,
  employment_type text not null,
  headcount integer not null default 1,
  armed_requirement text not null default 'unarmed',
  status text not null default 'draft',
  description text,
  hiring_manager_id uuid references public.employees(id) on delete restrict,
  requested_by uuid not null references public.employees(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  approved_by uuid references public.employees(id) on delete restrict,
  approved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_requisition_title_present check (btrim(title) <> ''),
  constraint hr_requisition_type check (employment_type in ('hourly', 'salary', 'flex')),
  constraint hr_requisition_armed check (armed_requirement in ('unarmed', 'armed', 'either')),
  constraint hr_requisition_headcount check (headcount between 1 and 500),
  constraint hr_requisition_status check (status in ('draft', 'pending_approval', 'open', 'paused', 'filled', 'canceled')),
  constraint hr_requisition_approval_consistent check (
    (approved_at is null and approved_by is null) or (approved_at is not null and approved_by is not null)
  )
);

create table private.hr_applicants (
  id uuid primary key default gen_random_uuid(),
  legal_first_name text not null,
  legal_middle_name text,
  legal_last_name text not null,
  preferred_name text,
  personal_email text,
  mobile_phone text,
  city text,
  region text,
  source text,
  source_detail text,
  retention_until date,
  converted_employee_id uuid unique references public.employees(id) on delete restrict,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_applicant_legal_name_present check (btrim(legal_first_name) <> '' and btrim(legal_last_name) <> ''),
  constraint hr_applicant_email_format check (personal_email is null or personal_email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
);
create unique index hr_applicants_normalized_email_unique on private.hr_applicants(lower(personal_email)) where personal_email is not null;

create table private.hr_applications (
  id uuid primary key default gen_random_uuid(),
  applicant_id uuid not null references private.hr_applicants(id) on delete restrict,
  requisition_id uuid not null references private.hr_requisitions(id) on delete restrict,
  stage text not null default 'applied',
  status text not null default 'active',
  applied_at timestamptz not null default clock_timestamp(),
  stage_changed_at timestamptz not null default clock_timestamp(),
  owner_id uuid references public.employees(id) on delete restrict,
  disposition_reason text,
  disposition_note text,
  disposed_at timestamptz,
  disposed_by uuid references public.employees(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_application_unique unique(applicant_id, requisition_id),
  constraint hr_application_stage check (stage in ('applied', 'screening', 'interview', 'reference_check', 'offer', 'accepted', 'hired', 'rejected', 'withdrawn')),
  constraint hr_application_status check (status in ('active', 'on_hold', 'completed', 'withdrawn', 'rejected', 'hired')),
  constraint hr_application_disposition_consistent check (
    (disposed_at is null and disposed_by is null and disposition_reason is null)
    or (disposed_at is not null and disposed_by is not null and btrim(coalesce(disposition_reason, '')) <> '')
  )
);

create table private.hr_application_stage_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references private.hr_applications(id) on delete restrict,
  from_stage text,
  to_stage text not null,
  reason text not null,
  changed_by uuid not null references public.employees(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp(),
  constraint hr_stage_history_reason_present check (btrim(reason) <> '')
);

create table private.hr_interviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references private.hr_applications(id) on delete restrict,
  interview_type text not null default 'structured',
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  time_zone text not null default 'America/Denver',
  location_or_link text,
  status text not null default 'scheduled',
  scheduled_by uuid not null references public.employees(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_interview_dates check (scheduled_end > scheduled_start),
  constraint hr_interview_type check (interview_type in ('phone', 'video', 'in_person', 'structured', 'panel')),
  constraint hr_interview_status check (status in ('scheduled', 'completed', 'canceled', 'no_show'))
);

create table private.hr_interview_panelists (
  interview_id uuid not null references private.hr_interviews(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  primary key(interview_id, employee_id)
);

create table private.hr_interview_scorecards (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references private.hr_interviews(id) on delete restrict,
  panelist_id uuid not null references public.employees(id) on delete restrict,
  recommendation text not null,
  overall_score integer,
  evidence jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default clock_timestamp(),
  constraint hr_scorecard_unique unique(interview_id, panelist_id),
  constraint hr_scorecard_recommendation check (recommendation in ('strong_yes', 'yes', 'mixed', 'no', 'strong_no')),
  constraint hr_scorecard_score check (overall_score is null or overall_score between 1 and 5),
  constraint hr_scorecard_evidence_object check (jsonb_typeof(evidence) = 'object')
);

create table private.hr_offers (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references private.hr_applications(id) on delete restrict,
  version_number integer not null default 1,
  status text not null default 'draft',
  job_title text not null,
  employment_type text not null,
  proposed_start_date date not null,
  compensation_basis text not null,
  compensation_amount numeric(12,2),
  currency text not null default 'USD',
  expires_at timestamptz,
  approved_by uuid references public.employees(id) on delete restrict,
  approved_at timestamptz,
  candidate_decided_at timestamptz,
  prepared_by uuid not null references public.employees(id) on delete restrict,
  prepared_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_offer_version_unique unique(application_id, version_number),
  constraint hr_offer_status check (status in ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'withdrawn', 'expired')),
  constraint hr_offer_employment_type check (employment_type in ('hourly', 'salary', 'flex')),
  constraint hr_offer_comp_basis check (compensation_basis in ('hourly', 'annual', 'none')),
  constraint hr_offer_amount check ((compensation_basis = 'none' and compensation_amount is null) or (compensation_basis <> 'none' and compensation_amount > 0)),
  constraint hr_offer_approval_consistent check ((approved_at is null and approved_by is null) or (approved_at is not null and approved_by is not null))
);

create table private.hr_recruiting_events (
  id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  action text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  previous_state jsonb,
  next_state jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_recruiting_event_type check (aggregate_type in ('requisition', 'applicant', 'application', 'interview', 'scorecard', 'offer', 'conversion')),
  constraint hr_recruiting_event_action_present check (btrim(action) <> ''),
  constraint hr_recruiting_event_reason_present check (btrim(reason) <> '')
);

create index hr_applications_worklist_idx on private.hr_applications(status, stage, stage_changed_at desc);
create index hr_requisitions_worklist_idx on private.hr_requisitions(status, updated_at desc);
create index hr_interviews_application_idx on private.hr_interviews(application_id, scheduled_start);
create index hr_recruiting_events_aggregate_idx on private.hr_recruiting_events(aggregate_type, aggregate_id, occurred_at desc);

create or replace function private.hr_recruiting_require_actor_permission(target_actor_id uuid, target_permission text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_status public.employee_status;
  target_account_active boolean;
  target_permissions text[];
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  select employee.status, account.disabled_at is null
    into target_status, target_account_active
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.id = target_actor_id;
  if target_status <> 'active' or not coalesce(target_account_active, false) then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  target_permissions := private.employee_effective_permissions(target_actor_id);
  if not (target_permission = any(coalesce(target_permissions, array[]::text[]))) then
    raise insufficient_privilege using message = 'The required recruiting permission is missing.';
  end if;
end
$$;

create or replace function private.hr_recruiting_assert_enabled()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce((select gate.enabled from private.hr_recruiting_release_gate gate where gate.singleton), false) then
    raise exception 'The recruiting workspace has not been released.' using errcode = '55000';
  end if;
end
$$;

create or replace function private.hr_recruiting_append_event(
  target_type text, target_id uuid, target_action text, target_actor_id uuid,
  target_reason text, target_previous jsonb default null, target_next jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare event_id uuid;
begin
  insert into private.hr_recruiting_events(aggregate_type, aggregate_id, action, actor_id, reason, previous_state, next_state)
  values (target_type, target_id, target_action, target_actor_id, btrim(target_reason), target_previous, target_next)
  returning id into event_id;
  return event_id;
end
$$;

create or replace function public.service_get_hr_recruiting_workspace(
  target_actor_id uuid, target_page_size integer default 10, target_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare page_size integer := greatest(5, least(coalesce(target_page_size, 10), 20));
declare row_offset integer := greatest(0, coalesce(target_offset, 0));
declare gate_enabled boolean;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_recruiting_require_actor_permission(target_actor_id, 'hr.recruiting.view');
  select gate.enabled into gate_enabled from private.hr_recruiting_release_gate gate where gate.singleton;
  if not coalesce(gate_enabled, false) then
    return jsonb_build_object('enabled', false, 'requisitions', '[]'::jsonb, 'applications', '[]'::jsonb, 'counts', jsonb_build_object('openRequisitions', 0, 'activeCandidates', 0, 'pendingInterviews', 0, 'pendingOffers', 0));
  end if;
  return jsonb_build_object(
    'enabled', true, 'pageSize', page_size, 'offset', row_offset,
    'requisitions', coalesce((select jsonb_agg(row.payload order by row.updated_at desc) from (
      select requisition.updated_at, jsonb_build_object('id', requisition.id, 'number', requisition.requisition_number, 'title', requisition.title, 'status', requisition.status, 'employmentType', requisition.employment_type, 'headcount', requisition.headcount, 'armedRequirement', requisition.armed_requirement, 'updatedAt', requisition.updated_at) payload
      from private.hr_requisitions requisition order by requisition.updated_at desc limit page_size offset row_offset
    ) row), '[]'::jsonb),
    'applications', coalesce((select jsonb_agg(row.payload order by row.stage_changed_at desc) from (
      select application.stage_changed_at, jsonb_build_object('id', application.id, 'applicantId', applicant.id, 'candidateName', concat_ws(' ', applicant.legal_first_name, applicant.legal_last_name), 'requisitionTitle', requisition.title, 'stage', application.stage, 'status', application.status, 'stageChangedAt', application.stage_changed_at, 'convertedEmployeeId', applicant.converted_employee_id) payload
      from private.hr_applications application join private.hr_applicants applicant on applicant.id = application.applicant_id join private.hr_requisitions requisition on requisition.id = application.requisition_id
      order by application.stage_changed_at desc limit page_size offset row_offset
    ) row), '[]'::jsonb),
    'counts', jsonb_build_object(
      'openRequisitions', (select count(*) from private.hr_requisitions where status = 'open'),
      'activeCandidates', (select count(*) from private.hr_applications where status = 'active'),
      'pendingInterviews', (select count(*) from private.hr_interviews where status = 'scheduled'),
      'pendingOffers', (select count(*) from private.hr_offers where status in ('pending_approval', 'approved', 'sent'))
    )
  );
end
$$;

create or replace function public.service_hr_recruiting_action(
  target_actor_id uuid, target_action text, target_payload jsonb, target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare record_id uuid; previous_record jsonb; next_record jsonb; required_permission text := 'hr.recruiting.manage';
declare selected_application_id uuid; selected_applicant_id uuid; selected_requisition_id uuid; selected_interview_id uuid; offer_version integer;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_recruiting_assert_enabled();
  if target_action in ('approve_requisition', 'approve_offer', 'mark_offer_sent', 'record_offer_decision') then required_permission := 'hr.recruiting.approve'; end if;
  perform private.hr_recruiting_require_actor_permission(target_actor_id, required_permission);
  if btrim(coalesce(target_reason, '')) = '' or length(btrim(target_reason)) > 1000 then raise check_violation using message = 'A concise audit reason is required.'; end if;

  if target_action = 'create_requisition' then
    insert into private.hr_requisitions(title, employment_type, headcount, armed_requirement, description, hiring_manager_id, requested_by)
    values (btrim(target_payload->>'title'), coalesce(nullif(target_payload->>'employmentType',''),'hourly'), coalesce(nullif(target_payload->>'headcount','')::integer,1), coalesce(nullif(target_payload->>'armedRequirement',''),'unarmed'), nullif(btrim(target_payload->>'description'),''), nullif(target_payload->>'hiringManagerId','')::uuid, target_actor_id)
    returning id into record_id;
    select to_jsonb(item.*) into next_record from private.hr_requisitions item where item.id = record_id;
    perform private.hr_recruiting_append_event('requisition', record_id, target_action, target_actor_id, target_reason, null, next_record);
  elsif target_action = 'submit_requisition' then
    record_id := (target_payload->>'requisitionId')::uuid;
    select to_jsonb(item.*) into previous_record from private.hr_requisitions item where item.id = record_id for update;
    update private.hr_requisitions set status = 'pending_approval', updated_at = clock_timestamp() where id = record_id and status = 'draft' returning to_jsonb(hr_requisitions) into next_record;
    if next_record is null then raise check_violation using message = 'Only a draft requisition can be submitted.'; end if;
    perform private.hr_recruiting_append_event('requisition', record_id, target_action, target_actor_id, target_reason, previous_record, next_record);
  elsif target_action = 'approve_requisition' then
    record_id := (target_payload->>'requisitionId')::uuid;
    select to_jsonb(item.*) into previous_record from private.hr_requisitions item where item.id = record_id for update;
    update private.hr_requisitions set status = 'open', approved_by = target_actor_id, approved_at = clock_timestamp(), updated_at = clock_timestamp() where id = record_id and status = 'pending_approval' returning to_jsonb(hr_requisitions) into next_record;
    if next_record is null then raise check_violation using message = 'Only a pending requisition can be approved.'; end if;
    perform private.hr_recruiting_append_event('requisition', record_id, target_action, target_actor_id, target_reason, previous_record, next_record);
  elsif target_action = 'create_application' then
    selected_requisition_id := (target_payload->>'requisitionId')::uuid;
    if not exists(select 1 from private.hr_requisitions where id = selected_requisition_id and status = 'open') then raise check_violation using message = 'Applications require an open requisition.'; end if;
    insert into private.hr_applicants(legal_first_name, legal_middle_name, legal_last_name, preferred_name, personal_email, mobile_phone, city, region, source, source_detail, created_by)
    values (btrim(target_payload->>'legalFirstName'), nullif(btrim(target_payload->>'legalMiddleName'),''), btrim(target_payload->>'legalLastName'), nullif(btrim(target_payload->>'preferredName'),''), nullif(lower(btrim(target_payload->>'personalEmail')),''), nullif(btrim(target_payload->>'mobilePhone'),''), nullif(btrim(target_payload->>'city'),''), nullif(btrim(target_payload->>'region'),''), nullif(btrim(target_payload->>'source'),''), nullif(btrim(target_payload->>'sourceDetail'),''), target_actor_id)
    returning id into selected_applicant_id;
    insert into private.hr_applications(applicant_id, requisition_id, owner_id) values (selected_applicant_id, selected_requisition_id, target_actor_id) returning id into record_id;
    select to_jsonb(item.*) into next_record from private.hr_applications item where item.id = record_id;
    insert into private.hr_application_stage_history(application_id, to_stage, reason, changed_by) values(record_id, 'applied', target_reason, target_actor_id);
    perform private.hr_recruiting_append_event('application', record_id, target_action, target_actor_id, target_reason, null, next_record);
  elsif target_action = 'move_application' then
    selected_application_id := (target_payload->>'applicationId')::uuid;
    select to_jsonb(item.*) into previous_record from private.hr_applications item where item.id = selected_application_id for update;
    update private.hr_applications set stage = target_payload->>'stage', stage_changed_at = clock_timestamp(), updated_at = clock_timestamp() where id = selected_application_id and status in ('active','on_hold') returning to_jsonb(hr_applications) into next_record;
    if next_record is null then raise check_violation using message = 'The application cannot be moved.'; end if;
    insert into private.hr_application_stage_history(application_id, from_stage, to_stage, reason, changed_by) values(selected_application_id, previous_record->>'stage', target_payload->>'stage', target_reason, target_actor_id);
    perform private.hr_recruiting_append_event('application', selected_application_id, target_action, target_actor_id, target_reason, previous_record, next_record);
    record_id := selected_application_id;
  elsif target_action = 'schedule_interview' then
    selected_application_id := (target_payload->>'applicationId')::uuid;
    if not exists(select 1 from private.hr_applications application where application.id = selected_application_id and application.status = 'active') then raise check_violation using message = 'Interviews require an active application.'; end if;
    insert into private.hr_interviews(application_id, interview_type, scheduled_start, scheduled_end, time_zone, location_or_link, scheduled_by)
    values(selected_application_id, coalesce(nullif(target_payload->>'interviewType',''),'structured'), (target_payload->>'scheduledStart')::timestamptz, (target_payload->>'scheduledEnd')::timestamptz, coalesce(nullif(target_payload->>'timeZone',''),'America/Denver'), nullif(btrim(target_payload->>'locationOrLink'),''), target_actor_id)
    returning id into record_id;
    select to_jsonb(item.*) into next_record from private.hr_interviews item where item.id = record_id;
    perform private.hr_recruiting_append_event('interview', record_id, target_action, target_actor_id, target_reason, null, next_record);
  elsif target_action = 'assign_interview_panelist' then
    selected_interview_id := (target_payload->>'interviewId')::uuid;
    record_id := (target_payload->>'employeeId')::uuid;
    if not exists(select 1 from private.hr_interviews interview where interview.id = selected_interview_id and interview.status = 'scheduled') then raise check_violation using message = 'Panelists can only be assigned to a scheduled interview.'; end if;
    if not exists(select 1 from public.employees employee where employee.id = record_id and employee.status = 'active') then raise check_violation using message = 'The panelist must be an active employee.'; end if;
    insert into private.hr_interview_panelists(interview_id, employee_id) values(selected_interview_id, record_id) on conflict do nothing;
    next_record := jsonb_build_object('interviewId', selected_interview_id, 'employeeId', record_id);
    perform private.hr_recruiting_append_event('interview', selected_interview_id, target_action, target_actor_id, target_reason, null, next_record);
  elsif target_action = 'submit_scorecard' then
    selected_interview_id := (target_payload->>'interviewId')::uuid;
    if not exists(select 1 from private.hr_interview_panelists panelist where panelist.interview_id = selected_interview_id and panelist.employee_id = target_actor_id) then raise insufficient_privilege using message = 'Only an assigned panelist can submit this scorecard.'; end if;
    insert into private.hr_interview_scorecards(interview_id, panelist_id, recommendation, overall_score, evidence)
    values(selected_interview_id, target_actor_id, target_payload->>'recommendation', nullif(target_payload->>'overallScore','')::integer, coalesce(target_payload->'evidence','{}'::jsonb))
    returning id into record_id;
    select to_jsonb(item.*) into next_record from private.hr_interview_scorecards item where item.id = record_id;
    perform private.hr_recruiting_append_event('scorecard', record_id, target_action, target_actor_id, target_reason, null, next_record);
  elsif target_action = 'prepare_offer' then
    selected_application_id := (target_payload->>'applicationId')::uuid;
    select coalesce(max(item.version_number),0)+1 into offer_version from private.hr_offers item where item.application_id = selected_application_id;
    insert into private.hr_offers(application_id, version_number, job_title, employment_type, proposed_start_date, compensation_basis, compensation_amount, expires_at, prepared_by)
    values(selected_application_id, offer_version, btrim(target_payload->>'jobTitle'), target_payload->>'employmentType', (target_payload->>'proposedStartDate')::date, target_payload->>'compensationBasis', nullif(target_payload->>'compensationAmount','')::numeric, nullif(target_payload->>'expiresAt','')::timestamptz, target_actor_id)
    returning id into record_id;
    select to_jsonb(item.*) into next_record from private.hr_offers item where item.id = record_id;
    perform private.hr_recruiting_append_event('offer', record_id, target_action, target_actor_id, target_reason, null, next_record);
  elsif target_action = 'submit_offer' then
    record_id := (target_payload->>'offerId')::uuid;
    select to_jsonb(item.*) into previous_record from private.hr_offers item where item.id = record_id for update;
    update private.hr_offers set status = 'pending_approval', updated_at = clock_timestamp() where id = record_id and status = 'draft' returning to_jsonb(hr_offers) into next_record;
    if next_record is null then raise check_violation using message = 'Only a draft offer can be submitted for approval.'; end if;
    perform private.hr_recruiting_append_event('offer', record_id, target_action, target_actor_id, target_reason, previous_record, next_record);
  elsif target_action = 'approve_offer' then
    record_id := (target_payload->>'offerId')::uuid;
    select to_jsonb(item.*) into previous_record from private.hr_offers item where item.id = record_id for update;
    update private.hr_offers set status = 'approved', approved_by = target_actor_id, approved_at = clock_timestamp(), updated_at = clock_timestamp() where id = record_id and status = 'pending_approval' returning to_jsonb(hr_offers) into next_record;
    if next_record is null then raise check_violation using message = 'Only a pending offer can be approved.'; end if;
    perform private.hr_recruiting_append_event('offer', record_id, target_action, target_actor_id, target_reason, previous_record, next_record);
  elsif target_action = 'mark_offer_sent' then
    record_id := (target_payload->>'offerId')::uuid;
    select to_jsonb(item.*) into previous_record from private.hr_offers item where item.id = record_id for update;
    update private.hr_offers set status = 'sent', updated_at = clock_timestamp() where id = record_id and status = 'approved' returning to_jsonb(hr_offers) into next_record;
    if next_record is null then raise check_violation using message = 'Only an approved offer can be marked sent.'; end if;
    perform private.hr_recruiting_append_event('offer', record_id, target_action, target_actor_id, target_reason, previous_record, next_record);
  elsif target_action = 'record_offer_decision' then
    record_id := (target_payload->>'offerId')::uuid;
    select to_jsonb(item.*) into previous_record from private.hr_offers item where item.id = record_id for update;
    update private.hr_offers set status = target_payload->>'decision', candidate_decided_at = clock_timestamp(), updated_at = clock_timestamp() where id = record_id and status in ('approved','sent') and target_payload->>'decision' in ('accepted','declined') returning to_jsonb(hr_offers) into next_record;
    if next_record is null then raise check_violation using message = 'The offer decision is not valid.'; end if;
    if target_payload->>'decision' = 'accepted' then update private.hr_applications set stage='accepted', stage_changed_at=clock_timestamp(), updated_at=clock_timestamp() where id=(next_record->>'application_id')::uuid; end if;
    perform private.hr_recruiting_append_event('offer', record_id, target_action, target_actor_id, target_reason, previous_record, next_record);
  elsif target_action = 'dispose_application' then
    record_id := (target_payload->>'applicationId')::uuid;
    select to_jsonb(item.*) into previous_record from private.hr_applications item where item.id = record_id for update;
    update private.hr_applications
    set stage = case target_payload->>'disposition' when 'withdrawn' then 'withdrawn' else 'rejected' end,
        status = case target_payload->>'disposition' when 'withdrawn' then 'withdrawn' else 'rejected' end,
        disposition_reason = btrim(target_payload->>'dispositionReason'),
        disposition_note = nullif(btrim(target_payload->>'dispositionNote'),''),
        disposed_at = clock_timestamp(), disposed_by = target_actor_id,
        stage_changed_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = record_id and status in ('active','on_hold') and target_payload->>'disposition' in ('withdrawn','rejected') and btrim(coalesce(target_payload->>'dispositionReason','')) <> ''
    returning to_jsonb(hr_applications) into next_record;
    if next_record is null then raise check_violation using message = 'A valid disposition and reason are required for an active application.'; end if;
    insert into private.hr_application_stage_history(application_id, from_stage, to_stage, reason, changed_by) values(record_id, previous_record->>'stage', next_record->>'stage', target_reason, target_actor_id);
    perform private.hr_recruiting_append_event('application', record_id, target_action, target_actor_id, target_reason, previous_record, next_record);
  else
    raise check_violation using message = 'Unsupported recruiting action.';
  end if;
  return jsonb_build_object('id', record_id, 'action', target_action, 'record', next_record);
end
$$;

do $$
declare relation_name text;
begin
  foreach relation_name in array array['hr_recruiting_release_gate','hr_requisitions','hr_applicants','hr_applications','hr_application_stage_history','hr_interviews','hr_interview_panelists','hr_interview_scorecards','hr_offers','hr_recruiting_events'] loop
    execute format('alter table private.%I enable row level security', relation_name);
    execute format('revoke all on private.%I from public, anon, authenticated', relation_name);
    execute format('grant select, insert, update on private.%I to service_role', relation_name);
  end loop;
  create trigger hr_recruiting_events_append_only before update or delete on private.hr_recruiting_events for each row execute function private.prevent_append_only_change();
  create trigger hr_application_stage_history_append_only before update or delete on private.hr_application_stage_history for each row execute function private.prevent_append_only_change();
  create trigger hr_interview_scorecards_append_only before update or delete on private.hr_interview_scorecards for each row execute function private.prevent_append_only_change();
end
$$;

revoke all on function private.hr_recruiting_require_actor_permission(uuid,text) from public,anon,authenticated;
revoke all on function private.hr_recruiting_assert_enabled() from public,anon,authenticated;
revoke all on function private.hr_recruiting_append_event(text,uuid,text,uuid,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.service_get_hr_recruiting_workspace(uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.service_hr_recruiting_action(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function private.hr_recruiting_require_actor_permission(uuid,text) to service_role;
grant execute on function private.hr_recruiting_assert_enabled() to service_role;
grant execute on function private.hr_recruiting_append_event(text,uuid,text,uuid,text,jsonb,jsonb) to service_role;
grant execute on function public.service_get_hr_recruiting_workspace(uuid,integer,integer) to service_role;
grant execute on function public.service_hr_recruiting_action(uuid,text,jsonb,text) to service_role;

do $$
declare baseline_employee_count bigint; baseline_employee_role_count bigint; baseline_role_permission_count bigint; baseline_override_count bigint; baseline_account_count bigint;
begin
  select employee_count, employee_role_count, role_permission_count, override_count, account_count into baseline_employee_count, baseline_employee_role_count, baseline_role_permission_count, baseline_override_count, baseline_account_count from hris_stage6_run1_preservation_baseline;
  if baseline_employee_count <> (select count(*) from public.employees) or baseline_employee_role_count <> (select count(*) from public.employee_access_roles) or baseline_role_permission_count <> (select count(*) from public.access_role_permissions) or baseline_override_count <> (select count(*) from public.employee_permission_overrides) or baseline_account_count <> (select count(*) from private.employee_accounts) then
    raise exception 'Stage 6 run 1 changed protected employee or access-control assignments.';
  end if;
end
$$;

commit;
