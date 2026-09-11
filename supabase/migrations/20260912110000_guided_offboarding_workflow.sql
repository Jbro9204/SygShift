begin;

-- One protected lifecycle case now owns separation and rehire coordination.
-- This migration adds workflow controls only; it does not create cases or
-- change any current employee, access, schedule, punch, or payroll record.

alter table private.hr_lifecycle_cases
  drop constraint if exists hr_lifecycle_case_status;
alter table private.hr_lifecycle_cases
  add constraint hr_lifecycle_case_status check (
    status in ('draft','pending_approval','approved','approved_scheduled','due','denied','in_progress','completed','canceled')
  );

alter table private.hr_lifecycle_cases
  add column if not exists lifecycle_type text,
  add column if not exists employee_username_snapshot text,
  add column if not exists completed_by uuid references public.employees(id) on delete restrict,
  add column if not exists canceled_by uuid references public.employees(id) on delete restrict,
  add column if not exists canceled_at timestamptz,
  add column if not exists execution_result jsonb;

update private.hr_lifecycle_cases
set lifecycle_type = case when case_type = 'rehire' then 'rehire' else 'involuntary_termination' end
where lifecycle_type is null;

update private.hr_lifecycle_cases
set
  completed_by = coalesce(completed_by, approved_by, requested_by),
  execution_result = coalesce(execution_result, jsonb_build_object('legacyCase', true, 'status', 'completed'))
where status = 'completed';

update private.hr_lifecycle_cases
set
  canceled_by = coalesce(canceled_by, approved_by, requested_by),
  canceled_at = coalesce(canceled_at, updated_at, created_at)
where status = 'canceled';

alter table private.hr_lifecycle_cases
  alter column lifecycle_type set not null;
alter table private.hr_lifecycle_cases
  add constraint hr_lifecycle_type check (
    lifecycle_type in ('voluntary_resignation','involuntary_termination','job_abandonment','end_of_assignment','rehire')
  ),
  add constraint hr_lifecycle_execution_result check (
    execution_result is null or jsonb_typeof(execution_result) = 'object'
  ),
  add constraint hr_lifecycle_cancel_consistent check (
    (status = 'canceled' and canceled_by is not null and canceled_at is not null)
    or (status <> 'canceled' and canceled_by is null and canceled_at is null)
  );

alter table private.hr_lifecycle_cases
  drop constraint if exists hr_lifecycle_case_decision;
alter table private.hr_lifecycle_cases
  add constraint hr_lifecycle_case_decision check (
    (
      status in ('approved','approved_scheduled','due','denied','in_progress','completed')
      and approved_by is not null
      and approved_at is not null
      and btrim(coalesce(decision_reason,'')) <> ''
    ) or status in ('draft','pending_approval','canceled')
  );

alter table private.hr_lifecycle_cases
  drop constraint if exists hr_lifecycle_case_completed;
alter table private.hr_lifecycle_cases
  add constraint hr_lifecycle_case_completed check (
    (status = 'completed' and completed_at is not null and completed_by is not null and execution_result is not null)
    or (status <> 'completed' and completed_at is null and completed_by is null)
  );

drop index if exists private.hr_lifecycle_one_open_case_per_type;
create unique index hr_lifecycle_one_open_case_per_type
  on private.hr_lifecycle_cases(employee_id, case_type)
  where status in ('draft','pending_approval','approved','approved_scheduled','due','in_progress');

alter table private.hr_lifecycle_tasks
  drop constraint if exists hr_lifecycle_task_workstream;
alter table private.hr_lifecycle_tasks
  add constraint hr_lifecycle_task_workstream check (
    workstream in (
      'timecard','payroll','payroll_final_pay','benefits','licensing','training','documents',
      'assets','schedule','client_site_notifications','communications','records_retention','account_access'
    )
  );

alter table private.hr_lifecycle_tasks
  add column if not exists evidence_note text;

create table if not exists private.hr_lifecycle_document_links (
  id uuid primary key default gen_random_uuid(),
  lifecycle_case_id uuid not null references private.hr_lifecycle_cases(id) on delete restrict,
  form_code text not null,
  source_document_id uuid references private.hr_documents(id) on delete restrict,
  status text not null default 'recommended',
  linked_by uuid not null references public.employees(id) on delete restrict,
  linked_at timestamptz not null default clock_timestamp(),
  constraint hr_lifecycle_document_code check (form_code ~ '^GS-HR-70[0-4]$'),
  constraint hr_lifecycle_document_status check (status in ('recommended','opened','assigned','completed','not_applicable')),
  unique(lifecycle_case_id, form_code)
);

create index if not exists hr_lifecycle_cases_effective_queue_idx
  on private.hr_lifecycle_cases(effective_on, status)
  where status in ('approved','approved_scheduled','due','in_progress');
create index if not exists hr_lifecycle_tasks_owner_due_idx
  on private.hr_lifecycle_tasks(assigned_to, due_on, status)
  where status not in ('completed','waived','canceled');

alter table private.hr_lifecycle_document_links enable row level security;
revoke all on private.hr_lifecycle_document_links from public, anon, authenticated;
grant select, insert, update on private.hr_lifecycle_document_links to service_role;

create or replace function private.hr_lifecycle_task_label(target_workstream text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case target_workstream
    when 'timecard' then 'Final timecard review'
    when 'payroll_final_pay' then 'Payroll and final pay'
    when 'benefits' then 'Benefits closeout'
    when 'licensing' then 'Licensing and credentials'
    when 'training' then 'Training records'
    when 'documents' then 'Documents and notices'
    when 'assets' then 'Property and equipment return'
    when 'schedule' then 'Schedule and coverage release'
    when 'client_site_notifications' then 'Client and site notifications'
    when 'communications' then 'Employee and internal communications'
    when 'records_retention' then 'Records retention review'
    when 'account_access' then 'Final account access shutdown'
    else initcap(replace(target_workstream, '_', ' '))
  end
$$;

create or replace function private.hr_lifecycle_default_forms(target_lifecycle_type text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case target_lifecycle_type
    when 'voluntary_resignation' then array['GS-HR-700','GS-HR-703','GS-HR-704']::text[]
    when 'job_abandonment' then array['GS-HR-701','GS-HR-704']::text[]
    when 'involuntary_termination' then array['GS-HR-702','GS-HR-704']::text[]
    when 'end_of_assignment' then array['GS-HR-702','GS-HR-704']::text[]
    else array['GS-HR-704']::text[]
  end
$$;

create or replace function public.service_create_hr_lifecycle_case(
  target_actor_id uuid,
  target_employee_id uuid,
  target_lifecycle_type text,
  target_effective_on date,
  target_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  case_id uuid;
  employee_record public.employees%rowtype;
  workstream text;
  current_form_code text;
  case_type_value text;
  clean_reason text := btrim(coalesce(target_reason, ''));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage9_assert_enabled('offboarding');
  perform private.hr_stage9_require_actor_permission(target_actor_id, 'hr.offboarding.manage');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'offboarding');

  if target_lifecycle_type not in ('voluntary_resignation','involuntary_termination','job_abandonment','end_of_assignment','rehire') then
    raise check_violation using message = 'Choose a supported employee lifecycle type.';
  end if;
  if target_effective_on is null then raise check_violation using message = 'Choose the effective date.'; end if;
  if char_length(clean_reason) < 10 or char_length(clean_reason) > 4000 then
    raise check_violation using message = 'Explain the request in 10 to 4,000 characters.';
  end if;

  select * into employee_record from public.employees employee where employee.id = target_employee_id for update;
  if employee_record.id is null then raise no_data_found using message = 'The selected employee was not found.'; end if;
  if target_lifecycle_type = 'rehire' and employee_record.status::text <> 'separated' then
    raise check_violation using message = 'A rehire case can only be opened for a separated employee.';
  end if;
  if target_lifecycle_type <> 'rehire' and employee_record.status::text = 'separated' then
    raise check_violation using message = 'This employee is already separated. Use the rehire workflow if they are returning.';
  end if;
  if target_lifecycle_type <> 'rehire' and target_actor_id = target_employee_id then
    raise insufficient_privilege using message = 'You cannot open your own separation case.';
  end if;

  case_type_value := case when target_lifecycle_type = 'rehire' then 'rehire' else 'separation' end;
  insert into private.hr_lifecycle_cases(
    employee_id, case_type, lifecycle_type, status, effective_on, requested_by,
    request_reason, employee_username_snapshot
  ) values (
    target_employee_id, case_type_value, target_lifecycle_type, 'pending_approval', target_effective_on,
    target_actor_id, clean_reason, employee_record.username
  ) returning id into case_id;

  foreach workstream in array array[
    'timecard','payroll_final_pay','benefits','licensing','training','documents','assets',
    'schedule','client_site_notifications','communications','records_retention','account_access'
  ] loop
    insert into private.hr_lifecycle_tasks(lifecycle_case_id, workstream, status, assigned_to, due_on)
    values (case_id, workstream, 'pending', target_actor_id, target_effective_on);
  end loop;

  foreach current_form_code in array private.hr_lifecycle_default_forms(target_lifecycle_type) loop
    insert into private.hr_lifecycle_document_links(lifecycle_case_id, form_code, source_document_id, linked_by)
    select case_id, current_form_code, library.source_document_id, target_actor_id
    from private.hr_template_library_items library
    where library.form_code = current_form_code
    on conflict(lifecycle_case_id, form_code) do nothing;
  end loop;

  insert into private.hr_lifecycle_events(lifecycle_case_id, action, actor_id, reason, details)
  values(case_id, 'submitted', target_actor_id, clean_reason,
    jsonb_build_object('lifecycleType', target_lifecycle_type, 'effectiveOn', target_effective_on));

  insert into public.employee_notifications(
    recipient_employee_id, sender_employee_id, source_type, source_id, source_key, title, body,
    priority, requires_acknowledgement, action_required, action_path, action_label
  )
  select employee.id, target_actor_id, 'hr_offboarding', case_id,
    concat('hr-offboarding:approval:', case_id, ':', employee.id),
    'Employee lifecycle approval needed',
    concat('Review the ', replace(target_lifecycle_type, '_', ' '), ' request for ', employee_record.first_name, ' ', employee_record.last_name, '.'),
    'important', true, true, concat('/hr/offboarding?case=', case_id), 'Review lifecycle case'
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and employee.id <> target_actor_id
    and 'hr.offboarding.approve' = any(coalesce(private.employee_effective_permissions(employee.id), array[]::text[]));

  return jsonb_build_object('id', case_id, 'status', 'pending_approval');
end
$$;

create or replace function public.service_get_hr_offboarding_options(target_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage9_assert_enabled('offboarding');
  perform private.hr_stage9_require_actor_permission(target_actor_id, 'hr.offboarding.view');
  return jsonb_build_object(
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'name', concat_ws(' ', employee.first_name, nullif(employee.middle_name,''), employee.last_name),
        'username', employee.username,
        'employeeNumber', employee.employee_number,
        'status', employee.status
      ) order by employee.last_name, employee.first_name, employee.id)
      from public.employees employee
      where employee.status in ('onboarding','active','leave','separated')
    ), '[]'::jsonb),
    'owners', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'name', concat_ws(' ', employee.first_name, employee.last_name)
      ) order by employee.last_name, employee.first_name, employee.id)
      from public.employees employee
      join private.employee_accounts account on account.employee_id = employee.id
      where employee.status = 'active' and account.disabled_at is null
        and 'hr.offboarding.view' = any(coalesce(private.employee_effective_permissions(employee.id), array[]::text[]))
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.service_get_hr_offboarding_workspace(
  target_actor_id uuid,
  target_page_size integer default 10,
  target_offset integer default 0,
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
  page_size integer := case when target_page_size in (5,10,20) then target_page_size else 10 end;
  row_offset integer := greatest(coalesce(target_offset,0),0);
  counts_payload jsonb;
  items_payload jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage9_assert_enabled('offboarding');
  perform private.hr_stage9_require_actor_permission(target_actor_id, 'hr.offboarding.view');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'offboarding');

  counts_payload := jsonb_build_object(
    'primary', (select count(*) from private.hr_lifecycle_cases where status in ('draft','pending_approval','approved','approved_scheduled','due','in_progress')),
    'secondary', (select count(*) from private.hr_lifecycle_cases where status = 'pending_approval'),
    'tertiary', (select count(*) from private.hr_lifecycle_tasks where status in ('pending','ready','in_progress','blocked'))
  );
  select coalesce(jsonb_agg(queue_item.payload order by queue_item.sort_at desc), '[]'::jsonb)
  into items_payload
  from (
    select
      lifecycle.updated_at as sort_at,
      jsonb_build_object(
        'id', lifecycle.id,
        'title', concat_ws(' ', employee.first_name, nullif(employee.middle_name,''), employee.last_name),
        'subtitle', initcap(replace(lifecycle.lifecycle_type, '_', ' ')),
        'status', case
          when lifecycle.status in ('approved','approved_scheduled','in_progress')
            and lifecycle.effective_on <= (clock_timestamp() at time zone 'America/Denver')::date then 'due'
          else lifecycle.status
        end,
        'dateLabel', lifecycle.effective_on,
        'detail', lifecycle.request_reason
      ) as payload
    from private.hr_lifecycle_cases lifecycle
    join public.employees employee on employee.id = lifecycle.employee_id
    order by lifecycle.updated_at desc, lifecycle.id desc
    limit page_size offset row_offset
  ) queue_item;

  return jsonb_build_object(
    'enabled', true,
    'module', 'offboarding',
    'pageSize', page_size,
    'offset', row_offset,
    'counts', counts_payload,
    'items', items_payload
  );
end
$$;

create or replace function public.service_review_hr_lifecycle_case(
  target_actor_id uuid,
  target_case_id uuid,
  target_decision text,
  target_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  case_record private.hr_lifecycle_cases%rowtype;
  clean_reason text := btrim(coalesce(target_reason, ''));
  next_status text;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage9_assert_enabled('offboarding');
  perform private.hr_stage9_require_actor_permission(target_actor_id, 'hr.offboarding.approve');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'offboarding');
  if target_decision not in ('approved','denied') then raise check_violation using message = 'Choose Approve or Deny.'; end if;
  if char_length(clean_reason) < 10 or char_length(clean_reason) > 4000 then raise check_violation using message = 'Explain the decision in 10 to 4,000 characters.'; end if;

  select * into case_record from private.hr_lifecycle_cases lifecycle where lifecycle.id = target_case_id for update;
  if case_record.id is null or case_record.status <> 'pending_approval' then raise check_violation using message = 'This case is no longer awaiting approval.'; end if;
  if case_record.requested_by = target_actor_id then raise insufficient_privilege using message = 'A different qualified person must review this case.'; end if;

  next_status := case when target_decision = 'denied' then 'denied' else 'approved_scheduled' end;
  update private.hr_lifecycle_cases
  set status = next_status, approved_by = target_actor_id, approved_at = clock_timestamp(),
      decision_reason = clean_reason, updated_at = clock_timestamp()
  where id = target_case_id;
  if target_decision = 'approved' then
    update private.hr_lifecycle_tasks set status = 'ready', updated_at = clock_timestamp()
    where lifecycle_case_id = target_case_id and status = 'pending';
  else
    update private.hr_lifecycle_tasks set status = 'canceled', updated_at = clock_timestamp()
    where lifecycle_case_id = target_case_id and status not in ('completed','waived','canceled');
  end if;

  insert into private.hr_lifecycle_approvals(lifecycle_case_id, decision, decided_by, reason)
  values(target_case_id, target_decision, target_actor_id, clean_reason);
  insert into private.hr_lifecycle_events(lifecycle_case_id, action, actor_id, reason, details)
  values(target_case_id, target_decision, target_actor_id, clean_reason, jsonb_build_object('status', next_status));

  update public.employee_notifications set resolved_at = clock_timestamp(), action_required = false
  where source_id = target_case_id and source_type = 'hr_offboarding' and source_key like 'hr-offboarding:approval:%';
  perform private.create_employee_notification(
    case_record.requested_by, 'hr_offboarding', target_case_id,
    concat('hr-offboarding:decision:', target_case_id, ':', case_record.requested_by),
    case when target_decision = 'approved' then 'Employee lifecycle case approved' else 'Employee lifecycle case denied' end,
    concat('The lifecycle case was ', target_decision, '. Open the case for the recorded decision and next steps.'),
    case when target_decision = 'approved' then 'important' else 'routine' end,
    false, concat('/hr/offboarding?case=', target_case_id), 'Open lifecycle case', target_actor_id
  );
  return jsonb_build_object('id', target_case_id, 'status', next_status);
end
$$;

create or replace function public.service_update_hr_lifecycle_task(
  target_actor_id uuid,
  target_task_id uuid,
  target_status text,
  target_assigned_to uuid,
  target_due_on date,
  target_note text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  task_record private.hr_lifecycle_tasks%rowtype;
  clean_note text := nullif(btrim(coalesce(target_note, '')), '');
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage9_assert_enabled('offboarding');
  perform private.hr_stage9_require_actor_permission(target_actor_id, 'hr.offboarding.manage');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'offboarding');
  if target_status not in ('ready','in_progress','blocked','completed','waived') then raise check_violation using message = 'Choose a supported checklist status.'; end if;
  if target_status in ('completed','waived') and char_length(coalesce(clean_note,'')) < 3 then
    raise check_violation using message = 'Completion evidence or a waiver reason is required.';
  end if;
  if target_assigned_to is not null and not exists(
    select 1 from public.employees employee join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_assigned_to and employee.status = 'active' and account.disabled_at is null
  ) then raise check_violation using message = 'Choose an active checklist owner.'; end if;

  select * into task_record from private.hr_lifecycle_tasks task where task.id = target_task_id for update;
  if task_record.id is null then raise no_data_found using message = 'The checklist item was not found.'; end if;
  if not exists(select 1 from private.hr_lifecycle_cases lifecycle where lifecycle.id = task_record.lifecycle_case_id and lifecycle.status in ('approved','approved_scheduled','due','in_progress')) then
    raise check_violation using message = 'Checklist work is available only after approval and before final completion.';
  end if;

  update private.hr_lifecycle_tasks
  set status = target_status,
      assigned_to = coalesce(target_assigned_to, assigned_to, target_actor_id),
      due_on = coalesce(target_due_on, due_on),
      completion_note = case when target_status in ('completed','waived') then clean_note else null end,
      evidence_note = clean_note,
      completed_by = case when target_status in ('completed','waived') then target_actor_id else null end,
      completed_at = case when target_status in ('completed','waived') then clock_timestamp() else null end,
      updated_at = clock_timestamp()
  where id = target_task_id;
  update private.hr_lifecycle_cases set status = 'in_progress', updated_at = clock_timestamp()
  where id = task_record.lifecycle_case_id and status in ('approved','approved_scheduled','due') and target_status in ('in_progress','blocked','completed','waived');
  insert into private.hr_lifecycle_events(lifecycle_case_id, action, actor_id, reason, details)
  values(task_record.lifecycle_case_id, 'checklist_updated', target_actor_id,
    coalesce(clean_note, concat(private.hr_lifecycle_task_label(task_record.workstream), ' moved to ', target_status, '.')),
    jsonb_build_object('taskId', target_task_id, 'workstream', task_record.workstream, 'status', target_status,
      'assignedTo', target_assigned_to, 'dueOn', target_due_on));
  return jsonb_build_object('id', target_task_id, 'status', target_status);
end
$$;

create or replace function public.service_cancel_hr_lifecycle_case(
  target_actor_id uuid,
  target_case_id uuid,
  target_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare clean_reason text := btrim(coalesce(target_reason, ''));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage9_assert_enabled('offboarding');
  perform private.hr_stage9_require_actor_permission(target_actor_id, 'hr.offboarding.manage');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'offboarding');
  if char_length(clean_reason) < 10 or char_length(clean_reason) > 4000 then raise check_violation using message = 'Explain the cancellation in 10 to 4,000 characters.'; end if;
  update private.hr_lifecycle_cases
  set status = 'canceled', canceled_by = target_actor_id, canceled_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = target_case_id and status in ('draft','pending_approval','approved','approved_scheduled','due','in_progress');
  if not found then raise check_violation using message = 'This case can no longer be canceled.'; end if;
  update private.hr_lifecycle_tasks set status = 'canceled', updated_at = clock_timestamp()
  where lifecycle_case_id = target_case_id and status not in ('completed','waived','canceled');
  insert into private.hr_lifecycle_events(lifecycle_case_id, action, actor_id, reason, details)
  values(target_case_id, 'canceled', target_actor_id, clean_reason, '{}'::jsonb);
  update public.employee_notifications set resolved_at = clock_timestamp(), action_required = false
  where source_id = target_case_id and source_type = 'hr_offboarding';
  return jsonb_build_object('id', target_case_id, 'status', 'canceled');
end
$$;

create or replace function public.service_execute_hr_lifecycle_case(
  target_actor_id uuid,
  target_case_id uuid,
  target_confirmation_username text,
  target_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  case_record private.hr_lifecycle_cases%rowtype;
  employee_record public.employees%rowtype;
  clean_reason text := btrim(coalesce(target_reason, ''));
  result jsonb;
  active_authorization_id uuid;
  changed_at timestamptz := clock_timestamp();
  operational_today date := (clock_timestamp() at time zone 'America/Denver')::date;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage9_assert_enabled('offboarding');
  perform private.hr_stage9_require_actor_permission(target_actor_id, 'hr.offboarding.approve');
  perform private.hr_stage9_require_actor_permission(target_actor_id, 'hr.people.manage');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'offboarding');
  if char_length(clean_reason) < 10 or char_length(clean_reason) > 1000 then raise check_violation using message = 'Explain final execution in 10 to 1,000 characters.'; end if;

  perform pg_advisory_xact_lock(hashtextextended('hr-lifecycle-execution:' || target_case_id::text, 0));
  select * into case_record from private.hr_lifecycle_cases lifecycle where lifecycle.id = target_case_id for update;
  if case_record.id is null or case_record.status not in ('approved','approved_scheduled','due','in_progress') then raise check_violation using message = 'This case is not approved for final execution.'; end if;
  if case_record.effective_on > operational_today then raise check_violation using message = 'Final execution becomes available on the approved effective date.'; end if;
  if exists(select 1 from private.hr_lifecycle_tasks task where task.lifecycle_case_id = target_case_id and task.status not in ('completed','waived','canceled')) then
    raise check_violation using message = 'Complete or formally waive every required checklist item before final execution.';
  end if;
  select * into employee_record from public.employees employee where employee.id = case_record.employee_id for update;
  if employee_record.id is null then raise no_data_found using message = 'The employee record was not found.'; end if;
  if target_actor_id = employee_record.id and case_record.case_type = 'separation' then raise insufficient_privilege using message = 'You cannot terminate your own employment record.'; end if;
  if lower(btrim(coalesce(target_confirmation_username,''))) <> lower(employee_record.username) then raise check_violation using message = 'Enter the employee username exactly to confirm final execution.'; end if;

  if case_record.case_type = 'separation' then
    if employee_record.role::text = 'admin' and not exists (
      select 1
      from public.employees actor
      where actor.id = target_actor_id
        and actor.role::text = 'admin'
        and actor.status::text = 'active'
    ) then
      raise insufficient_privilege using message = 'Only an Admin can complete an Admin separation.';
    end if;
    result := private.separate_employee_account_and_future_work(case_record.employee_id, target_actor_id, clean_reason, case_record.effective_on);
    if employee_record.hired_on is not null then
      select prior_authorization.id into active_authorization_id
      from private.hr_stage2_effective_date_authorizations prior_authorization
      where prior_authorization.employee_id = case_record.employee_id
        and not exists(select 1 from private.hr_stage2_effective_date_authorizations replacement where replacement.supersedes_id = prior_authorization.id)
      order by prior_authorization.authorized_at desc, prior_authorization.id desc limit 1;
      insert into private.hr_stage2_effective_date_authorizations(
        employee_id, hired_on, separated_on, source_type, source_reference, reason,
        source_status, authorized_by, authorized_at, supersedes_id
      ) values (
        case_record.employee_id, employee_record.hired_on, case_record.effective_on, 'offboarding_case',
        concat('Lifecycle case ', target_case_id), clean_reason, 'separated', target_actor_id, changed_at,
        active_authorization_id
      );
    end if;
    result := result || jsonb_build_object('status','separated','accessRestored',false);
  else
    if employee_record.status::text <> 'separated' then raise check_violation using message = 'Only a separated employee can complete a rehire workflow.'; end if;
    update public.employees set status = 'onboarding', separated_on = null, updated_at = changed_at where id = case_record.employee_id;
    -- Account, role assignments, overrides, MFA devices, pay, licenses, and schedules remain inactive.
    result := jsonb_build_object(
      'employeeId', case_record.employee_id, 'status', 'onboarding', 'accessRestored', false,
      'nextStep', 'Complete onboarding and explicitly approve new access in User Accounts.'
    );
  end if;

  update private.hr_lifecycle_cases
  set status = 'completed', completed_by = target_actor_id, completed_at = changed_at,
      execution_result = result, updated_at = changed_at
  where id = target_case_id;
  insert into private.hr_lifecycle_events(lifecycle_case_id, action, actor_id, reason, details)
  values(target_case_id, 'completed', target_actor_id, clean_reason, result);
  update public.employee_notifications set resolved_at = changed_at, action_required = false
  where source_id = target_case_id and source_type = 'hr_offboarding';
  return result || jsonb_build_object('id', target_case_id, 'completedAt', changed_at);
end
$$;

create or replace function public.service_get_hr_lifecycle_case(
  target_actor_id uuid,
  target_case_id uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  can_manage boolean;
  can_approve boolean;
  can_execute boolean;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_stage9_assert_enabled('offboarding');
  perform private.hr_stage9_require_actor_permission(target_actor_id, 'hr.offboarding.view');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'offboarding');
  can_manage := 'hr.offboarding.manage' = any(coalesce(private.employee_effective_permissions(target_actor_id), array[]::text[]));
  can_approve := 'hr.offboarding.approve' = any(coalesce(private.employee_effective_permissions(target_actor_id), array[]::text[]));
  can_execute := can_approve and 'hr.people.manage' = any(coalesce(private.employee_effective_permissions(target_actor_id), array[]::text[]));

  select jsonb_build_object(
    'case', jsonb_build_object(
      'id', lifecycle.id,
      'employeeId', lifecycle.employee_id,
      'employeeName', concat_ws(' ', employee.first_name, nullif(employee.middle_name,''), employee.last_name),
      'username', employee.username,
      'employeeRole', employee.role,
      'caseType', lifecycle.case_type,
      'lifecycleType', lifecycle.lifecycle_type,
      'status', case when lifecycle.status in ('approved','approved_scheduled','in_progress') and lifecycle.effective_on <= (clock_timestamp() at time zone 'America/Denver')::date then 'due' else lifecycle.status end,
      'storedStatus', lifecycle.status,
      'effectiveOn', lifecycle.effective_on,
      'requestReason', lifecycle.request_reason,
      'requestedById', lifecycle.requested_by,
      'requestedByName', concat_ws(' ', requester.first_name, requester.last_name),
      'requestedAt', lifecycle.created_at,
      'approvedByName', concat_ws(' ', approver.first_name, approver.last_name),
      'approvedAt', lifecycle.approved_at,
      'decisionReason', lifecycle.decision_reason,
      'completedByName', concat_ws(' ', completer.first_name, completer.last_name),
      'completedAt', lifecycle.completed_at,
      'executionResult', lifecycle.execution_result,
      'canManage', can_manage and lifecycle.status not in ('completed','denied','canceled'),
      'canReview', can_approve and lifecycle.status = 'pending_approval' and lifecycle.requested_by <> target_actor_id,
      'canExecute', can_execute and lifecycle.status in ('approved','approved_scheduled','due','in_progress') and lifecycle.effective_on <= (clock_timestamp() at time zone 'America/Denver')::date,
      'canCancel', can_manage and lifecycle.status in ('draft','pending_approval','approved','approved_scheduled','due','in_progress')
    ),
    'progress', jsonb_build_object(
      'total', (select count(*) from private.hr_lifecycle_tasks task where task.lifecycle_case_id = lifecycle.id and task.status <> 'canceled'),
      'done', (select count(*) from private.hr_lifecycle_tasks task where task.lifecycle_case_id = lifecycle.id and task.status in ('completed','waived'))
    ),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', task.id, 'workstream', task.workstream, 'label', private.hr_lifecycle_task_label(task.workstream),
        'status', task.status, 'assignedTo', task.assigned_to,
        'assignedToName', concat_ws(' ', owner.first_name, owner.last_name), 'dueOn', task.due_on,
        'completionNote', task.completion_note, 'evidenceNote', task.evidence_note,
        'completedByName', concat_ws(' ', finisher.first_name, finisher.last_name), 'completedAt', task.completed_at
      ) order by task.created_at, task.id)
      from private.hr_lifecycle_tasks task
      left join public.employees owner on owner.id = task.assigned_to
      left join public.employees finisher on finisher.id = task.completed_by
      where task.lifecycle_case_id = lifecycle.id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', event.id, 'action', event.action, 'actorName', concat_ws(' ', actor.first_name, actor.last_name),
        'reason', event.reason, 'details', event.details, 'occurredAt', event.occurred_at
      ) order by event.occurred_at desc, event.id desc)
      from private.hr_lifecycle_events event join public.employees actor on actor.id = event.actor_id
      where event.lifecycle_case_id = lifecycle.id
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', link.id, 'formCode', link.form_code, 'title', library.title,
        'sensitivity', library.sensitivity, 'status', link.status,
        'sourceDocumentId', coalesce(link.source_document_id, library.source_document_id),
        'available', coalesce(link.source_document_id, library.source_document_id) is not null
      ) order by link.form_code)
      from private.hr_lifecycle_document_links link
      join private.hr_template_library_items library on library.form_code = link.form_code
      where link.lifecycle_case_id = lifecycle.id
    ), '[]'::jsonb),
    'conditions', jsonb_build_object(
      'futureAssignments', (select count(*) from public.shift_assignments assignment join public.shifts shift on shift.id = assignment.shift_id where assignment.employee_id = lifecycle.employee_id and assignment.status in ('assigned','confirmed') and shift.canceled_at is null and (shift.starts_at at time zone shift.time_zone)::date >= (clock_timestamp() at time zone 'America/Denver')::date),
      'pendingCorrections', (select count(*) from public.time_event_corrections correction join public.time_events event on event.id = correction.time_event_id where event.employee_id = lifecycle.employee_id and correction.approved_at is null and correction.declined_at is null),
      'assignedAssets', (select count(*) from private.hr_asset_assignments assignment where assignment.employee_id = lifecycle.employee_id and assignment.status = 'active'),
      'activeEmployeeCases', (select count(*) from private.hr_cases employee_case where employee_case.subject_employee_id = lifecycle.employee_id and employee_case.status in ('open','triage','investigating','pending')),
      'onLeave', employee.status::text = 'leave'
    )
  ) into result
  from private.hr_lifecycle_cases lifecycle
  join public.employees employee on employee.id = lifecycle.employee_id
  join public.employees requester on requester.id = lifecycle.requested_by
  left join public.employees approver on approver.id = lifecycle.approved_by
  left join public.employees completer on completer.id = lifecycle.completed_by
  where lifecycle.id = target_case_id;
  if result is null then raise no_data_found using message = 'The employee lifecycle case was not found.'; end if;
  return result;
end
$$;

create or replace function public.service_refresh_hr_offboarding_due_cases()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  case_record record;
  recipient record;
  due_count integer := 0;
  notification_count integer := 0;
  notification_id uuid;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  for case_record in
    update private.hr_lifecycle_cases lifecycle
    set status = 'due', updated_at = clock_timestamp()
    where lifecycle.status in ('approved','approved_scheduled')
      and lifecycle.effective_on <= (clock_timestamp() at time zone 'America/Denver')::date
    returning lifecycle.*
  loop
    due_count := due_count + 1;
    insert into private.hr_lifecycle_events(lifecycle_case_id, action, actor_id, reason, details)
    values(case_record.id, 'due', coalesce(case_record.approved_by, case_record.requested_by),
      'The approved effective date has arrived; final human review and execution are required.',
      jsonb_build_object('effectiveOn', case_record.effective_on, 'systemGenerated', true));
    for recipient in
      select employee.id
      from public.employees employee join private.employee_accounts account on account.employee_id = employee.id
      where employee.status = 'active' and account.disabled_at is null
        and 'hr.people.manage' = any(coalesce(private.employee_effective_permissions(employee.id), array[]::text[]))
        and 'hr.offboarding.approve' = any(coalesce(private.employee_effective_permissions(employee.id), array[]::text[]))
    loop
      insert into public.employee_notifications(
        recipient_employee_id, sender_employee_id, source_type, source_id, source_key, title, body,
        priority, requires_acknowledgement, action_required, action_path, action_label
      ) values (
        recipient.id, case_record.approved_by, 'hr_offboarding', case_record.id,
        concat('hr-offboarding:due:', case_record.id, ':', recipient.id),
        'Employee offboarding is due',
        'The effective date has arrived. Complete or waive every checklist item, then perform the final human-confirmed action.',
        'urgent', true, true, concat('/hr/offboarding?case=', case_record.id), 'Complete offboarding'
      ) on conflict(source_key) do nothing returning id into notification_id;
      if notification_id is not null then notification_count := notification_count + 1; end if;
      notification_id := null;
    end loop;
  end loop;
  return jsonb_build_object('dueCases', due_count, 'notificationsCreated', notification_count);
end
$$;

revoke all on function private.hr_lifecycle_task_label(text) from public, anon, authenticated;
revoke all on function private.hr_lifecycle_default_forms(text) from public, anon, authenticated;
revoke all on function public.service_create_hr_lifecycle_case(uuid,uuid,text,date,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.service_get_hr_offboarding_options(uuid) from public, anon, authenticated;
revoke all on function public.service_get_hr_offboarding_workspace(uuid,integer,integer,text,timestamptz) from public, anon, authenticated;
revoke all on function public.service_review_hr_lifecycle_case(uuid,uuid,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.service_update_hr_lifecycle_task(uuid,uuid,text,uuid,date,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.service_cancel_hr_lifecycle_case(uuid,uuid,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.service_execute_hr_lifecycle_case(uuid,uuid,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.service_get_hr_lifecycle_case(uuid,uuid,text,timestamptz) from public, anon, authenticated;
revoke all on function public.service_refresh_hr_offboarding_due_cases() from public, anon, authenticated;

grant execute on function private.hr_lifecycle_task_label(text) to service_role;
grant execute on function private.hr_lifecycle_default_forms(text) to service_role;
grant execute on function public.service_create_hr_lifecycle_case(uuid,uuid,text,date,text,text,timestamptz) to service_role;
grant execute on function public.service_get_hr_offboarding_options(uuid) to service_role;
grant execute on function public.service_get_hr_offboarding_workspace(uuid,integer,integer,text,timestamptz) to service_role;
grant execute on function public.service_review_hr_lifecycle_case(uuid,uuid,text,text,text,timestamptz) to service_role;
grant execute on function public.service_update_hr_lifecycle_task(uuid,uuid,text,uuid,date,text,text,timestamptz) to service_role;
grant execute on function public.service_cancel_hr_lifecycle_case(uuid,uuid,text,text,timestamptz) to service_role;
grant execute on function public.service_execute_hr_lifecycle_case(uuid,uuid,text,text,text,timestamptz) to service_role;
grant execute on function public.service_get_hr_lifecycle_case(uuid,uuid,text,timestamptz) to service_role;
grant execute on function public.service_refresh_hr_offboarding_due_cases() to service_role;

notify pgrst, 'reload schema';
commit;
