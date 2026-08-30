begin;

-- Stage 5, run 1: dormant, versioned HR automation foundation. No permission is
-- assigned here and the release gate remains disabled after deployment.
create temporary table hris_stage5_run1_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.employee_accounts) as account_count;

insert into public.permission_catalog
  (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  ('hr.automation.view', 'HR & Finance', 'View HR automation', 'View approved HR workflow definitions, runs, human tasks, and delivery status.', 'sensitive', true, false, true),
  ('hr.automation.manage', 'HR & Finance', 'Manage HR automation', 'Create and publish versioned HR workflow definitions.', 'critical', true, false, true),
  ('hr.automation.operate', 'HR & Finance', 'Operate HR automation', 'Start, pause, resume, cancel, retry, and complete HR workflow work.', 'critical', true, false, true),
  ('hr.automation.override', 'HR & Finance', 'Override HR automation', 'Apply a documented manual override to a specific HR workflow occurrence.', 'critical', true, false, true)
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    active = excluded.active,
    updated_at = clock_timestamp();

create table if not exists private.hr_automation_release_gate (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  enabled_at timestamptz,
  enabled_by uuid references public.employees(id) on delete restrict,
  evidence text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_automation_release_evidence_required check (not enabled or nullif(btrim(evidence), '') is not null)
);

insert into private.hr_automation_release_gate (singleton, enabled)
values (true, false)
on conflict (singleton) do nothing;

create table if not exists private.hr_workflow_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  status text not null default 'draft',
  active_version_id uuid,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_by uuid not null references public.employees(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_workflow_definition_code_format check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint hr_workflow_definition_name_present check (nullif(btrim(name), '') is not null),
  constraint hr_workflow_definition_status_check check (status in ('draft', 'published', 'retired'))
);

create table if not exists private.hr_workflow_versions (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references private.hr_workflow_definitions(id) on delete restrict,
  version_number integer not null,
  status text not null default 'draft',
  trigger_type text not null,
  trigger_config jsonb not null default '{}'::jsonb,
  input_schema jsonb not null default '{}'::jsonb,
  steps jsonb not null,
  change_note text not null,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  published_by uuid references public.employees(id) on delete restrict,
  published_at timestamptz,
  retired_by uuid references public.employees(id) on delete restrict,
  retired_at timestamptz,
  unique (definition_id, version_number),
  constraint hr_workflow_version_positive check (version_number > 0),
  constraint hr_workflow_version_status_check check (status in ('draft', 'published', 'retired')),
  constraint hr_workflow_trigger_type_check check (trigger_type in ('manual', 'event', 'scheduled')),
  constraint hr_workflow_steps_array check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) > 0),
  constraint hr_workflow_change_note_present check (nullif(btrim(change_note), '') is not null),
  constraint hr_workflow_publish_fields check ((status = 'draft' and published_at is null and published_by is null) or (status <> 'draft' and published_at is not null and published_by is not null))
);

alter table private.hr_workflow_definitions
  drop constraint if exists hr_workflow_definitions_active_version_id_fkey;
alter table private.hr_workflow_definitions
  add constraint hr_workflow_definitions_active_version_id_fkey
  foreign key (active_version_id) references private.hr_workflow_versions(id) on delete restrict;

create table if not exists private.hr_workflow_instances (
  id uuid primary key default gen_random_uuid(),
  workflow_version_id uuid not null references private.hr_workflow_versions(id) on delete restrict,
  subject_employee_id uuid references public.employees(id) on delete restrict,
  requested_by uuid not null references public.employees(id) on delete restrict,
  idempotency_key text not null unique,
  state text not null default 'queued',
  context jsonb not null default '{}'::jsonb,
  current_step_key text,
  due_at timestamptz,
  started_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  failure_code text,
  failure_message text,
  lock_version integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_workflow_instance_idempotency_present check (nullif(btrim(idempotency_key), '') is not null),
  constraint hr_workflow_instance_state_check check (state in ('queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled')),
  constraint hr_workflow_instance_lock_positive check (lock_version > 0)
);

create table if not exists private.hr_workflow_tasks (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references private.hr_workflow_instances(id) on delete restrict,
  step_key text not null,
  assigned_employee_id uuid references public.employees(id) on delete restrict,
  required_permission text references public.permission_catalog(code) on delete restrict,
  title text not null,
  instructions text,
  status text not null default 'open',
  due_at timestamptz,
  viewed_at timestamptz,
  completed_by uuid references public.employees(id) on delete restrict,
  completed_at timestamptz,
  completion_note text,
  action_center_visible boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (instance_id, step_key, assigned_employee_id),
  constraint hr_workflow_task_step_present check (nullif(btrim(step_key), '') is not null),
  constraint hr_workflow_task_title_present check (nullif(btrim(title), '') is not null),
  constraint hr_workflow_task_assignee_check check (assigned_employee_id is not null or required_permission is not null),
  constraint hr_workflow_task_status_check check (status in ('open', 'viewed', 'completed', 'cancelled', 'expired')),
  constraint hr_workflow_task_completion_check check ((status = 'completed' and completed_by is not null and completed_at is not null and nullif(btrim(completion_note), '') is not null) or status <> 'completed')
);

create table if not exists private.hr_automation_events (
  id bigint generated always as identity primary key,
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  actor_employee_id uuid references public.employees(id) on delete restrict,
  reason text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_automation_event_aggregate_present check (nullif(btrim(aggregate_type), '') is not null),
  constraint hr_automation_event_type_present check (nullif(btrim(event_type), '') is not null)
);

create index if not exists hr_workflow_versions_definition_idx on private.hr_workflow_versions(definition_id, version_number desc);
create index if not exists hr_workflow_instances_state_idx on private.hr_workflow_instances(state, due_at, created_at);
create index if not exists hr_workflow_instances_subject_idx on private.hr_workflow_instances(subject_employee_id, created_at desc);
create index if not exists hr_workflow_tasks_assignee_idx on private.hr_workflow_tasks(assigned_employee_id, status, due_at) where action_center_visible;
create index if not exists hr_workflow_tasks_permission_idx on private.hr_workflow_tasks(required_permission, status, due_at) where action_center_visible;
create index if not exists hr_automation_events_aggregate_idx on private.hr_automation_events(aggregate_type, aggregate_id, occurred_at desc);

create or replace function private.hr_automation_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise check_violation using message = 'HR automation audit events are append-only.';
end;
$$;

drop trigger if exists hr_automation_events_append_only on private.hr_automation_events;
create trigger hr_automation_events_append_only
before update or delete on private.hr_automation_events
for each row execute function private.hr_automation_events_append_only();

create or replace function private.hr_workflow_version_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and old.status <> 'draft' then
    raise check_violation using message = 'Published HR workflow versions cannot be deleted.';
  end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    if not (
      old.status = 'published'
      and new.status = 'retired'
      and new.definition_id = old.definition_id
      and new.version_number = old.version_number
      and new.trigger_type = old.trigger_type
      and new.trigger_config = old.trigger_config
      and new.input_schema = old.input_schema
      and new.steps = old.steps
      and new.change_note = old.change_note
      and new.created_by = old.created_by
      and new.created_at = old.created_at
      and new.published_by = old.published_by
      and new.published_at = old.published_at
      and new.retired_by is not null
      and new.retired_at is not null
    ) then
      raise check_violation using message = 'Published HR workflow versions are immutable. Publish a new version instead.';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists hr_workflow_version_immutable on private.hr_workflow_versions;
create trigger hr_workflow_version_immutable
before update or delete on private.hr_workflow_versions
for each row execute function private.hr_workflow_version_immutable();

create or replace function private.validate_hr_workflow_steps(target_steps jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(target_steps) = 'array'
    and jsonb_array_length(target_steps) between 1 and 50
    and not exists (
      select 1
      from jsonb_array_elements(target_steps) step
      where jsonb_typeof(step) <> 'object'
         or nullif(btrim(step->>'key'), '') is null
         or step->>'type' not in ('human_task', 'notification', 'delay', 'condition', 'complete')
         or (step ? 'dependsOn' and jsonb_typeof(step->'dependsOn') <> 'array')
    )
    and (
      select count(*) = count(distinct step->>'key')
      from jsonb_array_elements(target_steps) step
    )
    and not exists (
      select 1
      from jsonb_array_elements(target_steps) step
      cross join lateral jsonb_array_elements(coalesce(step->'dependsOn', '[]'::jsonb)) dependency
      where jsonb_typeof(dependency) <> 'string'
         or nullif(btrim(dependency #>> '{}'), '') is null
         or dependency #>> '{}' = step->>'key'
         or not exists (
           select 1
           from jsonb_array_elements(target_steps) candidate
           where candidate->>'key' = dependency #>> '{}'
         )
    );
$$;

create or replace function private.hr_workflow_steps_validate_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.validate_hr_workflow_steps(new.steps) then
    raise check_violation using message = 'Workflow steps require 1–50 uniquely keyed supported steps.';
  end if;
  return new;
end;
$$;

drop trigger if exists hr_workflow_steps_validate on private.hr_workflow_versions;
create trigger hr_workflow_steps_validate
before insert or update of steps on private.hr_workflow_versions
for each row execute function private.hr_workflow_steps_validate_trigger();

alter table private.hr_automation_release_gate enable row level security;
alter table private.hr_workflow_definitions enable row level security;
alter table private.hr_workflow_versions enable row level security;
alter table private.hr_workflow_instances enable row level security;
alter table private.hr_workflow_tasks enable row level security;
alter table private.hr_automation_events enable row level security;

revoke all on table private.hr_automation_release_gate from public, anon, authenticated;
revoke all on table private.hr_workflow_definitions from public, anon, authenticated;
revoke all on table private.hr_workflow_versions from public, anon, authenticated;
revoke all on table private.hr_workflow_instances from public, anon, authenticated;
revoke all on table private.hr_workflow_tasks from public, anon, authenticated;
revoke all on table private.hr_automation_events from public, anon, authenticated;

do $$
declare
  baseline record;
begin
  select * into baseline from hris_stage5_run1_preservation_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
     or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
     or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
     or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
     or baseline.account_count <> (select count(*) from private.employee_accounts) then
    raise exception 'Stage 5 run 1 changed protected employee or access-control assignments.';
  end if;
  if exists (select 1 from private.hr_automation_release_gate where singleton and enabled) then
    raise exception 'Stage 5 automation release gate must remain disabled.';
  end if;
end;
$$;

commit;
