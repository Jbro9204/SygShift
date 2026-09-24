begin;
set local lock_timeout = '5s';

create temporary table onboarding_account_release_baseline on commit drop as
select
  (select count(*) from public.employees) employee_count,
  (select count(*) from private.employee_accounts) account_count,
  (select count(*) from public.access_roles) access_role_count,
  (select count(*) from public.employee_access_roles) employee_role_count,
  (select count(*) from public.employee_permission_overrides) override_count;

insert into public.permission_catalog (
  code, category, name, description, risk_level, requires_mfa, locked, active
)
values
  (
    'reports.account_activity.view',
    'HR & Finance',
    'View user account activity report',
    'View account readiness, completed sign-in activity, MFA posture, active sessions, and role assignments for employees.',
    'critical', true, true, true
  ),
  (
    'reports.account_activity.export',
    'HR & Finance',
    'Export user account activity report',
    'Export the protected user account and completed sign-in activity report.',
    'critical', true, true, true
  )
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = excluded.active,
    updated_at = clock_timestamp();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, permission.code, true
from public.access_roles role
cross join public.permission_catalog permission
where role.code in ('system_admin', 'human_resources')
  and permission.code in ('reports.account_activity.view', 'reports.account_activity.export')
on conflict (role_id, permission_code) do update
set enabled = true, updated_at = clock_timestamp();

create or replace function private.hr_onboarding_ensure_standard_template(target_actor_id uuid)
returns table(template_id uuid, template_version integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  select template.id, template.current_version
  into template_id, template_version
  from private.hr_onboarding_templates template
  where template.name = 'Guardianship Standard Onboarding'
    and template.status = 'active'
  order by template.approved_at desc nulls last
  limit 1;

  if template_id is null then
    insert into private.hr_onboarding_templates (
      name, description, status, current_version, conditions,
      created_by, approved_by, approved_at
    ) values (
      'Guardianship Standard Onboarding',
      'Federal, state, employment, job-duty, and company onboarding requirements.',
      'active', 1, '{"dynamic":true}'::jsonb,
      target_actor_id, target_actor_id, clock_timestamp()
    )
    returning id, current_version into template_id, template_version;

    insert into private.hr_onboarding_template_steps (
      template_id, template_version, step_code, title, description, task_type,
      responsible_group, required, due_offset_days, source_requirement, sort_order, created_by
    ) values
      (template_id,template_version,'identity','Legal identity and contact information','Confirm legal name, personal contact details, and emergency contact.','employee_information','hr',true,-10,'{"nonWaivable":true}'::jsonb,10,target_actor_id),
      (template_id,template_version,'i9','Form I-9 and identity documents','Complete employment eligibility verification and upload the supporting record.','i9','hr',true,-1,'{"jurisdiction":"federal","documentRequired":true,"documentCategory":"i9","nonWaivable":true}'::jsonb,20,target_actor_id),
      (template_id,template_version,'w4','Federal Form W-4','Complete and upload the federal withholding form.','tax_payroll','hr',true,-1,'{"jurisdiction":"federal","documentRequired":true,"documentCategory":"w4","nonWaivable":true}'::jsonb,30,target_actor_id),
      (template_id,template_version,'co_withholding','Colorado withholding election','Complete the current Colorado withholding requirement.','document','hr',true,-1,'{"states":["CO"],"documentRequired":true,"documentCategory":"co_withholding","nonWaivable":true}'::jsonb,40,target_actor_id),
      (template_id,template_version,'ca_withholding','California withholding election','Complete the current California withholding requirement.','document','hr',true,-1,'{"states":["CA"],"documentRequired":true,"documentCategory":"ca_withholding","nonWaivable":true}'::jsonb,40,target_actor_id),
      (template_id,template_version,'az_withholding','Arizona withholding election','Complete the current Arizona withholding requirement.','document','hr',true,-1,'{"states":["AZ"],"documentRequired":true,"documentCategory":"az_withholding","nonWaivable":true}'::jsonb,40,target_actor_id),
      (template_id,template_version,'payroll','iSolved payroll enrollment','Confirm the employee is ready for payroll enrollment.','tax_payroll','hr',true,-1,'{"nonWaivable":true}'::jsonb,50,target_actor_id),
      (template_id,template_version,'policies','Handbook and policy acknowledgments','Record required company acknowledgments.','acknowledgment','hr',true,-1,'{"documentRequired":true,"documentCategory":"policy_acknowledgment","nonWaivable":true}'::jsonb,60,target_actor_id),
      (template_id,template_version,'guard_license','Guard license','Upload and validate the jurisdiction-appropriate guard credential.','license','licensing',true,-5,'{"requiresGuardLicense":true,"nonWaivable":true}'::jsonb,70,target_actor_id),
      (template_id,template_version,'armed_credentials','Armed credentials','Upload and validate all required armed endorsements and training.','license','licensing',true,-5,'{"requiresArmedCredentials":true,"nonWaivable":true}'::jsonb,80,target_actor_id),
      (template_id,template_version,'account_invite','SygShift account and secure setup','Provision the linked account and send the controlled setup message.','account_invite','it',true,-2,'{"nonWaivable":true}'::jsonb,90,target_actor_id),
      (template_id,template_version,'equipment_access','Equipment, access, and site readiness','Issue required equipment, keys, badges, and access.','equipment','operations',true,0,'{}'::jsonb,100,target_actor_id),
      (template_id,template_version,'orientation','Manager orientation','Confirm role, reporting structure, first-day plan, and required training.','manager','manager',true,0,'{}'::jsonb,110,target_actor_id);
  end if;

  return next;
end
$$;

create or replace function public.service_hr_onboarding_create_prehire(
  target_actor_id uuid,
  target_payload jsonb,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  created_employee_id uuid := gen_random_uuid();
  created_person_id uuid;
  created_worker_id uuid;
  selected_legal_entity_id uuid;
  selected_template_id uuid;
  selected_template_version integer;
  created_case_id uuid;
  first_name text := btrim(coalesce(target_payload->>'firstName',''));
  middle_name text := nullif(btrim(coalesce(target_payload->>'middleName','')),'');
  last_name text := btrim(coalesce(target_payload->>'lastName',''));
  personal_email text := lower(btrim(coalesce(target_payload->>'personalEmail','')));
  mobile_phone text := nullif(btrim(coalesce(target_payload->>'mobilePhone','')),'');
  position_title text := btrim(coalesce(target_payload->>'positionTitle',''));
  work_state text := upper(btrim(coalesce(target_payload->>'workState','')));
  role_value text := btrim(coalesce(target_payload->>'role','guard'));
  employment_type_value text := btrim(coalesce(target_payload->>'employmentType','hourly'));
  job_family_value text := btrim(coalesce(target_payload->>'jobFamily','other'));
  start_date_value date;
  needs_guard_license boolean;
  needs_armed_credentials boolean;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.manage');
  if btrim(coalesce(target_reason,'')) = '' or char_length(btrim(target_reason)) > 1000 then raise check_violation using message='A concise audit reason is required.'; end if;
  if first_name = '' or last_name = '' or position_title = '' then raise check_violation using message='Legal first name, legal last name, and position title are required.'; end if;
  if personal_email = '' or personal_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise check_violation using message='A valid personal email is required.'; end if;
  if personal_email ~* '@guardianshipsecurity\.net$' then raise check_violation using message='Use the employee personal email. Company-domain delivery is temporarily disabled.'; end if;
  if exists(select 1 from private.employee_contacts contact where lower(contact.personal_email)=personal_email) then raise unique_violation using message='That personal email is already linked to an employee.'; end if;
  if work_state not in ('CO','CA','AZ') then raise check_violation using message='Choose CO, CA, or AZ as the work state.'; end if;
  if employment_type_value not in ('hourly','salary','flex') then raise check_violation using message='Choose hourly, salary, or flex employment.'; end if;
  if job_family_value not in ('guard','administration','operations','other') then raise check_violation using message='Choose a supported job family.'; end if;
  if not exists(select 1 from pg_catalog.pg_enum item join pg_catalog.pg_type enum_type on enum_type.oid=item.enumtypid where enum_type.typname='app_role' and item.enumlabel=role_value) then raise check_violation using message='Choose a supported SygShift role.'; end if;
  begin start_date_value := (target_payload->>'startDate')::date; exception when others then raise check_violation using message='A valid start date is required.'; end;
  needs_guard_license := coalesce((target_payload->>'requiresGuardLicense')::boolean,job_family_value='guard');
  needs_armed_credentials := coalesce((target_payload->>'requiresArmedCredentials')::boolean,false);
  if needs_armed_credentials then needs_guard_license := true; end if;

  insert into public.employees(id,first_name,middle_name,last_name,role,employment_type,status,hired_on,job_title)
  values(created_employee_id,first_name,middle_name,last_name,role_value::public.app_role,employment_type_value::public.employment_type,'onboarding',start_date_value,position_title);
  insert into private.employee_contacts(employee_id,personal_email,mobile_phone) values(created_employee_id,personal_email,mobile_phone);
  insert into private.hr_person_identifiers(employee_id,created_by) values(created_employee_id,target_actor_id) returning id into created_person_id;
  insert into private.hr_worker_identifiers(person_id,worker_reference,created_by)
  select created_person_id,employee.employee_number,target_actor_id from public.employees employee where employee.id=created_employee_id returning id into created_worker_id;
  insert into private.hr_legal_entities(code,name) values('GSL','Guardianship Security LLC')
  on conflict(code) do update set active=true,updated_at=clock_timestamp() returning id into selected_legal_entity_id;
  insert into private.hr_employment_relationships(worker_id,legal_entity_id,status,worker_classification,employment_type,effective_start,change_reason,recorded_by)
  values(created_worker_id,selected_legal_entity_id,'prehire','employee',employment_type_value,start_date_value,'Pre-hire onboarding created',target_actor_id);

  select ensured.template_id, ensured.template_version
  into selected_template_id, selected_template_version
  from private.hr_onboarding_ensure_standard_template(target_actor_id) ensured;

  insert into private.hr_onboarding_cases(employee_id,template_id,template_version,target_start_date,owner_id,launched_by)
  values(created_employee_id,selected_template_id,selected_template_version,start_date_value,target_actor_id,target_actor_id) returning id into created_case_id;
  insert into private.hr_onboarding_profiles(case_id,work_state,employment_type_snapshot,job_family,position_title,requires_guard_license,requires_armed_credentials)
  values(created_case_id,work_state,employment_type_value,job_family_value,position_title,needs_guard_license,needs_armed_credentials);
  insert into private.hr_onboarding_tasks(case_id,template_step_id,step_code,title,task_type,responsible_group,required,due_at,assignee_id,source_requirement)
  select created_case_id,step.id,step.step_code,step.title,step.task_type,step.responsible_group,step.required,((start_date_value+step.due_offset_days)::timestamp at time zone 'America/Denver'),case when step.responsible_group='employee' then created_employee_id else null end,step.source_requirement
  from private.hr_onboarding_template_steps step
  where step.template_id = selected_template_id
    and step.template_version = selected_template_version
    and private.hr_onboarding_step_applies(step.source_requirement,work_state,employment_type_value,job_family_value,needs_guard_license,needs_armed_credentials);
  insert into private.hr_onboarding_events(case_id,action,actor_id,reason,details)
  values(created_case_id,'create_prehire',target_actor_id,btrim(target_reason),jsonb_build_object('employeeId',created_employee_id,'workState',work_state,'jobFamily',job_family_value,'requiresGuardLicense',needs_guard_license,'requiresArmedCredentials',needs_armed_credentials));
  perform private.hr_onboarding_recalculate_case(created_case_id);
  return jsonb_build_object(
    'id',created_employee_id,'employeeId',created_employee_id,'caseId',created_case_id,
    'employeeNumber',(select employee_number from public.employees where id=created_employee_id),
    'username',(select username from public.employees where id=created_employee_id),
    'action','create_prehire','caseStatus',(select status from private.hr_onboarding_cases where id=created_case_id)
  );
end
$$;

create or replace function public.service_get_hr_onboarding_options(
  target_actor_id uuid,
  target_search text,
  target_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  clean_search text := lower(btrim(coalesce(target_search,'')));
  row_limit integer := least(greatest(coalesce(target_limit,25),1),50);
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.manage');
  return jsonb_build_object(
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', option.id,
        'employeeNumber', option.employee_number,
        'employeeName', option.employee_name,
        'status', option.status,
        'positionTitle', option.job_title,
        'role', option.role,
        'employmentType', option.employment_type,
        'hiredOn', option.hired_on
      ) order by option.employee_name)
      from (
        select employee.id, employee.employee_number,
          concat_ws(' ',employee.first_name,employee.last_name) employee_name,
          employee.status::text status, employee.job_title,
          employee.role::text role, employee.employment_type::text employment_type,
          employee.hired_on
        from public.employees employee
        where employee.status in ('onboarding','active')
          and not exists(select 1 from private.hr_onboarding_cases onboarding_case where onboarding_case.employee_id=employee.id)
          and (clean_search = '' or concat_ws(' ',employee.first_name,employee.last_name,employee.employee_number,employee.username,employee.job_title) ilike '%'||clean_search||'%')
        order by employee.last_name, employee.first_name
        limit row_limit
      ) option
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.service_hr_onboarding_launch_existing(
  target_actor_id uuid,
  target_employee_id uuid,
  target_payload jsonb,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  selected_template_id uuid;
  selected_template_version integer;
  created_case_id uuid;
  work_state text := upper(btrim(coalesce(target_payload->>'workState','')));
  employment_type_value text;
  job_family_value text := btrim(coalesce(target_payload->>'jobFamily','other'));
  position_title text;
  start_date_value date;
  needs_guard_license boolean;
  needs_armed_credentials boolean;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.manage');
  if btrim(coalesce(target_reason,'')) = '' or char_length(btrim(target_reason)) > 1000 then raise check_violation using message='A concise audit reason is required.'; end if;
  select * into employee_record from public.employees employee where employee.id=target_employee_id and employee.status in ('onboarding','active') for update;
  if not found then raise check_violation using message='Choose an active or onboarding employee.'; end if;
  if exists(select 1 from private.hr_onboarding_cases onboarding_case where onboarding_case.employee_id=target_employee_id) then raise unique_violation using message='This employee already has an onboarding case.'; end if;
  if work_state not in ('CO','CA','AZ') then raise check_violation using message='Choose CO, CA, or AZ as the work state.'; end if;
  employment_type_value := coalesce(nullif(btrim(target_payload->>'employmentType'),''),employee_record.employment_type::text);
  if employment_type_value not in ('hourly','salary','flex') then raise check_violation using message='Choose hourly, salary, or flex employment.'; end if;
  if job_family_value not in ('guard','administration','operations','other') then raise check_violation using message='Choose a supported job family.'; end if;
  position_title := coalesce(nullif(btrim(target_payload->>'positionTitle'),''),nullif(btrim(employee_record.job_title),''),initcap(replace(employee_record.role::text,'_',' ')));
  begin start_date_value := coalesce(nullif(target_payload->>'startDate','')::date,employee_record.hired_on,current_date); exception when others then raise check_violation using message='A valid start date is required.'; end;
  needs_guard_license := coalesce((target_payload->>'requiresGuardLicense')::boolean,job_family_value='guard');
  needs_armed_credentials := coalesce((target_payload->>'requiresArmedCredentials')::boolean,false);
  if needs_armed_credentials then needs_guard_license := true; end if;

  select ensured.template_id, ensured.template_version into selected_template_id, selected_template_version
  from private.hr_onboarding_ensure_standard_template(target_actor_id) ensured;
  insert into private.hr_onboarding_cases(employee_id,template_id,template_version,target_start_date,owner_id,launched_by)
  values(target_employee_id,selected_template_id,selected_template_version,start_date_value,target_actor_id,target_actor_id) returning id into created_case_id;
  insert into private.hr_onboarding_profiles(case_id,work_state,employment_type_snapshot,job_family,position_title,requires_guard_license,requires_armed_credentials)
  values(created_case_id,work_state,employment_type_value,job_family_value,position_title,needs_guard_license,needs_armed_credentials);
  insert into private.hr_onboarding_tasks(case_id,template_step_id,step_code,title,task_type,responsible_group,required,due_at,assignee_id,source_requirement)
  select created_case_id,step.id,step.step_code,step.title,step.task_type,step.responsible_group,step.required,((start_date_value+step.due_offset_days)::timestamp at time zone 'America/Denver'),case when step.responsible_group='employee' then target_employee_id else null end,step.source_requirement
  from private.hr_onboarding_template_steps step
  where step.template_id = selected_template_id
    and step.template_version = selected_template_version
    and private.hr_onboarding_step_applies(step.source_requirement,work_state,employment_type_value,job_family_value,needs_guard_license,needs_armed_credentials);
  insert into private.hr_onboarding_events(case_id,action,actor_id,reason,details)
  values(created_case_id,'launch_existing_employee',target_actor_id,btrim(target_reason),jsonb_build_object('employeeId',target_employee_id,'priorEmployeeStatus',employee_record.status,'workState',work_state,'jobFamily',job_family_value));
  perform private.hr_onboarding_recalculate_case(created_case_id);
  return jsonb_build_object('id',target_employee_id,'employeeId',target_employee_id,'caseId',created_case_id,'action','launch_existing_employee','caseStatus',(select status from private.hr_onboarding_cases where id=created_case_id));
end
$$;

create or replace function public.service_get_hr_onboarding_case(target_actor_id uuid,target_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.view');
  if not exists(select 1 from private.hr_onboarding_cases where id=target_case_id) then raise no_data_found using message='Onboarding case not found.'; end if;
  return jsonb_build_object(
    'case',(select jsonb_build_object('id',onboarding_case.id,'employeeId',employee.id,'employeeNumber',employee.employee_number,'employeeName',concat_ws(' ',employee.first_name,employee.last_name),'status',onboarding_case.status,'targetStartDate',onboarding_case.target_start_date,'templateId',onboarding_case.template_id,'templateVersion',onboarding_case.template_version,'workState',coalesce(profile.work_state,'CO'),'employmentType',coalesce(profile.employment_type_snapshot,employee.employment_type::text),'jobFamily',coalesce(profile.job_family,case when employee.role::text='guard' then 'guard' when employee.role::text in ('supervisor','scheduler','dispatcher') then 'operations' when employee.role::text in ('admin','recruiting_licensing') then 'administration' else 'other' end),'positionTitle',coalesce(profile.position_title,nullif(btrim(employee.job_title),''),initcap(replace(employee.role::text,'_',' '))),'requiresGuardLicense',coalesce(profile.requires_guard_license,employee.role::text='guard'),'requiresArmedCredentials',coalesce(profile.requires_armed_credentials,false),'welcomeEmailStatus',coalesce(profile.welcome_email_status,'not_sent'),'accountSetupStatus',coalesce(profile.account_setup_status,'not_sent')) from private.hr_onboarding_cases onboarding_case join public.employees employee on employee.id=onboarding_case.employee_id left join private.hr_onboarding_profiles profile on profile.case_id=onboarding_case.id where onboarding_case.id=target_case_id),
    'accountReadiness',(select jsonb_build_object(
      'accountState',case when account.employee_id is null then 'not_created' when account.disabled_at is not null then 'disabled' when account.must_change_password then 'setup_incomplete' when private.employee_requires_mfa(employee.id) and account.mfa_enrolled_at is null then 'mfa_required' when completion.completed_count=0 then 'first_login_pending' else 'ready' end,
      'invitedAt',account.invited_at,'activatedAt',account.activated_at,'passwordChangedAt',account.password_changed_at,
      'firstCompletedSignInAt',completion.first_completed_at,'lastCompletedSignInAt',completion.last_completed_at,
      'completedSignInCount',completion.completed_count,'completedSources',completion.sources,
      'requiresMfa',private.employee_requires_mfa(employee.id),'mfaEnrolledAt',account.mfa_enrolled_at,
      'activeSessionCount',coalesce(session_count.active_sessions,0)
    ) from private.hr_onboarding_cases onboarding_case join public.employees employee on employee.id=onboarding_case.employee_id left join private.employee_accounts account on account.employee_id=employee.id left join lateral (select count(*)::integer completed_count,min(sign_in.completed_at) first_completed_at,max(sign_in.completed_at) last_completed_at,coalesce(array_agg(distinct sign_in.completion_source),array[]::text[]) sources from private.employee_sign_in_completions sign_in where sign_in.employee_id=employee.id) completion on true left join lateral (select count(*)::integer active_sessions from auth.sessions auth_session where auth_session.user_id=account.auth_user_id and (auth_session.not_after is null or auth_session.not_after>clock_timestamp())) session_count on true where onboarding_case.id=target_case_id),
    'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',task.id,'stepCode',task.step_code,'title',task.title,'taskType',task.task_type,'responsibleGroup',task.responsible_group,'required',task.required,'dueAt',task.due_at,'status',task.status,'sourceStatus',private.hr_onboarding_task_source_status(task.id),'evidence',task.evidence,'sourceRequirement',task.source_requirement,'resolutionReason',task.resolution_reason) order by template_step.sort_order,task.title) from private.hr_onboarding_tasks task join private.hr_onboarding_template_steps template_step on template_step.id=task.template_step_id where task.case_id=target_case_id),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(jsonb_build_object('action',event.action,'actorId',event.actor_id,'reason',event.reason,'occurredAt',event.occurred_at,'details',event.details) order by event.occurred_at desc) from private.hr_onboarding_events event where event.case_id=target_case_id),'[]'::jsonb)
  );
end
$$;

create or replace function public.service_get_user_account_activity_report(
  target_actor_id uuid,
  target_search text,
  target_employment_status text,
  target_account_status text,
  target_login_status text,
  target_mfa_status text,
  target_role text,
  target_source text,
  target_stale_days integer,
  target_page_size integer,
  target_offset integer,
  target_export boolean,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_request_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_search text := lower(btrim(coalesce(target_search,'')));
  stale_days integer := case when target_stale_days in (7,30,60,90) then target_stale_days else 30 end;
  row_limit integer := case when coalesce(target_export,false) then 5000 else least(greatest(coalesce(target_page_size,25),10),50) end;
  row_offset integer := case when coalesce(target_export,false) then 0 else greatest(coalesce(target_offset,0),0) end;
  report_payload jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'reports.account_activity.view');
  if coalesce(target_export,false) then perform private.hr_onboarding_require_actor_permission(target_actor_id,'reports.account_activity.export'); end if;
  if target_mfa_method not in ('authenticator','security_key')
    or target_mfa_verified_at is null
    or target_mfa_verified_at < clock_timestamp() - interval '30 minutes'
    or target_mfa_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message='A recent MFA verification is required.';
  end if;
  if target_employment_status not in ('','onboarding','active','leave','inactive','separated')
    or target_account_status not in ('','not_created','active','disabled','setup_incomplete')
    or target_login_status not in ('','never_signed_in','recent','stale')
    or target_mfa_status not in ('','required_missing','enrolled','not_required') then
    raise check_violation using message='Choose supported account activity filters.';
  end if;
  if char_length(clean_search)>120 or char_length(coalesce(target_role,''))>80 or char_length(coalesce(target_source,''))>30 then raise check_violation using message='A report filter is too long.'; end if;

  with account_rows as (
    select employee.id employee_id,employee.employee_number,concat_ws(' ',employee.first_name,employee.last_name) employee_name,
      employee.username,contact.company_email,employee.status::text employment_status,employee.employment_type::text employment_type,
      employee.job_title,employee.role::text primary_role,coalesce(role_names.names,array[]::text[]) access_roles,
      case when account.employee_id is null then 'not_created' when account.disabled_at is not null then 'disabled' when account.must_change_password then 'setup_incomplete' else 'active' end account_state,
      case when completion.last_completed_at is null then 'never_signed_in' when completion.last_completed_at >= clock_timestamp()-(stale_days||' days')::interval then 'recent' else 'stale' end login_state,
      account.invited_at,account.activated_at,account.password_changed_at,completion.first_completed_at,completion.last_completed_at,
      completion.completed_count,completion.sources,private.employee_requires_mfa(employee.id) requires_mfa,
      account.mfa_enrolled_at,coalesce(session_count.active_sessions,0) active_session_count,coalesce(device_count.trusted_devices,0) trusted_device_count,
      case
        when account.disabled_at is null and account.employee_id is not null and employee.status in ('inactive','separated') then 'enabled_noncurrent_employee'
        when account.disabled_at is not null and employee.status in ('active','onboarding') then 'disabled_current_employee'
        when private.employee_requires_mfa(employee.id) and account.employee_id is not null and account.disabled_at is null and account.mfa_enrolled_at is null then 'mfa_missing'
        else 'none'
      end security_exception,
      case
        when account.employee_id is null then 'Create account'
        when account.disabled_at is not null and employee.status in ('active','onboarding') then 'Review disabled account'
        when account.must_change_password then 'Complete password setup'
        when private.employee_requires_mfa(employee.id) and account.mfa_enrolled_at is null then 'Enroll MFA'
        when completion.last_completed_at is null then 'Complete first sign-in'
        when completion.last_completed_at < clock_timestamp()-(stale_days||' days')::interval then 'Review inactive login'
        else 'No action required'
      end next_action
    from public.employees employee
    left join private.employee_contacts contact on contact.employee_id=employee.id
    left join private.employee_accounts account on account.employee_id=employee.id
    left join lateral (select count(*)::integer completed_count,min(sign_in.completed_at) first_completed_at,max(sign_in.completed_at) last_completed_at,coalesce(array_agg(distinct sign_in.completion_source),array[]::text[]) sources from private.employee_sign_in_completions sign_in where sign_in.employee_id=employee.id) completion on true
    left join lateral (select coalesce(array_agg(distinct role_name order by role_name),array[]::text[]) names from (select access_role.name role_name from public.access_roles access_role where access_role.system_role and access_role.active and access_role.base_app_role=employee.role union select access_role.name from public.employee_access_roles assignment join public.access_roles access_role on access_role.id=assignment.role_id where assignment.employee_id=employee.id and access_role.active) employee_roles) role_names on true
    left join lateral (select count(*)::integer active_sessions from auth.sessions auth_session where auth_session.user_id=account.auth_user_id and (auth_session.not_after is null or auth_session.not_after>clock_timestamp())) session_count on true
    left join lateral (select count(*)::integer trusted_devices from private.trusted_devices device where device.employee_id=employee.id and device.revoked_at is null and device.expires_at>clock_timestamp()) device_count on true
  ), filtered as (
    select * from account_rows row
    where (clean_search='' or concat_ws(' ',row.employee_name,row.employee_number,row.username,row.company_email,row.job_title,array_to_string(row.access_roles,' ')) ilike '%'||clean_search||'%')
      and (coalesce(target_employment_status,'')='' or row.employment_status=target_employment_status)
      and (coalesce(target_account_status,'')='' or row.account_state=target_account_status)
      and (coalesce(target_login_status,'')='' or row.login_state=target_login_status)
      and (coalesce(target_mfa_status,'')='' or (target_mfa_status='required_missing' and row.requires_mfa and row.mfa_enrolled_at is null) or (target_mfa_status='enrolled' and row.mfa_enrolled_at is not null) or (target_mfa_status='not_required' and not row.requires_mfa))
      and (coalesce(target_role,'')='' or lower(row.primary_role)=lower(target_role) or exists(select 1 from unnest(row.access_roles) role_name where lower(role_name)=lower(target_role)))
      and (coalesce(target_source,'')='' or target_source=any(row.sources))
  ), paged as (
    select * from filtered order by case when security_exception<>'none' then 0 when next_action<>'No action required' then 1 else 2 end, employee_name limit row_limit offset row_offset
  )
  select jsonb_build_object(
    'serverTimestamp',clock_timestamp(),'staleDays',stale_days,'pageSize',row_limit,'offset',row_offset,
    'totalCount',(select count(*) from filtered),
    'summary',jsonb_build_object(
      'total',(select count(*) from filtered),
      'activeAccounts',(select count(*) from filtered where account_state='active'),
      'neverSignedIn',(select count(*) from filtered where login_state='never_signed_in'),
      'pendingSetup',(select count(*) from filtered where account_state in ('not_created','setup_incomplete')),
      'mfaAttention',(select count(*) from filtered where requires_mfa and mfa_enrolled_at is null and account_state<>'disabled'),
      'disabled',(select count(*) from filtered where account_state='disabled'),
      'securityExceptions',(select count(*) from filtered where security_exception<>'none')
    ),
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'employeeId',row.employee_id,'employeeNumber',row.employee_number,'employeeName',row.employee_name,'username',row.username,'companyEmail',row.company_email,
      'employmentStatus',row.employment_status,'employmentType',row.employment_type,'jobTitle',row.job_title,'primaryRole',row.primary_role,'accessRoles',row.access_roles,
      'accountState',row.account_state,'loginState',row.login_state,'invitedAt',row.invited_at,'activatedAt',row.activated_at,'passwordChangedAt',row.password_changed_at,
      'firstCompletedSignInAt',row.first_completed_at,'lastCompletedSignInAt',row.last_completed_at,'completedSignInCount',row.completed_count,'completedSources',row.sources,
      'requiresMfa',row.requires_mfa,'mfaEnrolled',row.mfa_enrolled_at is not null,'mfaEnrolledAt',row.mfa_enrolled_at,
      'activeSessionCount',row.active_session_count,'trustedDeviceCount',row.trusted_device_count,'securityException',row.security_exception,'nextAction',row.next_action
    ) order by case when row.security_exception<>'none' then 0 when row.next_action<>'No action required' then 1 else 2 end,row.employee_name) from paged row),'[]'::jsonb)
  ) into report_payload;

  if coalesce(target_export,false) then
    insert into private.audit_events(employee_id,schema_name,table_name,operation,row_id,new_record)
    values(target_actor_id,'private','employee_sign_in_completions','EXPORT',coalesce(nullif(target_request_id,''),gen_random_uuid()::text),jsonb_build_object('report','user_account_activity','rowCount',jsonb_array_length(report_payload->'rows'),'filters',jsonb_build_object('employmentStatus',target_employment_status,'accountStatus',target_account_status,'loginStatus',target_login_status,'mfaStatus',target_mfa_status,'role',target_role,'source',target_source,'staleDays',stale_days)));
  end if;
  return report_payload;
end
$$;

revoke all on function private.hr_onboarding_ensure_standard_template(uuid) from public,anon,authenticated;
revoke all on function public.service_hr_onboarding_create_prehire(uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.service_get_hr_onboarding_options(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.service_hr_onboarding_launch_existing(uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.service_get_hr_onboarding_case(uuid,uuid) from public,anon,authenticated;
revoke all on function public.service_get_user_account_activity_report(uuid,text,text,text,text,text,text,text,integer,integer,integer,boolean,text,timestamptz,text) from public,anon,authenticated;
grant execute on function private.hr_onboarding_ensure_standard_template(uuid) to service_role;
grant execute on function public.service_hr_onboarding_create_prehire(uuid,jsonb,text) to service_role;
grant execute on function public.service_get_hr_onboarding_options(uuid,text,integer) to service_role;
grant execute on function public.service_hr_onboarding_launch_existing(uuid,uuid,jsonb,text) to service_role;
grant execute on function public.service_get_hr_onboarding_case(uuid,uuid) to service_role;
grant execute on function public.service_get_user_account_activity_report(uuid,text,text,text,text,text,text,text,integer,integer,integer,boolean,text,timestamptz,text) to service_role;

do $$
declare baseline onboarding_account_release_baseline%rowtype;
begin
  select * into strict baseline from onboarding_account_release_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.account_count <> (select count(*) from private.employee_accounts)
    or baseline.access_role_count <> (select count(*) from public.access_roles)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides) then
    raise exception 'Onboarding and account reporting release changed protected employee identity or access assignments.';
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
