-- Transaction body: combine with the migration under ONE outer BEGIN and final ROLLBACK.
-- No provider call, committed fixture, punch, pay rate, schedule, or payroll mutation.
do $$
declare
  employee_id uuid;
  ticket_id uuid;
  fixture_id uuid;
  notification_id uuid;
  queue record;
  before_row jsonb;
  after_row jsonb;
  generic_id uuid := gen_random_uuid();
  clock_out_id uuid := gen_random_uuid();
  claimed jsonb;
  actor_auth uuid;
  actor_employee uuid;
  retry_result jsonb;
  generation_id uuid;
  audit_id uuid;
begin
  perform set_config('sygshift.push_kicked', 'yes', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  select employee.id into employee_id from public.employees employee order by employee.id limit 1;
  select ticket.id into ticket_id from public.support_tickets ticket order by ticket.id limit 1;
  assert employee_id is not null and ticket_id is not null, 'Existing foreign-key anchors are required; no identity is created or modified.';

  assert private.notification_terminal_outcome('Suppressed — Employee Preference') = 'suppressed';
  assert private.notification_terminal_outcome('Suppressed — Blocked Domain') = 'suppressed';
  assert private.notification_terminal_outcome('E_RECIPIENT_SUPPRESSED: Confirmed provider code') = 'suppressed';
  assert private.notification_terminal_outcome('Suppressed by call-off lifecycle reconciliation because no live coverage action remains.') = 'canceled';
  assert private.notification_terminal_outcome('Unclassified historic delivery error') = 'failed';

  for queue in select * from (values
    ('private', 'notification_outbox', 'notification'),
    ('public', 'support_ticket_notifications', 'support_ticket_notification'),
    ('public', 'employee_notification_email_deliveries', 'employee_notification')
  ) as queues(schema_name, table_name, marker_name)
  loop
    fixture_id := gen_random_uuid();
    if queue.table_name = 'notification_outbox' then
      insert into private.notification_outbox(id, message_type, aggregate_type, aggregate_id, payload, idempotency_key, attempt_count)
      values(fixture_id, 'schedule_published', 'terminal_state_regression', gen_random_uuid(), '{}'::jsonb,
        'terminal-state-regression:' || fixture_id::text, 1);
    elsif queue.table_name = 'support_ticket_notifications' then
      insert into public.support_ticket_notifications(id, ticket_id, recipient_employee_id, message_type, subject, body, idempotency_key, attempt_count)
      values(fixture_id, ticket_id, employee_id, 'terminal_state_regression', 'Rollback-only terminal fixture',
        'Rollback-only terminal fixture. No message is delivered.', 'terminal-state-regression:' || fixture_id::text, 1);
    else
      notification_id := gen_random_uuid();
      insert into public.employee_notifications(id, recipient_employee_id, source_type, source_key, title, body)
      values(notification_id, employee_id, 'terminal_state_regression', 'terminal-state-regression:' || fixture_id::text,
        'Rollback-only terminal fixture', 'Rollback-only terminal fixture. No message is delivered.');
      insert into public.employee_notification_email_deliveries(id, notification_id, recipient_employee_id, subject, body, attempt_count)
      values(fixture_id, notification_id, employee_id, 'Rollback-only terminal fixture', 'Rollback-only terminal fixture. No message is delivered.', 1);
    end if;

    assert not has_function_privilege('anon', 'public.service_mark_' || queue.marker_name || '_suppressed(uuid,text)', 'EXECUTE');
    assert not has_function_privilege('authenticated', 'public.service_mark_' || queue.marker_name || '_suppressed(uuid,text)', 'EXECUTE');
    assert has_function_privilege('service_role', 'public.service_mark_' || queue.marker_name || '_suppressed(uuid,text)', 'EXECUTE');
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
    begin
      execute format('select public.service_mark_%s_suppressed($1,$2)', queue.marker_name)
        using fixture_id, 'Suppressed — Provider Recipient';
      raise exception 'Unauthorized suppression accepted for %', queue.table_name;
    exception when insufficient_privilege then null;
    end;
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

    execute format('select public.service_mark_%s_result($1,false,$2)', queue.marker_name) using fixture_id, 'Transient retry fixture';
    execute format('select to_jsonb(delivery) from %I.%I delivery where id=$1', queue.schema_name, queue.table_name) into before_row using fixture_id;
    assert before_row ->> 'failed_at' is null and before_row ->> 'terminal_outcome' is null, 'Transient failures remain retryable.';
    begin
      execute format('update %I.%I set attempt_count=5 where id=$1', queue.schema_name, queue.table_name) using fixture_id;
      execute format('select public.service_mark_%s_result($1,false,$2)', queue.marker_name) using fixture_id, 'Retry exhausted fixture';
      execute format('select to_jsonb(delivery) from %I.%I delivery where id=$1', queue.schema_name, queue.table_name) into after_row using fixture_id;
      assert after_row ->> 'terminal_outcome' = 'retry_exhausted' and after_row ->> 'failed_at' is not null;
      raise exception using errcode='ZX001', message='Rollback this isolated exhaustion assertion';
    exception when sqlstate 'ZX001' then null;
    end;
    if queue.table_name = 'employee_notification_email_deliveries' then
      begin
        update public.employee_notifications set dismissed_at=clock_timestamp() where id=notification_id;
        update public.employee_notification_email_deliveries
        set failed_at=clock_timestamp(), last_error=coalesce(last_error, 'Suppressed by call-off lifecycle reconciliation because no live coverage action remains.')
        where id=fixture_id;
        assert (select terminal_outcome='canceled' and last_error='Transient retry fixture'
          from public.employee_notification_email_deliveries where id=fixture_id), 'Lifecycle cancellation lost the previous retry error or its terminal outcome.';
        raise exception using errcode='ZX002', message='Rollback this isolated lifecycle assertion';
      exception when sqlstate 'ZX002' then null;
      end;
    end if;
    execute format('select public.service_mark_%s_suppressed($1,$2)', queue.marker_name) using fixture_id, 'Suppressed — Provider Recipient';
    execute format('select to_jsonb(delivery) from %I.%I delivery where id=$1', queue.schema_name, queue.table_name) into before_row using fixture_id;
    assert before_row ->> 'terminal_outcome' = 'suppressed' and before_row ->> 'failed_at' is not null;

    -- Suppression wins over both late acceptance and late failure; repeated suppression is idempotent.
    execute format('select public.service_mark_%s_result($1,true,null)', queue.marker_name) using fixture_id;
    execute format('select public.service_mark_%s_result($1,false,$2)', queue.marker_name) using fixture_id, 'Late failed result';
    execute format('select public.service_mark_%s_suppressed($1,$2)', queue.marker_name) using fixture_id, 'Different late reason';
    execute format('select to_jsonb(delivery) from %I.%I delivery where id=$1', queue.schema_name, queue.table_name) into after_row using fixture_id;
    assert before_row = after_row, 'Late results overwrote terminal evidence.';
    begin
      execute format('update %I.%I set failed_at=null, terminal_outcome=null, attempt_count=0 where id=$1', queue.schema_name, queue.table_name) using fixture_id;
      raise exception 'A terminal queue row was reopened';
    exception when object_not_in_prerequisite_state then null;
    end;

    -- Build one fresh fixture from the same safe fields to test the reverse race.
    fixture_id := gen_random_uuid();
    if queue.table_name = 'notification_outbox' then
      insert into private.notification_outbox(id, message_type, aggregate_type, aggregate_id, payload, idempotency_key, attempt_count)
      values(fixture_id, 'schedule_published', 'terminal_state_regression', gen_random_uuid(), '{}'::jsonb,
        'terminal-state-regression:' || fixture_id::text, 5);
    elsif queue.table_name = 'support_ticket_notifications' then
      insert into public.support_ticket_notifications(id, ticket_id, recipient_employee_id, message_type, subject, body, idempotency_key, attempt_count)
      values(fixture_id, ticket_id, employee_id, 'terminal_state_regression', 'Rollback-only accepted fixture',
        'Rollback-only accepted fixture. No message is delivered.', 'terminal-state-regression:' || fixture_id::text, 5);
    else
      notification_id := gen_random_uuid();
      insert into public.employee_notifications(id, recipient_employee_id, source_type, source_key, title, body)
      values(notification_id, employee_id, 'terminal_state_regression', 'terminal-state-regression:' || fixture_id::text,
        'Rollback-only accepted fixture', 'Rollback-only accepted fixture. No message is delivered.');
      insert into public.employee_notification_email_deliveries(id, notification_id, recipient_employee_id, subject, body, attempt_count)
      values(fixture_id, notification_id, employee_id, 'Rollback-only accepted fixture', 'Rollback-only accepted fixture. No message is delivered.', 5);
    end if;
    execute format('select public.service_mark_%s_result($1,true,null)', queue.marker_name) using fixture_id;
    execute format('select to_jsonb(delivery) from %I.%I delivery where id=$1', queue.schema_name, queue.table_name) into before_row using fixture_id;
    execute format('select public.service_mark_%s_suppressed($1,$2)', queue.marker_name) using fixture_id, 'Suppressed — Provider Recipient';
    execute format('select public.service_mark_%s_result($1,false,$2)', queue.marker_name) using fixture_id, 'Late failed result';
    execute format('select to_jsonb(delivery) from %I.%I delivery where id=$1', queue.schema_name, queue.table_name) into after_row using fixture_id;
    assert before_row = after_row and before_row ->> 'delivered_at' is not null, 'Acceptance was overwritten by a late terminal result.';
  end loop;

  fixture_id := gen_random_uuid();
  insert into private.notification_outbox(id, message_type, aggregate_type, aggregate_id, payload, idempotency_key, attempt_count)
  values(fixture_id, 'schedule_published', 'terminal_state_regression', gen_random_uuid(), '{}'::jsonb,
    'terminal-state-regression:' || fixture_id::text, 5);
  perform public.service_mark_notification_result(fixture_id, false, 'Retry exhausted fixture');
  assert (select terminal_outcome = 'retry_exhausted' and failed_at is not null from private.notification_outbox where id=fixture_id);

  audit_id := public.service_log_email_delivery('terminal_state_regression',null,null,'regression@example.invalid',
    'suppressed_provider_recipient',null,'E_RECIPIENT_SUPPRESSED: Rollback-only suppression fixture');
  assert (select delivery_status='suppressed_provider_recipient' from private.email_delivery_audit where id=audit_id);

  select employee.id,account.auth_user_id into actor_employee,actor_auth
  from public.employees employee join private.employee_accounts account on account.employee_id=employee.id
  where employee.status='active' and account.disabled_at is null
    and 'notifications.manage'=any(private.employee_effective_permissions(employee.id))
  order by (employee.username='jbrown') desc,employee.id limit 1;
  assert actor_auth is not null, 'An existing authorized notification manager is required.';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal2')::text,true);
  retry_result := public.retry_notification_job(fixture_id);
  assert (retry_result->>'retried')::integer=1, 'Authorized retry did not create one new generation.';
  select id into generation_id from private.notification_outbox where retry_of_notification_id=fixture_id;
  assert generation_id is not null;
  assert (select terminal_outcome='retry_exhausted' and failed_at is not null and attempt_count=5
    from private.notification_outbox where id=fixture_id), 'Authorized retry rewrote terminal evidence.';
  retry_result := public.retry_notification_job(fixture_id);
  assert (retry_result->>'retried')::integer=0, 'Repeated retry created a duplicate generation.';
  retry_result := public.retry_all_failed_notifications();
  assert not exists(select 1 from private.notification_outbox parent join private.notification_outbox child
    on child.retry_of_notification_id=parent.id where parent.terminal_outcome in ('suppressed','canceled')),
    'Bulk retry revived an intentional suppression or cancellation.';
  claimed := public.get_notification_center('all','terminal_state_regression',null,null,1,20);
  assert claimed->'summary' ? 'suppressed' and claimed->'summary' ? 'canceled' and claimed->'summary' ? 'retryExhausted',
    'Delivery operations lost distinct terminal statuses.';
  assert exists(select 1 from jsonb_array_elements(claimed->'batches') batch where batch->>'id'=generation_id::text and batch->>'status'='queued'),
    'Delivery operations did not show the new active generation.';
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);

  insert into private.notification_outbox(id, message_type, aggregate_type, aggregate_id, payload, idempotency_key, available_at, created_at)
  values (clock_out_id, 'automatic_clock_out_employee', 'terminal_state_regression', gen_random_uuid(), '{}'::jsonb,
    'terminal-state-clock-out:' || clock_out_id::text, '2000-01-01', '2000-01-01'),
    (generic_id, 'schedule_published', 'terminal_state_regression', gen_random_uuid(), '{}'::jsonb,
    'terminal-state-schedule:' || generic_id::text, '2000-01-02', '2000-01-02');
  claimed := public.service_claim_notification_batch(1);
  assert jsonb_array_length(claimed)=1 and claimed->0->>'id'=generic_id::text, 'Generic claimant stole a timekeeping notification.';
  assert (select attempt_count=0 and attempted_at is null from private.notification_outbox where id=clock_out_id);

  assert not exists(select 1 from private.notification_outbox where delivered_at is null and failed_at is null and attempt_count>=5 and aggregate_type <> 'terminal_state_regression'),
    'A real exhausted delivery remained stranded after stabilization.';
end;
$$;
select 'notification_terminal_state_regression_passed' as status;
