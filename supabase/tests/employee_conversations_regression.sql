-- Rollback-only production verification for the purpose-limited Employee Conversations workspace.
-- No conversation, event, permission override, or audit fixture survives the final ROLLBACK.
begin;

do $$
declare
  reviewer_employee_id uuid;
  reviewer_auth_user_id uuid;
  unauthorized_auth_user_id uuid;
  target_employee_id uuid;
  fixture_conversation_id uuid;
  completed_fixture_id uuid;
  workspace jsonb;
  blocked boolean := false;
  protected_employee_count bigint;
  protected_corrective_count bigint;
  protected_accountability_count bigint;
  protected_time_event_count bigint;
  protected_override_count bigint;
begin
  select employee.id, account.auth_user_id
  into reviewer_employee_id, reviewer_auth_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and account.auth_user_id is not null
    and 'hr.conversations.review' = any(private.employee_effective_permissions(employee.id))
  order by employee.created_at
  limit 1;

  select employee.id
  into target_employee_id
  from public.employees employee
  where employee.status in ('onboarding', 'active', 'leave')
    and employee.id <> reviewer_employee_id
  order by employee.created_at
  limit 1;

  select account.auth_user_id
  into unauthorized_auth_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and account.auth_user_id is not null
    and not ('hr.conversations.view' = any(private.employee_effective_permissions(employee.id)))
  order by employee.created_at
  limit 1;

  assert reviewer_auth_user_id is not null, 'An active Employee Conversations reviewer is required.';
  assert target_employee_id is not null, 'An active employee target is required.';
  assert unauthorized_auth_user_id is not null, 'An active employee without Employee Conversations access is required.';

  select count(*) into protected_employee_count from public.employees;
  select count(*) into protected_corrective_count from private.hr_corrective_actions;
  select count(*) into protected_accountability_count from public.attendance_accountability_events;
  select count(*) into protected_time_event_count from public.time_events;
  select count(*) into protected_override_count from public.employee_permission_overrides;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', reviewer_auth_user_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', reviewer_auth_user_id::text, true);

  workspace := public.get_employee_conversations_workspace(target_employee_id, 'all', 'all', 10, 0);
  assert workspace -> 'selectedEmployee' ->> 'id' = target_employee_id::text, 'Reviewer could not open the selected employee conversation workspace.';
  assert coalesce((workspace ->> 'canReviewAll')::boolean, false), 'Reviewer lost approved companywide scope.';

  fixture_conversation_id := public.create_employee_conversation(
    target_employee_id,
    'training',
    (clock_timestamp() at time zone 'America/Denver')::date,
    'Rollback-only training conversation',
    'Reviewed the documented procedure and observed the employee demonstrate each required step.',
    'Use the reviewed procedure during the next assigned shift.',
    true,
    (clock_timestamp() at time zone 'America/Denver')::date + 7
  );
  assert exists (
    select 1 from private.hr_employee_conversations conversation
    where conversation.id = fixture_conversation_id
      and conversation.employee_id = target_employee_id
      and conversation.status = 'open'
  ), 'A scheduled follow-up did not create an open record.';
  assert (select count(*) from private.hr_employee_conversation_events event where event.conversation_id = fixture_conversation_id) = 1, 'Creation did not produce exactly one initial event.';

  perform public.record_employee_conversation_action(
    fixture_conversation_id,
    'follow_up',
    'Employee demonstrated the procedure again and requested one additional review.',
    (clock_timestamp() at time zone 'America/Denver')::date + 14
  );
  perform public.record_employee_conversation_action(
    fixture_conversation_id,
    'complete',
    'Employee completed the follow-up and demonstrated the procedure correctly.',
    null
  );
  perform public.record_employee_conversation_action(
    fixture_conversation_id,
    'reopen',
    'A final supervisory check is required after the next assigned shift.',
    (clock_timestamp() at time zone 'America/Denver')::date + 21
  );
  perform public.record_employee_conversation_action(
    fixture_conversation_id,
    'void',
    'Rollback-only record created solely for release verification.',
    null
  );

  assert exists (
    select 1 from private.hr_employee_conversations conversation
    where conversation.id = fixture_conversation_id
      and conversation.status = 'voided'
      and conversation.void_reason = 'Rollback-only record created solely for release verification.'
  ), 'The reasoned void did not preserve the original record.';
  assert (select count(*) from private.hr_employee_conversation_events event where event.conversation_id = fixture_conversation_id) = 5, 'The append-only activity timeline is incomplete.';
  assert (select count(*) from private.audit_events event where event.table_name = 'hr_employee_conversations' and event.row_id = fixture_conversation_id::text) = 5, 'Conversation mutations were not fully audited.';

  begin
    update private.hr_employee_conversation_events event
    set note = 'This update must not be possible.'
    where event.conversation_id = fixture_conversation_id;
    raise exception 'Conversation event history was editable.';
  exception when others then
    if sqlerrm = 'Conversation event history was editable.' then raise; end if;
  end;

  completed_fixture_id := public.create_employee_conversation(
    target_employee_id,
    'recognition',
    (clock_timestamp() at time zone 'America/Denver')::date,
    'Rollback-only recognition',
    'Recognized the employee for completing the documented assignment accurately and on time.',
    null,
    true,
    null
  );
  assert exists (
    select 1 from private.hr_employee_conversations conversation
    where conversation.id = completed_fixture_id
      and conversation.status = 'completed'
      and conversation.completed_by = reviewer_employee_id
  ), 'A record without follow-up did not save complete.';
  assert (select count(*) from private.hr_employee_conversation_events event where event.conversation_id = completed_fixture_id) = 2, 'Automatic completion did not remain visible in history.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', unauthorized_auth_user_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', unauthorized_auth_user_id::text, true);
  begin
    perform public.get_employee_conversations_workspace(null, 'all', 'active', 10, 0);
  exception when insufficient_privilege then
    blocked := true;
  end;
  assert blocked, 'An employee without the dedicated permission opened Employee Conversations.';

  assert not has_table_privilege('authenticated', 'private.hr_employee_conversations', 'select'), 'Authenticated users received direct conversation-table access.';
  assert not has_table_privilege('authenticated', 'private.hr_employee_conversation_events', 'select'), 'Authenticated users received direct event-table access.';
  assert not has_function_privilege('anon', 'public.get_employee_conversations_workspace(uuid,text,text,integer,integer)', 'execute'), 'Anonymous workspace execution is exposed.';
  assert has_function_privilege('authenticated', 'public.get_employee_conversations_workspace(uuid,text,text,integer,integer)', 'execute'), 'Authenticated callers cannot reach the permission-enforcing workspace boundary.';

  assert protected_employee_count = (select count(*) from public.employees), 'Regression changed employee records.';
  assert protected_corrective_count = (select count(*) from private.hr_corrective_actions), 'Regression changed corrective actions.';
  assert protected_accountability_count = (select count(*) from public.attendance_accountability_events), 'Regression changed accountability events.';
  assert protected_time_event_count = (select count(*) from public.time_events), 'Regression changed time events.';
  assert protected_override_count = (select count(*) from public.employee_permission_overrides), 'Regression changed individual permission overrides.';
end
$$;

rollback;
