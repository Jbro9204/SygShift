begin;

create temporary table guided_corrective_action_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from private.hr_cases) as case_count,
  (select count(*) from private.hr_case_notes) as case_note_count,
  (select count(*) from private.hr_case_evidence) as case_evidence_count,
  (select count(*) from private.hr_documents) as document_count,
  (select count(*) from public.employee_access_roles) as role_assignment_count,
  (select count(*) from public.employee_permission_overrides) as permission_override_count;

create table private.hr_corrective_actions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null unique references private.hr_cases(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  action_level text not null,
  title text not null,
  occurred_on date not null,
  factual_summary text not null,
  policy_expectation text not null,
  improvement_expectation text not null,
  follow_up_on date,
  status text not null default 'pending_hr_review',
  proposed_by uuid not null references public.employees(id) on delete restrict,
  proposed_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.employees(id) on delete restrict,
  reviewed_at timestamptz,
  review_reason text,
  delivered_by uuid references public.employees(id) on delete restrict,
  delivered_at timestamptz,
  response_due_at timestamptz,
  closed_by uuid references public.employees(id) on delete restrict,
  closed_at timestamptz,
  closure_reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_corrective_action_level check (action_level in ('coaching', 'written_warning', 'final_warning', 'performance_improvement')),
  constraint hr_corrective_action_title check (btrim(title) <> '' and char_length(title) <= 200),
  constraint hr_corrective_action_facts check (char_length(btrim(factual_summary)) between 8 and 10000),
  constraint hr_corrective_action_policy check (char_length(btrim(policy_expectation)) between 8 and 6000),
  constraint hr_corrective_action_improvement check (char_length(btrim(improvement_expectation)) between 8 and 6000),
  constraint hr_corrective_action_dates check (follow_up_on is null or follow_up_on >= occurred_on),
  constraint hr_corrective_action_status check (status in ('pending_hr_review', 'approved', 'delivered', 'employee_responded', 'closed', 'canceled')),
  constraint hr_corrective_action_review check (
    (status = 'pending_hr_review' and reviewed_by is null and reviewed_at is null and review_reason is null)
    or (status <> 'pending_hr_review' and reviewed_by is not null and reviewed_at is not null and btrim(coalesce(review_reason, '')) <> '')
  ),
  constraint hr_corrective_action_delivery check (
    (status in ('pending_hr_review', 'approved', 'canceled') and delivered_by is null and delivered_at is null and response_due_at is null)
    or (status in ('delivered', 'employee_responded', 'closed') and delivered_by is not null and delivered_at is not null and response_due_at is not null)
  ),
  constraint hr_corrective_action_closure check (
    (status <> 'closed' and closed_by is null and closed_at is null and closure_reason is null)
    or (status = 'closed' and closed_by is not null and closed_at is not null and btrim(coalesce(closure_reason, '')) <> '')
  )
);

create index hr_corrective_actions_employee_status_idx
  on private.hr_corrective_actions(employee_id, status, response_due_at, updated_at desc);

create table private.hr_corrective_action_responses (
  id uuid primary key default gen_random_uuid(),
  corrective_action_id uuid not null unique references private.hr_corrective_actions(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  response_type text not null,
  statement text,
  receipt_wording text not null,
  responded_at timestamptz not null default clock_timestamp(),
  constraint hr_corrective_action_response_type check (response_type in ('acknowledged_receipt', 'employee_response', 'dispute', 'declined_acknowledgment')),
  constraint hr_corrective_action_response_statement check (
    (response_type = 'acknowledged_receipt' and statement is null)
    or (response_type <> 'acknowledged_receipt' and char_length(btrim(coalesce(statement, ''))) between 8 and 10000)
  ),
  constraint hr_corrective_action_receipt_wording check (btrim(receipt_wording) = 'I acknowledge receipt of this record. My acknowledgment confirms receipt and review; it does not mean that I agree with the record.')
);

create table private.hr_corrective_action_events (
  id uuid primary key default gen_random_uuid(),
  corrective_action_id uuid not null references private.hr_corrective_actions(id) on delete restrict,
  action text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_corrective_action_event_action check (action in ('submitted', 'approved', 'canceled', 'delivered', 'acknowledged_receipt', 'employee_response', 'dispute', 'declined_acknowledgment', 'closed')),
  constraint hr_corrective_action_event_reason check (btrim(reason) <> '' and char_length(reason) <= 10000),
  constraint hr_corrective_action_event_details check (jsonb_typeof(details) = 'object')
);

alter table private.hr_corrective_actions enable row level security;
alter table private.hr_corrective_action_responses enable row level security;
alter table private.hr_corrective_action_events enable row level security;
revoke all on private.hr_corrective_actions, private.hr_corrective_action_responses, private.hr_corrective_action_events from public, anon, authenticated;
grant select, insert, update on private.hr_corrective_actions to service_role;
grant select, insert on private.hr_corrective_action_responses, private.hr_corrective_action_events to service_role;

create trigger hr_corrective_action_responses_append_only
before update or delete on private.hr_corrective_action_responses
for each row execute function private.prevent_append_only_change();

create trigger hr_corrective_action_events_append_only
before update or delete on private.hr_corrective_action_events
for each row execute function private.prevent_append_only_change();

create or replace function public.service_get_guided_corrective_actions(
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
  page_size integer := least(greatest(coalesce(target_page_size, 10), 5), 20);
  row_offset integer := greatest(coalesce(target_offset, 0), 0);
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  perform private.hr_stage8_assert_enabled('cases');
  perform private.hr_stage8_require_actor_permission(target_actor_id, 'hr.cases.view');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'cases');

  return jsonb_build_object(
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'name', concat_ws(' ', employee.first_name, employee.last_name),
        'employeeNumber', employee.employee_number
      ) order by employee.last_name, employee.first_name)
      from public.employees employee
      where employee.status in ('onboarding', 'active', 'leave')
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'pendingReview', (select count(*) from private.hr_corrective_actions action where action.status = 'pending_hr_review'),
      'readyToDeliver', (select count(*) from private.hr_corrective_actions action where action.status = 'approved'),
      'awaitingEmployee', (select count(*) from private.hr_corrective_actions action where action.status = 'delivered'),
      'followUpDue', (select count(*) from private.hr_corrective_actions action where action.status in ('employee_responded', 'delivered') and action.follow_up_on is not null and action.follow_up_on <= (clock_timestamp() at time zone 'America/Denver')::date)
    ),
    'pageSize', page_size,
    'offset', row_offset,
    'total', (select count(*) from private.hr_corrective_actions),
    'items', coalesce((
      select jsonb_agg(item.payload order by item.sort_at desc)
      from (
        select
          action.updated_at as sort_at,
          jsonb_build_object(
            'id', action.id,
            'caseId', action.case_id,
            'caseNumber', case_record.case_number,
            'employeeId', action.employee_id,
            'employeeName', concat_ws(' ', employee.first_name, employee.last_name),
            'employeeNumber', employee.employee_number,
            'actionLevel', action.action_level,
            'title', action.title,
            'occurredOn', action.occurred_on,
            'factualSummary', action.factual_summary,
            'policyExpectation', action.policy_expectation,
            'improvementExpectation', action.improvement_expectation,
            'followUpOn', action.follow_up_on,
            'status', action.status,
            'proposedById', action.proposed_by,
            'proposedByName', concat_ws(' ', proposer.first_name, proposer.last_name),
            'proposedAt', action.proposed_at,
            'reviewedByName', case when reviewer.id is null then null else concat_ws(' ', reviewer.first_name, reviewer.last_name) end,
            'reviewedAt', action.reviewed_at,
            'reviewReason', action.review_reason,
            'deliveredAt', action.delivered_at,
            'responseDueAt', action.response_due_at,
            'response', case when response.id is null then null else jsonb_build_object(
              'type', response.response_type,
              'statement', response.statement,
              'respondedAt', response.responded_at
            ) end,
            'events', coalesce((select jsonb_agg(jsonb_build_object(
              'id', event.id,
              'action', event.action,
              'actorName', concat_ws(' ', actor.first_name, actor.last_name),
              'reason', event.reason,
              'occurredAt', event.occurred_at
            ) order by event.occurred_at desc) from private.hr_corrective_action_events event join public.employees actor on actor.id = event.actor_id where event.corrective_action_id = action.id), '[]'::jsonb)
          ) as payload
        from private.hr_corrective_actions action
        join private.hr_cases case_record on case_record.id = action.case_id
        join public.employees employee on employee.id = action.employee_id
        join public.employees proposer on proposer.id = action.proposed_by
        left join public.employees reviewer on reviewer.id = action.reviewed_by
        left join private.hr_corrective_action_responses response on response.corrective_action_id = action.id
        order by action.updated_at desc
        limit page_size offset row_offset
      ) item
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.service_create_guided_corrective_action(
  target_actor_id uuid,
  target_payload jsonb,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb := coalesce(target_payload, '{}'::jsonb);
  employee_id uuid := private.hr_operational_uuid(payload, 'employeeId', 'Employee');
  case_id uuid;
  action_id uuid;
  case_title text := private.hr_operational_text(payload, 'title', 'Title', 200);
  action_level text := private.hr_operational_text(payload, 'actionLevel', 'Action level', 40);
  factual_summary text := private.hr_operational_text(payload, 'factualSummary', 'Factual summary', 10000);
  policy_expectation text := private.hr_operational_text(payload, 'policyExpectation', 'Policy or expectation', 6000);
  improvement_expectation text := private.hr_operational_text(payload, 'improvementExpectation', 'Improvement expectation', 6000);
  occurred_on date := private.hr_operational_date(payload, 'occurredOn', 'Occurrence date');
  follow_up_on date := private.hr_operational_date(payload, 'followUpOn', 'Follow-up date', false);
  clean_reason text := private.hr_operational_text(payload, 'submissionReason', 'Submission reason', 4000);
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  perform private.hr_stage8_assert_enabled('cases');
  perform private.hr_stage8_require_actor_permission(target_actor_id, 'hr.cases.manage');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'cases');
  perform private.hr_operational_require_employee(employee_id);
  if action_level not in ('coaching', 'written_warning', 'final_warning', 'performance_improvement') then raise check_violation using message = 'Choose a supported corrective-action level.'; end if;
  if char_length(factual_summary) < 8 or char_length(policy_expectation) < 8 or char_length(improvement_expectation) < 8 then raise check_violation using message = 'Facts, expectations, and next steps each need at least 8 characters.'; end if;
  if follow_up_on is not null and follow_up_on < occurred_on then raise check_violation using message = 'Follow-up cannot be before the occurrence date.'; end if;

  insert into private.hr_cases(subject_employee_id, case_type, title, status, priority, owner_id, opened_by)
  values (employee_id, 'corrective_action', case_title, 'pending', case when action_level in ('final_warning', 'performance_improvement') then 'high' else 'normal' end, target_actor_id, target_actor_id)
  returning id into case_id;

  insert into private.hr_corrective_actions(case_id, employee_id, action_level, title, occurred_on, factual_summary, policy_expectation, improvement_expectation, follow_up_on, proposed_by)
  values (case_id, employee_id, action_level, case_title, occurred_on, factual_summary, policy_expectation, improvement_expectation, follow_up_on, target_actor_id)
  returning id into action_id;

  insert into private.hr_case_participants(case_id, employee_id, participant_role, added_by)
  values (case_id, employee_id, 'subject', target_actor_id), (case_id, target_actor_id, 'owner', target_actor_id);
  insert into private.hr_case_events(case_id, action, actor_id, reason, details)
  values (case_id, 'corrective_action_submitted', target_actor_id, clean_reason, jsonb_build_object('correctiveActionId', action_id,'actionLevel',action_level));
  insert into private.hr_corrective_action_events(corrective_action_id, action, actor_id, reason, details)
  values (action_id, 'submitted', target_actor_id, clean_reason, jsonb_build_object('caseId',case_id,'actionLevel',action_level));
  return jsonb_build_object('id', action_id, 'caseId', case_id, 'status', 'pending_hr_review');
end
$$;

create or replace function public.service_review_guided_corrective_action(
  target_actor_id uuid,
  target_corrective_action_id uuid,
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
  action_record private.hr_corrective_actions%rowtype;
  clean_decision text := lower(btrim(coalesce(target_decision, '')));
  clean_reason text := btrim(coalesce(target_reason, ''));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  perform private.hr_stage8_assert_enabled('cases');
  perform private.hr_stage8_require_actor_permission(target_actor_id, 'hr.cases.manage');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'cases');
  if clean_decision not in ('approved', 'canceled') then raise check_violation using message = 'Choose Approve or Return / cancel.'; end if;
  if char_length(clean_reason) < 8 or char_length(clean_reason) > 4000 then raise check_violation using message = 'Enter a review reason of at least 8 characters.'; end if;
  select * into action_record from private.hr_corrective_actions where id = target_corrective_action_id for update;
  if action_record.id is null or action_record.status <> 'pending_hr_review' then raise check_violation using message = 'This corrective action is no longer waiting for review.'; end if;
  if action_record.proposed_by = target_actor_id then raise insufficient_privilege using message = 'A different qualified HR reviewer must make this decision.'; end if;

  update private.hr_corrective_actions set status = clean_decision, reviewed_by = target_actor_id, reviewed_at = clock_timestamp(), review_reason = clean_reason, updated_at = clock_timestamp() where id = action_record.id;
  update private.hr_cases set status = case when clean_decision = 'approved' then 'pending' else 'canceled' end, closed_by = case when clean_decision = 'canceled' then target_actor_id else null end, closed_at = case when clean_decision = 'canceled' then clock_timestamp() else null end, outcome = case when clean_decision = 'canceled' then clean_reason else null end, updated_at = clock_timestamp() where id = action_record.case_id;
  insert into private.hr_corrective_action_events(corrective_action_id, action, actor_id, reason) values(action_record.id, clean_decision, target_actor_id, clean_reason);
  insert into private.hr_case_events(case_id, action, actor_id, reason, details) values(action_record.case_id, concat('corrective_action_',clean_decision), target_actor_id, clean_reason, jsonb_build_object('correctiveActionId',action_record.id));
  return jsonb_build_object('id', action_record.id, 'status', clean_decision);
end
$$;

create or replace function public.service_deliver_guided_corrective_action(
  target_actor_id uuid,
  target_corrective_action_id uuid,
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
  action_record private.hr_corrective_actions%rowtype;
  created_notification_id uuid;
  clean_reason text := btrim(coalesce(target_reason, ''));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  perform private.hr_stage8_assert_enabled('cases');
  perform private.hr_stage8_require_actor_permission(target_actor_id, 'hr.cases.manage');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'cases');
  if char_length(clean_reason) < 8 or char_length(clean_reason) > 4000 then raise check_violation using message = 'Enter a delivery note of at least 8 characters.'; end if;
  select * into action_record from private.hr_corrective_actions where id = target_corrective_action_id for update;
  if action_record.id is null or action_record.status <> 'approved' then raise check_violation using message = 'Only an approved corrective action can be delivered.'; end if;

  update private.hr_corrective_actions set status = 'delivered', delivered_by = target_actor_id, delivered_at = clock_timestamp(), response_due_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp() where id = action_record.id returning * into action_record;
  created_notification_id := private.create_employee_notification(
    action_record.employee_id,
    'corrective_action',
    action_record.id,
    concat('corrective-action-delivered:',action_record.id),
    'Corrective action requires your review',
    'A protected employment record is ready in Action Center. Review it and acknowledge receipt, respond, dispute, or decline acknowledgment. Acknowledgment confirms receipt only; it does not mean agreement.',
    'important',
    false,
    '/actions?checkpoint=required',
    'Review and respond',
    target_actor_id
  );
  if created_notification_id is not null then
    insert into public.employee_notification_email_deliveries(notification_id, recipient_employee_id, subject, body)
    values (created_notification_id, action_record.employee_id, '[SygShift] Corrective action requires your review', 'A protected employment record is ready in SygShift Action Center. Acknowledgment confirms receipt only; it does not mean agreement.\n\nOpen SygShift: https://app.sygilant.us/actions?checkpoint=required')
    on conflict do nothing;
    perform private.signal_employee_update(action_record.employee_id, jsonb_build_object('kind','required_action','id',action_record.id,'isNew',true));
  end if;
  insert into private.hr_corrective_action_events(corrective_action_id, action, actor_id, reason, details) values(action_record.id, 'delivered', target_actor_id, clean_reason, jsonb_build_object('responseDueAt',action_record.response_due_at,'notificationId',created_notification_id));
  insert into private.hr_case_events(case_id, action, actor_id, reason, details) values(action_record.case_id, 'corrective_action_delivered', target_actor_id, clean_reason, jsonb_build_object('correctiveActionId',action_record.id));
  return jsonb_build_object('id', action_record.id, 'status', 'delivered', 'responseDueAt', action_record.response_due_at);
end
$$;

create or replace function public.service_close_guided_corrective_action(
  target_actor_id uuid,
  target_corrective_action_id uuid,
  target_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare action_record private.hr_corrective_actions%rowtype; clean_reason text := btrim(coalesce(target_reason, ''));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  perform private.hr_stage8_assert_enabled('cases');
  perform private.hr_stage8_require_actor_permission(target_actor_id, 'hr.cases.manage');
  perform private.hr_stage9_require_recent_mfa(target_mfa_method, target_mfa_verified_at, 'cases');
  if char_length(clean_reason) < 8 or char_length(clean_reason) > 4000 then raise check_violation using message = 'Enter a closure reason of at least 8 characters.'; end if;
  select * into action_record from private.hr_corrective_actions where id = target_corrective_action_id for update;
  if action_record.id is null or action_record.status not in ('delivered', 'employee_responded') then raise check_violation using message = 'Deliver the action before closing it.'; end if;
  update private.hr_corrective_actions set status='closed',closed_by=target_actor_id,closed_at=clock_timestamp(),closure_reason=clean_reason,updated_at=clock_timestamp() where id=action_record.id;
  update private.hr_cases set status='closed',closed_by=target_actor_id,closed_at=clock_timestamp(),outcome=clean_reason,updated_at=clock_timestamp() where id=action_record.case_id;
  insert into private.hr_corrective_action_events(corrective_action_id,action,actor_id,reason) values(action_record.id,'closed',target_actor_id,clean_reason);
  insert into private.hr_case_events(case_id,action,actor_id,reason,details) values(action_record.case_id,'corrective_action_closed',target_actor_id,clean_reason,jsonb_build_object('correctiveActionId',action_record.id));
  return jsonb_build_object('id',action_record.id,'status','closed');
end
$$;

create or replace function public.get_my_guided_corrective_actions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', action.id,
      'caseNumber', case_record.case_number,
      'actionLevel', action.action_level,
      'title', action.title,
      'occurredOn', action.occurred_on,
      'factualSummary', action.factual_summary,
      'policyExpectation', action.policy_expectation,
      'improvementExpectation', action.improvement_expectation,
      'followUpOn', action.follow_up_on,
      'status', action.status,
      'deliveredAt', action.delivered_at,
      'responseDueAt', action.response_due_at,
      'receiptWording', 'I acknowledge receipt of this record. My acknowledgment confirms receipt and review; it does not mean that I agree with the record.',
      'response', case when response.id is null then null else jsonb_build_object('type',response.response_type,'statement',response.statement,'respondedAt',response.responded_at) end
    ) order by action.updated_at desc) from private.hr_corrective_actions action join private.hr_cases case_record on case_record.id=action.case_id left join private.hr_corrective_action_responses response on response.corrective_action_id=action.id where action.employee_id=actor_id and action.status in ('delivered','employee_responded','closed')), '[]'::jsonb)
  );
end
$$;

create or replace function public.respond_to_my_guided_corrective_action(
  target_corrective_action_id uuid,
  target_response_type text,
  target_statement text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  action_record private.hr_corrective_actions%rowtype;
  response_id uuid;
  clean_type text := lower(btrim(coalesce(target_response_type, '')));
  clean_statement text := nullif(btrim(coalesce(target_statement, '')), '');
  receipt_wording constant text := 'I acknowledge receipt of this record. My acknowledgment confirms receipt and review; it does not mean that I agree with the record.';
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if clean_type not in ('acknowledged_receipt','employee_response','dispute','declined_acknowledgment') then raise check_violation using message = 'Choose how you want to respond.'; end if;
  if clean_type = 'acknowledged_receipt' then clean_statement := null;
  elsif char_length(coalesce(clean_statement,'')) < 8 or char_length(clean_statement) > 10000 then raise check_violation using message = 'Enter a response of at least 8 characters.';
  end if;
  select * into action_record from private.hr_corrective_actions where id=target_corrective_action_id and employee_id=actor_id for update;
  if action_record.id is null or action_record.status <> 'delivered' then raise check_violation using message = 'This corrective action is not awaiting your response.'; end if;
  insert into private.hr_corrective_action_responses(corrective_action_id,employee_id,response_type,statement,receipt_wording)
  values(action_record.id,actor_id,clean_type,clean_statement,receipt_wording) returning id into response_id;
  update private.hr_corrective_actions set status='employee_responded',updated_at=clock_timestamp() where id=action_record.id;
  insert into private.hr_corrective_action_events(corrective_action_id,action,actor_id,reason,details)
  values(action_record.id,clean_type,actor_id,coalesce(clean_statement,receipt_wording),jsonb_build_object('responseId',response_id));
  insert into private.hr_case_events(case_id,action,actor_id,reason,details)
  values(action_record.case_id,concat('employee_',clean_type),actor_id,coalesce(clean_statement,receipt_wording),jsonb_build_object('correctiveActionId',action_record.id,'responseId',response_id));
  perform private.signal_employee_update(actor_id,jsonb_build_object('kind','required_action','id',action_record.id,'isNew',false));
  return jsonb_build_object('id',action_record.id,'responseId',response_id,'status','employee_responded','responseType',clean_type);
end
$$;

create temporary table required_action_checkpoint_dependent_functions on commit drop as
select p.oid::regprocedure::text as identity, pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where (n.nspname='private' and p.proname='employee_has_blocking_required_actions')
   or (n.nspname='public' and p.proname in ('get_required_action_checkpoint','get_required_action_checkpoint_report','service_has_required_action_checkpoint'));

alter function private.employee_required_action_checkpoint_rows(uuid)
  rename to employee_required_action_checkpoint_base_rows;

create function private.employee_required_action_checkpoint_rows(target_employee_id uuid)
returns table (
  source_id uuid, action_type text, title text, description text, status text,
  priority text, priority_rank integer, response_kind text, action_label text,
  route text, assigned_at timestamptz, due_at timestamptz, viewed_at timestamptz,
  authoritative_version text, metadata jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.employee_required_action_checkpoint_base_rows(target_employee_id)
  union all
  select
    action.id,
    'corrective_action',
    action.title,
    concat(action.factual_summary, E'\n\nExpected going forward: ', action.improvement_expectation),
    case when action.response_due_at < clock_timestamp() then 'overdue' else 'delivered' end,
    case when action.response_due_at < clock_timestamp() then 'critical' else 'high' end,
    case when action.response_due_at < clock_timestamp() then 1 else 2 end,
    'acknowledgment',
    'Review and respond',
    '/actions?checkpoint=required',
    action.delivered_at,
    action.response_due_at,
    null::timestamptz,
    concat('Corrective action case ', case_record.case_number),
    jsonb_build_object(
      'caseId', action.case_id,
      'caseNumber', case_record.case_number,
      'actionLevel', action.action_level,
      'wording', 'Acknowledgment confirms receipt and review only. It does not mean agreement, and you may respond, dispute, or decline acknowledgment.'
    )
  from private.hr_corrective_actions action
  join private.hr_cases case_record on case_record.id=action.case_id
  where action.employee_id=target_employee_id
    and action.status='delivered'
    and private.employee_required_action_checkpoint_enrolled(target_employee_id)
$$;

do $$
declare function_record record;
begin
  for function_record in select * from required_action_checkpoint_dependent_functions loop
    execute function_record.definition;
  end loop;
end
$$;

revoke all on function private.employee_required_action_checkpoint_rows(uuid) from public,anon,authenticated;
revoke all on function private.employee_required_action_checkpoint_base_rows(uuid) from public,anon,authenticated;
grant execute on function private.employee_required_action_checkpoint_rows(uuid), private.employee_required_action_checkpoint_base_rows(uuid) to service_role;

revoke all on function public.service_get_guided_corrective_actions(uuid,integer,integer,text,timestamptz) from public,anon,authenticated;
revoke all on function public.service_create_guided_corrective_action(uuid,jsonb,text,timestamptz) from public,anon,authenticated;
revoke all on function public.service_review_guided_corrective_action(uuid,uuid,text,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.service_deliver_guided_corrective_action(uuid,uuid,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.service_close_guided_corrective_action(uuid,uuid,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.get_my_guided_corrective_actions() from public,anon;
revoke all on function public.respond_to_my_guided_corrective_action(uuid,text,text) from public,anon;
grant execute on function public.service_get_guided_corrective_actions(uuid,integer,integer,text,timestamptz), public.service_create_guided_corrective_action(uuid,jsonb,text,timestamptz), public.service_review_guided_corrective_action(uuid,uuid,text,text,text,timestamptz), public.service_deliver_guided_corrective_action(uuid,uuid,text,text,timestamptz), public.service_close_guided_corrective_action(uuid,uuid,text,text,timestamptz) to service_role;
grant execute on function public.get_my_guided_corrective_actions(), public.respond_to_my_guided_corrective_action(uuid,text,text) to authenticated;

comment on table private.hr_corrective_actions is 'Human-reviewed corrective-action records connected to the canonical restricted HR case and employee identity.';
comment on function public.respond_to_my_guided_corrective_action(uuid,text,text) is 'Records one immutable employee receipt response without representing acknowledgment as agreement or signature.';

do $$
declare baseline guided_corrective_action_preservation_baseline%rowtype;
begin
  select * into strict baseline from guided_corrective_action_preservation_baseline;
  if baseline.employee_count<>(select count(*) from public.employees)
    or baseline.case_count<>(select count(*) from private.hr_cases)
    or baseline.case_note_count<>(select count(*) from private.hr_case_notes)
    or baseline.case_evidence_count<>(select count(*) from private.hr_case_evidence)
    or baseline.document_count<>(select count(*) from private.hr_documents)
    or baseline.role_assignment_count<>(select count(*) from public.employee_access_roles)
    or baseline.permission_override_count<>(select count(*) from public.employee_permission_overrides)
  then raise exception 'Guided corrective-action migration changed protected business or access records.';
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
