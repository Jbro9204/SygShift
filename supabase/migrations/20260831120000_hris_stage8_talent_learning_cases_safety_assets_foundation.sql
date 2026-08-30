begin;

-- Stage 8: dormant Talent, Learning, Employee Cases, Safety, and Asset
-- foundations. No module is enabled, no employee data is inferred, and no
-- existing role or person receives access through this migration.
create temporary table hris_stage8_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) employee_count,
  (select count(*) from public.employee_access_roles) employee_role_count,
  (select count(*) from public.access_role_permissions) role_permission_count,
  (select count(*) from public.employee_permission_overrides) override_count,
  (select count(*) from private.employee_accounts) account_count,
  (select count(*) from public.time_off_requests) time_off_request_count;

insert into public.permission_catalog(code,category,name,description,risk_level,requires_mfa,locked,active)
values
  ('hr.talent.view','HR & Finance','View talent records','View performance cycles, goals, reviews, and development plans.','sensitive',true,true,true),
  ('hr.talent.manage','HR & Finance','Manage talent records','Create and maintain performance, goal, and development records.','critical',true,true,true),
  ('hr.talent.restricted','HR & Finance','View restricted talent records','View restricted calibration, succession, and performance-improvement records.','critical',true,true,true),
  ('hr.learning.view','HR & Finance','View learning records','View courses, assignments, completion history, and evidence.','sensitive',true,true,true),
  ('hr.learning.manage','HR & Finance','Manage learning catalog','Create and maintain learning items, evidence, and renewal rules.','critical',true,true,true),
  ('hr.learning.assign','HR & Finance','Assign learning','Assign required or optional learning and record completion decisions.','critical',true,true,true),
  ('hr.cases.view','HR & Finance','View employee cases','View employee-relations case summaries and work queues.','critical',true,true,true),
  ('hr.cases.manage','HR & Finance','Manage employee cases','Create and maintain employee-relations cases, tasks, evidence, and outcomes.','critical',true,true,true),
  ('hr.cases.restricted','HR & Finance','View restricted case records','View legally restricted case notes and evidence with recent MFA.','critical',true,true,true),
  ('hr.safety.view','HR & Finance','View safety records','View safety incidents, restrictions, and return-to-work status.','critical',true,true,true),
  ('hr.safety.manage','HR & Finance','Manage safety records','Create and maintain safety incidents, tasks, witnesses, and return-to-work records.','critical',true,true,true),
  ('hr.safety.restricted','HR & Finance','View restricted safety records','View restricted medical and workers compensation records with recent MFA.','critical',true,true,true),
  ('hr.assets.view','HR & Finance','View company assets','View company assets and employee assignment history.','sensitive',true,true,true),
  ('hr.assets.manage','HR & Finance','Manage company assets','Create assets and record issue, transfer, condition, loss, and return events.','critical',true,true,true),
  ('hr.assets.approve','HR & Finance','Approve asset decisions','Approve financial review, loss, damage, and offboarding asset decisions.','critical',true,true,true)
on conflict(code) do update set category=excluded.category,name=excluded.name,description=excluded.description,
  risk_level=excluded.risk_level,requires_mfa=excluded.requires_mfa,locked=excluded.locked,active=excluded.active;

create table private.hr_stage8_release_gates (
  module text primary key,
  enabled boolean not null default false,
  enabled_by uuid references public.employees(id) on delete restrict,
  enabled_at timestamptz,
  reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_stage8_gate_module check(module in ('talent','learning','cases','safety','assets')),
  constraint hr_stage8_gate_consistent check(
    (not enabled and enabled_by is null and enabled_at is null)
    or (enabled and enabled_by is not null and enabled_at is not null and btrim(coalesce(reason,''))<>'')
  )
);
insert into private.hr_stage8_release_gates(module) values ('talent'),('learning'),('cases'),('safety'),('assets');

create table private.hr_talent_cycles (
  id uuid primary key default gen_random_uuid(), name text not null, cycle_type text not null default 'performance',
  status text not null default 'draft', starts_on date not null, ends_on date not null,
  configuration jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.employees(id) on delete restrict,
  approved_by uuid references public.employees(id) on delete restrict, approved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_talent_cycle_name check(btrim(name)<>'' and char_length(name)<=160),
  constraint hr_talent_cycle_type check(cycle_type in ('performance','probationary','development','check_in','other')),
  constraint hr_talent_cycle_status check(status in ('draft','open','closed','archived')),
  constraint hr_talent_cycle_dates check(ends_on>=starts_on),
  constraint hr_talent_cycle_config check(jsonb_typeof(configuration)='object'),
  constraint hr_talent_cycle_approval check((approved_by is null and approved_at is null) or (approved_by is not null and approved_at is not null))
);

create table private.hr_talent_goals (
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.employees(id) on delete restrict,
  cycle_id uuid references private.hr_talent_cycles(id) on delete restrict, parent_goal_id uuid references private.hr_talent_goals(id) on delete restrict,
  title text not null, description text, status text not null default 'draft', progress_percent numeric(5,2) not null default 0,
  starts_on date, due_on date, created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_talent_goal_title check(btrim(title)<>'' and char_length(title)<=200),
  constraint hr_talent_goal_status check(status in ('draft','active','completed','canceled','archived')),
  constraint hr_talent_goal_progress check(progress_percent between 0 and 100),
  constraint hr_talent_goal_dates check(due_on is null or starts_on is null or due_on>=starts_on)
);

create table private.hr_talent_reviews (
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.employees(id) on delete restrict,
  cycle_id uuid references private.hr_talent_cycles(id) on delete restrict,
  reviewer_id uuid not null references public.employees(id) on delete restrict,
  review_type text not null default 'manager', status text not null default 'draft', rating numeric(5,2), summary text,
  submitted_at timestamptz, acknowledged_by uuid references public.employees(id) on delete restrict, acknowledged_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_talent_review_type check(review_type in ('self','manager','peer','probationary','check_in','other')),
  constraint hr_talent_review_status check(status in ('draft','in_progress','submitted','acknowledged','closed','canceled')),
  constraint hr_talent_review_rating check(rating is null or rating between 0 and 100),
  constraint hr_talent_review_ack check((acknowledged_by is null and acknowledged_at is null) or (acknowledged_by is not null and acknowledged_at is not null))
);

create table private.hr_talent_development_plans (
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.employees(id) on delete restrict,
  title text not null, status text not null default 'draft', objectives jsonb not null default '[]'::jsonb,
  starts_on date, target_on date, owner_id uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_talent_plan_title check(btrim(title)<>'' and char_length(title)<=200),
  constraint hr_talent_plan_status check(status in ('draft','active','completed','canceled','archived')),
  constraint hr_talent_plan_objectives check(jsonb_typeof(objectives)='array'),
  constraint hr_talent_plan_dates check(target_on is null or starts_on is null or target_on>=starts_on)
);

create table private.hr_talent_restricted_records (
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.employees(id) on delete restrict,
  record_type text not null, status text not null default 'active', summary text not null,
  details jsonb not null default '{}'::jsonb, document_id uuid references private.hr_documents(id) on delete restrict,
  recorded_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_talent_restricted_type check(record_type in ('calibration','succession','nine_box','performance_improvement','career_planning','other')),
  constraint hr_talent_restricted_status check(status in ('active','completed','closed','archived')),
  constraint hr_talent_restricted_summary check(btrim(summary)<>'' and char_length(summary)<=2000),
  constraint hr_talent_restricted_details check(jsonb_typeof(details)='object')
);

create table private.hr_talent_events (
  id uuid primary key default gen_random_uuid(), employee_id uuid references public.employees(id) on delete restrict,
  entity_type text not null, entity_id uuid, action text not null,
  actor_id uuid not null references public.employees(id) on delete restrict, reason text not null,
  details jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_talent_event_text check(btrim(entity_type)<>'' and btrim(action)<>'' and btrim(reason)<>''),
  constraint hr_talent_event_details check(jsonb_typeof(details)='object')
);

create table private.hr_learning_categories (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null, description text,
  status text not null default 'active', created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_learning_category_code check(code ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  constraint hr_learning_category_name check(btrim(name)<>'' and char_length(name)<=160),
  constraint hr_learning_category_status check(status in ('active','retired'))
);

create table private.hr_learning_items (
  id uuid primary key default gen_random_uuid(), category_id uuid references private.hr_learning_categories(id) on delete restrict,
  code text not null unique, title text not null, description text, delivery_method text not null default 'external',
  requirement_type text not null default 'optional', renewal_days integer, status text not null default 'draft',
  configuration jsonb not null default '{}'::jsonb, created_by uuid not null references public.employees(id) on delete restrict,
  approved_by uuid references public.employees(id) on delete restrict, approved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_learning_item_code check(code ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  constraint hr_learning_item_title check(btrim(title)<>'' and char_length(title)<=200),
  constraint hr_learning_delivery check(delivery_method in ('in_person','virtual','self_paced','external','document','other')),
  constraint hr_learning_requirement check(requirement_type in ('required','optional','role_required','site_required','credential_related')),
  constraint hr_learning_renewal check(renewal_days is null or renewal_days>0),
  constraint hr_learning_item_status check(status in ('draft','active','retired')),
  constraint hr_learning_item_config check(jsonb_typeof(configuration)='object'),
  constraint hr_learning_item_approval check((approved_by is null and approved_at is null) or (approved_by is not null and approved_at is not null))
);

create table private.hr_learning_assignments (
  id uuid primary key default gen_random_uuid(), learning_item_id uuid not null references private.hr_learning_items(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  assigned_by uuid not null references public.employees(id) on delete restrict, assigned_at timestamptz not null default clock_timestamp(),
  due_on date, status text not null default 'assigned', completed_at timestamptz, expires_on date,
  completion_source text, completion_note text, updated_at timestamptz not null default clock_timestamp(),
  constraint hr_learning_assignment_unique unique(learning_item_id,employee_id,assigned_at),
  constraint hr_learning_assignment_status check(status in ('assigned','in_progress','completed','waived','overdue','canceled')),
  constraint hr_learning_assignment_completion check((status<>'completed' and completed_at is null) or (status='completed' and completed_at is not null)),
  constraint hr_learning_assignment_expiry check(expires_on is null or completed_at is null or expires_on>=completed_at::date)
);

create table private.hr_learning_evidence (
  id uuid primary key default gen_random_uuid(), assignment_id uuid not null references private.hr_learning_assignments(id) on delete restrict,
  evidence_type text not null, summary text not null, document_id uuid references private.hr_documents(id) on delete restrict,
  recorded_by uuid not null references public.employees(id) on delete restrict, recorded_at timestamptz not null default clock_timestamp(),
  constraint hr_learning_evidence_type check(evidence_type in ('certificate','attendance','score','external_record','manager_attestation','other')),
  constraint hr_learning_evidence_summary check(btrim(summary)<>'' and char_length(summary)<=2000)
);

create table private.hr_learning_license_connections (
  id uuid primary key default gen_random_uuid(), learning_item_id uuid not null references private.hr_learning_items(id) on delete restrict,
  credential_type_id uuid not null references public.credential_types(id) on delete restrict,
  relationship text not null default 'supports', created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint hr_learning_license_unique unique(learning_item_id,credential_type_id,relationship),
  constraint hr_learning_license_relationship check(relationship in ('prerequisite','supports','renews','evidence_for'))
);

create table private.hr_learning_events (
  id uuid primary key default gen_random_uuid(), assignment_id uuid references private.hr_learning_assignments(id) on delete restrict,
  learning_item_id uuid references private.hr_learning_items(id) on delete restrict, action text not null,
  actor_id uuid not null references public.employees(id) on delete restrict, reason text not null,
  details jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_learning_event_text check(btrim(action)<>'' and btrim(reason)<>''),
  constraint hr_learning_event_details check(jsonb_typeof(details)='object')
);

create table private.hr_cases (
  id uuid primary key default gen_random_uuid(), case_number bigint generated always as identity unique,
  subject_employee_id uuid references public.employees(id) on delete restrict, case_type text not null,
  title text not null, status text not null default 'open', priority text not null default 'normal',
  owner_id uuid not null references public.employees(id) on delete restrict, opened_by uuid not null references public.employees(id) on delete restrict,
  opened_at timestamptz not null default clock_timestamp(), closed_by uuid references public.employees(id) on delete restrict,
  closed_at timestamptz, outcome text, legal_hold boolean not null default false,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_case_type check(case_type in ('complaint','grievance','investigation','coaching','corrective_action','accommodation','protected_leave','harassment','policy','legal','other')),
  constraint hr_case_title check(btrim(title)<>'' and char_length(title)<=200),
  constraint hr_case_status check(status in ('open','triage','investigating','pending','resolved','closed','canceled')),
  constraint hr_case_priority check(priority in ('low','normal','high','urgent')),
  constraint hr_case_close check((status not in ('resolved','closed','canceled') and closed_by is null and closed_at is null) or (status in ('resolved','closed','canceled') and closed_by is not null and closed_at is not null and btrim(coalesce(outcome,''))<>''))
);

create table private.hr_case_participants (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references private.hr_cases(id) on delete restrict,
  employee_id uuid references public.employees(id) on delete restrict, participant_name text,
  participant_role text not null, added_by uuid not null references public.employees(id) on delete restrict,
  added_at timestamptz not null default clock_timestamp(),
  constraint hr_case_participant_identity check(employee_id is not null or btrim(coalesce(participant_name,''))<>''),
  constraint hr_case_participant_role check(participant_role in ('subject','complainant','witness','owner','reviewer','representative','other'))
);

create table private.hr_case_notes (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references private.hr_cases(id) on delete restrict,
  note_type text not null default 'case_note', note text not null, restricted boolean not null default true,
  recorded_by uuid not null references public.employees(id) on delete restrict, recorded_at timestamptz not null default clock_timestamp(),
  constraint hr_case_note_type check(note_type in ('case_note','interview','finding','decision','communication','legal','other')),
  constraint hr_case_note_text check(btrim(note)<>'' and char_length(note)<=10000)
);

create table private.hr_case_tasks (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references private.hr_cases(id) on delete restrict,
  title text not null, assigned_to uuid references public.employees(id) on delete restrict, due_on date,
  status text not null default 'open', completed_at timestamptz,
  created_by uuid not null references public.employees(id) on delete restrict, created_at timestamptz not null default clock_timestamp(),
  constraint hr_case_task_title check(btrim(title)<>'' and char_length(title)<=200),
  constraint hr_case_task_status check(status in ('open','in_progress','completed','canceled')),
  constraint hr_case_task_completion check((status<>'completed' and completed_at is null) or (status='completed' and completed_at is not null))
);

create table private.hr_case_evidence (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references private.hr_cases(id) on delete restrict,
  evidence_type text not null, summary text not null, document_id uuid references private.hr_documents(id) on delete restrict,
  collected_by uuid not null references public.employees(id) on delete restrict, collected_at timestamptz not null default clock_timestamp(),
  legal_hold boolean not null default false,
  constraint hr_case_evidence_type check(evidence_type in ('document','photo','video','audio','email','statement','system_record','other')),
  constraint hr_case_evidence_summary check(btrim(summary)<>'' and char_length(summary)<=2000)
);

create table private.hr_case_events (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references private.hr_cases(id) on delete restrict,
  action text not null, actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null, details jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_case_event_text check(btrim(action)<>'' and btrim(reason)<>''),
  constraint hr_case_event_details check(jsonb_typeof(details)='object')
);

create table private.hr_safety_cases (
  id uuid primary key default gen_random_uuid(), incident_number bigint generated always as identity unique,
  employee_id uuid references public.employees(id) on delete restrict, site_id uuid references public.sites(id) on delete restrict,
  incident_type text not null, title text not null, status text not null default 'open', occurred_at timestamptz not null,
  reported_by uuid not null references public.employees(id) on delete restrict, reported_at timestamptz not null default clock_timestamp(),
  owner_id uuid references public.employees(id) on delete restrict, claim_number text, legal_hold boolean not null default false,
  closed_by uuid references public.employees(id) on delete restrict, closed_at timestamptz, outcome text,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_safety_type check(incident_type in ('injury','illness','near_miss','vehicle','property','violence','exposure','workers_comp','other')),
  constraint hr_safety_title check(btrim(title)<>'' and char_length(title)<=200),
  constraint hr_safety_status check(status in ('open','triage','investigating','treatment','restricted_duty','return_to_work','closed','canceled')),
  constraint hr_safety_close check((status not in ('closed','canceled') and closed_by is null and closed_at is null) or (status in ('closed','canceled') and closed_by is not null and closed_at is not null and btrim(coalesce(outcome,''))<>''))
);

create table private.hr_safety_witnesses (
  id uuid primary key default gen_random_uuid(), safety_case_id uuid not null references private.hr_safety_cases(id) on delete restrict,
  employee_id uuid references public.employees(id) on delete restrict, witness_name text, statement_document_id uuid references private.hr_documents(id) on delete restrict,
  recorded_by uuid not null references public.employees(id) on delete restrict, recorded_at timestamptz not null default clock_timestamp(),
  constraint hr_safety_witness_identity check(employee_id is not null or btrim(coalesce(witness_name,''))<>'')
);

create table private.hr_safety_restrictions (
  id uuid primary key default gen_random_uuid(), safety_case_id uuid not null references private.hr_safety_cases(id) on delete restrict,
  restriction_type text not null, summary text not null, starts_on date not null, ends_on date,
  status text not null default 'active', recorded_by uuid not null references public.employees(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint hr_safety_restriction_type check(restriction_type in ('no_work','modified_duty','hours','location','equipment','medical','other')),
  constraint hr_safety_restriction_summary check(btrim(summary)<>'' and char_length(summary)<=2000),
  constraint hr_safety_restriction_status check(status in ('active','released','expired','canceled')),
  constraint hr_safety_restriction_dates check(ends_on is null or ends_on>=starts_on)
);

create table private.hr_safety_return_to_work (
  id uuid primary key default gen_random_uuid(), safety_case_id uuid not null references private.hr_safety_cases(id) on delete restrict,
  planned_on date not null, actual_on date, status text not null default 'planned', work_status text not null,
  approved_by uuid references public.employees(id) on delete restrict, approved_at timestamptz, notes text,
  created_by uuid not null references public.employees(id) on delete restrict, created_at timestamptz not null default clock_timestamp(),
  constraint hr_safety_rtw_status check(status in ('planned','approved','started','completed','canceled')),
  constraint hr_safety_rtw_work_status check(work_status in ('full_duty','modified_duty','restricted_hours','not_released')),
  constraint hr_safety_rtw_dates check(actual_on is null or actual_on>=planned_on),
  constraint hr_safety_rtw_approval check((approved_by is null and approved_at is null) or (approved_by is not null and approved_at is not null))
);

create table private.hr_safety_medical_records (
  id uuid primary key default gen_random_uuid(), safety_case_id uuid not null references private.hr_safety_cases(id) on delete restrict,
  record_type text not null, summary text not null, document_id uuid references private.hr_documents(id) on delete restrict,
  recorded_by uuid not null references public.employees(id) on delete restrict, recorded_at timestamptz not null default clock_timestamp(),
  constraint hr_safety_medical_type check(record_type in ('medical_note','treatment','diagnosis','restriction','release','claim','other')),
  constraint hr_safety_medical_summary check(btrim(summary)<>'' and char_length(summary)<=2000)
);

create table private.hr_safety_events (
  id uuid primary key default gen_random_uuid(), safety_case_id uuid not null references private.hr_safety_cases(id) on delete restrict,
  action text not null, actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null, details jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_safety_event_text check(btrim(action)<>'' and btrim(reason)<>''),
  constraint hr_safety_event_details check(jsonb_typeof(details)='object')
);

create table private.hr_assets (
  id uuid primary key default gen_random_uuid(), asset_tag text not null unique, asset_type text not null,
  name text not null, description text, serial_number text, status text not null default 'available',
  condition text not null default 'good', acquired_on date, retired_on date, metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_asset_tag check(btrim(asset_tag)<>'' and char_length(asset_tag)<=100),
  constraint hr_asset_type check(asset_type in ('uniform','badge','key','access_card','radio','phone','computer','vehicle','weapon','equipment','other')),
  constraint hr_asset_name check(btrim(name)<>'' and char_length(name)<=200),
  constraint hr_asset_status check(status in ('available','assigned','maintenance','lost','damaged','retired','disposed')),
  constraint hr_asset_condition check(condition in ('new','excellent','good','fair','poor','damaged','unknown')),
  constraint hr_asset_dates check(retired_on is null or acquired_on is null or retired_on>=acquired_on),
  constraint hr_asset_metadata check(jsonb_typeof(metadata)='object')
);

create table private.hr_asset_assignments (
  id uuid primary key default gen_random_uuid(), asset_id uuid not null references private.hr_assets(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  assigned_by uuid not null references public.employees(id) on delete restrict, assigned_at timestamptz not null default clock_timestamp(),
  condition_out text not null, status text not null default 'active', returned_at timestamptz,
  received_by uuid references public.employees(id) on delete restrict, condition_in text, return_note text,
  constraint hr_asset_assignment_status check(status in ('active','returned','lost','damaged','transferred','canceled')),
  constraint hr_asset_assignment_conditions check(condition_out in ('new','excellent','good','fair','poor','damaged','unknown') and (condition_in is null or condition_in in ('new','excellent','good','fair','poor','damaged','unknown'))),
  constraint hr_asset_assignment_return check((status='active' and returned_at is null and received_by is null) or (status<>'active' and returned_at is not null))
);

create unique index hr_asset_one_active_assignment on private.hr_asset_assignments(asset_id) where status='active';

create table private.hr_asset_acknowledgments (
  id uuid primary key default gen_random_uuid(), assignment_id uuid not null references private.hr_asset_assignments(id) on delete restrict,
  acknowledgment_type text not null, acknowledged_by uuid not null references public.employees(id) on delete restrict,
  acknowledged_at timestamptz not null default clock_timestamp(), statement text not null,
  constraint hr_asset_ack_type check(acknowledgment_type in ('receipt','condition','policy','return','loss','damage','other')),
  constraint hr_asset_ack_statement check(btrim(statement)<>'')
);

create table private.hr_asset_financial_reviews (
  id uuid primary key default gen_random_uuid(), assignment_id uuid not null references private.hr_asset_assignments(id) on delete restrict,
  review_type text not null, status text not null default 'pending', amount_cents bigint,
  requested_by uuid not null references public.employees(id) on delete restrict, requested_at timestamptz not null default clock_timestamp(),
  decided_by uuid references public.employees(id) on delete restrict, decided_at timestamptz, decision_reason text,
  constraint hr_asset_financial_type check(review_type in ('loss','damage','replacement','payroll_review','write_off','other')),
  constraint hr_asset_financial_status check(status in ('pending','approved','denied','withdrawn')),
  constraint hr_asset_financial_amount check(amount_cents is null or amount_cents>=0),
  constraint hr_asset_financial_decision check((status='pending' and decided_by is null and decided_at is null and decision_reason is null) or (status<>'pending' and decided_by is not null and decided_at is not null and btrim(coalesce(decision_reason,''))<>''))
);

create table private.hr_asset_events (
  id uuid primary key default gen_random_uuid(), asset_id uuid not null references private.hr_assets(id) on delete restrict,
  assignment_id uuid references private.hr_asset_assignments(id) on delete restrict,
  action text not null, actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null, details jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_asset_event_text check(btrim(action)<>'' and btrim(reason)<>''),
  constraint hr_asset_event_details check(jsonb_typeof(details)='object')
);

create or replace function private.hr_stage8_assert_enabled(target_module text) returns void language plpgsql stable security definer set search_path='' as $$
declare module_enabled boolean;
begin
  if target_module not in ('talent','learning','cases','safety','assets') then raise check_violation using message='Unsupported Stage 8 HR module.'; end if;
  select gate.enabled into module_enabled from private.hr_stage8_release_gates gate where gate.module=target_module;
  if not coalesce(module_enabled,false) then raise check_violation using message='This HR module is staged but not enabled.'; end if;
end $$;

create or replace function private.hr_stage8_require_actor_permission(target_actor_id uuid,target_permission text) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.employees employee where employee.id=target_actor_id and employee.status='active') then raise insufficient_privilege using message='An active employee identity is required.'; end if;
  if not exists(select 1 from private.employee_accounts account where account.employee_id=target_actor_id and account.disabled_at is null and account.activated_at is not null) then raise insufficient_privilege using message='An active login is required.'; end if;
  if not (target_permission=any(coalesce(private.employee_effective_permissions(target_actor_id),array[]::text[]))) then raise insufficient_privilege using message='The requested HR permission is required.'; end if;
end $$;

create or replace function private.hr_stage8_require_recent_mfa(target_method text,target_verified_at timestamptz,target_scope text) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if target_method not in ('authenticator','totp','security_key','webauthn','recovery_code') or target_verified_at is null or target_verified_at < clock_timestamp()-interval '15 minutes' or target_verified_at > clock_timestamp()+interval '1 minute' then
    raise insufficient_privilege using message=format('Recent MFA verification is required for %s access.',target_scope);
  end if;
end $$;

-- The Worker reports authenticator verification using the public method label.
-- Keep the existing compensation gate aligned before that dormant module is enabled.
create or replace function private.hr_compensation_require_recent_mfa(target_method text,target_verified_at timestamptz) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if target_method not in ('authenticator','totp','security_key','webauthn','recovery_code') or target_verified_at is null or target_verified_at < clock_timestamp()-interval '15 minutes' or target_verified_at > clock_timestamp()+interval '1 minute' then
    raise insufficient_privilege using message='Recent MFA verification is required for compensation access.';
  end if;
end $$;

create or replace function public.service_get_hr_stage8_workspace(
  target_actor_id uuid,target_module text,target_page_size integer default 10,target_offset integer default 0,
  target_mfa_method text default null,target_mfa_verified_at timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  page_size integer:=least(greatest(coalesce(target_page_size,10),1),20);
  row_offset integer:=greatest(coalesce(target_offset,0),0);
  permission_code text;
  counts_payload jsonb;
  items_payload jsonb;
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  if target_module not in ('talent','learning','cases','safety','assets') then raise check_violation using message='Unsupported Stage 8 HR module.'; end if;
  permission_code:=case target_module
    when 'talent' then 'hr.talent.view' when 'learning' then 'hr.learning.view'
    when 'cases' then 'hr.cases.view' when 'safety' then 'hr.safety.view' when 'assets' then 'hr.assets.view' end;
  perform private.hr_stage8_assert_enabled(target_module);
  perform private.hr_stage8_require_actor_permission(target_actor_id,permission_code);
  if target_module in ('cases','safety') then perform private.hr_stage8_require_recent_mfa(target_mfa_method,target_mfa_verified_at,target_module); end if;

  if target_module='talent' then
    counts_payload:=jsonb_build_object('primary',(select count(*) from private.hr_talent_cycles where status='open'),'secondary',(select count(*) from private.hr_talent_goals where status='active'),'tertiary',(select count(*) from private.hr_talent_reviews where status in ('draft','in_progress')));
    select coalesce(jsonb_agg(row.payload order by row.sort_at desc),'[]'::jsonb) into items_payload from (
      select goal.updated_at sort_at,jsonb_build_object('id',goal.id,'title',concat_ws(' ',employee.first_name,employee.last_name),'subtitle',goal.title,'status',goal.status,'dateLabel',goal.due_on,'detail',concat(goal.progress_percent,'% complete')) payload
      from private.hr_talent_goals goal join public.employees employee on employee.id=goal.employee_id
      order by goal.updated_at desc limit page_size offset row_offset
    ) row;
  elsif target_module='learning' then
    counts_payload:=jsonb_build_object('primary',(select count(*) from private.hr_learning_items where status='active'),'secondary',(select count(*) from private.hr_learning_assignments where status in ('assigned','in_progress','overdue')),'tertiary',(select count(*) from private.hr_learning_assignments where status='completed'));
    select coalesce(jsonb_agg(row.payload order by row.sort_at desc),'[]'::jsonb) into items_payload from (
      select assignment.assigned_at sort_at,jsonb_build_object('id',assignment.id,'title',concat_ws(' ',employee.first_name,employee.last_name),'subtitle',item.title,'status',assignment.status,'dateLabel',assignment.due_on,'detail',item.requirement_type) payload
      from private.hr_learning_assignments assignment join private.hr_learning_items item on item.id=assignment.learning_item_id join public.employees employee on employee.id=assignment.employee_id
      order by assignment.assigned_at desc limit page_size offset row_offset
    ) row;
  elsif target_module='cases' then
    counts_payload:=jsonb_build_object('primary',(select count(*) from private.hr_cases where status in ('open','triage','investigating','pending')),'secondary',(select count(*) from private.hr_cases where priority in ('high','urgent') and status not in ('closed','canceled')),'tertiary',(select count(*) from private.hr_case_tasks where status in ('open','in_progress')));
    select coalesce(jsonb_agg(row.payload order by row.sort_at desc),'[]'::jsonb) into items_payload from (
      select case_record.updated_at sort_at,jsonb_build_object('id',case_record.id,'title',concat('Case ',case_record.case_number),'subtitle',case_record.title,'status',case_record.status,'dateLabel',case_record.opened_at::date,'detail',concat(case_record.case_type,' · ',case_record.priority)) payload
      from private.hr_cases case_record order by case_record.updated_at desc limit page_size offset row_offset
    ) row;
  elsif target_module='safety' then
    counts_payload:=jsonb_build_object('primary',(select count(*) from private.hr_safety_cases where status not in ('closed','canceled')),'secondary',(select count(*) from private.hr_safety_restrictions where status='active'),'tertiary',(select count(*) from private.hr_safety_return_to_work where status in ('planned','approved','started')));
    select coalesce(jsonb_agg(row.payload order by row.sort_at desc),'[]'::jsonb) into items_payload from (
      select safety_case.updated_at sort_at,jsonb_build_object('id',safety_case.id,'title',concat('Incident ',safety_case.incident_number),'subtitle',safety_case.title,'status',safety_case.status,'dateLabel',safety_case.occurred_at::date,'detail',safety_case.incident_type) payload
      from private.hr_safety_cases safety_case order by safety_case.updated_at desc limit page_size offset row_offset
    ) row;
  else
    counts_payload:=jsonb_build_object('primary',(select count(*) from private.hr_assets where status='available'),'secondary',(select count(*) from private.hr_asset_assignments where status='active'),'tertiary',(select count(*) from private.hr_asset_financial_reviews where status='pending'));
    select coalesce(jsonb_agg(row.payload order by row.sort_at desc),'[]'::jsonb) into items_payload from (
      select asset.updated_at sort_at,jsonb_build_object('id',asset.id,'title',asset.asset_tag,'subtitle',asset.name,'status',asset.status,'dateLabel',asset.acquired_on,'detail',concat(asset.asset_type,' · ',asset.condition)) payload
      from private.hr_assets asset order by asset.updated_at desc limit page_size offset row_offset
    ) row;
  end if;

  return jsonb_build_object('enabled',true,'module',target_module,'pageSize',page_size,'offset',row_offset,'counts',counts_payload,'items',coalesce(items_payload,'[]'::jsonb));
end $$;

do $$ declare relation_name text; begin
  foreach relation_name in array array[
    'hr_stage8_release_gates','hr_talent_cycles','hr_talent_goals','hr_talent_reviews','hr_talent_development_plans','hr_talent_restricted_records','hr_talent_events',
    'hr_learning_categories','hr_learning_items','hr_learning_assignments','hr_learning_evidence','hr_learning_license_connections','hr_learning_events',
    'hr_cases','hr_case_participants','hr_case_notes','hr_case_tasks','hr_case_evidence','hr_case_events',
    'hr_safety_cases','hr_safety_witnesses','hr_safety_restrictions','hr_safety_return_to_work','hr_safety_medical_records','hr_safety_events',
    'hr_assets','hr_asset_assignments','hr_asset_acknowledgments','hr_asset_financial_reviews','hr_asset_events'
  ] loop
    execute format('alter table private.%I enable row level security',relation_name);
    execute format('revoke all on private.%I from public,anon,authenticated',relation_name);
    execute format('grant select,insert,update on private.%I to service_role',relation_name);
  end loop;
  create trigger hr_talent_events_append_only before update or delete on private.hr_talent_events for each row execute function private.prevent_append_only_change();
  create trigger hr_learning_events_append_only before update or delete on private.hr_learning_events for each row execute function private.prevent_append_only_change();
  create trigger hr_case_events_append_only before update or delete on private.hr_case_events for each row execute function private.prevent_append_only_change();
  create trigger hr_safety_events_append_only before update or delete on private.hr_safety_events for each row execute function private.prevent_append_only_change();
  create trigger hr_asset_events_append_only before update or delete on private.hr_asset_events for each row execute function private.prevent_append_only_change();
  create trigger hr_asset_acknowledgments_append_only before update or delete on private.hr_asset_acknowledgments for each row execute function private.prevent_append_only_change();
end $$;

revoke all on function private.hr_stage8_assert_enabled(text) from public,anon,authenticated;
revoke all on function private.hr_stage8_require_actor_permission(uuid,text) from public,anon,authenticated;
revoke all on function private.hr_stage8_require_recent_mfa(text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.service_get_hr_stage8_workspace(uuid,text,integer,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function private.hr_stage8_assert_enabled(text) to service_role;
grant execute on function private.hr_stage8_require_actor_permission(uuid,text) to service_role;
grant execute on function private.hr_stage8_require_recent_mfa(text,timestamptz,text) to service_role;
grant execute on function public.service_get_hr_stage8_workspace(uuid,text,integer,integer,text,timestamptz) to service_role;
grant usage,select on sequence private.hr_cases_case_number_seq to service_role;
grant usage,select on sequence private.hr_safety_cases_incident_number_seq to service_role;

do $$ declare baseline record; begin
  select * into baseline from hris_stage8_preservation_baseline;
  if baseline.employee_count<>(select count(*) from public.employees)
    or baseline.employee_role_count<>(select count(*) from public.employee_access_roles)
    or baseline.role_permission_count<>(select count(*) from public.access_role_permissions)
    or baseline.override_count<>(select count(*) from public.employee_permission_overrides)
    or baseline.account_count<>(select count(*) from private.employee_accounts)
    or baseline.time_off_request_count<>(select count(*) from public.time_off_requests) then
    raise exception 'Stage 8 changed protected identities, access assignments, accounts, or operational time-off records.';
  end if;
end $$;

commit;
