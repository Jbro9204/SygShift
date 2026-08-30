begin;

-- Stage 7: protected Leave, Benefits, and Compensation foundations. These
-- modules remain dormant until both their database gate and Worker flag are
-- deliberately enabled. No policy, plan, balance, rate, or access assignment
-- is inferred by this migration.
create temporary table hris_stage7_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) employee_count,
  (select count(*) from public.employee_access_roles) employee_role_count,
  (select count(*) from public.access_role_permissions) role_permission_count,
  (select count(*) from public.employee_permission_overrides) override_count,
  (select count(*) from private.employee_accounts) account_count,
  (select count(*) from public.time_off_requests) time_off_request_count;

insert into public.permission_catalog(code,category,name,description,risk_level,requires_mfa,locked,active)
values
  ('hr.leave.view','HR & Finance','View leave administration','View protected leave cases and policy status without protected medical details.','sensitive',true,true,true),
  ('hr.leave.manage','HR & Finance','Manage leave administration','Create and maintain leave cases linked to operational time-off requests.','critical',true,true,true),
  ('hr.leave.approve','HR & Finance','Approve leave administration','Approve leave cases and authorize documented downstream treatment.','critical',true,true,true),
  ('hr.leave.protected.view','HR & Finance','View protected leave records','View restricted medical and protected leave details.','critical',true,true,true),
  ('hr.leave.protected.manage','HR & Finance','Manage protected leave records','Create and maintain restricted medical and protected leave details.','critical',true,true,true),
  ('hr.benefits.view','HR & Finance','View benefits administration','View configured benefit plans, eligibility, enrollment windows, and enrollments.','sensitive',true,true,true),
  ('hr.benefits.manage','HR & Finance','Manage benefits administration','Configure benefit plans, tiers, eligibility rules, and enrollment records.','critical',true,true,true),
  ('hr.benefits.approve','HR & Finance','Approve benefits administration','Activate benefit configurations and approve enrollment decisions.','critical',true,true,true),
  ('hr.compensation.view','HR & Finance','View compensation','View effective-dated compensation records and change history.','critical',true,true,true),
  ('hr.compensation.manage','HR & Finance','Manage compensation','Create compensation components and propose employee changes.','critical',true,true,true),
  ('hr.compensation.approve','HR & Finance','Approve compensation','Approve or reject compensation changes with recent MFA.','critical',true,true,true)
on conflict(code) do update set category=excluded.category,name=excluded.name,description=excluded.description,
  risk_level=excluded.risk_level,requires_mfa=excluded.requires_mfa,locked=excluded.locked,active=excluded.active;

create table private.hr_leave_release_gate (
  singleton boolean primary key default true check(singleton), enabled boolean not null default false,
  enabled_by uuid references public.employees(id) on delete restrict, enabled_at timestamptz, reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_leave_gate_consistent check((not enabled and enabled_by is null and enabled_at is null) or (enabled and enabled_by is not null and enabled_at is not null and btrim(coalesce(reason,''))<>''))
);
insert into private.hr_leave_release_gate(singleton) values(true);

create table private.hr_leave_policy_definitions (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null,
  description text, employment_types text[] not null default array[]::text[], request_types text[] not null default array[]::text[],
  status text not null default 'draft', effective_from date, effective_through date,
  rules jsonb not null default '{}'::jsonb, created_by uuid not null references public.employees(id) on delete restrict,
  approved_by uuid references public.employees(id) on delete restrict, approved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_leave_policy_code check(code ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  constraint hr_leave_policy_name check(btrim(name)<>'' and char_length(name)<=160),
  constraint hr_leave_policy_status check(status in ('draft','active','retired')),
  constraint hr_leave_policy_employment_types check(employment_types <@ array['hourly','salary','flex']::text[]),
  constraint hr_leave_policy_request_types check(request_types <@ array['paid_vacation','sick_time','unpaid_time_off']::text[]),
  constraint hr_leave_policy_dates check(effective_through is null or effective_from is null or effective_through>=effective_from),
  constraint hr_leave_policy_rules check(jsonb_typeof(rules)='object'),
  constraint hr_leave_policy_approval check((approved_by is null and approved_at is null) or (approved_by is not null and approved_at is not null))
);

create table private.hr_leave_cases (
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.employees(id) on delete restrict,
  time_off_request_id uuid unique references public.time_off_requests(id) on delete restrict,
  policy_id uuid references private.hr_leave_policy_definitions(id) on delete restrict,
  case_type text not null, status text not null default 'open', start_on date not null, return_on date,
  pay_treatment text not null default 'unpaid', operational_summary text,
  opened_by uuid not null references public.employees(id) on delete restrict, opened_at timestamptz not null default clock_timestamp(),
  decided_by uuid references public.employees(id) on delete restrict, decided_at timestamptz, decision_reason text,
  closed_by uuid references public.employees(id) on delete restrict, closed_at timestamptz, close_reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_leave_case_type check(case_type in ('paid_vacation','sick_time','unpaid_time_off','protected_leave','accommodation','other')),
  constraint hr_leave_case_status check(status in ('open','under_review','approved','denied','closed','canceled')),
  constraint hr_leave_case_dates check(return_on is null or return_on>=start_on),
  constraint hr_leave_case_pay check(pay_treatment in ('unpaid','paid_vacation','paid_sick','salary_continuation','pending')),
  constraint hr_leave_case_decision check((status not in ('approved','denied') and decided_by is null and decided_at is null and decision_reason is null) or (status in ('approved','denied') and decided_by is not null and decided_at is not null and btrim(coalesce(decision_reason,''))<>'')),
  constraint hr_leave_case_close check((status not in ('closed','canceled') and closed_by is null and closed_at is null and close_reason is null) or (status in ('closed','canceled') and closed_by is not null and closed_at is not null and btrim(coalesce(close_reason,''))<>''))
);

create table private.hr_leave_downstream_authorizations (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references private.hr_leave_cases(id) on delete restrict,
  target_system text not null, treatment text not null, effective_from date not null, effective_through date,
  status text not null default 'authorized', authorized_by uuid not null references public.employees(id) on delete restrict,
  reason text not null, authorized_at timestamptz not null default clock_timestamp(),
  constraint hr_leave_downstream_unique unique(case_id,target_system,effective_from),
  constraint hr_leave_downstream_target check(target_system in ('schedule','time_attendance','payroll')),
  constraint hr_leave_downstream_status check(status in ('authorized','applied','revoked')),
  constraint hr_leave_downstream_dates check(effective_through is null or effective_through>=effective_from),
  constraint hr_leave_downstream_reason check(btrim(reason)<>'')
);

create table private.hr_leave_protected_records (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references private.hr_leave_cases(id) on delete restrict,
  record_type text not null, summary text not null, document_id uuid references private.hr_documents(id) on delete restrict,
  recorded_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_leave_protected_type check(record_type in ('certification','medical_note','accommodation','restriction','communication','other')),
  constraint hr_leave_protected_summary check(btrim(summary)<>'' and char_length(summary)<=2000)
);

create table private.hr_leave_events (
  id uuid primary key default gen_random_uuid(), case_id uuid references private.hr_leave_cases(id) on delete restrict,
  policy_id uuid references private.hr_leave_policy_definitions(id) on delete restrict, action text not null,
  actor_id uuid not null references public.employees(id) on delete restrict, reason text not null,
  details jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_leave_event_target check(case_id is not null or policy_id is not null),
  constraint hr_leave_event_reason check(btrim(reason)<>''), constraint hr_leave_event_details check(jsonb_typeof(details)='object')
);

create table private.hr_benefits_release_gate (
  singleton boolean primary key default true check(singleton), enabled boolean not null default false,
  enabled_by uuid references public.employees(id) on delete restrict, enabled_at timestamptz, reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_benefits_gate_consistent check((not enabled and enabled_by is null and enabled_at is null) or (enabled and enabled_by is not null and enabled_at is not null and btrim(coalesce(reason,''))<>''))
);
insert into private.hr_benefits_release_gate(singleton) values(true);

create table private.hr_benefit_plans (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null, plan_type text not null,
  carrier_name text, status text not null default 'draft', created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_benefit_plan_code check(code ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  constraint hr_benefit_plan_name check(btrim(name)<>'' and char_length(name)<=160),
  constraint hr_benefit_plan_type check(plan_type in ('medical','dental','vision','life','disability','retirement','other')),
  constraint hr_benefit_plan_status check(status in ('draft','active','retired'))
);

create table private.hr_benefit_plan_versions (
  id uuid primary key default gen_random_uuid(), plan_id uuid not null references private.hr_benefit_plans(id) on delete restrict,
  version integer not null, effective_from date not null, effective_through date, configuration jsonb not null default '{}'::jsonb,
  status text not null default 'draft', created_by uuid not null references public.employees(id) on delete restrict,
  approved_by uuid references public.employees(id) on delete restrict, approved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), constraint hr_benefit_version_unique unique(plan_id,version),
  constraint hr_benefit_version_dates check(effective_through is null or effective_through>=effective_from),
  constraint hr_benefit_version_status check(status in ('draft','active','retired')),
  constraint hr_benefit_version_configuration check(jsonb_typeof(configuration)='object'),
  constraint hr_benefit_version_approval check((approved_by is null and approved_at is null) or (approved_by is not null and approved_at is not null))
);

create table private.hr_benefit_coverage_tiers (
  id uuid primary key default gen_random_uuid(), plan_version_id uuid not null references private.hr_benefit_plan_versions(id) on delete restrict,
  code text not null, name text not null, employee_cost_cents integer, employer_cost_cents integer,
  metadata jsonb not null default '{}'::jsonb, constraint hr_benefit_tier_unique unique(plan_version_id,code),
  constraint hr_benefit_tier_cost check((employee_cost_cents is null or employee_cost_cents>=0) and (employer_cost_cents is null or employer_cost_cents>=0)),
  constraint hr_benefit_tier_metadata check(jsonb_typeof(metadata)='object')
);

create table private.hr_benefit_eligibility_rules (
  id uuid primary key default gen_random_uuid(), plan_version_id uuid not null references private.hr_benefit_plan_versions(id) on delete restrict,
  employment_types text[] not null default array[]::text[], waiting_period_days integer,
  conditions jsonb not null default '{}'::jsonb, created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint hr_benefit_rule_types check(employment_types <@ array['hourly','salary','flex']::text[]),
  constraint hr_benefit_rule_wait check(waiting_period_days is null or waiting_period_days between 0 and 3650),
  constraint hr_benefit_rule_conditions check(jsonb_typeof(conditions)='object')
);

create table private.hr_benefit_enrollment_windows (
  id uuid primary key default gen_random_uuid(), name text not null, window_type text not null,
  opens_at timestamptz not null, closes_at timestamptz not null, status text not null default 'draft',
  created_by uuid not null references public.employees(id) on delete restrict,
  approved_by uuid references public.employees(id) on delete restrict, approved_at timestamptz,
  constraint hr_benefit_window_dates check(closes_at>opens_at),
  constraint hr_benefit_window_type check(window_type in ('open_enrollment','new_hire','life_event','administrative')),
  constraint hr_benefit_window_status check(status in ('draft','open','closed','canceled'))
);

create table private.hr_benefit_employee_enrollments (
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.employees(id) on delete restrict,
  plan_version_id uuid not null references private.hr_benefit_plan_versions(id) on delete restrict,
  coverage_tier_id uuid references private.hr_benefit_coverage_tiers(id) on delete restrict,
  enrollment_window_id uuid references private.hr_benefit_enrollment_windows(id) on delete restrict,
  status text not null default 'pending', elected_on date not null default current_date,
  effective_from date, effective_through date, recorded_by uuid not null references public.employees(id) on delete restrict,
  approved_by uuid references public.employees(id) on delete restrict, approved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_benefit_enrollment_unique unique(employee_id,plan_version_id,effective_from),
  constraint hr_benefit_enrollment_status check(status in ('pending','approved','declined','waived','active','ended','canceled')),
  constraint hr_benefit_enrollment_dates check(effective_through is null or effective_from is null or effective_through>=effective_from)
);

create table private.hr_benefit_dependents (
  id uuid primary key default gen_random_uuid(), enrollment_id uuid not null references private.hr_benefit_employee_enrollments(id) on delete restrict,
  legal_name text not null, relationship text not null, birth_date date, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(), constraint hr_benefit_dependent_name check(btrim(legal_name)<>''),
  constraint hr_benefit_dependent_relationship check(relationship in ('spouse','domestic_partner','child','other')),
  constraint hr_benefit_dependent_metadata check(jsonb_typeof(metadata)='object')
);

create table private.hr_benefit_beneficiaries (
  id uuid primary key default gen_random_uuid(), enrollment_id uuid not null references private.hr_benefit_employee_enrollments(id) on delete restrict,
  legal_name text not null, relationship text, allocation_percent numeric(5,2) not null,
  created_at timestamptz not null default clock_timestamp(), constraint hr_beneficiary_name check(btrim(legal_name)<>''),
  constraint hr_beneficiary_allocation check(allocation_percent>0 and allocation_percent<=100)
);

create table private.hr_benefit_events (
  id uuid primary key default gen_random_uuid(), plan_id uuid references private.hr_benefit_plans(id) on delete restrict,
  enrollment_id uuid references private.hr_benefit_employee_enrollments(id) on delete restrict,
  action text not null, actor_id uuid not null references public.employees(id) on delete restrict, reason text not null,
  details jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_benefit_event_target check(plan_id is not null or enrollment_id is not null),
  constraint hr_benefit_event_reason check(btrim(reason)<>''), constraint hr_benefit_event_details check(jsonb_typeof(details)='object')
);

create table private.hr_compensation_release_gate (
  singleton boolean primary key default true check(singleton), enabled boolean not null default false,
  enabled_by uuid references public.employees(id) on delete restrict, enabled_at timestamptz, reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_comp_gate_consistent check((not enabled and enabled_by is null and enabled_at is null) or (enabled and enabled_by is not null and enabled_at is not null and btrim(coalesce(reason,''))<>''))
);
insert into private.hr_compensation_release_gate(singleton) values(true);

create table private.hr_compensation_grades (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null, description text,
  status text not null default 'draft', created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_comp_grade_code check(code ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  constraint hr_comp_grade_status check(status in ('draft','active','retired'))
);

create table private.hr_compensation_bands (
  id uuid primary key default gen_random_uuid(), grade_id uuid not null references private.hr_compensation_grades(id) on delete restrict,
  effective_from date not null, effective_through date, minimum_amount_cents bigint, midpoint_amount_cents bigint, maximum_amount_cents bigint,
  currency_code char(3) not null default 'USD', pay_frequency text not null,
  created_by uuid not null references public.employees(id) on delete restrict, created_at timestamptz not null default clock_timestamp(),
  constraint hr_comp_band_unique unique(grade_id,effective_from),
  constraint hr_comp_band_dates check(effective_through is null or effective_through>=effective_from),
  constraint hr_comp_band_amounts check((minimum_amount_cents is null or minimum_amount_cents>=0) and (midpoint_amount_cents is null or midpoint_amount_cents>=coalesce(minimum_amount_cents,0)) and (maximum_amount_cents is null or maximum_amount_cents>=coalesce(midpoint_amount_cents,minimum_amount_cents,0))),
  constraint hr_comp_band_frequency check(pay_frequency in ('hourly','weekly','biweekly','semimonthly','monthly','annual'))
);

create table private.hr_compensation_components (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null, component_type text not null,
  taxable boolean, status text not null default 'draft', configuration jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  constraint hr_comp_component_code check(code ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  constraint hr_comp_component_type check(component_type in ('base_pay','differential','stipend','bonus','commission','allowance','other')),
  constraint hr_comp_component_status check(status in ('draft','active','retired')),
  constraint hr_comp_component_configuration check(jsonb_typeof(configuration)='object')
);

create table private.hr_employee_compensation_records (
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.employees(id) on delete restrict,
  component_id uuid not null references private.hr_compensation_components(id) on delete restrict,
  grade_id uuid references private.hr_compensation_grades(id) on delete restrict,
  amount_cents bigint not null, currency_code char(3) not null default 'USD', pay_frequency text not null,
  effective_from date not null, effective_through date, source_proposal_id uuid,
  created_by uuid not null references public.employees(id) on delete restrict, created_at timestamptz not null default clock_timestamp(),
  constraint hr_employee_comp_unique unique(employee_id,component_id,effective_from),
  constraint hr_employee_comp_amount check(amount_cents>=0),
  constraint hr_employee_comp_frequency check(pay_frequency in ('hourly','weekly','biweekly','semimonthly','monthly','annual','one_time')),
  constraint hr_employee_comp_dates check(effective_through is null or effective_through>=effective_from)
);

create table private.hr_compensation_proposals (
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.employees(id) on delete restrict,
  component_id uuid not null references private.hr_compensation_components(id) on delete restrict,
  grade_id uuid references private.hr_compensation_grades(id) on delete restrict,
  proposed_amount_cents bigint not null, currency_code char(3) not null default 'USD', pay_frequency text not null,
  effective_from date not null, status text not null default 'pending', reason text not null,
  proposed_by uuid not null references public.employees(id) on delete restrict, proposed_at timestamptz not null default clock_timestamp(),
  resolved_by uuid references public.employees(id) on delete restrict, resolved_at timestamptz, resolution_reason text,
  constraint hr_comp_proposal_amount check(proposed_amount_cents>=0),
  constraint hr_comp_proposal_frequency check(pay_frequency in ('hourly','weekly','biweekly','semimonthly','monthly','annual','one_time')),
  constraint hr_comp_proposal_status check(status in ('pending','approved','rejected','canceled')),
  constraint hr_comp_proposal_reason check(btrim(reason)<>''),
  constraint hr_comp_proposal_resolution check((status in ('pending','canceled') and resolved_by is null and resolved_at is null) or (status in ('approved','rejected') and resolved_by is not null and resolved_at is not null and btrim(coalesce(resolution_reason,''))<>'')),
  constraint hr_comp_proposal_separation check(resolved_by is null or resolved_by<>proposed_by)
);
alter table private.hr_employee_compensation_records add constraint hr_employee_comp_source_fk foreign key(source_proposal_id) references private.hr_compensation_proposals(id) on delete restrict;

create table private.hr_compensation_approvals (
  id uuid primary key default gen_random_uuid(), proposal_id uuid not null references private.hr_compensation_proposals(id) on delete restrict,
  decision text not null, approver_id uuid not null references public.employees(id) on delete restrict, reason text not null,
  mfa_method text not null, mfa_verified_at timestamptz not null, decided_at timestamptz not null default clock_timestamp(),
  constraint hr_comp_approval_unique unique(proposal_id), constraint hr_comp_approval_decision check(decision in ('approved','rejected')),
  constraint hr_comp_approval_reason check(btrim(reason)<>''), constraint hr_comp_approval_mfa check(mfa_method in ('totp','security_key','webauthn','recovery_code'))
);

create table private.hr_compensation_events (
  id uuid primary key default gen_random_uuid(), employee_id uuid references public.employees(id) on delete restrict,
  proposal_id uuid references private.hr_compensation_proposals(id) on delete restrict,
  action text not null, actor_id uuid not null references public.employees(id) on delete restrict, reason text not null,
  details jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_comp_event_target check(employee_id is not null or proposal_id is not null),
  constraint hr_comp_event_reason check(btrim(reason)<>''), constraint hr_comp_event_details check(jsonb_typeof(details)='object')
);

create index hr_leave_cases_status_start_idx on private.hr_leave_cases(status,start_on);
create index hr_leave_cases_employee_idx on private.hr_leave_cases(employee_id,start_on desc);
create index hr_leave_events_case_idx on private.hr_leave_events(case_id,occurred_at desc);
create index hr_benefit_enrollments_employee_idx on private.hr_benefit_employee_enrollments(employee_id,status);
create index hr_benefit_events_enrollment_idx on private.hr_benefit_events(enrollment_id,occurred_at desc);
create index hr_comp_records_employee_idx on private.hr_employee_compensation_records(employee_id,effective_from desc);
create index hr_comp_proposals_status_idx on private.hr_compensation_proposals(status,effective_from);
create index hr_comp_events_employee_idx on private.hr_compensation_events(employee_id,occurred_at desc);

create or replace function private.hr_stage7_assert_enabled(target_module text) returns void language plpgsql stable security definer set search_path='' as $$
declare module_enabled boolean;
begin
  if target_module='leave' then select enabled into module_enabled from private.hr_leave_release_gate where singleton;
  elsif target_module='benefits' then select enabled into module_enabled from private.hr_benefits_release_gate where singleton;
  elsif target_module='compensation' then select enabled into module_enabled from private.hr_compensation_release_gate where singleton;
  else raise check_violation using message='Unsupported HR module.'; end if;
  if not coalesce(module_enabled,false) then raise check_violation using message='This HR module is staged but not enabled.'; end if;
end $$;

create or replace function private.hr_stage7_require_actor_permission(target_actor_id uuid,target_permission text) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.employees employee where employee.id=target_actor_id and employee.status='active') then raise insufficient_privilege using message='An active employee identity is required.'; end if;
  if not exists(select 1 from private.employee_accounts account where account.employee_id=target_actor_id and account.disabled_at is null and account.activated_at is not null) then raise insufficient_privilege using message='An active login is required.'; end if;
  if not (target_permission=any(coalesce(private.employee_effective_permissions(target_actor_id),array[]::text[]))) then raise insufficient_privilege using message='The requested HR permission is required.'; end if;
end $$;

create or replace function private.hr_compensation_require_recent_mfa(target_method text,target_verified_at timestamptz) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if target_method not in ('totp','security_key','webauthn','recovery_code') or target_verified_at is null or target_verified_at < clock_timestamp()-interval '15 minutes' or target_verified_at > clock_timestamp()+interval '1 minute' then
    raise insufficient_privilege using message='Recent MFA verification is required for compensation access.';
  end if;
end $$;

create or replace function private.hr_compensation_enforce_approval_separation() returns trigger language plpgsql security definer set search_path='' as $$
declare proposal_author uuid;
begin
  select proposal.proposed_by into proposal_author
  from private.hr_compensation_proposals proposal
  where proposal.id = new.proposal_id;
  if proposal_author is null then raise foreign_key_violation using message='The compensation proposal does not exist.'; end if;
  if proposal_author = new.approver_id then raise insufficient_privilege using message='A compensation proposal requires a different approver.'; end if;
  return new;
end $$;

create or replace function public.service_get_hr_leave_workspace(target_actor_id uuid,target_page_size integer default 10,target_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare page_size integer:=least(greatest(coalesce(target_page_size,10),1),20); row_offset integer:=greatest(coalesce(target_offset,0),0);
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_stage7_assert_enabled('leave'); perform private.hr_stage7_require_actor_permission(target_actor_id,'hr.leave.view');
  return jsonb_build_object('enabled',true,'pageSize',page_size,'offset',row_offset,
    'counts',jsonb_build_object('openCases',(select count(*) from private.hr_leave_cases where status in ('open','under_review')),'approvedCases',(select count(*) from private.hr_leave_cases where status='approved'),'activePolicies',(select count(*) from private.hr_leave_policy_definitions where status='active')),
    'items',coalesce((select jsonb_agg(row.payload order by row.start_on desc,row.employee_name) from (select leave_case.start_on,concat_ws(' ',employee.first_name,employee.last_name) employee_name,jsonb_build_object('id',leave_case.id,'employeeId',employee.id,'employeeNumber',employee.employee_number,'employeeName',concat_ws(' ',employee.first_name,employee.last_name),'caseType',leave_case.case_type,'status',leave_case.status,'startOn',leave_case.start_on,'returnOn',leave_case.return_on,'payTreatment',leave_case.pay_treatment,'requestId',leave_case.time_off_request_id) payload from private.hr_leave_cases leave_case join public.employees employee on employee.id=leave_case.employee_id order by leave_case.start_on desc,employee_name limit page_size offset row_offset) row),'[]'::jsonb),
    'policies',coalesce((select jsonb_agg(jsonb_build_object('id',policy.id,'code',policy.code,'name',policy.name,'status',policy.status,'effectiveFrom',policy.effective_from,'effectiveThrough',policy.effective_through) order by policy.name) from private.hr_leave_policy_definitions policy),'[]'::jsonb));
end $$;

create or replace function public.service_get_hr_benefits_workspace(target_actor_id uuid,target_page_size integer default 10,target_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare page_size integer:=least(greatest(coalesce(target_page_size,10),1),20); row_offset integer:=greatest(coalesce(target_offset,0),0);
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_stage7_assert_enabled('benefits'); perform private.hr_stage7_require_actor_permission(target_actor_id,'hr.benefits.view');
  return jsonb_build_object('enabled',true,'pageSize',page_size,'offset',row_offset,
    'counts',jsonb_build_object('activePlans',(select count(*) from private.hr_benefit_plans where status='active'),'openWindows',(select count(*) from private.hr_benefit_enrollment_windows where status='open' and opens_at<=clock_timestamp() and closes_at>=clock_timestamp()),'pendingEnrollments',(select count(*) from private.hr_benefit_employee_enrollments where status='pending')),
    'items',coalesce((select jsonb_agg(row.payload order by row.name) from (select plan.name,jsonb_build_object('id',plan.id,'code',plan.code,'name',plan.name,'planType',plan.plan_type,'carrierName',plan.carrier_name,'status',plan.status) payload from private.hr_benefit_plans plan order by plan.name limit page_size offset row_offset) row),'[]'::jsonb),
    'windows',coalesce((select jsonb_agg(jsonb_build_object('id',enrollment_window.id,'name',enrollment_window.name,'windowType',enrollment_window.window_type,'opensAt',enrollment_window.opens_at,'closesAt',enrollment_window.closes_at,'status',enrollment_window.status) order by enrollment_window.opens_at desc) from private.hr_benefit_enrollment_windows enrollment_window),'[]'::jsonb));
end $$;

create or replace function public.service_get_hr_compensation_workspace(target_actor_id uuid,target_page_size integer default 10,target_offset integer default 0,target_mfa_method text default null,target_mfa_verified_at timestamptz default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare page_size integer:=least(greatest(coalesce(target_page_size,10),1),20); row_offset integer:=greatest(coalesce(target_offset,0),0);
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_stage7_assert_enabled('compensation'); perform private.hr_stage7_require_actor_permission(target_actor_id,'hr.compensation.view'); perform private.hr_compensation_require_recent_mfa(target_mfa_method,target_mfa_verified_at);
  return jsonb_build_object('enabled',true,'pageSize',page_size,'offset',row_offset,
    'counts',jsonb_build_object('activeComponents',(select count(*) from private.hr_compensation_components where status='active'),'pendingProposals',(select count(*) from private.hr_compensation_proposals where status='pending'),'activeRecords',(select count(*) from private.hr_employee_compensation_records where effective_from<=current_date and (effective_through is null or effective_through>=current_date))),
    'items',coalesce((select jsonb_agg(row.payload order by row.proposed_at desc) from (select proposal.proposed_at,jsonb_build_object('id',proposal.id,'employeeId',employee.id,'employeeNumber',employee.employee_number,'employeeName',concat_ws(' ',employee.first_name,employee.last_name),'componentName',component.name,'amountCents',proposal.proposed_amount_cents,'currencyCode',proposal.currency_code,'payFrequency',proposal.pay_frequency,'effectiveFrom',proposal.effective_from,'status',proposal.status,'proposedAt',proposal.proposed_at) payload from private.hr_compensation_proposals proposal join public.employees employee on employee.id=proposal.employee_id join private.hr_compensation_components component on component.id=proposal.component_id order by proposal.proposed_at desc limit page_size offset row_offset) row),'[]'::jsonb),
    'components',coalesce((select jsonb_agg(jsonb_build_object('id',component.id,'code',component.code,'name',component.name,'componentType',component.component_type,'status',component.status) order by component.name) from private.hr_compensation_components component),'[]'::jsonb));
end $$;

do $$ declare relation_name text; begin
  foreach relation_name in array array[
    'hr_leave_release_gate','hr_leave_policy_definitions','hr_leave_cases','hr_leave_downstream_authorizations','hr_leave_protected_records','hr_leave_events',
    'hr_benefits_release_gate','hr_benefit_plans','hr_benefit_plan_versions','hr_benefit_coverage_tiers','hr_benefit_eligibility_rules','hr_benefit_enrollment_windows','hr_benefit_employee_enrollments','hr_benefit_dependents','hr_benefit_beneficiaries','hr_benefit_events',
    'hr_compensation_release_gate','hr_compensation_grades','hr_compensation_bands','hr_compensation_components','hr_employee_compensation_records','hr_compensation_proposals','hr_compensation_approvals','hr_compensation_events'
  ] loop
    execute format('alter table private.%I enable row level security',relation_name);
    execute format('revoke all on private.%I from public,anon,authenticated',relation_name);
    execute format('grant select,insert,update on private.%I to service_role',relation_name);
  end loop;
  create trigger hr_leave_events_append_only before update or delete on private.hr_leave_events for each row execute function private.prevent_append_only_change();
  create trigger hr_benefit_events_append_only before update or delete on private.hr_benefit_events for each row execute function private.prevent_append_only_change();
  create trigger hr_compensation_events_append_only before update or delete on private.hr_compensation_events for each row execute function private.prevent_append_only_change();
  create trigger hr_compensation_approvals_append_only before update or delete on private.hr_compensation_approvals for each row execute function private.prevent_append_only_change();
  create trigger hr_compensation_approval_separation before insert on private.hr_compensation_approvals for each row execute function private.hr_compensation_enforce_approval_separation();
end $$;

revoke all on function private.hr_stage7_assert_enabled(text) from public,anon,authenticated;
revoke all on function private.hr_stage7_require_actor_permission(uuid,text) from public,anon,authenticated;
revoke all on function private.hr_compensation_require_recent_mfa(text,timestamptz) from public,anon,authenticated;
revoke all on function private.hr_compensation_enforce_approval_separation() from public,anon,authenticated;
revoke all on function public.service_get_hr_leave_workspace(uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.service_get_hr_benefits_workspace(uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.service_get_hr_compensation_workspace(uuid,integer,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function private.hr_stage7_assert_enabled(text) to service_role;
grant execute on function private.hr_stage7_require_actor_permission(uuid,text) to service_role;
grant execute on function private.hr_compensation_require_recent_mfa(text,timestamptz) to service_role;
grant execute on function private.hr_compensation_enforce_approval_separation() to service_role;
grant execute on function public.service_get_hr_leave_workspace(uuid,integer,integer) to service_role;
grant execute on function public.service_get_hr_benefits_workspace(uuid,integer,integer) to service_role;
grant execute on function public.service_get_hr_compensation_workspace(uuid,integer,integer,text,timestamptz) to service_role;

do $$ declare baseline record; begin
  select * into baseline from hris_stage7_preservation_baseline;
  if baseline.employee_count<>(select count(*) from public.employees)
    or baseline.employee_role_count<>(select count(*) from public.employee_access_roles)
    or baseline.role_permission_count<>(select count(*) from public.access_role_permissions)
    or baseline.override_count<>(select count(*) from public.employee_permission_overrides)
    or baseline.account_count<>(select count(*) from private.employee_accounts)
    or baseline.time_off_request_count<>(select count(*) from public.time_off_requests) then
    raise exception 'Stage 7 changed protected identities, access assignments, accounts, or operational time-off records.';
  end if;
end $$;

commit;
