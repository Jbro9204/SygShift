begin;

-- Stage 5, run 2: transactional work queue, retries, dead-letter handling,
-- pause/resume/cancel controls, human-task completion, and audited overrides.
create temporary table hris_stage5_run2_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count;

create table if not exists private.hr_automation_jobs (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references private.hr_workflow_instances(id) on delete restrict,
  step_key text not null,
  sequence_number integer not null,
  job_type text not null,
  payload jsonb not null default '{}'::jsonb,
  dependency_step_keys text[] not null default array[]::text[],
  idempotency_key text not null unique,
  state text not null default 'queued',
  priority integer not null default 100,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default clock_timestamp(),
  leased_until timestamptz,
  leased_by text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (instance_id, step_key),
  constraint hr_automation_job_sequence_positive check (sequence_number > 0),
  constraint hr_automation_job_type_check check (job_type in ('human_task', 'notification', 'delay', 'condition', 'complete')),
  constraint hr_automation_job_state_check check (state in ('queued', 'leased', 'waiting_human', 'retry_wait', 'completed', 'dead_letter', 'cancelled')),
  constraint hr_automation_job_attempts_check check (attempt_count >= 0 and max_attempts between 1 and 20 and attempt_count <= max_attempts),
  constraint hr_automation_job_priority_check check (priority between 1 and 1000)
);

create table if not exists private.hr_automation_dead_letters (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references private.hr_automation_jobs(id) on delete restrict,
  instance_id uuid not null references private.hr_workflow_instances(id) on delete restrict,
  error_code text not null,
  error_message text not null,
  payload_snapshot jsonb not null,
  failed_at timestamptz not null default clock_timestamp(),
  replayed_by uuid references public.employees(id) on delete restrict,
  replayed_at timestamptz,
  replay_reason text,
  constraint hr_automation_dead_letter_error_present check (nullif(btrim(error_code), '') is not null and nullif(btrim(error_message), '') is not null),
  constraint hr_automation_dead_letter_replay_check check ((replayed_at is null and replayed_by is null and replay_reason is null) or (replayed_at is not null and replayed_by is not null and nullif(btrim(replay_reason), '') is not null))
);

create table if not exists private.hr_automation_schedules (
  workflow_version_id uuid primary key references private.hr_workflow_versions(id) on delete restrict,
  next_run_at timestamptz not null,
  last_enqueued_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

create index if not exists hr_automation_jobs_claim_idx
  on private.hr_automation_jobs(state, run_after, priority, created_at)
  where state in ('queued', 'retry_wait');
create index if not exists hr_automation_jobs_instance_idx
  on private.hr_automation_jobs(instance_id, sequence_number);
create index if not exists hr_automation_schedules_due_idx
  on private.hr_automation_schedules(next_run_at);

create or replace function private.hr_automation_require_actor_permission(
  target_actor_id uuid,
  target_permission text
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  effective_permissions text[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if not exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_actor_id
      and employee.status in ('active', 'leave')
      and account.disabled_at is null
  ) then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  effective_permissions := private.employee_effective_permissions(target_actor_id);
  if not target_permission = any(effective_permissions) then
    raise insufficient_privilege using message = 'The required HR automation permission is missing.';
  end if;
  return effective_permissions;
end;
$$;

create or replace function private.hr_automation_require_released()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.hr_automation_release_gate gate where gate.singleton and gate.enabled) then
    raise insufficient_privilege using message = 'HR automation has not been released.';
  end if;
end;
$$;

create or replace function public.service_set_hr_automation_release_gate(
  target_actor_id uuid,
  target_enabled boolean,
  target_evidence text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_evidence text := nullif(btrim(coalesce(target_evidence, '')), '');
begin
  perform private.hr_automation_require_actor_permission(target_actor_id, 'hr.automation.override');
  if clean_evidence is null then
    raise check_violation using message = 'Release evidence is required.';
  end if;
  update private.hr_automation_release_gate
  set enabled = target_enabled,
      enabled_at = case when target_enabled then clock_timestamp() else null end,
      enabled_by = target_actor_id,
      evidence = clean_evidence,
      updated_at = clock_timestamp()
  where singleton;
  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, actor_employee_id, reason, details)
  values ('release_gate', target_actor_id, case when target_enabled then 'released' else 'disabled' end, target_actor_id, clean_evidence, jsonb_build_object('enabled', target_enabled));
  return jsonb_build_object('enabled', target_enabled, 'updatedAt', clock_timestamp());
end;
$$;

create or replace function public.service_save_hr_workflow_draft(
  target_actor_id uuid,
  target_definition_id uuid,
  target_code text,
  target_name text,
  target_description text,
  target_trigger_type text,
  target_trigger_config jsonb,
  target_input_schema jsonb,
  target_steps jsonb,
  target_change_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  definition_id uuid := target_definition_id;
  version_id uuid;
  version_number integer;
  clean_code text := lower(nullif(btrim(coalesce(target_code, '')), ''));
  clean_name text := nullif(btrim(coalesce(target_name, '')), '');
  clean_note text := nullif(btrim(coalesce(target_change_note, '')), '');
begin
  perform private.hr_automation_require_released();
  perform private.hr_automation_require_actor_permission(target_actor_id, 'hr.automation.manage');
  if clean_code is null or clean_code !~ '^[a-z][a-z0-9_]*$' or clean_name is null or clean_note is null then
    raise check_violation using message = 'A valid code, name, and change note are required.';
  end if;
  if not private.validate_hr_workflow_steps(target_steps) then
    raise check_violation using message = 'Workflow steps are invalid.';
  end if;

  if definition_id is null then
    insert into private.hr_workflow_definitions (code, name, description, created_by, updated_by)
    values (clean_code, clean_name, nullif(btrim(target_description), ''), target_actor_id, target_actor_id)
    returning id into definition_id;
  else
    update private.hr_workflow_definitions
    set name = clean_name,
        description = nullif(btrim(target_description), ''),
        updated_by = target_actor_id,
        updated_at = clock_timestamp()
    where id = definition_id and status <> 'retired';
    if not found then raise no_data_found using message = 'The workflow definition is unavailable.'; end if;
  end if;

  select version.id, version.version_number
  into version_id, version_number
  from private.hr_workflow_versions version
  where version.definition_id = definition_id and version.status = 'draft'
  order by version.version_number desc limit 1;

  if version_id is null then
    select coalesce(max(version.version_number), 0) + 1 into version_number
    from private.hr_workflow_versions version where version.definition_id = definition_id;
    insert into private.hr_workflow_versions (
      definition_id, version_number, trigger_type, trigger_config, input_schema, steps, change_note, created_by
    ) values (
      definition_id, version_number, target_trigger_type, coalesce(target_trigger_config, '{}'::jsonb),
      coalesce(target_input_schema, '{}'::jsonb), target_steps, clean_note, target_actor_id
    ) returning id into version_id;
  else
    update private.hr_workflow_versions
    set trigger_type = target_trigger_type,
        trigger_config = coalesce(target_trigger_config, '{}'::jsonb),
        input_schema = coalesce(target_input_schema, '{}'::jsonb),
        steps = target_steps,
        change_note = clean_note
    where id = version_id and status = 'draft';
  end if;

  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, actor_employee_id, reason, details)
  values ('workflow_definition', definition_id, 'draft_saved', target_actor_id, clean_note, jsonb_build_object('versionId', version_id, 'versionNumber', version_number));
  return jsonb_build_object('definitionId', definition_id, 'versionId', version_id, 'versionNumber', version_number, 'status', 'draft');
end;
$$;

create or replace function public.service_publish_hr_workflow_version(
  target_actor_id uuid,
  target_version_id uuid,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_reason text := nullif(btrim(coalesce(target_reason, '')), '');
  definition_id uuid;
  trigger_type text;
  trigger_config jsonb;
begin
  perform private.hr_automation_require_released();
  perform private.hr_automation_require_actor_permission(target_actor_id, 'hr.automation.manage');
  if clean_reason is null then raise check_violation using message = 'A publication reason is required.'; end if;
  update private.hr_workflow_versions version
  set status = 'published', published_by = target_actor_id, published_at = clock_timestamp()
  where version.id = target_version_id and version.status = 'draft'
  returning version.definition_id, version.trigger_type, version.trigger_config into definition_id, trigger_type, trigger_config;
  if definition_id is null then raise no_data_found using message = 'The draft workflow version is unavailable.'; end if;
  update private.hr_workflow_definitions
  set status = 'published', active_version_id = target_version_id, updated_by = target_actor_id, updated_at = clock_timestamp()
  where id = definition_id;
  if trigger_type = 'scheduled' then
    insert into private.hr_automation_schedules (workflow_version_id, next_run_at)
    values (target_version_id, coalesce(nullif(trigger_config->>'startsAt', '')::timestamptz, clock_timestamp()))
    on conflict (workflow_version_id) do update set next_run_at = excluded.next_run_at, updated_at = clock_timestamp();
  end if;
  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, actor_employee_id, reason, details)
  values ('workflow_version', target_version_id, 'published', target_actor_id, clean_reason, jsonb_build_object('definitionId', definition_id));
  return jsonb_build_object('definitionId', definition_id, 'versionId', target_version_id, 'status', 'published');
end;
$$;

create or replace function private.enqueue_hr_workflow_jobs(target_instance_id uuid, target_steps jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  insert into private.hr_automation_jobs (
    instance_id, step_key, sequence_number, job_type, payload, dependency_step_keys,
    idempotency_key, priority, max_attempts, run_after
  )
  select
    target_instance_id,
    step->>'key',
    ordinality::integer,
    step->>'type',
    coalesce(step->'config', '{}'::jsonb),
    case
      when jsonb_array_length(coalesce(step->'dependsOn', '[]'::jsonb)) > 0
        then array(select jsonb_array_elements_text(step->'dependsOn'))
      when ordinality > 1
        then array[target_steps->((ordinality - 2)::integer)->>'key']
      else array[]::text[]
    end,
    target_instance_id::text || ':' || step->>'key',
    greatest(1, least(1000, coalesce(nullif(step->>'priority', '')::integer, 100))),
    greatest(1, least(20, coalesce(nullif(step->>'maxAttempts', '')::integer, 5))),
    case when step->>'type' = 'delay'
      then clock_timestamp() + make_interval(secs => greatest(0, coalesce(nullif(step->'config'->>'seconds', '')::integer, 0)))
      else clock_timestamp()
    end
  from jsonb_array_elements(target_steps) with ordinality as item(step, ordinality)
  on conflict (instance_id, step_key) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.service_start_hr_workflow(
  target_actor_id uuid,
  target_workflow_version_id uuid,
  target_subject_employee_id uuid,
  target_idempotency_key text,
  target_context jsonb,
  target_due_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  instance_id uuid;
  workflow_steps jsonb;
  clean_key text := nullif(btrim(coalesce(target_idempotency_key, '')), '');
begin
  perform private.hr_automation_require_released();
  perform private.hr_automation_require_actor_permission(target_actor_id, 'hr.automation.operate');
  if clean_key is null then raise check_violation using message = 'An idempotency key is required.'; end if;
  select version.steps into workflow_steps from private.hr_workflow_versions version
  where version.id = target_workflow_version_id and version.status = 'published';
  if workflow_steps is null then raise no_data_found using message = 'A published workflow version is required.'; end if;
  insert into private.hr_workflow_instances (
    workflow_version_id, subject_employee_id, requested_by, idempotency_key, context, due_at
  ) values (
    target_workflow_version_id, target_subject_employee_id, target_actor_id, clean_key,
    coalesce(target_context, '{}'::jsonb), target_due_at
  ) on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning id into instance_id;
  perform private.enqueue_hr_workflow_jobs(instance_id, workflow_steps);
  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, actor_employee_id, details)
  values ('workflow_instance', instance_id, 'started', target_actor_id, jsonb_build_object('idempotencyKey', clean_key))
  on conflict do nothing;
  return jsonb_build_object('instanceId', instance_id, 'state', (select state from private.hr_workflow_instances where id = instance_id));
end;
$$;

create or replace function public.service_control_hr_workflow_instance(
  target_actor_id uuid,
  target_instance_id uuid,
  target_action text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_reason text := nullif(btrim(coalesce(target_reason, '')), '');
  next_state text;
begin
  perform private.hr_automation_require_released();
  perform private.hr_automation_require_actor_permission(target_actor_id, 'hr.automation.operate');
  if clean_reason is null then raise check_violation using message = 'A reason is required.'; end if;
  if target_action = 'pause' then next_state := 'paused';
  elsif target_action = 'resume' then next_state := 'running';
  elsif target_action = 'cancel' then next_state := 'cancelled';
  else raise check_violation using message = 'Choose pause, resume, or cancel.'; end if;
  update private.hr_workflow_instances instance
  set state = next_state,
      paused_at = case when next_state = 'paused' then clock_timestamp() else null end,
      cancelled_at = case when next_state = 'cancelled' then clock_timestamp() else instance.cancelled_at end,
      lock_version = lock_version + 1,
      updated_at = clock_timestamp()
  where instance.id = target_instance_id
    and ((target_action = 'pause' and instance.state in ('queued', 'running', 'waiting'))
      or (target_action = 'resume' and instance.state = 'paused')
      or (target_action = 'cancel' and instance.state not in ('completed', 'cancelled')));
  if not found then raise check_violation using message = 'The workflow is not in a state that supports this action.'; end if;
  if next_state = 'cancelled' then
    update private.hr_automation_jobs set state = 'cancelled', cancelled_at = clock_timestamp(), leased_until = null, leased_by = null, updated_at = clock_timestamp()
    where instance_id = target_instance_id and state not in ('completed', 'cancelled');
    update private.hr_workflow_tasks set status = 'cancelled', updated_at = clock_timestamp()
    where instance_id = target_instance_id and status in ('open', 'viewed');
  end if;
  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, actor_employee_id, reason)
  values (
    'workflow_instance',
    target_instance_id,
    case target_action when 'pause' then 'paused' when 'resume' then 'resumed' else 'cancelled' end,
    target_actor_id,
    clean_reason
  );
  return jsonb_build_object('instanceId', target_instance_id, 'state', next_state);
end;
$$;

create or replace function public.service_claim_hr_automation_jobs(
  target_worker_id text,
  target_limit integer default 10,
  target_lease_seconds integer default 120
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_automation_require_released();

  update private.hr_automation_jobs job
  set state = case when job.attempt_count >= job.max_attempts then 'dead_letter' else 'retry_wait' end,
      run_after = case when job.attempt_count >= job.max_attempts then job.run_after else clock_timestamp() end,
      leased_until = null,
      leased_by = null,
      last_error_code = 'lease_expired',
      last_error_message = 'The worker lease expired before the job completed.',
      updated_at = clock_timestamp()
  where job.state = 'leased' and job.leased_until < clock_timestamp();

  insert into private.hr_automation_dead_letters (job_id, instance_id, error_code, error_message, payload_snapshot)
  select job.id, job.instance_id, 'lease_expired', 'The worker lease expired after the maximum number of attempts.', job.payload
  from private.hr_automation_jobs job
  where job.state = 'dead_letter' and job.last_error_code = 'lease_expired'
  on conflict (job_id) do nothing;

  update private.hr_workflow_instances instance
  set state = 'failed',
      failure_code = 'lease_expired',
      failure_message = 'An automation step exhausted its retry attempts after a worker lease expired.',
      updated_at = clock_timestamp()
  where instance.id in (
    select job.instance_id
    from private.hr_automation_jobs job
    where job.state = 'dead_letter' and job.last_error_code = 'lease_expired'
  ) and instance.state not in ('completed', 'cancelled', 'failed');
  with candidates as (
    select job.id
    from private.hr_automation_jobs job
    join private.hr_workflow_instances instance on instance.id = job.instance_id
    where instance.state in ('queued', 'running', 'waiting')
      and job.state in ('queued', 'retry_wait')
      and job.run_after <= clock_timestamp()
      and not exists (
        select 1 from unnest(job.dependency_step_keys) dependency(step_key)
        where not exists (
          select 1 from private.hr_automation_jobs completed
          where completed.instance_id = job.instance_id
            and completed.step_key = dependency.step_key
            and completed.state in ('completed', 'cancelled')
        )
      )
    order by job.priority, job.run_after, job.created_at
    for update of job skip locked
    limit greatest(1, least(coalesce(target_limit, 10), 50))
  ), leased as (
    update private.hr_automation_jobs job
    set state = 'leased',
        attempt_count = job.attempt_count + 1,
        leased_by = nullif(btrim(target_worker_id), ''),
        leased_until = clock_timestamp() + make_interval(secs => greatest(30, least(coalesce(target_lease_seconds, 120), 900))),
        updated_at = clock_timestamp()
    from candidates where job.id = candidates.id
    returning job.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', leased.id, 'instanceId', leased.instance_id, 'stepKey', leased.step_key,
    'jobType', leased.job_type, 'payload', leased.payload, 'attemptCount', leased.attempt_count,
    'maxAttempts', leased.max_attempts, 'leasedUntil', leased.leased_until
  ) order by leased.priority, leased.created_at), '[]'::jsonb) into result from leased;
  update private.hr_workflow_instances instance
  set state = 'running', started_at = coalesce(started_at, clock_timestamp()), updated_at = clock_timestamp()
  where instance.id in (select (item->>'instanceId')::uuid from jsonb_array_elements(result) item)
    and instance.state = 'queued';
  return result;
end;
$$;

create or replace function public.service_complete_hr_automation_job(
  target_job_id uuid,
  target_result jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_record private.hr_automation_jobs%rowtype;
  instance_record private.hr_workflow_instances%rowtype;
  task_id uuid;
  notification_employee_id uuid;
  notification_payload jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_automation_require_released();
  select * into job_record from private.hr_automation_jobs where id = target_job_id for update;
  if job_record.id is null or job_record.state <> 'leased' or job_record.leased_until < clock_timestamp() then
    raise check_violation using message = 'The job lease is unavailable or expired.';
  end if;
  select * into instance_record from private.hr_workflow_instances where id = job_record.instance_id for update;
  if instance_record.state in ('paused', 'cancelled', 'completed') then raise check_violation using message = 'The workflow is not executable.'; end if;

  if job_record.job_type = 'human_task' then
    insert into private.hr_workflow_tasks (
      instance_id, step_key, assigned_employee_id, required_permission, title, instructions, due_at, action_center_visible
    ) values (
      job_record.instance_id, job_record.step_key,
      coalesce(nullif(job_record.payload->>'employeeId', '')::uuid, instance_record.subject_employee_id),
      nullif(job_record.payload->>'requiredPermission', ''),
      coalesce(nullif(btrim(job_record.payload->>'title'), ''), 'HR action required'),
      nullif(btrim(job_record.payload->>'instructions'), ''),
      coalesce(nullif(job_record.payload->>'dueAt', '')::timestamptz, instance_record.due_at),
      coalesce(nullif(job_record.payload->>'actionCenterVisible', '')::boolean, true)
    ) on conflict (instance_id, step_key, assigned_employee_id) do update
      set instructions = excluded.instructions, due_at = excluded.due_at, updated_at = clock_timestamp()
    returning id into task_id;
    update private.hr_automation_jobs set state = 'waiting_human', leased_until = null, leased_by = null, updated_at = clock_timestamp() where id = target_job_id;
    update private.hr_workflow_instances set state = 'waiting', current_step_key = job_record.step_key, updated_at = clock_timestamp() where id = job_record.instance_id;
  elsif job_record.job_type = 'notification' then
    notification_employee_id := coalesce(nullif(job_record.payload->>'recipientEmployeeId', '')::uuid, instance_record.subject_employee_id);
    notification_payload := coalesce(job_record.payload->'payload', jsonb_build_object('subject', job_record.payload->>'subject', 'message', job_record.payload->>'message'));
    if notification_employee_id is null then raise check_violation using message = 'A notification recipient is required.'; end if;
    insert into private.notification_outbox (
      message_type, aggregate_type, aggregate_id, recipient_employee_id, payload, idempotency_key
    ) values (
      coalesce(nullif(job_record.payload->>'messageType', ''), 'hr_workflow'), 'hr_workflow_instance',
      job_record.instance_id, notification_employee_id, notification_payload, 'hr-automation:' || job_record.id::text
    ) on conflict (idempotency_key) do nothing;
    update private.hr_automation_jobs set state = 'completed', completed_at = clock_timestamp(), leased_until = null, leased_by = null, updated_at = clock_timestamp() where id = target_job_id;
  elsif job_record.job_type = 'condition' then
    update private.hr_automation_jobs
    set state = 'cancelled', cancelled_at = clock_timestamp(), leased_until = null, leased_by = null, updated_at = clock_timestamp()
    where instance_id = job_record.instance_id
      and step_key = any(
        case when coalesce((target_result->>'conditionMatched')::boolean, false)
          then coalesce(array(select jsonb_array_elements_text(coalesce(job_record.payload->'onTrueCancelSteps', '[]'::jsonb))), array[]::text[])
          else coalesce(array(select jsonb_array_elements_text(coalesce(job_record.payload->'onFalseCancelSteps', '[]'::jsonb))), array[]::text[])
        end
      )
      and state in ('queued', 'retry_wait');
    update private.hr_automation_jobs
    set state = 'completed', completed_at = clock_timestamp(), leased_until = null, leased_by = null, updated_at = clock_timestamp()
    where id = target_job_id;
  else
    update private.hr_automation_jobs set state = 'completed', completed_at = clock_timestamp(), leased_until = null, leased_by = null, updated_at = clock_timestamp() where id = target_job_id;
  end if;

  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, details)
  values ('automation_job', target_job_id, case when job_record.job_type = 'human_task' then 'waiting_for_human' else 'completed' end, coalesce(target_result, '{}'::jsonb));

  if not exists (select 1 from private.hr_automation_jobs where instance_id = job_record.instance_id and state not in ('completed', 'cancelled')) then
    update private.hr_workflow_instances set state = 'completed', completed_at = clock_timestamp(), current_step_key = null, updated_at = clock_timestamp() where id = job_record.instance_id;
  end if;
  return jsonb_build_object('jobId', target_job_id, 'state', (select state from private.hr_automation_jobs where id = target_job_id), 'taskId', task_id);
end;
$$;

create or replace function public.service_fail_hr_automation_job(
  target_job_id uuid,
  target_error_code text,
  target_error_message text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_record private.hr_automation_jobs%rowtype;
  next_state text;
  delay_minutes integer;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  select * into job_record from private.hr_automation_jobs where id = target_job_id for update;
  if job_record.id is null or job_record.state <> 'leased' then raise check_violation using message = 'The leased job is unavailable.'; end if;
  next_state := case when job_record.attempt_count >= job_record.max_attempts then 'dead_letter' else 'retry_wait' end;
  delay_minutes := case job_record.attempt_count when 1 then 1 when 2 then 5 when 3 then 15 else 60 end;
  update private.hr_automation_jobs
  set state = next_state,
      run_after = case when next_state = 'retry_wait' then clock_timestamp() + make_interval(mins => delay_minutes) else run_after end,
      leased_until = null, leased_by = null,
      last_error_code = nullif(btrim(target_error_code), ''), last_error_message = left(coalesce(target_error_message, 'Unknown automation failure.'), 2000),
      updated_at = clock_timestamp()
  where id = target_job_id;
  if next_state = 'dead_letter' then
    insert into private.hr_automation_dead_letters (job_id, instance_id, error_code, error_message, payload_snapshot)
    values (target_job_id, job_record.instance_id, coalesce(nullif(btrim(target_error_code), ''), 'unknown'), left(coalesce(target_error_message, 'Unknown automation failure.'), 2000), job_record.payload)
    on conflict (job_id) do nothing;
    update private.hr_workflow_instances set state = 'failed', failure_code = target_error_code, failure_message = left(target_error_message, 2000), updated_at = clock_timestamp() where id = job_record.instance_id;
  end if;
  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, details)
  values ('automation_job', target_job_id, next_state, jsonb_build_object('attempt', job_record.attempt_count, 'errorCode', target_error_code, 'errorMessage', left(target_error_message, 2000)));
  return jsonb_build_object('jobId', target_job_id, 'state', next_state, 'runAfter', (select run_after from private.hr_automation_jobs where id = target_job_id));
end;
$$;

create or replace function public.service_complete_hr_workflow_task(
  target_actor_id uuid,
  target_task_id uuid,
  target_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  task_record private.hr_workflow_tasks%rowtype;
  effective_permissions text[];
  clean_note text := nullif(btrim(coalesce(target_note, '')), '');
begin
  perform private.hr_automation_require_released();
  effective_permissions := private.hr_automation_require_actor_permission(target_actor_id, 'actions.self.view');
  if clean_note is null then raise check_violation using message = 'A completion note is required.'; end if;
  select * into task_record from private.hr_workflow_tasks where id = target_task_id for update;
  if task_record.id is null or task_record.status not in ('open', 'viewed') then raise no_data_found using message = 'The HR task is no longer open.'; end if;
  if task_record.assigned_employee_id is distinct from target_actor_id
     and (task_record.required_permission is null or not task_record.required_permission = any(effective_permissions)) then
    raise insufficient_privilege using message = 'This HR task is assigned to someone else.';
  end if;
  update private.hr_workflow_tasks
  set status = 'completed', viewed_at = coalesce(viewed_at, clock_timestamp()), completed_by = target_actor_id,
      completed_at = clock_timestamp(), completion_note = clean_note, updated_at = clock_timestamp()
  where id = target_task_id;
  update private.hr_automation_jobs
  set state = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where instance_id = task_record.instance_id and step_key = task_record.step_key and state = 'waiting_human';
  update private.hr_workflow_instances
  set state = 'running', current_step_key = null, updated_at = clock_timestamp()
  where id = task_record.instance_id and state = 'waiting';
  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, actor_employee_id, reason, details)
  values ('workflow_task', target_task_id, 'completed', target_actor_id, clean_note, jsonb_build_object('instanceId', task_record.instance_id));
  if not exists (select 1 from private.hr_automation_jobs where instance_id = task_record.instance_id and state not in ('completed', 'cancelled')) then
    update private.hr_workflow_instances set state = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp() where id = task_record.instance_id;
  end if;
  return jsonb_build_object('taskId', target_task_id, 'status', 'completed', 'instanceId', task_record.instance_id);
end;
$$;

create or replace function public.service_override_hr_automation_job(
  target_actor_id uuid,
  target_job_id uuid,
  target_action text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_record private.hr_automation_jobs%rowtype;
  clean_reason text := nullif(btrim(coalesce(target_reason, '')), '');
begin
  perform private.hr_automation_require_released();
  perform private.hr_automation_require_actor_permission(target_actor_id, 'hr.automation.override');
  if clean_reason is null then raise check_violation using message = 'An override reason is required.'; end if;
  select * into job_record from private.hr_automation_jobs where id = target_job_id for update;
  if job_record.id is null then raise no_data_found using message = 'The automation job is unavailable.'; end if;
  if target_action = 'retry' then
    update private.hr_automation_jobs set state = 'queued', attempt_count = 0, run_after = clock_timestamp(), leased_until = null, leased_by = null, updated_at = clock_timestamp() where id = target_job_id and state = 'dead_letter';
    update private.hr_automation_dead_letters set replayed_by = target_actor_id, replayed_at = clock_timestamp(), replay_reason = clean_reason where job_id = target_job_id and replayed_at is null;
    update private.hr_workflow_instances set state = 'running', failure_code = null, failure_message = null, updated_at = clock_timestamp() where id = job_record.instance_id and state = 'failed';
  elsif target_action = 'complete' then
    update private.hr_automation_jobs set state = 'completed', completed_at = clock_timestamp(), leased_until = null, leased_by = null, updated_at = clock_timestamp() where id = target_job_id and state not in ('completed', 'cancelled');
  elsif target_action = 'cancel' then
    update private.hr_automation_jobs set state = 'cancelled', cancelled_at = clock_timestamp(), leased_until = null, leased_by = null, updated_at = clock_timestamp() where id = target_job_id and state <> 'completed';
  else raise check_violation using message = 'Choose retry, complete, or cancel.'; end if;
  if not found then raise check_violation using message = 'The selected override does not apply to this job state.'; end if;
  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, actor_employee_id, reason, details)
  values ('automation_job', target_job_id, 'manual_override_' || target_action, target_actor_id, clean_reason, jsonb_build_object('previousState', job_record.state));
  return jsonb_build_object('jobId', target_job_id, 'state', (select state from private.hr_automation_jobs where id = target_job_id));
end;
$$;

create or replace function public.service_enqueue_due_hr_automation(
  target_now timestamptz default clock_timestamp()
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  schedule_record record;
  interval_minutes integer;
  instance_id uuid;
  created_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_automation_require_released();
  for schedule_record in
    select schedule.*, version.steps, version.trigger_config
    from private.hr_automation_schedules schedule
    join private.hr_workflow_versions version on version.id = schedule.workflow_version_id and version.status = 'published'
    where schedule.next_run_at <= target_now
    order by schedule.next_run_at
    for update of schedule skip locked
  loop
    interval_minutes := greatest(5, least(coalesce(nullif(schedule_record.trigger_config->>'intervalMinutes', '')::integer, 1440), 525600));
    instance_id := null;
    insert into private.hr_workflow_instances (workflow_version_id, requested_by, idempotency_key, context)
    select schedule_record.workflow_version_id, definition.updated_by,
      'scheduled:' || schedule_record.workflow_version_id::text || ':' || to_char(schedule_record.next_run_at at time zone 'UTC', 'YYYYMMDDHH24MI'),
      jsonb_build_object('scheduledFor', schedule_record.next_run_at)
    from private.hr_workflow_versions version
    join private.hr_workflow_definitions definition on definition.id = version.definition_id
    where version.id = schedule_record.workflow_version_id
    on conflict (idempotency_key) do nothing returning id into instance_id;
    if instance_id is not null then
      perform private.enqueue_hr_workflow_jobs(instance_id, schedule_record.steps);
      created_count := created_count + 1;
    end if;
    update private.hr_automation_schedules
    set last_enqueued_at = schedule_record.next_run_at,
        next_run_at = schedule_record.next_run_at + make_interval(mins => interval_minutes),
        updated_at = clock_timestamp()
    where workflow_version_id = schedule_record.workflow_version_id;
  end loop;
  return created_count;
end;
$$;

alter table private.hr_automation_jobs enable row level security;
alter table private.hr_automation_dead_letters enable row level security;
alter table private.hr_automation_schedules enable row level security;

revoke all on table private.hr_automation_jobs from public, anon, authenticated;
revoke all on table private.hr_automation_dead_letters from public, anon, authenticated;
revoke all on table private.hr_automation_schedules from public, anon, authenticated;
revoke all on function public.service_set_hr_automation_release_gate(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.service_save_hr_workflow_draft(uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.service_publish_hr_workflow_version(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.service_start_hr_workflow(uuid, uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.service_control_hr_workflow_instance(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_claim_hr_automation_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.service_complete_hr_automation_job(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.service_fail_hr_automation_job(uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_complete_hr_workflow_task(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.service_override_hr_automation_job(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_enqueue_due_hr_automation(timestamptz) from public, anon, authenticated;
grant execute on function public.service_set_hr_automation_release_gate(uuid, boolean, text) to service_role;
grant execute on function public.service_save_hr_workflow_draft(uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, text) to service_role;
grant execute on function public.service_publish_hr_workflow_version(uuid, uuid, text) to service_role;
grant execute on function public.service_start_hr_workflow(uuid, uuid, uuid, text, jsonb, timestamptz) to service_role;
grant execute on function public.service_control_hr_workflow_instance(uuid, uuid, text, text) to service_role;
grant execute on function public.service_claim_hr_automation_jobs(text, integer, integer) to service_role;
grant execute on function public.service_complete_hr_automation_job(uuid, jsonb) to service_role;
grant execute on function public.service_fail_hr_automation_job(uuid, text, text) to service_role;
grant execute on function public.service_complete_hr_workflow_task(uuid, uuid, text) to service_role;
grant execute on function public.service_override_hr_automation_job(uuid, uuid, text, text) to service_role;
grant execute on function public.service_enqueue_due_hr_automation(timestamptz) to service_role;

do $$
declare baseline record;
begin
  select * into baseline from hris_stage5_run2_preservation_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
     or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
     or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
     or baseline.override_count <> (select count(*) from public.employee_permission_overrides) then
    raise exception 'Stage 5 run 2 changed protected employee or access-control assignments.';
  end if;
  if exists (select 1 from private.hr_automation_release_gate where singleton and enabled) then
    raise exception 'Stage 5 automation release gate must remain disabled.';
  end if;
end;
$$;

commit;
