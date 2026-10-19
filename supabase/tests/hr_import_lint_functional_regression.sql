-- Production rollback-only functional probes. No gate is enabled or bypassed.
-- Synthetic HR records reference an existing authorized actor; no employee,
-- punch, schedule, identity, payroll, rate, import candidate or import mapping
-- record is created or changed. No notification provider is invoked.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local plpgsql.check_asserts=on;
set local request.jwt.claim.role='service_role';

create temporary table hr_lint_functional_result(
  enqueue_inserted integer, enqueue_retry_inserted integer,
  dependencies_verified boolean, defaults_and_clamps_verified boolean,
  talent_update_verified boolean, automation_gate_denials_verified boolean,
  import_timestamp_contract_verified boolean, release_gates_preserved boolean
) on commit drop;

do $test$
declare
  actor_id uuid;
  definition_id uuid;
  version_id uuid;
  fixture_instance_id uuid;
  goal_id uuid;
  result_value jsonb;
  steps_value constant jsonb := '[
    {"key":"first","type":"notification","priority":9999,"maxAttempts":0},
    {"key":"second","type":"delay","config":{"seconds":5}},
    {"key":"third","type":"complete","dependsOn":["first"]}
  ]';
  inserted_count integer;
  retry_count integer;
  automation_gate_before text;
  talent_gate_before text;
  probe_started_at timestamptz := clock_timestamp();
begin
  select md5(jsonb_agg(to_jsonb(gate) order by gate.singleton)::text)
    into automation_gate_before from private.hr_automation_release_gate gate;
  select md5(jsonb_agg(to_jsonb(gate) order by gate.module)::text)
    into talent_gate_before from private.hr_stage8_release_gates gate;
  if exists(select 1 from private.hr_automation_release_gate where singleton and enabled) then
    raise exception 'This regression expects the retained closed HR automation gate; re-review before using another state.';
  end if;
  select employee.id into actor_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id=employee.id
  where employee.status='active' and account.disabled_at is null
    and account.activated_at is not null
    and 'hr.talent.manage'=any(private.employee_effective_permissions(employee.id))
  order by employee.id limit 1;
  if actor_id is null then raise exception 'No authorized retained actor exists for HR lint regression.'; end if;

  insert into private.hr_workflow_definitions(code,name,created_by,updated_by)
    values('lint_regression_'||replace(gen_random_uuid()::text,'-',''),'Rollback regression',actor_id,actor_id)
    returning id into definition_id;
  insert into private.hr_workflow_versions(definition_id,version_number,trigger_type,steps,change_note,created_by)
    values(definition_id,1,'manual',steps_value,'Rollback regression',actor_id) returning id into version_id;
  insert into private.hr_workflow_instances(workflow_version_id,requested_by,idempotency_key)
    values(version_id,actor_id,'lint-regression:'||gen_random_uuid()::text) returning id into fixture_instance_id;
  inserted_count := private.enqueue_hr_workflow_jobs(fixture_instance_id,steps_value);
  retry_count := private.enqueue_hr_workflow_jobs(fixture_instance_id,steps_value);
  assert inserted_count=3 and retry_count=0, 'Workflow enqueue did not preserve idempotency.';
  assert (select dependency_step_keys=array[]::text[] from private.hr_automation_jobs where instance_id=fixture_instance_id and step_key='first');
  assert (select dependency_step_keys=array['first']::text[] from private.hr_automation_jobs where instance_id=fixture_instance_id and step_key='second');
  assert (select dependency_step_keys=array['first']::text[] from private.hr_automation_jobs where instance_id=fixture_instance_id and step_key='third');
  assert (select priority=1000 and max_attempts=1 from private.hr_automation_jobs where instance_id=fixture_instance_id and step_key='first');
  assert (select max_attempts=5 and run_after>=probe_started_at+interval '5 seconds' from private.hr_automation_jobs where instance_id=fixture_instance_id and step_key='second');

  -- Keep the public draft and escalation release boundary closed in production.
  begin
    perform public.service_save_hr_workflow_draft(actor_id,definition_id,'lint_regression','Rollback regression',null,'manual','{}','{}',steps_value,'Rollback regression');
    raise exception 'The retained automation release gate accepted a draft mutation.';
  exception when insufficient_privilege then
    if sqlerrm <> 'HR automation has not been released.' then raise; end if;
  end;
  begin
    perform public.service_enqueue_hr_task_escalations(clock_timestamp());
    raise exception 'The retained automation release gate accepted escalation.';
  exception when insufficient_privilege then
    if sqlerrm <> 'HR automation has not been released.' then raise; end if;
  end;

  insert into private.hr_talent_goals(employee_id,title,status,created_by)
    values(actor_id,'Rollback lint regression','active',actor_id) returning id into goal_id;
  result_value := public.service_hr_operational_action(actor_id,'talent','update_goal',
    jsonb_build_object('id',goal_id,'status','completed','progressPercent',100),'Rollback lint regression',null,null);
  assert result_value->>'id'=goal_id::text, 'The talent goal update returned another record.';
  assert (select status='completed' and progress_percent=100 and employee_id=actor_id
    from private.hr_talent_goals where id=goal_id), 'The talent goal update did not preserve its employee owner.';
  assert (select count(*)=1 from private.hr_talent_events where entity_id=goal_id and action='updated'), 'The talent goal update has no single audit event.';

  assert exists(select 1 from information_schema.columns where table_schema='private' and table_name='import_runs' and column_name='created_at');
  assert not exists(select 1 from information_schema.columns where table_schema='private' and table_name='import_runs' and column_name='received_at');
  perform import_run.id from private.import_runs import_run
    order by import_run.created_at desc nulls last, import_run.started_at desc nulls last, import_run.id desc limit 1;
  assert automation_gate_before is not distinct from (select md5(jsonb_agg(to_jsonb(gate) order by gate.singleton)::text) from private.hr_automation_release_gate gate);
  assert talent_gate_before is not distinct from (select md5(jsonb_agg(to_jsonb(gate) order by gate.module)::text) from private.hr_stage8_release_gates gate);
  insert into pg_temp.hr_lint_functional_result values(inserted_count,retry_count,true,true,true,true,true,true);
end;
$test$;

select * from pg_temp.hr_lint_functional_result;
rollback;
