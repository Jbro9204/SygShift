-- LOCAL RESTORED-DATABASE ONLY. The first guard rejects every hosted database.
-- The local automation gate change is transactional and rolls back with all
-- synthetic fixtures. Hosted gates are never opened for these tests.
begin;
do $local_guard$
begin
  if current_database() <> 'overnight_recovery_fixture_v2_20261019'
    or inet_server_addr() is distinct from inet '127.0.0.1'
    or inet_server_port() is distinct from 55439 then
    raise exception 'This regression requires the explicitly isolated restored local database.';
  end if;
end;
$local_guard$;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local plpgsql.check_asserts=on;
set local request.jwt.claim.role='service_role';

create temporary table hr_local_lint_result(
  draft_create_and_update boolean, escalation_enqueue_and_cooldown boolean,
  import_auto_selection boolean, empty_import_promoted_people integer,
  employees_preserved boolean, hosted_acceptance boolean
) on commit drop;

do $test$
declare
  fixture_actor_id uuid;
  fixture_definition_id uuid;
  fixture_version_id uuid;
  fixture_instance_id uuid;
  fixture_task_id uuid;
  fixture_import_id uuid;
  initial_draft jsonb;
  updated_draft jsonb;
  import_result jsonb;
  direct_import_result jsonb;
  fixture_code text := 'lint_regression_'||replace(gen_random_uuid()::text,'-','');
  fixture_now timestamptz := clock_timestamp();
  source_file uuid;
  latest_import_time timestamptz;
  employees_before bigint;
  steps_value constant jsonb := '[{"key":"first","type":"notification"},{"key":"second","type":"complete"}]';
begin
  select employee.id into fixture_actor_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id=employee.id
  where employee.status='active' and account.disabled_at is null
    and 'hr.automation.manage'=any(private.employee_effective_permissions(employee.id))
  order by employee.id limit 1;
  if fixture_actor_id is null then raise exception 'No authorized retained local actor exists.'; end if;
  update private.hr_automation_release_gate
    set enabled=true, enabled_at=fixture_now, enabled_by=fixture_actor_id,
      evidence='Isolated local rollback fixture only; hosted release gate remains unchanged.'
    where singleton;
  initial_draft := public.service_save_hr_workflow_draft(fixture_actor_id,null,fixture_code,
    'Local rollback draft',null,'manual','{}','{}',steps_value,'Local rollback regression');
  fixture_definition_id := (initial_draft->>'definitionId')::uuid;
  fixture_version_id := (initial_draft->>'versionId')::uuid;
  updated_draft := public.service_save_hr_workflow_draft(fixture_actor_id,fixture_definition_id,fixture_code,
    'Updated local rollback draft','Updated fixture','manual','{}','{}',steps_value,'Local draft update regression');
  assert updated_draft->>'definitionId'=fixture_definition_id::text;
  assert updated_draft->>'versionId'=fixture_version_id::text and (updated_draft->>'versionNumber')::integer=1,
    'Updating a retained draft created a second workflow version.';
  assert (select name='Updated local rollback draft' from private.hr_workflow_definitions where id=fixture_definition_id);
  assert (select count(*)=1 from private.hr_workflow_versions where definition_id=fixture_definition_id);
  assert (select count(*)=2 from private.hr_automation_events where aggregate_id=fixture_definition_id and event_type='draft_saved');

  insert into private.hr_workflow_instances(workflow_version_id,requested_by,idempotency_key)
    values(fixture_version_id,fixture_actor_id,'local-lint:'||gen_random_uuid()::text) returning id into fixture_instance_id;
  insert into private.hr_workflow_tasks(instance_id,step_key,assigned_employee_id,title,due_at)
    values(fixture_instance_id,'overdue',fixture_actor_id,'Local overdue regression',fixture_now-interval '1 hour') returning id into fixture_task_id;
  insert into private.hr_workflow_tasks(instance_id,step_key,assigned_employee_id,title,due_at)
    values(fixture_instance_id,'future',fixture_actor_id,'Local future regression',fixture_now+interval '1 day');
  assert public.service_enqueue_hr_task_escalations(fixture_now)=1, 'The eligible overdue task did not escalate exactly once.';
  assert public.service_enqueue_hr_task_escalations(fixture_now+interval '1 second')=0, 'Escalation ignored its retained cooldown.';
  assert (select escalation_count=1 and escalated_at=fixture_now from private.hr_workflow_tasks where id=fixture_task_id);
  assert (select count(*)=1 from private.notification_outbox where aggregate_id=fixture_task_id and message_type='hr_task_escalation');
  assert (select count(*)=1 from private.hr_automation_events where aggregate_id=fixture_task_id and event_type='escalated');

  -- A synthetic, empty, newest import proves both nullable selectors without
  -- promoting any actual candidate or changing an employee or pay-rate record.
  select import_run.source_file_id into source_file from private.import_runs import_run order by import_run.created_at desc limit 1;
  select max(created_at)+interval '1 second' into latest_import_time from private.import_runs;
  if source_file is null then raise exception 'No retained local source-file identity exists.'; end if;
  insert into private.import_runs(source_file_id,extractor_version,created_at,started_at)
    values(source_file,'local_empty_lint_regression',latest_import_time,latest_import_time) returning id into fixture_import_id;
  select count(*) into employees_before from public.employees;
  import_result := public.service_promote_import_people(null);
  direct_import_result := private.promote_import_people_legacy_guard_body(null);
  assert import_result->>'importRunId'=fixture_import_id::text
    and direct_import_result->>'importRunId'=fixture_import_id::text,
    'Nullable import selection did not choose the newest supported created_at value.';
  assert (import_result->>'promotedCount')::integer=0 and (direct_import_result->>'promotedCount')::integer=0;
  assert (select count(*) from public.employees)=employees_before, 'An empty import changed employee count.';
  insert into pg_temp.hr_local_lint_result values(true,true,true,0,true,false);
end;
$test$;

select * from pg_temp.hr_local_lint_result;
rollback;
