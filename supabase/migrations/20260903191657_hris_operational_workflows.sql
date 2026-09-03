begin;

-- Release the in-system HR operations modules only after installing one
-- permission-checked, audited mutation boundary. This migration creates no
-- employee, leave, benefit, talent, learning, case, safety, asset, lifecycle,
-- service-request, or report record.
create temporary table hris_operational_release_baseline on commit drop as
select
  (select count(*) from public.employees) employee_count,
  (select count(*) from public.employee_access_roles) role_assignment_count,
  (select count(*) from public.employee_permission_overrides) override_count,
  (select count(*) from private.hr_leave_cases) leave_count,
  (select count(*) from private.hr_benefit_plans) benefit_count,
  (select count(*) from private.hr_talent_goals) talent_count,
  (select count(*) from private.hr_learning_items) learning_count,
  (select count(*) from private.hr_cases) case_count,
  (select count(*) from private.hr_safety_cases) safety_count,
  (select count(*) from private.hr_assets) asset_count,
  (select count(*) from private.hr_lifecycle_cases) lifecycle_count,
  (select count(*) from private.hr_service_requests) request_count,
  (select count(*) from private.hr_report_definitions) report_count;

create or replace function private.hr_operational_text(
  target_payload jsonb,
  target_key text,
  target_label text,
  target_max integer,
  target_required boolean default true
) returns text language plpgsql immutable set search_path='' as $$
declare clean_value text := nullif(btrim(coalesce(target_payload->>target_key,'')), '');
begin
  if target_required and clean_value is null then
    raise check_violation using message = target_label || ' is required.';
  end if;
  if clean_value is not null and char_length(clean_value) > target_max then
    raise check_violation using message = target_label || ' is too long.';
  end if;
  return clean_value;
end $$;

create or replace function private.hr_operational_uuid(
  target_payload jsonb,
  target_key text,
  target_label text,
  target_required boolean default true
) returns uuid language plpgsql immutable set search_path='' as $$
declare clean_value text := nullif(btrim(coalesce(target_payload->>target_key,'')), '');
begin
  if clean_value is null then
    if target_required then raise check_violation using message = target_label || ' is required.'; end if;
    return null;
  end if;
  begin return clean_value::uuid;
  exception when invalid_text_representation then raise check_violation using message = target_label || ' is invalid.';
  end;
end $$;

create or replace function private.hr_operational_date(
  target_payload jsonb,
  target_key text,
  target_label text,
  target_required boolean default true
) returns date language plpgsql immutable set search_path='' as $$
declare clean_value text := nullif(btrim(coalesce(target_payload->>target_key,'')), '');
begin
  if clean_value is null then
    if target_required then raise check_violation using message = target_label || ' is required.'; end if;
    return null;
  end if;
  begin return clean_value::date;
  exception when invalid_datetime_format then raise check_violation using message = target_label || ' is invalid.';
  end;
end $$;

create or replace function private.hr_operational_require_employee(target_employee_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(
    select 1 from public.employees employee
    where employee.id=target_employee_id and employee.status in ('onboarding','active','leave')
  ) then raise check_violation using message='Choose a current employee.'; end if;
end $$;

-- Repair three latent Stage 6 query ambiguities before those already-released
-- onboarding and recruiting paths are presented as part of the operational suite.
-- Rebuild the existing routines in place so their established signatures,
-- permission checks, grants, and behavior remain unchanged.
do $$
declare
  function_sql text;
  repaired_sql text;
begin
  select pg_catalog.pg_get_functiondef('public.service_hr_onboarding_action(uuid,text,jsonb,text)'::regprocedure)
  into function_sql;
  repaired_sql := replace(
    function_sql,
    'step.template_version=template_version',
    'step.template_version=(select template.current_version from private.hr_onboarding_templates template where template.id=selected_template_id)'
  );
  if repaired_sql = function_sql then
    raise check_violation using message='The onboarding template-version repair target was not found.';
  end if;
  execute repaired_sql;

  select pg_catalog.pg_get_functiondef('public.service_hr_onboarding_create_prehire(uuid,jsonb,text)'::regprocedure)
  into function_sql;
  repaired_sql := replace(
    function_sql,
    'lower(contact.personal_email)=personal_email',
    'lower(contact.personal_email)=lower(btrim(coalesce(target_payload->>''personalEmail'','''')))'
  );
  if repaired_sql = function_sql then
    raise check_violation using message='The onboarding personal-email repair target was not found.';
  end if;
  execute repaired_sql;

  select pg_catalog.pg_get_functiondef('public.service_review_candidate_conversion(uuid,uuid,text,text)'::regprocedure)
  into function_sql;
  repaired_sql := replace(
    function_sql,
    'select applicant.* into applicant from private.hr_applications application join private.hr_applicants applicant on applicant.id=application.applicant_id where application.id=conversion.application_id for update of applicant;',
    'select source_applicant.* into applicant from private.hr_applications application join private.hr_applicants source_applicant on source_applicant.id=application.applicant_id where application.id=conversion.application_id for update of source_applicant;'
  );
  if repaired_sql = function_sql then
    raise check_violation using message='The candidate-conversion applicant repair target was not found.';
  end if;
  execute repaired_sql;
end $$;

create or replace function public.service_hr_operational_action(
  target_actor_id uuid,
  target_module text,
  target_action text,
  target_payload jsonb,
  target_reason text,
  target_mfa_method text default null,
  target_mfa_verified_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  payload jsonb := coalesce(target_payload,'{}'::jsonb);
  clean_reason text := nullif(btrim(coalesce(target_reason,'')), '');
  target_id uuid;
  employee_id uuid;
  related_id uuid;
  result_id uuid;
  clean_status text;
  clean_type text;
  today_date date := (clock_timestamp() at time zone 'America/Denver')::date;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  if jsonb_typeof(payload) <> 'object' then raise check_violation using message='Action details must be an object.'; end if;
  if clean_reason is null or char_length(clean_reason)>4000 then raise check_violation using message='A valid business reason is required.'; end if;
  if target_module not in ('leave','benefits','talent','learning','cases','safety','assets','offboarding','self_service','reporting') then
    raise check_violation using message='Unsupported HR module.';
  end if;

  if target_module in ('leave','benefits') then
    perform private.hr_stage7_assert_enabled(target_module);
  elsif target_module in ('talent','learning','cases','safety','assets') then
    perform private.hr_stage8_assert_enabled(target_module);
  else
    perform private.hr_stage9_assert_enabled(target_module);
  end if;
  if target_module in ('cases','safety','offboarding','reporting') then
    perform private.hr_stage9_require_recent_mfa(target_mfa_method,target_mfa_verified_at,target_module);
  end if;

  if target_module='leave' and target_action='create_case' then
    perform private.hr_stage7_require_actor_permission(target_actor_id,'hr.leave.manage');
    employee_id:=private.hr_operational_uuid(payload,'employeeId','Employee'); perform private.hr_operational_require_employee(employee_id);
    clean_type:=private.hr_operational_text(payload,'caseType','Leave type',40);
    insert into private.hr_leave_cases(employee_id,case_type,status,start_on,return_on,pay_treatment,operational_summary,opened_by)
    values(employee_id,clean_type,'open',private.hr_operational_date(payload,'startOn','Start date'),private.hr_operational_date(payload,'returnOn','Return date',false),coalesce(private.hr_operational_text(payload,'payTreatment','Pay treatment',40,false),'pending'),private.hr_operational_text(payload,'summary','Summary',2000,false),target_actor_id)
    returning id into result_id;
    insert into private.hr_leave_events(case_id,action,actor_id,reason,details) values(result_id,'created',target_actor_id,clean_reason,jsonb_build_object('caseType',clean_type));

  elsif target_module='leave' and target_action='decide_case' then
    perform private.hr_stage7_require_actor_permission(target_actor_id,'hr.leave.approve');
    target_id:=private.hr_operational_uuid(payload,'id','Leave case'); clean_status:=private.hr_operational_text(payload,'status','Decision',20);
    if clean_status not in ('approved','denied') then raise check_violation using message='Choose approved or denied.'; end if;
    update private.hr_leave_cases set status=clean_status,decided_by=target_actor_id,decided_at=clock_timestamp(),decision_reason=clean_reason,updated_at=clock_timestamp()
    where id=target_id and status in ('open','under_review') and opened_by<>target_actor_id returning id into result_id;
    if result_id is null then raise check_violation using message='The leave case is unavailable or requires a different approver.'; end if;
    insert into private.hr_leave_events(case_id,action,actor_id,reason,details) values(result_id,clean_status,target_actor_id,clean_reason,'{}');

  elsif target_module='benefits' and target_action='create_plan' then
    perform private.hr_stage7_require_actor_permission(target_actor_id,'hr.benefits.manage');
    insert into private.hr_benefit_plans(code,name,plan_type,carrier_name,status,created_by)
    values(lower(private.hr_operational_text(payload,'code','Plan code',80)),private.hr_operational_text(payload,'name','Plan name',160),private.hr_operational_text(payload,'planType','Plan type',40),private.hr_operational_text(payload,'carrierName','Carrier',160,false),'draft',target_actor_id)
    returning id into result_id;
    insert into private.hr_benefit_events(plan_id,action,actor_id,reason,details) values(result_id,'created',target_actor_id,clean_reason,'{}');

  elsif target_module='benefits' and target_action='activate_plan' then
    perform private.hr_stage7_require_actor_permission(target_actor_id,'hr.benefits.approve');
    target_id:=private.hr_operational_uuid(payload,'id','Benefit plan');
    update private.hr_benefit_plans set status='active',updated_at=clock_timestamp() where id=target_id and status='draft' and created_by<>target_actor_id returning id into result_id;
    if result_id is null then raise check_violation using message='The plan is unavailable or requires a different approver.'; end if;
    insert into private.hr_benefit_events(plan_id,action,actor_id,reason,details) values(result_id,'activated',target_actor_id,clean_reason,'{}');

  elsif target_module='talent' and target_action='create_goal' then
    perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.talent.manage');
    employee_id:=private.hr_operational_uuid(payload,'employeeId','Employee'); perform private.hr_operational_require_employee(employee_id);
    insert into private.hr_talent_goals(employee_id,title,description,status,starts_on,due_on,created_by)
    values(employee_id,private.hr_operational_text(payload,'title','Goal title',200),private.hr_operational_text(payload,'description','Description',4000,false),'active',private.hr_operational_date(payload,'startsOn','Start date',false),private.hr_operational_date(payload,'dueOn','Due date',false),target_actor_id)
    returning id into result_id;
    insert into private.hr_talent_events(employee_id,entity_type,entity_id,action,actor_id,reason,details) values(employee_id,'goal',result_id,'created',target_actor_id,clean_reason,'{}');

  elsif target_module='talent' and target_action='update_goal' then
    perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.talent.manage');
    target_id:=private.hr_operational_uuid(payload,'id','Goal'); clean_status:=private.hr_operational_text(payload,'status','Status',20);
    update private.hr_talent_goals set status=clean_status,progress_percent=coalesce((payload->>'progressPercent')::numeric,progress_percent),updated_at=clock_timestamp()
    where id=target_id and clean_status in ('active','completed','canceled','archived') returning id,employee_id into result_id,employee_id;
    if result_id is null then raise check_violation using message='The goal could not be updated.'; end if;
    insert into private.hr_talent_events(employee_id,entity_type,entity_id,action,actor_id,reason,details) values(employee_id,'goal',result_id,'updated',target_actor_id,clean_reason,jsonb_build_object('status',clean_status));

  elsif target_module='learning' and target_action='create_item' then
    perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.learning.manage');
    insert into private.hr_learning_items(code,title,description,delivery_method,requirement_type,renewal_days,status,created_by,approved_by,approved_at)
    values(lower(private.hr_operational_text(payload,'code','Learning code',80)),private.hr_operational_text(payload,'title','Title',200),private.hr_operational_text(payload,'description','Description',4000,false),coalesce(private.hr_operational_text(payload,'deliveryMethod','Delivery method',40,false),'other'),coalesce(private.hr_operational_text(payload,'requirementType','Requirement type',40,false),'optional'),nullif(payload->>'renewalDays','')::integer,'active',target_actor_id,target_actor_id,clock_timestamp())
    returning id into result_id;
    insert into private.hr_learning_events(learning_item_id,action,actor_id,reason,details) values(result_id,'created',target_actor_id,clean_reason,'{}');

  elsif target_module='learning' and target_action='assign_item' then
    perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.learning.manage');
    related_id:=private.hr_operational_uuid(payload,'itemId','Learning item'); employee_id:=private.hr_operational_uuid(payload,'employeeId','Employee'); perform private.hr_operational_require_employee(employee_id);
    insert into private.hr_learning_assignments(learning_item_id,employee_id,assigned_by,due_on) values(related_id,employee_id,target_actor_id,private.hr_operational_date(payload,'dueOn','Due date',false)) returning id into result_id;
    insert into private.hr_learning_events(assignment_id,learning_item_id,action,actor_id,reason,details) values(result_id,related_id,'assigned',target_actor_id,clean_reason,'{}');

  elsif target_module='cases' and target_action='create_case' then
    perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.cases.manage');
    employee_id:=private.hr_operational_uuid(payload,'employeeId','Employee',false); if employee_id is not null then perform private.hr_operational_require_employee(employee_id); end if;
    insert into private.hr_cases(subject_employee_id,case_type,title,priority,owner_id,opened_by) values(employee_id,private.hr_operational_text(payload,'caseType','Case type',40),private.hr_operational_text(payload,'title','Case title',200),coalesce(private.hr_operational_text(payload,'priority','Priority',20,false),'normal'),target_actor_id,target_actor_id) returning id into result_id;
    insert into private.hr_case_events(case_id,action,actor_id,reason,details) values(result_id,'created',target_actor_id,clean_reason,'{}');

  elsif target_module='cases' and target_action='add_note' then
    perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.cases.manage');
    target_id:=private.hr_operational_uuid(payload,'id','Employee case');
    insert into private.hr_case_notes(case_id,note_type,note,restricted,recorded_by) values(target_id,coalesce(private.hr_operational_text(payload,'noteType','Note type',40,false),'case_note'),private.hr_operational_text(payload,'note','Case note',10000),coalesce((payload->>'restricted')::boolean,true),target_actor_id) returning id into result_id;
    insert into private.hr_case_events(case_id,action,actor_id,reason,details) values(target_id,'note_added',target_actor_id,clean_reason,jsonb_build_object('noteId',result_id));

  elsif target_module='cases' and target_action='close_case' then
    perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.cases.manage'); target_id:=private.hr_operational_uuid(payload,'id','Employee case');
    update private.hr_cases set status='closed',closed_by=target_actor_id,closed_at=clock_timestamp(),outcome=clean_reason,updated_at=clock_timestamp() where id=target_id and status not in ('closed','canceled') returning id into result_id;
    if result_id is null then raise check_violation using message='The employee case could not be closed.'; end if;
    insert into private.hr_case_events(case_id,action,actor_id,reason,details) values(result_id,'closed',target_actor_id,clean_reason,'{}');

  elsif target_module='safety' and target_action='create_case' then
    perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.safety.manage');
    employee_id:=private.hr_operational_uuid(payload,'employeeId','Employee',false); if employee_id is not null then perform private.hr_operational_require_employee(employee_id); end if;
    insert into private.hr_safety_cases(employee_id,site_id,incident_type,title,occurred_at,reported_by,owner_id)
    values(employee_id,private.hr_operational_uuid(payload,'siteId','Site',false),private.hr_operational_text(payload,'incidentType','Incident type',40),private.hr_operational_text(payload,'title','Incident title',200),(private.hr_operational_text(payload,'occurredAt','Incident time',40))::timestamptz,target_actor_id,target_actor_id) returning id into result_id;
    insert into private.hr_safety_events(safety_case_id,action,actor_id,reason,details) values(result_id,'created',target_actor_id,clean_reason,'{}');

  elsif target_module='assets' and target_action='create_asset' then
    perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.assets.manage');
    insert into private.hr_assets(asset_tag,asset_type,name,description,serial_number,condition,acquired_on,created_by)
    values(private.hr_operational_text(payload,'assetTag','Asset tag',100),private.hr_operational_text(payload,'assetType','Asset type',40),private.hr_operational_text(payload,'name','Asset name',200),private.hr_operational_text(payload,'description','Description',2000,false),private.hr_operational_text(payload,'serialNumber','Serial number',200,false),coalesce(private.hr_operational_text(payload,'condition','Condition',20,false),'good'),private.hr_operational_date(payload,'acquiredOn','Acquired date',false),target_actor_id) returning id into result_id;
    insert into private.hr_asset_events(asset_id,action,actor_id,reason,details) values(result_id,'created',target_actor_id,clean_reason,'{}');

  elsif target_module='assets' and target_action='assign_asset' then
    perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.assets.manage');
    related_id:=private.hr_operational_uuid(payload,'assetId','Asset'); employee_id:=private.hr_operational_uuid(payload,'employeeId','Employee'); perform private.hr_operational_require_employee(employee_id);
    update private.hr_assets set status='assigned',updated_at=clock_timestamp() where id=related_id and status='available';
    if not found then raise check_violation using message='The asset is not available.'; end if;
    insert into private.hr_asset_assignments(asset_id,employee_id,assigned_by,condition_out) values(related_id,employee_id,target_actor_id,coalesce(private.hr_operational_text(payload,'condition','Condition',20,false),'good')) returning id into result_id;
    insert into private.hr_asset_events(asset_id,assignment_id,action,actor_id,reason,details) values(related_id,result_id,'assigned',target_actor_id,clean_reason,'{}');

  elsif target_module='offboarding' and target_action='create_case' then
    perform private.hr_stage9_require_actor_permission(target_actor_id,'hr.offboarding.manage');
    employee_id:=private.hr_operational_uuid(payload,'employeeId','Employee');
    insert into private.hr_lifecycle_cases(employee_id,case_type,status,effective_on,requested_by,request_reason) values(employee_id,private.hr_operational_text(payload,'caseType','Lifecycle type',20),'pending_approval',private.hr_operational_date(payload,'effectiveOn','Effective date'),target_actor_id,clean_reason) returning id into result_id;
    insert into private.hr_lifecycle_events(lifecycle_case_id,action,actor_id,reason,details) values(result_id,'submitted',target_actor_id,clean_reason,'{}');

  elsif target_module='offboarding' and target_action='review_case' then
    perform private.hr_stage9_require_actor_permission(target_actor_id,'hr.offboarding.approve');
    target_id:=private.hr_operational_uuid(payload,'id','Lifecycle case'); clean_status:=private.hr_operational_text(payload,'decision','Decision',20);
    if clean_status not in ('approved','denied') then raise check_violation using message='Choose approved or denied.'; end if;
    update private.hr_lifecycle_cases set status=clean_status,approved_by=target_actor_id,approved_at=clock_timestamp(),decision_reason=clean_reason,updated_at=clock_timestamp() where id=target_id and status='pending_approval' and requested_by<>target_actor_id returning id into result_id;
    if result_id is null then raise check_violation using message='The lifecycle case is unavailable or requires a different approver.'; end if;
    insert into private.hr_lifecycle_approvals(lifecycle_case_id,decision,decided_by,reason) values(result_id,clean_status,target_actor_id,clean_reason);
    insert into private.hr_lifecycle_events(lifecycle_case_id,action,actor_id,reason,details) values(result_id,clean_status,target_actor_id,clean_reason,'{}');

  elsif target_module='self_service' and target_action='submit_request' then
    perform private.hr_stage9_require_actor_permission(target_actor_id,'hr.self_service.view');
    employee_id:=coalesce(private.hr_operational_uuid(payload,'employeeId','Employee',false),target_actor_id);
    if employee_id<>target_actor_id then perform private.hr_stage9_require_actor_permission(target_actor_id,'hr.self_service.manage'); end if;
    insert into private.hr_service_requests(requester_id,subject_employee_id,request_scope,request_reason,proposed_changes) values(target_actor_id,employee_id,private.hr_operational_text(payload,'scope','Request type',40),clean_reason,coalesce(payload->'proposedChanges','{}')) returning id into result_id;
    insert into private.hr_service_request_events(service_request_id,action,actor_id,reason,details) values(result_id,'submitted',target_actor_id,clean_reason,'{}');

  elsif target_module='self_service' and target_action='review_request' then
    perform private.hr_stage9_require_actor_permission(target_actor_id,'hr.self_service.manage'); target_id:=private.hr_operational_uuid(payload,'id','Request'); clean_status:=private.hr_operational_text(payload,'decision','Decision',20);
    if clean_status not in ('approved','denied') then raise check_violation using message='Choose approved or denied.'; end if;
    update private.hr_service_requests set status=clean_status,decided_by=target_actor_id,decided_at=clock_timestamp(),decision_reason=clean_reason,updated_at=clock_timestamp() where id=target_id and status in ('submitted','under_review') and requester_id<>target_actor_id returning id into result_id;
    if result_id is null then raise check_violation using message='The request is unavailable or requires a different reviewer.'; end if;
    insert into private.hr_service_request_events(service_request_id,action,actor_id,reason,details) values(result_id,clean_status,target_actor_id,clean_reason,'{}');

  elsif target_module='reporting' and target_action='create_definition' then
    perform private.hr_stage9_require_actor_permission(target_actor_id,'hr.reporting.manage');
    insert into private.hr_report_definitions(name,description,source_key,selected_columns,filters,visibility,status,owner_id)
    values(private.hr_operational_text(payload,'name','Report name',200),private.hr_operational_text(payload,'description','Description',2000,false),private.hr_operational_text(payload,'sourceKey','Report source',40),coalesce(payload->'selectedColumns','[]'),coalesce(payload->'filters','{}'),coalesce(private.hr_operational_text(payload,'visibility','Visibility',40,false),'private'),'active',target_actor_id) returning id into result_id;
    insert into private.hr_report_events(report_definition_id,action,actor_id,reason,details) values(result_id,'created',target_actor_id,clean_reason,'{}');
  else
    raise check_violation using message='Unsupported HR action.';
  end if;

  return jsonb_build_object('id',result_id,'module',target_module,'action',target_action,'status','completed');
end $$;

create or replace function public.service_get_hr_operational_options(
  target_actor_id uuid,
  target_module text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare employees_payload jsonb; references_payload jsonb := '[]'::jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  if target_module not in ('leave','benefits','talent','learning','cases','safety','assets','offboarding','self_service','reporting') then raise check_violation using message='Unsupported HR module.'; end if;
  perform private.hr_stage8_require_actor_permission(target_actor_id,'hr.people.view');
  select coalesce(jsonb_agg(jsonb_build_object('id',employee.id,'name',concat_ws(' ',employee.first_name,employee.last_name),'employeeNumber',employee.employee_number) order by employee.last_name,employee.first_name),'[]') into employees_payload
  from public.employees employee where employee.status in ('onboarding','active','leave');
  if target_module='learning' then
    select coalesce(jsonb_agg(jsonb_build_object('id',item.id,'label',item.title,'detail',item.code) order by item.title),'[]') into references_payload from private.hr_learning_items item where item.status='active';
  elsif target_module='assets' then
    select coalesce(jsonb_agg(jsonb_build_object('id',asset.id,'label',asset.name,'detail',asset.asset_tag) order by asset.asset_tag),'[]') into references_payload from private.hr_assets asset where asset.status='available';
  end if;
  return jsonb_build_object('employees',employees_payload,'references',references_payload);
end $$;

revoke all on function private.hr_operational_text(jsonb,text,text,integer,boolean) from public,anon,authenticated;
revoke all on function private.hr_operational_uuid(jsonb,text,text,boolean) from public,anon,authenticated;
revoke all on function private.hr_operational_date(jsonb,text,text,boolean) from public,anon,authenticated;
revoke all on function private.hr_operational_require_employee(uuid) from public,anon,authenticated;
revoke all on function public.service_hr_operational_action(uuid,text,text,jsonb,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.service_get_hr_operational_options(uuid,text) from public,anon,authenticated;
grant execute on function public.service_hr_operational_action(uuid,text,text,jsonb,text,text,timestamptz) to service_role;
grant execute on function public.service_get_hr_operational_options(uuid,text) to service_role;

do $$
declare release_actor_id uuid;
begin
  select account.employee_id into release_actor_id
  from private.employee_accounts account join public.employees employee on employee.id=account.employee_id
  where lower(employee.username)='jbrown' and account.disabled_at is null and employee.status='active' limit 1;
  if release_actor_id is null then raise check_violation using message='The authorized HR release owner was not found.'; end if;

  update private.hr_recruiting_release_gate set enabled=true,enabled_by=release_actor_id,enabled_at=clock_timestamp(),reason='Operational HR Suite release 09/03/2026',updated_at=clock_timestamp() where singleton;
  update private.hr_leave_release_gate set enabled=true,enabled_by=release_actor_id,enabled_at=clock_timestamp(),reason='Operational HR Suite release 09/03/2026',updated_at=clock_timestamp() where singleton;
  update private.hr_benefits_release_gate set enabled=true,enabled_by=release_actor_id,enabled_at=clock_timestamp(),reason='Operational HR Suite release 09/03/2026',updated_at=clock_timestamp() where singleton;
  update private.hr_stage8_release_gates set enabled=true,enabled_by=release_actor_id,enabled_at=clock_timestamp(),reason='Operational HR Suite release 09/03/2026',updated_at=clock_timestamp();
  update private.hr_stage9_release_gates set enabled=true,enabled_by=release_actor_id,enabled_at=clock_timestamp(),reason='Operational HR Suite release 09/03/2026',updated_at=clock_timestamp();
end $$;

do $$
declare baseline hris_operational_release_baseline%rowtype;
begin
  select * into baseline from hris_operational_release_baseline;
  if baseline.employee_count<>(select count(*) from public.employees)
    or baseline.role_assignment_count<>(select count(*) from public.employee_access_roles)
    or baseline.override_count<>(select count(*) from public.employee_permission_overrides)
    or baseline.leave_count<>(select count(*) from private.hr_leave_cases)
    or baseline.benefit_count<>(select count(*) from private.hr_benefit_plans)
    or baseline.talent_count<>(select count(*) from private.hr_talent_goals)
    or baseline.learning_count<>(select count(*) from private.hr_learning_items)
    or baseline.case_count<>(select count(*) from private.hr_cases)
    or baseline.safety_count<>(select count(*) from private.hr_safety_cases)
    or baseline.asset_count<>(select count(*) from private.hr_assets)
    or baseline.lifecycle_count<>(select count(*) from private.hr_lifecycle_cases)
    or baseline.request_count<>(select count(*) from private.hr_service_requests)
    or baseline.report_count<>(select count(*) from private.hr_report_definitions)
  then raise check_violation using message='HR operational release changed protected records unexpectedly.'; end if;
end $$;

commit;
