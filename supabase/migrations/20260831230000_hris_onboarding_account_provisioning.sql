begin;

-- The onboarding profile extends the existing employee/case identity. It is not a
-- second employee directory and never stores authentication secrets.
create table private.hr_onboarding_profiles (
  case_id uuid primary key references private.hr_onboarding_cases(id) on delete restrict,
  work_state text not null,
  employment_type_snapshot text not null,
  job_family text not null,
  position_title text not null,
  requires_guard_license boolean not null default false,
  requires_armed_credentials boolean not null default false,
  welcome_email_status text not null default 'not_sent',
  welcome_email_sent_at timestamptz,
  account_setup_status text not null default 'not_sent',
  account_setup_sent_at timestamptz,
  last_delivery_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_onboarding_profile_state check (work_state in ('CO','CA','AZ')),
  constraint hr_onboarding_profile_employment_type check (employment_type_snapshot in ('hourly','salary','flex')),
  constraint hr_onboarding_profile_job_family check (job_family in ('guard','administration','operations','other')),
  constraint hr_onboarding_profile_position_present check (btrim(position_title) <> ''),
  constraint hr_onboarding_profile_welcome_status check (welcome_email_status in ('not_sent','sent','failed')),
  constraint hr_onboarding_profile_account_status check (account_setup_status in ('not_sent','sent','failed'))
);

alter table private.hr_onboarding_profiles enable row level security;
revoke all on private.hr_onboarding_profiles from public,anon,authenticated;
grant select,insert,update on private.hr_onboarding_profiles to service_role;

-- Cases created while onboarding was staged predate the profile extension. Give
-- those records conservative snapshots so the release does not strand history.
insert into private.hr_onboarding_profiles(
  case_id,
  work_state,
  employment_type_snapshot,
  job_family,
  position_title,
  requires_guard_license,
  requires_armed_credentials
)
select
  onboarding_case.id,
  'CO',
  employee.employment_type::text,
  case
    when employee.role::text='guard' then 'guard'
    when employee.role::text in ('supervisor','scheduler','dispatcher') then 'operations'
    when employee.role::text in ('admin','recruiting_licensing') then 'administration'
    else 'other'
  end,
  coalesce(nullif(btrim(employee.job_title),''),initcap(replace(employee.role::text,'_',' '))),
  employee.role::text='guard',
  false
from private.hr_onboarding_cases onboarding_case
join public.employees employee on employee.id=onboarding_case.employee_id
on conflict(case_id) do nothing;

create or replace function private.hr_onboarding_step_applies(
  requirement jsonb,
  work_state text,
  employment_type text,
  job_family text,
  needs_guard_license boolean,
  needs_armed_credentials boolean
)
returns boolean
language plpgsql
immutable
set search_path=''
as $$
begin
  if jsonb_typeof(requirement->'states')='array'
    and not (requirement->'states' ? work_state) then return false; end if;
  if jsonb_typeof(requirement->'employmentTypes')='array'
    and not (requirement->'employmentTypes' ? employment_type) then return false; end if;
  if jsonb_typeof(requirement->'jobFamilies')='array'
    and not (requirement->'jobFamilies' ? job_family) then return false; end if;
  if coalesce((requirement->>'requiresGuardLicense')::boolean,false) and not needs_guard_license then return false; end if;
  if coalesce((requirement->>'requiresArmedCredentials')::boolean,false) and not needs_armed_credentials then return false; end if;
  return true;
end
$$;

create or replace function private.hr_onboarding_enforce_task_evidence()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare employee_id uuid; document_category text;
begin
  if new.status in ('waived','not_applicable')
    and coalesce((new.source_requirement->>'nonWaivable')::boolean,false) then
    raise check_violation using message='This required onboarding item cannot be waived.';
  end if;

  if new.status='completed'
    and old.status is distinct from 'completed'
    and coalesce((new.source_requirement->>'documentRequired')::boolean,false) then
    select onboarding_case.employee_id into employee_id
    from private.hr_onboarding_cases onboarding_case where onboarding_case.id=new.case_id;
    document_category:=nullif(btrim(new.source_requirement->>'documentCategory'),'');
    if document_category is null or not exists (
      select 1 from private.hr_documents document
      where document.employee_id=employee_id
        and document.archived_at is null
        and document.current_version_id is not null
        and lower(document.category)=lower(document_category)
    ) then
      raise check_violation using message='Upload the required document before completing this onboarding item.';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists hr_onboarding_tasks_enforce_evidence on private.hr_onboarding_tasks;
create trigger hr_onboarding_tasks_enforce_evidence
before update of status on private.hr_onboarding_tasks
for each row execute function private.hr_onboarding_enforce_task_evidence();

create or replace function private.hr_onboarding_activate_employment()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.status='completed' and old.status is distinct from 'completed' then
    update private.hr_employment_relationships relationship
    set status='active',change_reason='Onboarding completed',updated_at=clock_timestamp()
    where relationship.worker_id=(
      select worker.id from private.hr_worker_identifiers worker
      join private.hr_person_identifiers person on person.id=worker.person_id
      where person.employee_id=new.employee_id
    ) and relationship.status='prehire' and relationship.effective_end is null;
  end if;
  return new;
end
$$;

drop trigger if exists hr_onboarding_cases_activate_employment on private.hr_onboarding_cases;
create trigger hr_onboarding_cases_activate_employment
after update of status on private.hr_onboarding_cases
for each row execute function private.hr_onboarding_activate_employment();

create or replace function public.service_hr_onboarding_create_prehire(
  target_actor_id uuid,
  target_payload jsonb,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  employee_id uuid:=gen_random_uuid(); person_id uuid; worker_id uuid; legal_entity_id uuid;
  template_id uuid; template_version integer; case_id uuid;
  first_name text:=btrim(coalesce(target_payload->>'firstName',''));
  middle_name text:=nullif(btrim(coalesce(target_payload->>'middleName','')),'');
  last_name text:=btrim(coalesce(target_payload->>'lastName',''));
  personal_email text:=lower(btrim(coalesce(target_payload->>'personalEmail','')));
  mobile_phone text:=nullif(btrim(coalesce(target_payload->>'mobilePhone','')),'');
  position_title text:=btrim(coalesce(target_payload->>'positionTitle',''));
  work_state text:=upper(btrim(coalesce(target_payload->>'workState','')));
  role_value text:=btrim(coalesce(target_payload->>'role','guard'));
  employment_type text:=btrim(coalesce(target_payload->>'employmentType','hourly'));
  job_family text:=btrim(coalesce(target_payload->>'jobFamily','other'));
  start_date date; needs_guard boolean; needs_armed boolean;
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.manage');
  if btrim(coalesce(target_reason,''))='' or char_length(btrim(target_reason))>1000 then raise check_violation using message='A concise audit reason is required.'; end if;
  if first_name='' or last_name='' or position_title='' then raise check_violation using message='Legal first name, legal last name, and position title are required.'; end if;
  if personal_email='' or personal_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise check_violation using message='A valid personal email is required.'; end if;
  if personal_email ~* '@guardianshipsecurity\.net$' then raise check_violation using message='Use the employee personal email. Company-domain delivery is temporarily disabled.'; end if;
  if exists(select 1 from private.employee_contacts contact where lower(contact.personal_email)=personal_email) then raise unique_violation using message='That personal email is already linked to an employee.'; end if;
  if work_state not in ('CO','CA','AZ') then raise check_violation using message='Choose CO, CA, or AZ as the work state.'; end if;
  if employment_type not in ('hourly','salary','flex') then raise check_violation using message='Choose hourly, salary, or flex employment.'; end if;
  if job_family not in ('guard','administration','operations','other') then raise check_violation using message='Choose a supported job family.'; end if;
  if not exists(select 1 from pg_catalog.pg_enum item join pg_catalog.pg_type enum_type on enum_type.oid=item.enumtypid where enum_type.typname='app_role' and item.enumlabel=role_value) then raise check_violation using message='Choose a supported SygShift role.'; end if;
  begin start_date:=(target_payload->>'startDate')::date; exception when others then raise check_violation using message='A valid start date is required.'; end;
  needs_guard:=coalesce((target_payload->>'requiresGuardLicense')::boolean,job_family='guard');
  needs_armed:=coalesce((target_payload->>'requiresArmedCredentials')::boolean,false);
  if needs_armed then needs_guard:=true; end if;

  -- Username assignment remains centralized in the established employee trigger so
  -- onboarding follows the same deterministic collision handling as User Accounts.
  insert into public.employees(id,first_name,middle_name,last_name,role,employment_type,status,hired_on,job_title)
  values(employee_id,first_name,middle_name,last_name,role_value::public.app_role,employment_type::public.employment_type,'onboarding',start_date,position_title);
  insert into private.employee_contacts(employee_id,personal_email,mobile_phone) values(employee_id,personal_email,mobile_phone);
  insert into private.hr_person_identifiers(employee_id,created_by) values(employee_id,target_actor_id) returning id into person_id;
  insert into private.hr_worker_identifiers(person_id,worker_reference,created_by)
  select person_id,employee.employee_number,target_actor_id from public.employees employee where employee.id=employee_id returning id into worker_id;
  insert into private.hr_legal_entities(code,name) values('GSL','Guardianship Security LLC')
  on conflict(code) do update set active=true,updated_at=clock_timestamp() returning id into legal_entity_id;
  insert into private.hr_employment_relationships(worker_id,legal_entity_id,status,worker_classification,employment_type,effective_start,change_reason,recorded_by)
  values(worker_id,legal_entity_id,'prehire','employee',employment_type,start_date,'Pre-hire onboarding created',target_actor_id);

  select template.id,template.current_version into template_id,template_version
  from private.hr_onboarding_templates template where template.name='Guardianship Standard Onboarding' and template.status='active'
  order by template.approved_at desc nulls last limit 1;
  if template_id is null then
    insert into private.hr_onboarding_templates(name,description,status,current_version,conditions,created_by,approved_by,approved_at)
    values('Guardianship Standard Onboarding','Federal, state, employment, job-duty, and company onboarding requirements.','active',1,'{"dynamic":true}'::jsonb,target_actor_id,target_actor_id,clock_timestamp()) returning id,current_version into template_id,template_version;
    insert into private.hr_onboarding_template_steps(template_id,template_version,step_code,title,description,task_type,responsible_group,required,due_offset_days,source_requirement,sort_order,created_by) values
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

  insert into private.hr_onboarding_cases(employee_id,template_id,template_version,target_start_date,owner_id,launched_by)
  values(employee_id,template_id,template_version,start_date,target_actor_id,target_actor_id) returning id into case_id;
  insert into private.hr_onboarding_profiles(case_id,work_state,employment_type_snapshot,job_family,position_title,requires_guard_license,requires_armed_credentials)
  values(case_id,work_state,employment_type,job_family,position_title,needs_guard,needs_armed);
  insert into private.hr_onboarding_tasks(case_id,template_step_id,step_code,title,task_type,responsible_group,required,due_at,assignee_id,source_requirement)
  select case_id,step.id,step.step_code,step.title,step.task_type,step.responsible_group,step.required,((start_date+step.due_offset_days)::timestamp at time zone 'America/Denver'),case when step.responsible_group='employee' then employee_id else null end,step.source_requirement
  from private.hr_onboarding_template_steps step
  where step.template_id=template_id and step.template_version=template_version
    and private.hr_onboarding_step_applies(step.source_requirement,work_state,employment_type,job_family,needs_guard,needs_armed);
  insert into private.hr_onboarding_events(case_id,action,actor_id,reason,details)
  values(case_id,'create_prehire',target_actor_id,btrim(target_reason),jsonb_build_object('employeeId',employee_id,'workState',work_state,'jobFamily',job_family,'requiresGuardLicense',needs_guard,'requiresArmedCredentials',needs_armed));
  perform private.hr_onboarding_recalculate_case(case_id);
  return jsonb_build_object(
    'id',employee_id,
    'employeeId',employee_id,
    'caseId',case_id,
    'employeeNumber',(select employee_number from public.employees where id=employee_id),
    'username',(select username from public.employees where id=employee_id),
    'action','create_prehire',
    'caseStatus',(select onboarding_case.status from private.hr_onboarding_cases onboarding_case where onboarding_case.id=case_id)
  );
end
$$;

create or replace function public.service_get_hr_onboarding_welcome_target(target_actor_id uuid,target_case_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.manage');
  if not exists(select 1 from private.hr_onboarding_cases where id=target_case_id) then raise no_data_found using message='Onboarding case not found.'; end if;
  return (
    select jsonb_build_object(
      'caseId',onboarding_case.id,'employeeId',employee.id,'employeeNumber',employee.employee_number,
      'jobTitle',employee.job_title,'username',employee.username,'authEmail',employee.username||'@accounts.sygshift.invalid',
      'displayName',btrim(employee.first_name||' '||employee.last_name),'role',employee.role,'employmentType',employee.employment_type,
      'status',employee.status,'existingAuthUserId',account.auth_user_id,'contactEmail',contact.personal_email,
      'requiresMfa',employee.role in ('admin','supervisor','scheduler','dispatcher','recruiting_licensing'),
      'startDate',onboarding_case.target_start_date,
      'positionTitle',coalesce(profile.position_title,nullif(btrim(employee.job_title),''),initcap(replace(employee.role::text,'_',' '))),
      'welcomeEmailStatus',coalesce(profile.welcome_email_status,'not_sent'),
      'accountSetupStatus',coalesce(profile.account_setup_status,'not_sent')
    )
    from private.hr_onboarding_cases onboarding_case
    join public.employees employee on employee.id=onboarding_case.employee_id
    left join private.hr_onboarding_profiles profile on profile.case_id=onboarding_case.id
    join private.employee_contacts contact on contact.employee_id=employee.id
    left join private.employee_accounts account on account.employee_id=employee.id
    where onboarding_case.id=target_case_id
  );
end
$$;

create or replace function public.service_hr_onboarding_record_delivery(target_actor_id uuid,target_case_id uuid,target_kind text,target_status text,target_error text,target_reason text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.manage');
  if target_kind not in ('welcome','account_setup') or target_status not in ('sent','failed') then raise check_violation using message='Choose a supported onboarding delivery result.'; end if;
  update private.hr_onboarding_profiles set
    welcome_email_status=case when target_kind='welcome' then target_status else welcome_email_status end,
    welcome_email_sent_at=case when target_kind='welcome' and target_status='sent' then clock_timestamp() else welcome_email_sent_at end,
    account_setup_status=case when target_kind='account_setup' then target_status else account_setup_status end,
    account_setup_sent_at=case when target_kind='account_setup' and target_status='sent' then clock_timestamp() else account_setup_sent_at end,
    last_delivery_error=case when target_status='failed' then nullif(left(coalesce(target_error,''),1000),'') else null end,
    updated_at=clock_timestamp()
  where case_id=target_case_id;
  if not found then raise no_data_found using message='Onboarding profile not found.'; end if;
  insert into private.hr_onboarding_events(case_id,action,actor_id,reason,details)
  values(target_case_id,'deliver_'||target_kind,target_actor_id,btrim(target_reason),jsonb_build_object('status',target_status,'error',nullif(left(coalesce(target_error,''),1000),'')));
  return jsonb_build_object('caseId',target_case_id,'kind',target_kind,'status',target_status);
end
$$;

-- Pre-hire employees may receive the account that is linked to the same employee
-- identity. Inactive, separated, and leave records remain blocked.
create or replace function public.service_link_employee_auth_account(target_employee_id uuid,target_auth_user_id uuid,target_must_change_password boolean default true)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare existing_account private.employee_accounts%rowtype;
begin
  if target_employee_id is null or target_auth_user_id is null then raise check_violation using message='Employee and auth user identifiers are required.'; end if;
  if not exists(select 1 from public.employees employee where employee.id=target_employee_id and employee.status in ('active','onboarding')) then raise check_violation using message='Only active or onboarding employees can receive login accounts.'; end if;
  if not exists(select 1 from auth.users auth_user where auth_user.id=target_auth_user_id) then raise foreign_key_violation using message='The Supabase auth user does not exist.'; end if;
  select * into existing_account from private.employee_accounts account where account.employee_id=target_employee_id;
  if existing_account.employee_id is not null and existing_account.auth_user_id<>target_auth_user_id then raise unique_violation using message='This employee is already linked to a different auth account.'; end if;
  insert into private.employee_accounts(employee_id,auth_user_id,invited_at,disabled_at,must_change_password)
  values(target_employee_id,target_auth_user_id,clock_timestamp(),null,target_must_change_password)
  on conflict(employee_id) do update set disabled_at=null,must_change_password=target_must_change_password,password_changed_at=case when target_must_change_password then null else employee_accounts.password_changed_at end,invited_at=coalesce(employee_accounts.invited_at,excluded.invited_at),updated_at=clock_timestamp();
  return private.admin_user_record(target_employee_id);
end
$$;

create or replace function public.service_get_hr_onboarding_case(target_actor_id uuid,target_case_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.view');
  if not exists(select 1 from private.hr_onboarding_cases where id=target_case_id) then raise no_data_found using message='Onboarding case not found.'; end if;
  return jsonb_build_object(
    'case',(select jsonb_build_object('id',onboarding_case.id,'employeeId',employee.id,'employeeNumber',employee.employee_number,'employeeName',concat_ws(' ',employee.first_name,employee.last_name),'status',onboarding_case.status,'targetStartDate',onboarding_case.target_start_date,'templateId',onboarding_case.template_id,'templateVersion',onboarding_case.template_version,'workState',coalesce(profile.work_state,'CO'),'employmentType',coalesce(profile.employment_type_snapshot,employee.employment_type::text),'jobFamily',coalesce(profile.job_family,case when employee.role::text='guard' then 'guard' when employee.role::text in ('supervisor','scheduler','dispatcher') then 'operations' when employee.role::text in ('admin','recruiting_licensing') then 'administration' else 'other' end),'positionTitle',coalesce(profile.position_title,nullif(btrim(employee.job_title),''),initcap(replace(employee.role::text,'_',' '))),'requiresGuardLicense',coalesce(profile.requires_guard_license,employee.role::text='guard'),'requiresArmedCredentials',coalesce(profile.requires_armed_credentials,false),'welcomeEmailStatus',coalesce(profile.welcome_email_status,'not_sent'),'accountSetupStatus',coalesce(profile.account_setup_status,'not_sent')) from private.hr_onboarding_cases onboarding_case join public.employees employee on employee.id=onboarding_case.employee_id left join private.hr_onboarding_profiles profile on profile.case_id=onboarding_case.id where onboarding_case.id=target_case_id),
    'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',task.id,'stepCode',task.step_code,'title',task.title,'taskType',task.task_type,'responsibleGroup',task.responsible_group,'required',task.required,'dueAt',task.due_at,'status',task.status,'sourceStatus',private.hr_onboarding_task_source_status(task.id),'evidence',task.evidence,'sourceRequirement',task.source_requirement,'resolutionReason',task.resolution_reason) order by template_step.sort_order,task.title) from private.hr_onboarding_tasks task join private.hr_onboarding_template_steps template_step on template_step.id=task.template_step_id where task.case_id=target_case_id),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(jsonb_build_object('action',event.action,'actorId',event.actor_id,'reason',event.reason,'occurredAt',event.occurred_at,'details',event.details) order by event.occurred_at desc) from private.hr_onboarding_events event where event.case_id=target_case_id),'[]'::jsonb)
  );
end
$$;

create or replace function public.service_set_hr_onboarding_release_gate(
  target_actor_id uuid,
  target_enabled boolean,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  clean_reason text := nullif(btrim(coalesce(target_reason,'')), '');
  prior_enabled boolean;
  changed_at timestamptz := clock_timestamp();
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message='Service role required.';
  end if;
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.approve');
  if clean_reason is null then
    raise check_violation using message='A release reason is required.';
  end if;

  select gate.enabled into prior_enabled
  from private.hr_onboarding_release_gate gate
  where gate.singleton=true
  for update;

  update private.hr_onboarding_release_gate
  set enabled=target_enabled,
      enabled_by=case when target_enabled then target_actor_id else null end,
      enabled_at=case when target_enabled then changed_at else null end,
      reason=case when target_enabled then clean_reason else null end,
      updated_at=changed_at
  where singleton=true;

  insert into private.audit_events(
    employee_id,schema_name,table_name,operation,row_id,old_record,new_record
  ) values (
    target_actor_id,
    'private',
    'hr_onboarding_release_gate',
    case when target_enabled then 'ENABLE' else 'DISABLE' end,
    'singleton',
    jsonb_build_object('enabled',coalesce(prior_enabled,false)),
    jsonb_build_object('enabled',target_enabled,'reason',clean_reason,'changedAt',changed_at)
  );

  return jsonb_build_object('enabled',target_enabled,'updatedAt',changed_at);
end
$$;

revoke all on function private.hr_onboarding_step_applies(jsonb,text,text,text,boolean,boolean) from public,anon,authenticated;
revoke all on function private.hr_onboarding_enforce_task_evidence() from public,anon,authenticated;
revoke all on function private.hr_onboarding_activate_employment() from public,anon,authenticated;
revoke all on function public.service_hr_onboarding_create_prehire(uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.service_get_hr_onboarding_welcome_target(uuid,uuid) from public,anon,authenticated;
revoke all on function public.service_hr_onboarding_record_delivery(uuid,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.service_link_employee_auth_account(uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.service_get_hr_onboarding_case(uuid,uuid) from public,anon,authenticated;
revoke all on function public.service_set_hr_onboarding_release_gate(uuid,boolean,text) from public,anon,authenticated;
grant execute on function private.hr_onboarding_step_applies(jsonb,text,text,text,boolean,boolean) to service_role;
grant execute on function private.hr_onboarding_enforce_task_evidence() to service_role;
grant execute on function private.hr_onboarding_activate_employment() to service_role;
grant execute on function public.service_hr_onboarding_create_prehire(uuid,jsonb,text) to service_role;
grant execute on function public.service_get_hr_onboarding_welcome_target(uuid,uuid) to service_role;
grant execute on function public.service_hr_onboarding_record_delivery(uuid,uuid,text,text,text,text) to service_role;
grant execute on function public.service_link_employee_auth_account(uuid,uuid,boolean) to service_role;
grant execute on function public.service_get_hr_onboarding_case(uuid,uuid) to service_role;
grant execute on function public.service_set_hr_onboarding_release_gate(uuid,boolean,text) to service_role;

commit;
