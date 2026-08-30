begin;

-- Stage 9: dormant offboarding/rehire coordination, controlled self-service,
-- and permission-aware reporting. Existing identities, access assignments,
-- employment records, and operational history remain unchanged.
create temporary table hris_stage9_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) employee_count,
  (select count(*) from public.employee_access_roles) employee_role_count,
  (select count(*) from public.access_role_permissions) role_permission_count,
  (select count(*) from public.employee_permission_overrides) override_count,
  (select count(*) from private.employee_accounts) account_count,
  (select count(*) from public.schedules) schedule_count,
  (select count(*) from public.time_events) time_event_count;

insert into public.permission_catalog(code,category,name,description,risk_level,requires_mfa,locked,active)
values
  ('hr.offboarding.view','HR & Finance','View lifecycle cases','View separation, rehire, approval, and coordinated handoff status.','critical',true,true,true),
  ('hr.offboarding.manage','HR & Finance','Manage lifecycle cases','Create and coordinate separation, rehire, and downstream handoff work.','critical',true,true,true),
  ('hr.offboarding.approve','HR & Finance','Approve lifecycle decisions','Approve or deny separation and rehire decisions with an auditable reason.','critical',true,true,true),
  ('hr.self_service.view','HR & Finance','View self-service requests','View authorized employee and manager self-service requests.','sensitive',true,true,true),
  ('hr.self_service.manage','HR & Finance','Manage self-service requests','Review and decide employee and manager self-service requests.','critical',true,true,true),
  ('hr.reporting.view','HR & Finance','View HR reporting','View permission-filtered HR reports and completed report jobs.','sensitive',true,true,true),
  ('hr.reporting.manage','HR & Finance','Manage HR reports','Create and maintain governed report definitions.','critical',true,true,true),
  ('hr.reporting.export','HR & Finance','Export HR reports','Queue and download permission-filtered HR report exports.','critical',true,true,true),
  ('hr.reporting.schedule','HR & Finance','Schedule HR reports','Create and maintain scheduled HR report deliveries.','critical',true,true,true)
on conflict(code) do update set category=excluded.category,name=excluded.name,description=excluded.description,
  risk_level=excluded.risk_level,requires_mfa=excluded.requires_mfa,locked=excluded.locked,active=excluded.active;

create table private.hr_stage9_release_gates (
  module text primary key,
  enabled boolean not null default false,
  enabled_by uuid references public.employees(id) on delete restrict,
  enabled_at timestamptz,
  reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_stage9_gate_module check(module in ('offboarding','self_service','reporting')),
  constraint hr_stage9_gate_consistent check(
    (not enabled and enabled_by is null and enabled_at is null)
    or (enabled and enabled_by is not null and enabled_at is not null and btrim(coalesce(reason,''))<>'')
  )
);
insert into private.hr_stage9_release_gates(module) values ('offboarding'),('self_service'),('reporting');

create table private.hr_lifecycle_cases (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  case_type text not null,
  status text not null default 'draft',
  effective_on date not null,
  requested_by uuid not null references public.employees(id) on delete restrict,
  request_reason text not null,
  approved_by uuid references public.employees(id) on delete restrict,
  approved_at timestamptz,
  decision_reason text,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_lifecycle_case_type check(case_type in ('separation','rehire')),
  constraint hr_lifecycle_case_status check(status in ('draft','pending_approval','approved','denied','in_progress','completed','canceled')),
  constraint hr_lifecycle_case_reason check(btrim(request_reason)<>'' and char_length(request_reason)<=4000),
  constraint hr_lifecycle_case_decision check(
    (status in ('approved','denied','in_progress','completed') and approved_by is not null and approved_at is not null and btrim(coalesce(decision_reason,''))<>'')
    or status in ('draft','pending_approval','canceled')
  ),
  constraint hr_lifecycle_case_completed check((status='completed' and completed_at is not null) or status<>'completed')
);
create unique index hr_lifecycle_one_open_case_per_type on private.hr_lifecycle_cases(employee_id,case_type)
where status in ('draft','pending_approval','approved','in_progress');

create table private.hr_lifecycle_approvals (
  id uuid primary key default gen_random_uuid(),
  lifecycle_case_id uuid not null references private.hr_lifecycle_cases(id) on delete restrict,
  decision text not null,
  decided_by uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  decided_at timestamptz not null default clock_timestamp(),
  constraint hr_lifecycle_approval_decision check(decision in ('approved','denied','returned','canceled')),
  constraint hr_lifecycle_approval_reason check(btrim(reason)<>'' and char_length(reason)<=4000)
);

create table private.hr_lifecycle_tasks (
  id uuid primary key default gen_random_uuid(),
  lifecycle_case_id uuid not null references private.hr_lifecycle_cases(id) on delete restrict,
  workstream text not null,
  status text not null default 'pending',
  assigned_to uuid references public.employees(id) on delete restrict,
  due_on date,
  completion_note text,
  completed_by uuid references public.employees(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_lifecycle_task_workstream check(workstream in ('account_access','schedule','payroll','licensing','documents','training','assets')),
  constraint hr_lifecycle_task_status check(status in ('pending','ready','in_progress','blocked','completed','waived','canceled')),
  constraint hr_lifecycle_task_completion check(
    (status in ('completed','waived') and completed_by is not null and completed_at is not null and btrim(coalesce(completion_note,''))<>'')
    or status in ('pending','ready','in_progress','blocked','canceled')
  ),
  unique(lifecycle_case_id,workstream)
);

create table private.hr_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  lifecycle_case_id uuid not null references private.hr_lifecycle_cases(id) on delete restrict,
  action text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_lifecycle_event_text check(btrim(action)<>'' and btrim(reason)<>''),
  constraint hr_lifecycle_event_details check(jsonb_typeof(details)='object')
);

create table private.hr_service_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.employees(id) on delete restrict,
  subject_employee_id uuid not null references public.employees(id) on delete restrict,
  request_scope text not null,
  status text not null default 'submitted',
  request_reason text not null,
  proposed_changes jsonb not null default '{}'::jsonb,
  assigned_to uuid references public.employees(id) on delete restrict,
  submitted_at timestamptz not null default clock_timestamp(),
  decided_by uuid references public.employees(id) on delete restrict,
  decided_at timestamptz,
  decision_reason text,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_service_request_scope check(request_scope in ('profile','contact','employment','document','schedule','time','leave','benefit','other')),
  constraint hr_service_request_status check(status in ('submitted','under_review','approved','denied','completed','withdrawn','canceled')),
  constraint hr_service_request_reason check(btrim(request_reason)<>'' and char_length(request_reason)<=4000),
  constraint hr_service_request_changes check(jsonb_typeof(proposed_changes)='object'),
  constraint hr_service_request_decision check(
    (status in ('approved','denied','completed') and decided_by is not null and decided_at is not null and btrim(coalesce(decision_reason,''))<>'')
    or status in ('submitted','under_review','withdrawn','canceled')
  )
);

create table private.hr_service_request_events (
  id uuid primary key default gen_random_uuid(),
  service_request_id uuid not null references private.hr_service_requests(id) on delete restrict,
  action text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_service_event_text check(btrim(action)<>'' and btrim(reason)<>''),
  constraint hr_service_event_details check(jsonb_typeof(details)='object')
);

create table private.hr_report_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  source_key text not null,
  selected_columns jsonb not null default '[]'::jsonb,
  filters jsonb not null default '{}'::jsonb,
  visibility text not null default 'private',
  status text not null default 'draft',
  owner_id uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_report_definition_name check(btrim(name)<>'' and char_length(name)<=200),
  constraint hr_report_source check(source_key in ('people','employment','documents','leave','benefits','compensation','learning','assets','lifecycle')),
  constraint hr_report_columns check(jsonb_typeof(selected_columns)='array' and jsonb_array_length(selected_columns)>0),
  constraint hr_report_filters check(jsonb_typeof(filters)='object'),
  constraint hr_report_visibility check(visibility in ('private','role','authorized_hr')),
  constraint hr_report_status check(status in ('draft','active','archived'))
);

create table private.hr_report_schedules (
  id uuid primary key default gen_random_uuid(),
  report_definition_id uuid not null references private.hr_report_definitions(id) on delete restrict,
  schedule_rule text not null,
  time_zone text not null default 'America/Denver',
  recipients jsonb not null default '[]'::jsonb,
  enabled boolean not null default false,
  next_run_at timestamptz,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_report_schedule_rule check(btrim(schedule_rule)<>'' and char_length(schedule_rule)<=500),
  constraint hr_report_schedule_zone check(time_zone='America/Denver'),
  constraint hr_report_schedule_recipients check(jsonb_typeof(recipients)='array')
);

create table private.hr_report_runs (
  id uuid primary key default gen_random_uuid(),
  report_definition_id uuid not null references private.hr_report_definitions(id) on delete restrict,
  report_schedule_id uuid references private.hr_report_schedules(id) on delete restrict,
  requested_by uuid not null references public.employees(id) on delete restrict,
  status text not null default 'queued',
  export_format text not null default 'xlsx',
  range_start date,
  range_end date,
  row_count integer,
  result_metadata jsonb not null default '{}'::jsonb,
  error_message text,
  queued_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint hr_report_run_status check(status in ('queued','running','completed','failed','canceled','expired')),
  constraint hr_report_run_format check(export_format in ('xlsx','csv','pdf')),
  constraint hr_report_run_range check(range_end is null or range_start is null or range_end>=range_start),
  constraint hr_report_run_count check(row_count is null or row_count>=0),
  constraint hr_report_run_metadata check(jsonb_typeof(result_metadata)='object'),
  constraint hr_report_run_completion check((status in ('completed','failed','canceled','expired') and completed_at is not null) or status in ('queued','running'))
);

create table private.hr_report_events (
  id uuid primary key default gen_random_uuid(),
  report_definition_id uuid references private.hr_report_definitions(id) on delete restrict,
  report_run_id uuid references private.hr_report_runs(id) on delete restrict,
  action text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_report_event_target check(report_definition_id is not null or report_run_id is not null),
  constraint hr_report_event_text check(btrim(action)<>'' and btrim(reason)<>''),
  constraint hr_report_event_details check(jsonb_typeof(details)='object')
);

create index hr_lifecycle_cases_status_effective_idx on private.hr_lifecycle_cases(status,effective_on);
create index hr_lifecycle_tasks_case_status_idx on private.hr_lifecycle_tasks(lifecycle_case_id,status);
create index hr_service_requests_subject_status_idx on private.hr_service_requests(subject_employee_id,status);
create index hr_report_runs_status_queued_idx on private.hr_report_runs(status,queued_at);

create or replace function private.hr_stage9_assert_enabled(target_module text) returns void language plpgsql stable security definer set search_path='' as $$
declare module_enabled boolean;
begin
  if target_module not in ('offboarding','self_service','reporting') then raise check_violation using message='Unsupported Stage 9 HR module.'; end if;
  select gate.enabled into module_enabled from private.hr_stage9_release_gates gate where gate.module=target_module;
  if not coalesce(module_enabled,false) then raise check_violation using message='This HR module is staged but not enabled.'; end if;
end $$;

create or replace function private.hr_stage9_require_actor_permission(target_actor_id uuid,target_permission text) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.employees employee where employee.id=target_actor_id and employee.status='active') then raise insufficient_privilege using message='An active employee identity is required.'; end if;
  if not exists(select 1 from private.employee_accounts account where account.employee_id=target_actor_id and account.disabled_at is null and account.activated_at is not null) then raise insufficient_privilege using message='An active login is required.'; end if;
  if not (target_permission=any(coalesce(private.employee_effective_permissions(target_actor_id),array[]::text[]))) then raise insufficient_privilege using message='The requested HR permission is required.'; end if;
end $$;

create or replace function private.hr_stage9_require_recent_mfa(target_method text,target_verified_at timestamptz,target_scope text) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if target_method not in ('authenticator','totp','security_key','webauthn','recovery_code') or target_verified_at is null or target_verified_at < clock_timestamp()-interval '15 minutes' or target_verified_at > clock_timestamp()+interval '1 minute' then
    raise insufficient_privilege using message=format('Recent MFA verification is required for %s access.',target_scope);
  end if;
end $$;

create or replace function public.service_get_hr_stage9_workspace(
  target_actor_id uuid,target_module text,target_page_size integer default 10,target_offset integer default 0,
  target_mfa_method text default null,target_mfa_verified_at timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  page_size integer:=case when target_page_size in (5,10,20) then target_page_size else 10 end;
  row_offset integer:=greatest(coalesce(target_offset,0),0);
  permission_code text;
  can_manage boolean:=false;
  counts_payload jsonb;
  items_payload jsonb;
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  if target_module not in ('offboarding','self_service','reporting') then raise check_violation using message='Unsupported Stage 9 HR module.'; end if;
  permission_code:=case target_module when 'offboarding' then 'hr.offboarding.view' when 'self_service' then 'hr.self_service.view' else 'hr.reporting.view' end;
  perform private.hr_stage9_assert_enabled(target_module);
  perform private.hr_stage9_require_actor_permission(target_actor_id,permission_code);
  can_manage:=case target_module
    when 'offboarding' then 'hr.offboarding.manage'=any(coalesce(private.employee_effective_permissions(target_actor_id),array[]::text[]))
    when 'self_service' then 'hr.self_service.manage'=any(coalesce(private.employee_effective_permissions(target_actor_id),array[]::text[]))
    else 'hr.reporting.manage'=any(coalesce(private.employee_effective_permissions(target_actor_id),array[]::text[]))
  end;
  if target_module in ('offboarding','reporting') then perform private.hr_stage9_require_recent_mfa(target_mfa_method,target_mfa_verified_at,target_module); end if;

  if target_module='offboarding' then
    counts_payload:=jsonb_build_object(
      'primary',(select count(*) from private.hr_lifecycle_cases where status in ('draft','pending_approval','approved','in_progress')),
      'secondary',(select count(*) from private.hr_lifecycle_cases where status='pending_approval'),
      'tertiary',(select count(*) from private.hr_lifecycle_tasks where status in ('pending','ready','in_progress','blocked'))
    );
    select coalesce(jsonb_agg(row.payload order by row.sort_at desc),'[]'::jsonb) into items_payload from (
      select lifecycle.updated_at sort_at,jsonb_build_object('id',lifecycle.id,'title',concat_ws(' ',employee.first_name,employee.last_name),'subtitle',case when lifecycle.case_type='rehire' then 'Rehire' else 'Separation' end,'status',lifecycle.status,'dateLabel',lifecycle.effective_on,'detail',lifecycle.request_reason) payload
      from private.hr_lifecycle_cases lifecycle join public.employees employee on employee.id=lifecycle.employee_id
      order by lifecycle.updated_at desc limit page_size offset row_offset
    ) row;
  elsif target_module='self_service' then
    counts_payload:=jsonb_build_object(
      'primary',(select count(*) from private.hr_service_requests where status in ('submitted','under_review') and (can_manage or requester_id=target_actor_id or subject_employee_id=target_actor_id)),
      'secondary',(select count(*) from private.hr_service_requests where requester_id=target_actor_id and status in ('submitted','under_review')),
      'tertiary',(select count(*) from private.hr_service_requests where status='approved' and (can_manage or requester_id=target_actor_id or subject_employee_id=target_actor_id))
    );
    select coalesce(jsonb_agg(row.payload order by row.sort_at desc),'[]'::jsonb) into items_payload from (
      select request.updated_at sort_at,jsonb_build_object('id',request.id,'title',concat_ws(' ',employee.first_name,employee.last_name),'subtitle',initcap(replace(request.request_scope,'_',' ')),'status',request.status,'dateLabel',request.submitted_at::date,'detail',request.request_reason) payload
      from private.hr_service_requests request join public.employees employee on employee.id=request.subject_employee_id
      where can_manage or request.requester_id=target_actor_id or request.subject_employee_id=target_actor_id
      order by request.updated_at desc limit page_size offset row_offset
    ) row;
  else
    counts_payload:=jsonb_build_object(
      'primary',(select count(*) from private.hr_report_definitions where status='active' and (can_manage or owner_id=target_actor_id or visibility='authorized_hr')),
      'secondary',(select count(*) from private.hr_report_runs run join private.hr_report_definitions definition on definition.id=run.report_definition_id where run.status in ('queued','running') and (can_manage or definition.owner_id=target_actor_id or definition.visibility='authorized_hr')),
      'tertiary',(select count(*) from private.hr_report_schedules schedule join private.hr_report_definitions definition on definition.id=schedule.report_definition_id where schedule.enabled and (can_manage or definition.owner_id=target_actor_id or definition.visibility='authorized_hr'))
    );
    select coalesce(jsonb_agg(row.payload order by row.sort_at desc),'[]'::jsonb) into items_payload from (
      select report.updated_at sort_at,jsonb_build_object('id',report.id,'title',report.name,'subtitle',initcap(replace(report.source_key,'_',' ')),'status',report.status,'dateLabel',report.updated_at::date,'detail',report.description) payload
      from private.hr_report_definitions report
      where can_manage or report.owner_id=target_actor_id or report.visibility='authorized_hr'
      order by report.updated_at desc limit page_size offset row_offset
    ) row;
  end if;

  return jsonb_build_object('enabled',true,'module',target_module,'pageSize',page_size,'offset',row_offset,'counts',counts_payload,'items',coalesce(items_payload,'[]'::jsonb));
end $$;

do $$ declare relation_name text; begin
  foreach relation_name in array array[
    'hr_stage9_release_gates','hr_lifecycle_cases','hr_lifecycle_approvals','hr_lifecycle_tasks','hr_lifecycle_events',
    'hr_service_requests','hr_service_request_events','hr_report_definitions','hr_report_schedules','hr_report_runs','hr_report_events'
  ] loop
    execute format('alter table private.%I enable row level security',relation_name);
    execute format('revoke all on private.%I from public,anon,authenticated',relation_name);
    execute format('grant select,insert,update on private.%I to service_role',relation_name);
  end loop;
  create trigger hr_lifecycle_approvals_append_only before update or delete on private.hr_lifecycle_approvals for each row execute function private.prevent_append_only_change();
  create trigger hr_lifecycle_events_append_only before update or delete on private.hr_lifecycle_events for each row execute function private.prevent_append_only_change();
  create trigger hr_service_request_events_append_only before update or delete on private.hr_service_request_events for each row execute function private.prevent_append_only_change();
  create trigger hr_report_events_append_only before update or delete on private.hr_report_events for each row execute function private.prevent_append_only_change();
end $$;

revoke all on function private.hr_stage9_assert_enabled(text) from public,anon,authenticated;
revoke all on function private.hr_stage9_require_actor_permission(uuid,text) from public,anon,authenticated;
revoke all on function private.hr_stage9_require_recent_mfa(text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.service_get_hr_stage9_workspace(uuid,text,integer,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function private.hr_stage9_assert_enabled(text) to service_role;
grant execute on function private.hr_stage9_require_actor_permission(uuid,text) to service_role;
grant execute on function private.hr_stage9_require_recent_mfa(text,timestamptz,text) to service_role;
grant execute on function public.service_get_hr_stage9_workspace(uuid,text,integer,integer,text,timestamptz) to service_role;

do $$ declare baseline record; begin
  select * into baseline from hris_stage9_preservation_baseline;
  if baseline.employee_count<>(select count(*) from public.employees)
    or baseline.employee_role_count<>(select count(*) from public.employee_access_roles)
    or baseline.role_permission_count<>(select count(*) from public.access_role_permissions)
    or baseline.override_count<>(select count(*) from public.employee_permission_overrides)
    or baseline.account_count<>(select count(*) from private.employee_accounts)
    or baseline.schedule_count<>(select count(*) from public.schedules)
    or baseline.time_event_count<>(select count(*) from public.time_events) then
    raise exception 'Stage 9 changed protected identities, access assignments, accounts, schedules, or time records.';
  end if;
end $$;

commit;
