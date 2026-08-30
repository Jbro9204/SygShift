begin;

-- Stage 6, run 3: configurable onboarding with dependency-aware tasks and
-- readiness calculated from authoritative SygShift systems. The feature remains
-- dormant until its release gate and Worker flag are both deliberately enabled.
create temporary table hris_stage6_run3_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.employee_accounts) as account_count;

insert into public.permission_catalog(code, category, name, description, risk_level, requires_mfa, locked, active)
values
  ('hr.onboarding.view','HR & Finance','View onboarding','View onboarding cases, tasks, dependencies, and readiness.','sensitive',true,true,true),
  ('hr.onboarding.manage','HR & Finance','Manage onboarding','Create templates, launch cases, and work onboarding tasks.','critical',true,true,true),
  ('hr.onboarding.approve','HR & Finance','Approve onboarding','Activate templates, waive required work, and finalize onboarding.','critical',true,true,true)
on conflict(code) do update set
  category=excluded.category,
  name=excluded.name,
  description=excluded.description,
  risk_level=excluded.risk_level,
  requires_mfa=excluded.requires_mfa,
  locked=excluded.locked,
  active=excluded.active;

create table private.hr_onboarding_release_gate (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  enabled_by uuid references public.employees(id) on delete restrict,
  enabled_at timestamptz,
  reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_onboarding_gate_consistent check(
    (enabled=false and enabled_by is null and enabled_at is null)
    or (enabled=true and enabled_by is not null and enabled_at is not null and btrim(coalesce(reason,'')) <> '')
  )
);
insert into private.hr_onboarding_release_gate(singleton) values(true);

create table private.hr_onboarding_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null default 'draft',
  current_version integer not null default 1,
  conditions jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.employees(id) on delete restrict,
  approved_by uuid references public.employees(id) on delete restrict,
  approved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_onboarding_template_name check(btrim(name) <> '' and char_length(name) <= 160),
  constraint hr_onboarding_template_status check(status in ('draft','active','retired')),
  constraint hr_onboarding_template_conditions check(jsonb_typeof(conditions)='object'),
  constraint hr_onboarding_template_approval check((approved_by is null and approved_at is null) or (approved_by is not null and approved_at is not null))
);

create table private.hr_onboarding_template_steps (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references private.hr_onboarding_templates(id) on delete restrict,
  template_version integer not null,
  step_code text not null,
  title text not null,
  description text,
  task_type text not null,
  responsible_group text not null default 'hr',
  required boolean not null default true,
  due_offset_days integer not null default 0,
  source_requirement jsonb not null default '{}'::jsonb,
  sort_order integer not null default 100,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint hr_onboarding_step_unique unique(template_id,template_version,step_code),
  constraint hr_onboarding_step_code check(step_code ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  constraint hr_onboarding_step_title check(btrim(title) <> '' and char_length(title) <= 180),
  constraint hr_onboarding_step_type check(task_type in ('employee_information','emergency_contact','tax_payroll','direct_deposit','i9','acknowledgment','license','training','equipment','badge_key','account_invite','site_access','manager','document','other')),
  constraint hr_onboarding_step_group check(responsible_group in ('employee','manager','hr','it','licensing','training','operations')),
  constraint hr_onboarding_step_offset check(due_offset_days between -90 and 365),
  constraint hr_onboarding_step_requirement check(jsonb_typeof(source_requirement)='object')
);

create table private.hr_onboarding_step_dependencies (
  step_id uuid not null references private.hr_onboarding_template_steps(id) on delete restrict,
  depends_on_step_id uuid not null references private.hr_onboarding_template_steps(id) on delete restrict,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  primary key(step_id,depends_on_step_id),
  constraint hr_onboarding_dependency_not_self check(step_id <> depends_on_step_id)
);

create table private.hr_onboarding_cases (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null unique references public.employees(id) on delete restrict,
  application_id uuid unique references private.hr_applications(id) on delete restrict,
  template_id uuid not null references private.hr_onboarding_templates(id) on delete restrict,
  template_version integer not null,
  target_start_date date not null,
  status text not null default 'preboarding',
  owner_id uuid references public.employees(id) on delete restrict,
  launched_by uuid not null references public.employees(id) on delete restrict,
  launched_at timestamptz not null default clock_timestamp(),
  finalized_by uuid references public.employees(id) on delete restrict,
  finalized_at timestamptz,
  finalization_reason text,
  canceled_by uuid references public.employees(id) on delete restrict,
  canceled_at timestamptz,
  cancellation_reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_onboarding_case_status check(status in ('preboarding','in_progress','blocked','ready','completed','canceled')),
  constraint hr_onboarding_case_finalization check(
    (status <> 'completed' and finalized_by is null and finalized_at is null and finalization_reason is null)
    or (status='completed' and finalized_by is not null and finalized_at is not null and btrim(coalesce(finalization_reason,'')) <> '')
  ),
  constraint hr_onboarding_case_cancellation check(
    (status <> 'canceled' and canceled_by is null and canceled_at is null and cancellation_reason is null)
    or (status='canceled' and canceled_by is not null and canceled_at is not null and btrim(coalesce(cancellation_reason,'')) <> '')
  )
);

create table private.hr_onboarding_tasks (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references private.hr_onboarding_cases(id) on delete restrict,
  template_step_id uuid not null references private.hr_onboarding_template_steps(id) on delete restrict,
  step_code text not null,
  title text not null,
  task_type text not null,
  responsible_group text not null,
  required boolean not null,
  due_at timestamptz,
  status text not null default 'not_started',
  assignee_id uuid references public.employees(id) on delete restrict,
  evidence jsonb not null default '{}'::jsonb,
  source_requirement jsonb not null default '{}'::jsonb,
  completed_by uuid references public.employees(id) on delete restrict,
  completed_at timestamptz,
  waived_by uuid references public.employees(id) on delete restrict,
  waived_at timestamptz,
  resolution_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_onboarding_task_unique unique(case_id,step_code),
  constraint hr_onboarding_task_status check(status in ('not_started','in_progress','blocked','completed','waived','not_applicable')),
  constraint hr_onboarding_task_evidence check(jsonb_typeof(evidence)='object'),
  constraint hr_onboarding_task_requirement check(jsonb_typeof(source_requirement)='object'),
  constraint hr_onboarding_task_completion check(
    (status <> 'completed' and completed_by is null and completed_at is null)
    or (status='completed' and completed_by is not null and completed_at is not null and btrim(coalesce(resolution_reason,'')) <> '')
  ),
  constraint hr_onboarding_task_waiver check(
    (status not in ('waived','not_applicable') and waived_by is null and waived_at is null)
    or (status in ('waived','not_applicable') and waived_by is not null and waived_at is not null and btrim(coalesce(resolution_reason,'')) <> '')
  )
);

create table private.hr_onboarding_events (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references private.hr_onboarding_templates(id) on delete restrict,
  case_id uuid references private.hr_onboarding_cases(id) on delete restrict,
  task_id uuid references private.hr_onboarding_tasks(id) on delete restrict,
  action text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_onboarding_event_reason check(btrim(reason) <> ''),
  constraint hr_onboarding_event_details check(jsonb_typeof(details)='object'),
  constraint hr_onboarding_event_target check(template_id is not null or case_id is not null or task_id is not null)
);

create table private.hr_onboarding_reminders (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references private.hr_onboarding_tasks(id) on delete restrict,
  reminder_type text not null,
  due_at timestamptz not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_onboarding_reminder_unique unique(task_id,reminder_type,due_at),
  constraint hr_onboarding_reminder_type check(reminder_type in ('upcoming','due','overdue','escalation')),
  constraint hr_onboarding_reminder_status check(status in ('pending','processing','sent','failed','canceled')),
  constraint hr_onboarding_reminder_attempts check(attempts between 0 and 25),
  constraint hr_onboarding_reminder_details check(jsonb_typeof(details)='object')
);

create index hr_onboarding_cases_status_start_idx on private.hr_onboarding_cases(status,target_start_date);
create index hr_onboarding_tasks_case_status_idx on private.hr_onboarding_tasks(case_id,status,due_at);
create index hr_onboarding_events_case_idx on private.hr_onboarding_events(case_id,occurred_at desc);
create index hr_onboarding_reminders_status_due_idx on private.hr_onboarding_reminders(status,due_at);

create or replace function private.hr_onboarding_assert_enabled() returns void language plpgsql stable security definer set search_path='' as $$
begin
  if not coalesce((select enabled from private.hr_onboarding_release_gate where singleton=true),false) then
    raise check_violation using message='HR onboarding is staged but not enabled.';
  end if;
end
$$;

create or replace function private.hr_onboarding_require_actor_permission(target_actor_id uuid,target_permission text) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.employees employee where employee.id=target_actor_id and employee.status='active') then raise insufficient_privilege using message='An active employee identity is required.'; end if;
  if not exists(select 1 from private.employee_accounts account where account.employee_id=target_actor_id and account.disabled_at is null and account.activated_at is not null) then raise insufficient_privilege using message='An active login is required.'; end if;
  if not (target_permission = any(coalesce(private.employee_effective_permissions(target_actor_id),array[]::text[]))) then raise insufficient_privilege using message='The requested onboarding permission is required.'; end if;
end
$$;

create or replace function private.hr_onboarding_task_source_status(target_task_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare task_record private.hr_onboarding_tasks%rowtype; target_employee_id uuid; result jsonb;
begin
  select task.* into task_record from private.hr_onboarding_tasks task where task.id=target_task_id;
  if not found then return jsonb_build_object('state','missing','authoritative',true); end if;
  select onboarding_case.employee_id into target_employee_id from private.hr_onboarding_cases onboarding_case where onboarding_case.id=task_record.case_id;
  if task_record.task_type='account_invite' then
    select case when account.employee_id is null then jsonb_build_object('state','not_created','authoritative',true) when account.disabled_at is not null then jsonb_build_object('state','disabled','authoritative',true) when account.activated_at is null then jsonb_build_object('state','invited','authoritative',true) else jsonb_build_object('state','active','authoritative',true) end into result
    from (select target_employee_id employee_id) target left join private.employee_accounts account on account.employee_id=target.employee_id;
  elsif task_record.task_type='license' then
    select jsonb_build_object('state',case when count(*) filter(where credential.status='active' and (credential.expires_on is null or credential.expires_on>=current_date))>0 then 'ready' else 'missing_or_expired' end,'activeCount',count(*) filter(where credential.status='active' and (credential.expires_on is null or credential.expires_on>=current_date)),'authoritative',true) into result
    from public.employee_credentials credential
    left join public.credential_types credential_type on credential_type.id=credential.credential_type_id
    where credential.employee_id=target_employee_id
      and (
        not (task_record.source_requirement ? 'credentialType')
        or credential_type.code=task_record.source_requirement->>'credentialType'
        or credential.kind::text=task_record.source_requirement->>'credentialType'
      );
  elsif task_record.task_type='training' then
    select jsonb_build_object('state',case when count(*) filter(where assignment.status in ('assigned','in_progress'))>0 then 'incomplete' when count(*) filter(where assignment.status='completed')>0 then 'complete' else 'not_assigned' end,'incompleteCount',count(*) filter(where assignment.status in ('assigned','in_progress')),'authoritative',true) into result
    from public.training_assignments assignment where assignment.employee_id=target_employee_id and assignment.status<>'superseded';
  elsif task_record.task_type in ('document','i9','acknowledgment','tax_payroll','direct_deposit') then
    select jsonb_build_object('state',case when count(*)>0 then 'on_file' else 'not_on_file' end,'documentCount',count(*),'authoritative',true) into result
    from private.hr_documents document where document.employee_id=target_employee_id and document.archived_at is null
      and (not (task_record.source_requirement ? 'documentCategory') or document.category=task_record.source_requirement->>'documentCategory');
  else
    result := jsonb_build_object('state',task_record.status,'authoritative',false,'note','Completion is recorded on the onboarding task.');
  end if;
  return coalesce(result,jsonb_build_object('state','unknown','authoritative',true));
end
$$;

create or replace function private.hr_onboarding_recalculate_case(target_case_id uuid) returns text language plpgsql volatile security definer set search_path='' as $$
declare next_status text;
begin
  select case
    when onboarding_case.status in ('completed','canceled') then onboarding_case.status
    when exists(select 1 from private.hr_onboarding_tasks task where task.case_id=target_case_id and task.required and task.status='blocked') then 'blocked'
    when not exists(select 1 from private.hr_onboarding_tasks task where task.case_id=target_case_id and task.required and task.status not in ('completed','waived','not_applicable')) then 'ready'
    when exists(select 1 from private.hr_onboarding_tasks task where task.case_id=target_case_id and task.status<>'not_started') then 'in_progress'
    else 'preboarding' end into next_status
  from private.hr_onboarding_cases onboarding_case where onboarding_case.id=target_case_id for update;
  update private.hr_onboarding_cases set status=next_status,updated_at=clock_timestamp() where id=target_case_id;
  return next_status;
end
$$;

create or replace function public.service_get_hr_onboarding_workspace(target_actor_id uuid,target_page_size integer default 10,target_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare page_size integer:=least(greatest(coalesce(target_page_size,10),1),20); row_offset integer:=greatest(coalesce(target_offset,0),0);
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.view');
  return jsonb_build_object(
    'enabled',true,'pageSize',page_size,'offset',row_offset,
    'counts',jsonb_build_object(
      'activeCases',(select count(*) from private.hr_onboarding_cases where status not in ('completed','canceled')),
      'readyCases',(select count(*) from private.hr_onboarding_cases where status='ready'),
      'overdueTasks',(select count(*) from private.hr_onboarding_tasks task join private.hr_onboarding_cases onboarding_case on onboarding_case.id=task.case_id where task.status not in ('completed','waived','not_applicable') and task.due_at<clock_timestamp() and onboarding_case.status not in ('completed','canceled'))
    ),
    'cases',coalesce((select jsonb_agg(row.payload order by row.target_start_date,row.employee_name) from (
      select onboarding_case.target_start_date,concat_ws(' ',employee.first_name,employee.last_name) employee_name,
        jsonb_build_object('id',onboarding_case.id,'employeeId',employee.id,'employeeNumber',employee.employee_number,'employeeName',concat_ws(' ',employee.first_name,employee.last_name),'status',onboarding_case.status,'targetStartDate',onboarding_case.target_start_date,'templateName',template.name,'taskCounts',jsonb_build_object('total',count(task.id),'complete',count(task.id) filter(where task.status in ('completed','waived','not_applicable')),'overdue',count(task.id) filter(where task.status not in ('completed','waived','not_applicable') and task.due_at<clock_timestamp()))) payload
      from private.hr_onboarding_cases onboarding_case join public.employees employee on employee.id=onboarding_case.employee_id join private.hr_onboarding_templates template on template.id=onboarding_case.template_id left join private.hr_onboarding_tasks task on task.case_id=onboarding_case.id
      group by onboarding_case.id,employee.id,template.id order by onboarding_case.target_start_date,employee_name limit page_size offset row_offset
    ) row),'[]'::jsonb),
    'templates',coalesce((select jsonb_agg(jsonb_build_object('id',template.id,'name',template.name,'status',template.status,'version',template.current_version) order by template.name) from private.hr_onboarding_templates template),'[]'::jsonb)
  );
end
$$;

create or replace function public.service_get_hr_onboarding_case(target_actor_id uuid,target_case_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.view');
  if not exists(select 1 from private.hr_onboarding_cases where id=target_case_id) then raise no_data_found using message='Onboarding case not found.'; end if;
  return jsonb_build_object(
    'case',(select jsonb_build_object('id',onboarding_case.id,'employeeId',employee.id,'employeeNumber',employee.employee_number,'employeeName',concat_ws(' ',employee.first_name,employee.last_name),'status',onboarding_case.status,'targetStartDate',onboarding_case.target_start_date,'templateId',onboarding_case.template_id,'templateVersion',onboarding_case.template_version) from private.hr_onboarding_cases onboarding_case join public.employees employee on employee.id=onboarding_case.employee_id where onboarding_case.id=target_case_id),
    'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',task.id,'stepCode',task.step_code,'title',task.title,'taskType',task.task_type,'responsibleGroup',task.responsible_group,'required',task.required,'dueAt',task.due_at,'status',task.status,'sourceStatus',private.hr_onboarding_task_source_status(task.id),'evidence',task.evidence,'resolutionReason',task.resolution_reason) order by template_step.sort_order,task.title) from private.hr_onboarding_tasks task join private.hr_onboarding_template_steps template_step on template_step.id=task.template_step_id where task.case_id=target_case_id),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(jsonb_build_object('action',event.action,'actorId',event.actor_id,'reason',event.reason,'occurredAt',event.occurred_at,'details',event.details) order by event.occurred_at desc) from private.hr_onboarding_events event where event.case_id=target_case_id),'[]'::jsonb)
  );
end
$$;

create or replace function public.service_hr_onboarding_action(target_actor_id uuid,target_action text,target_payload jsonb,target_reason text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare required_permission text:='hr.onboarding.manage'; record_id uuid; selected_template_id uuid; selected_case_id uuid; selected_task_id uuid; template_version integer; next_status text;
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  if target_action in ('activate_template','waive_task','finalize_case') then required_permission:='hr.onboarding.approve'; end if;
  perform private.hr_onboarding_require_actor_permission(target_actor_id,required_permission);
  if btrim(coalesce(target_reason,''))='' or char_length(btrim(target_reason))>1000 then raise check_violation using message='A concise audit reason is required.'; end if;

  if target_action='create_template' then
    insert into private.hr_onboarding_templates(name,description,conditions,created_by) values(btrim(target_payload->>'name'),nullif(btrim(target_payload->>'description'),''),coalesce(target_payload->'conditions','{}'::jsonb),target_actor_id) returning id into record_id;
  elsif target_action='add_template_step' then
    selected_template_id:=(target_payload->>'templateId')::uuid;
    select current_version into template_version from private.hr_onboarding_templates where id=selected_template_id and status='draft' for update;
    if not found then raise check_violation using message='Steps can only be added to a draft template.'; end if;
    insert into private.hr_onboarding_template_steps(template_id,template_version,step_code,title,description,task_type,responsible_group,required,due_offset_days,source_requirement,sort_order,created_by)
    values(selected_template_id,template_version,btrim(target_payload->>'stepCode'),btrim(target_payload->>'title'),nullif(btrim(target_payload->>'description'),''),target_payload->>'taskType',coalesce(nullif(target_payload->>'responsibleGroup',''),'hr'),coalesce((target_payload->>'required')::boolean,true),coalesce(nullif(target_payload->>'dueOffsetDays','')::integer,0),coalesce(target_payload->'sourceRequirement','{}'::jsonb),coalesce(nullif(target_payload->>'sortOrder','')::integer,100),target_actor_id) returning id into record_id;
  elsif target_action='add_step_dependency' then
    selected_task_id:=(target_payload->>'stepId')::uuid;
    record_id:=(target_payload->>'dependsOnStepId')::uuid;
    select step.template_id into selected_template_id
    from private.hr_onboarding_template_steps step
    where step.id=selected_task_id;
    if selected_template_id is null then raise check_violation using message='The onboarding step does not exist.'; end if;
    if not exists(select 1 from private.hr_onboarding_template_steps step join private.hr_onboarding_template_steps dependency on dependency.id=record_id and dependency.template_id=step.template_id and dependency.template_version=step.template_version where step.id=selected_task_id) then raise check_violation using message='Dependencies must belong to the same template version.'; end if;
    if exists(with recursive graph(step_id,depends_on_step_id) as (select dependency.step_id,dependency.depends_on_step_id from private.hr_onboarding_step_dependencies dependency where dependency.step_id=record_id union all select dependency.step_id,dependency.depends_on_step_id from private.hr_onboarding_step_dependencies dependency join graph on dependency.step_id=graph.depends_on_step_id) select 1 from graph where depends_on_step_id=selected_task_id) then raise check_violation using message='The dependency would create a cycle.'; end if;
    insert into private.hr_onboarding_step_dependencies(step_id,depends_on_step_id,created_by) values(selected_task_id,record_id,target_actor_id) on conflict do nothing;
  elsif target_action='activate_template' then
    record_id:=(target_payload->>'templateId')::uuid;
    update private.hr_onboarding_templates template set status='active',approved_by=target_actor_id,approved_at=clock_timestamp(),updated_at=clock_timestamp() where template.id=record_id and template.status='draft' and exists(select 1 from private.hr_onboarding_template_steps step where step.template_id=template.id and step.template_version=template.current_version);
    if not found then raise check_violation using message='A draft template with at least one step is required.'; end if;
  elsif target_action='launch_case' then
    selected_template_id:=(target_payload->>'templateId')::uuid;
    select current_version into template_version from private.hr_onboarding_templates where id=selected_template_id and status='active';
    if not found then raise check_violation using message='An active onboarding template is required.'; end if;
    if not exists(select 1 from public.employees employee where employee.id=(target_payload->>'employeeId')::uuid and employee.status='onboarding') then raise check_violation using message='Onboarding can only launch for an onboarding-status employee.'; end if;
    insert into private.hr_onboarding_cases(employee_id,application_id,template_id,template_version,target_start_date,owner_id,launched_by)
    values((target_payload->>'employeeId')::uuid,nullif(target_payload->>'applicationId','')::uuid,selected_template_id,template_version,(target_payload->>'targetStartDate')::date,nullif(target_payload->>'ownerId','')::uuid,target_actor_id) returning id into record_id;
    insert into private.hr_onboarding_tasks(case_id,template_step_id,step_code,title,task_type,responsible_group,required,due_at,assignee_id,source_requirement)
    select record_id,step.id,step.step_code,step.title,step.task_type,step.responsible_group,step.required,(((target_payload->>'targetStartDate')::date+step.due_offset_days)::timestamp at time zone 'America/Denver'),case when step.responsible_group='employee' then (target_payload->>'employeeId')::uuid else null end,step.source_requirement
    from private.hr_onboarding_template_steps step where step.template_id=selected_template_id and step.template_version=template_version;
    insert into private.hr_onboarding_reminders(task_id,reminder_type,due_at,details)
    select task.id,'upcoming',task.due_at-interval '2 days',jsonb_build_object('caseId',record_id) from private.hr_onboarding_tasks task where task.case_id=record_id and task.due_at is not null
    on conflict do nothing;
    insert into private.hr_onboarding_reminders(task_id,reminder_type,due_at,details)
    select task.id,'overdue',task.due_at+interval '1 day',jsonb_build_object('caseId',record_id,'responsibleGroup',task.responsible_group) from private.hr_onboarding_tasks task where task.case_id=record_id and task.due_at is not null
    on conflict do nothing;
    selected_case_id:=record_id;
  elsif target_action='start_task' then
    selected_task_id:=(target_payload->>'taskId')::uuid;
    update private.hr_onboarding_tasks set status='in_progress',assignee_id=coalesce(assignee_id,target_actor_id),updated_at=clock_timestamp() where id=selected_task_id and status='not_started' returning case_id into selected_case_id;
    if selected_case_id is null then raise check_violation using message='Only a not-started task can be started.'; end if;
    record_id:=selected_task_id;
  elsif target_action='complete_task' then
    selected_task_id:=(target_payload->>'taskId')::uuid;
    if exists(select 1 from private.hr_onboarding_step_dependencies dependency join private.hr_onboarding_tasks blocked_task on blocked_task.template_step_id=dependency.depends_on_step_id join private.hr_onboarding_tasks target_task on target_task.id=selected_task_id and blocked_task.case_id=target_task.case_id where dependency.step_id=target_task.template_step_id and blocked_task.status not in ('completed','waived','not_applicable')) then raise check_violation using message='Complete required predecessor tasks first.'; end if;
    update private.hr_onboarding_tasks set status='completed',evidence=coalesce(target_payload->'evidence','{}'::jsonb),completed_by=target_actor_id,completed_at=clock_timestamp(),resolution_reason=btrim(target_reason),updated_at=clock_timestamp() where id=selected_task_id and status in ('not_started','in_progress','blocked') returning case_id into selected_case_id;
    if selected_case_id is null then raise check_violation using message='This task cannot be completed from its current state.'; end if;
    record_id:=selected_task_id;
  elsif target_action='waive_task' then
    selected_task_id:=(target_payload->>'taskId')::uuid;
    update private.hr_onboarding_tasks set status=case when coalesce((target_payload->>'notApplicable')::boolean,false) then 'not_applicable' else 'waived' end,waived_by=target_actor_id,waived_at=clock_timestamp(),resolution_reason=btrim(target_reason),updated_at=clock_timestamp() where id=selected_task_id and status not in ('completed','waived','not_applicable') returning case_id into selected_case_id;
    if selected_case_id is null then raise check_violation using message='This task cannot be waived from its current state.'; end if;
    record_id:=selected_task_id;
  elsif target_action='finalize_case' then
    record_id:=(target_payload->>'caseId')::uuid;
    perform private.hr_onboarding_recalculate_case(record_id);
    if exists(select 1 from private.hr_onboarding_tasks task where task.case_id=record_id and task.required and task.status not in ('completed','waived','not_applicable')) then raise check_violation using message='Required onboarding tasks remain incomplete.'; end if;
    update private.hr_onboarding_cases set status='completed',finalized_by=target_actor_id,finalized_at=clock_timestamp(),finalization_reason=btrim(target_reason),updated_at=clock_timestamp() where id=record_id and status='ready' returning employee_id into selected_task_id;
    if selected_task_id is null then raise check_violation using message='Only a ready onboarding case can be finalized.'; end if;
    update public.employees set status='active',updated_at=clock_timestamp() where id=selected_task_id and status='onboarding';
    selected_case_id:=record_id;
  elsif target_action='cancel_case' then
    record_id:=(target_payload->>'caseId')::uuid;
    update private.hr_onboarding_cases set status='canceled',canceled_by=target_actor_id,canceled_at=clock_timestamp(),cancellation_reason=btrim(target_reason),updated_at=clock_timestamp() where id=record_id and status not in ('completed','canceled') returning id into selected_case_id;
    if selected_case_id is null then raise check_violation using message='This onboarding case cannot be canceled.'; end if;
  else
    raise check_violation using message='Unsupported onboarding action.';
  end if;

  if selected_case_id is not null and target_action not in ('finalize_case','cancel_case') then next_status:=private.hr_onboarding_recalculate_case(selected_case_id); end if;
  insert into private.hr_onboarding_events(template_id,case_id,task_id,action,actor_id,reason,details)
  values(
    case when target_action in ('create_template','add_template_step','add_step_dependency','activate_template') then coalesce(selected_template_id,record_id) else null end,
    selected_case_id,
    case when target_action in ('start_task','complete_task','waive_task') then record_id else null end,
    target_action,target_actor_id,btrim(target_reason),jsonb_build_object('recordId',record_id,'caseStatus',next_status)
  );
  return jsonb_build_object('id',record_id,'caseId',selected_case_id,'action',target_action,'caseStatus',next_status);
end
$$;

do $$ declare relation_name text; begin
  foreach relation_name in array array['hr_onboarding_release_gate','hr_onboarding_templates','hr_onboarding_template_steps','hr_onboarding_step_dependencies','hr_onboarding_cases','hr_onboarding_tasks','hr_onboarding_events','hr_onboarding_reminders'] loop
    execute format('alter table private.%I enable row level security',relation_name);
    execute format('revoke all on private.%I from public,anon,authenticated',relation_name);
    execute format('grant select,insert,update on private.%I to service_role',relation_name);
  end loop;
  create trigger hr_onboarding_events_append_only before update or delete on private.hr_onboarding_events for each row execute function private.prevent_append_only_change();
end $$;

revoke all on function private.hr_onboarding_assert_enabled() from public,anon,authenticated;
revoke all on function private.hr_onboarding_require_actor_permission(uuid,text) from public,anon,authenticated;
revoke all on function private.hr_onboarding_task_source_status(uuid) from public,anon,authenticated;
revoke all on function private.hr_onboarding_recalculate_case(uuid) from public,anon,authenticated;
revoke all on function public.service_get_hr_onboarding_workspace(uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.service_get_hr_onboarding_case(uuid,uuid) from public,anon,authenticated;
revoke all on function public.service_hr_onboarding_action(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function private.hr_onboarding_assert_enabled() to service_role;
grant execute on function private.hr_onboarding_require_actor_permission(uuid,text) to service_role;
grant execute on function private.hr_onboarding_task_source_status(uuid) to service_role;
grant execute on function private.hr_onboarding_recalculate_case(uuid) to service_role;
grant execute on function public.service_get_hr_onboarding_workspace(uuid,integer,integer) to service_role;
grant execute on function public.service_get_hr_onboarding_case(uuid,uuid) to service_role;
grant execute on function public.service_hr_onboarding_action(uuid,text,jsonb,text) to service_role;

do $$ declare baseline record; begin
  select * into baseline from hris_stage6_run3_preservation_baseline;
  if baseline.employee_count<>(select count(*) from public.employees)
    or baseline.employee_role_count<>(select count(*) from public.employee_access_roles)
    or baseline.role_permission_count<>(select count(*) from public.access_role_permissions)
    or baseline.override_count<>(select count(*) from public.employee_permission_overrides)
    or baseline.account_count<>(select count(*) from private.employee_accounts) then
    raise exception 'Stage 6 run 3 changed protected production identities or access assignments during migration.';
  end if;
end $$;

commit;
