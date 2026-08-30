begin;

-- Stage 2, run 1 installs an additive, feature-off HR data contract. It does not
-- backfill protected production records or change any current role assignment.
create temporary table hris_stage2_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count;

create table private.hr_person_identifiers (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null unique references public.employees(id) on delete restrict,
  source_system text not null default 'sygshift_employee',
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references public.employees(id) on delete restrict,
  constraint hr_person_source_present check (btrim(source_system) <> '')
);

create table private.hr_worker_identifiers (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null unique references private.hr_person_identifiers(id) on delete restrict,
  worker_reference text unique,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references public.employees(id) on delete restrict,
  constraint hr_worker_reference_present check (worker_reference is null or btrim(worker_reference) <> '')
);

create table private.hr_legal_entities (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_legal_entity_code_format check (code ~ '^[A-Z][A-Z0-9_-]*$'),
  constraint hr_legal_entity_name_present check (btrim(name) <> '')
);

create table private.hr_organization_units (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references private.hr_legal_entities(id) on delete restrict,
  parent_id uuid references private.hr_organization_units(id) on delete restrict,
  code text not null unique,
  name text not null,
  unit_type text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_org_code_format check (code ~ '^[A-Z][A-Z0-9_-]*$'),
  constraint hr_org_name_present check (btrim(name) <> ''),
  constraint hr_org_unit_type check (unit_type in ('company', 'division', 'department', 'team', 'cost_center')),
  constraint hr_org_not_own_parent check (parent_id is null or parent_id <> id)
);

create table private.hr_work_locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  site_id uuid unique references public.sites(id) on delete restrict,
  time_zone text not null default 'America/Denver',
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_location_code_format check (code ~ '^[A-Z][A-Z0-9_-]*$'),
  constraint hr_location_name_present check (btrim(name) <> ''),
  constraint hr_location_time_zone_present check (btrim(time_zone) <> '')
);

create table private.hr_job_profiles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  description text,
  classification text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_job_code_format check (code ~ '^[A-Z][A-Z0-9_-]*$'),
  constraint hr_job_title_present check (btrim(title) <> ''),
  constraint hr_job_classification check (classification in ('employee', 'contractor', 'temporary', 'intern', 'volunteer'))
);

create table private.hr_positions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  job_profile_id uuid not null references private.hr_job_profiles(id) on delete restrict,
  organization_unit_id uuid not null references private.hr_organization_units(id) on delete restrict,
  location_id uuid references private.hr_work_locations(id) on delete restrict,
  headcount_limit integer not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_position_code_format check (code ~ '^[A-Z][A-Z0-9_-]*$'),
  constraint hr_position_title_present check (btrim(title) <> ''),
  constraint hr_position_headcount_positive check (headcount_limit > 0)
);

create table private.hr_employment_relationships (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references private.hr_worker_identifiers(id) on delete restrict,
  legal_entity_id uuid not null references private.hr_legal_entities(id) on delete restrict,
  status text not null,
  worker_classification text not null,
  employment_type text not null,
  effective_start date not null,
  effective_end date,
  change_reason text not null,
  source_system text not null default 'sygshift_hris',
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references public.employees(id) on delete restrict,
  closed_at timestamptz,
  closed_by uuid references public.employees(id) on delete restrict,
  close_reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_employment_status check (status in ('prehire', 'active', 'leave', 'separated', 'terminated')),
  constraint hr_employment_classification check (worker_classification in ('employee', 'contractor', 'temporary', 'intern', 'volunteer')),
  constraint hr_employment_type check (employment_type in ('hourly', 'salary', 'flex')),
  constraint hr_employment_dates check (effective_end is null or effective_end >= effective_start),
  constraint hr_employment_reason_present check (btrim(change_reason) <> ''),
  constraint hr_employment_close_consistent check (
    (effective_end is null and closed_at is null and closed_by is null and close_reason is null)
    or (effective_end is not null and closed_at is not null and closed_by is not null and btrim(coalesce(close_reason, '')) <> '')
  )
);

create table private.hr_assignments (
  id uuid primary key default gen_random_uuid(),
  employment_id uuid not null references private.hr_employment_relationships(id) on delete restrict,
  position_id uuid not null references private.hr_positions(id) on delete restrict,
  organization_unit_id uuid not null references private.hr_organization_units(id) on delete restrict,
  cost_center_id uuid references private.hr_organization_units(id) on delete restrict,
  location_id uuid references private.hr_work_locations(id) on delete restrict,
  assignment_type text not null default 'regular',
  primary_assignment boolean not null default true,
  effective_start date not null,
  effective_end date,
  change_reason text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references public.employees(id) on delete restrict,
  closed_at timestamptz,
  closed_by uuid references public.employees(id) on delete restrict,
  close_reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_assignment_type check (assignment_type in ('regular', 'temporary', 'acting', 'secondary')),
  constraint hr_assignment_dates check (effective_end is null or effective_end >= effective_start),
  constraint hr_assignment_reason_present check (btrim(change_reason) <> ''),
  constraint hr_assignment_close_consistent check (
    (effective_end is null and closed_at is null and closed_by is null and close_reason is null)
    or (effective_end is not null and closed_at is not null and closed_by is not null and btrim(coalesce(close_reason, '')) <> '')
  )
);

create table private.hr_manager_relationships (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references private.hr_assignments(id) on delete restrict,
  manager_worker_id uuid not null references private.hr_worker_identifiers(id) on delete restrict,
  relationship_type text not null default 'direct',
  effective_start date not null,
  effective_end date,
  change_reason text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references public.employees(id) on delete restrict,
  closed_at timestamptz,
  closed_by uuid references public.employees(id) on delete restrict,
  close_reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_manager_type check (relationship_type in ('direct', 'matrix', 'functional')),
  constraint hr_manager_dates check (effective_end is null or effective_end >= effective_start),
  constraint hr_manager_reason_present check (btrim(change_reason) <> ''),
  constraint hr_manager_close_consistent check (
    (effective_end is null and closed_at is null and closed_by is null and close_reason is null)
    or (effective_end is not null and closed_at is not null and closed_by is not null and btrim(coalesce(close_reason, '')) <> '')
  )
);

create table private.hr_employment_changes (
  id uuid primary key default gen_random_uuid(),
  employment_id uuid not null references private.hr_employment_relationships(id) on delete restrict,
  assignment_id uuid references private.hr_assignments(id) on delete restrict,
  change_type text not null,
  effective_on date not null,
  reason text not null,
  source_reference text,
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references public.employees(id) on delete restrict,
  constraint hr_employment_change_type check (change_type in ('hire', 'rehire', 'transfer', 'promotion', 'demotion', 'classification', 'status', 'leave', 'return', 'separation', 'correction')),
  constraint hr_employment_change_reason_present check (btrim(reason) <> '')
);

create table private.hr_compensation_changes (
  id uuid primary key default gen_random_uuid(),
  employment_id uuid not null references private.hr_employment_relationships(id) on delete restrict,
  component_code text not null default 'base_pay',
  amount numeric(14, 4) not null,
  currency_code char(3) not null default 'USD',
  pay_basis text not null,
  standard_weekly_hours numeric(6, 2),
  effective_start date not null,
  effective_end date,
  change_reason text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references public.employees(id) on delete restrict,
  closed_at timestamptz,
  closed_by uuid references public.employees(id) on delete restrict,
  close_reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_compensation_component_present check (btrim(component_code) <> ''),
  constraint hr_compensation_amount_nonnegative check (amount >= 0),
  constraint hr_compensation_currency_format check (currency_code ~ '^[A-Z]{3}$'),
  constraint hr_compensation_basis check (pay_basis in ('hourly', 'salary', 'stipend', 'bonus', 'allowance')),
  constraint hr_compensation_hours_valid check (standard_weekly_hours is null or standard_weekly_hours between 0 and 168),
  constraint hr_compensation_dates check (effective_end is null or effective_end >= effective_start),
  constraint hr_compensation_reason_present check (btrim(change_reason) <> ''),
  constraint hr_compensation_close_consistent check (
    (effective_end is null and closed_at is null and closed_by is null and close_reason is null)
    or (effective_end is not null and closed_at is not null and closed_by is not null and btrim(coalesce(close_reason, '')) <> '')
  )
);

create index hr_employment_worker_effective_idx on private.hr_employment_relationships(worker_id, effective_start, effective_end);
create index hr_assignments_employment_effective_idx on private.hr_assignments(employment_id, effective_start, effective_end);
create index hr_manager_assignment_effective_idx on private.hr_manager_relationships(assignment_id, relationship_type, effective_start, effective_end);
create index hr_compensation_employment_effective_idx on private.hr_compensation_changes(employment_id, component_code, effective_start, effective_end);

create function private.hris_prevent_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% records cannot be deleted; deactivate, close, or supersede the record.', tg_table_name;
end
$$;

create function private.hris_protect_effective_record()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_fixed jsonb;
  new_fixed jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception '% history is permanent and cannot be deleted.', tg_table_name;
  end if;

  old_fixed := to_jsonb(old) - array['effective_end', 'closed_at', 'closed_by', 'close_reason', 'updated_at'];
  new_fixed := to_jsonb(new) - array['effective_end', 'closed_at', 'closed_by', 'close_reason', 'updated_at'];
  if old_fixed <> new_fixed then
    raise exception '% history can only be closed; create a new effective-dated record for other changes.', tg_table_name;
  end if;
  if old.effective_end is not null then
    raise exception '% history is already closed and cannot be changed.', tg_table_name;
  end if;
  if new.effective_end is null or new.effective_end < new.effective_start then
    raise exception 'Closing % requires a valid effective end date.', tg_table_name;
  end if;
  if new.closed_at is null or new.closed_by is null or btrim(coalesce(new.close_reason, '')) = '' then
    raise exception 'Closing % requires an actor, timestamp, and reason.', tg_table_name;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;

create function private.hris_prevent_effective_overlap()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  conflict_exists boolean := false;
begin
  if tg_table_name = 'hr_employment_relationships' then
    select exists (
      select 1 from private.hr_employment_relationships existing
      where existing.worker_id = new.worker_id
        and existing.legal_entity_id = new.legal_entity_id
        and existing.id <> new.id
        and daterange(existing.effective_start, coalesce(existing.effective_end + 1, 'infinity'::date), '[)')
          && daterange(new.effective_start, coalesce(new.effective_end + 1, 'infinity'::date), '[)')
    ) into conflict_exists;
  elsif tg_table_name = 'hr_assignments' and new.primary_assignment then
    select exists (
      select 1 from private.hr_assignments existing
      where existing.employment_id = new.employment_id
        and existing.primary_assignment
        and existing.id <> new.id
        and daterange(existing.effective_start, coalesce(existing.effective_end + 1, 'infinity'::date), '[)')
          && daterange(new.effective_start, coalesce(new.effective_end + 1, 'infinity'::date), '[)')
    ) into conflict_exists;
  elsif tg_table_name = 'hr_manager_relationships' then
    if exists (
      select 1
      from private.hr_assignments assignment
      join private.hr_employment_relationships employment on employment.id = assignment.employment_id
      where assignment.id = new.assignment_id
        and employment.worker_id = new.manager_worker_id
    ) then
      raise exception 'A worker cannot be assigned as their own manager.';
    end if;

    select exists (
      select 1 from private.hr_manager_relationships existing
      where existing.assignment_id = new.assignment_id
        and existing.relationship_type = new.relationship_type
        and existing.id <> new.id
        and daterange(existing.effective_start, coalesce(existing.effective_end + 1, 'infinity'::date), '[)')
          && daterange(new.effective_start, coalesce(new.effective_end + 1, 'infinity'::date), '[)')
    ) into conflict_exists;
  elsif tg_table_name = 'hr_compensation_changes' then
    select exists (
      select 1 from private.hr_compensation_changes existing
      where existing.employment_id = new.employment_id
        and existing.component_code = new.component_code
        and existing.id <> new.id
        and daterange(existing.effective_start, coalesce(existing.effective_end + 1, 'infinity'::date), '[)')
          && daterange(new.effective_start, coalesce(new.effective_end + 1, 'infinity'::date), '[)')
    ) into conflict_exists;
  end if;

  if conflict_exists then
    raise exception '% has an overlapping effective-dated record.', tg_table_name;
  end if;
  return new;
end
$$;

create function private.hris_core_reconciliation_report()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'employeeCount', (select count(*) from public.employees),
    'activeEmployeeCount', (select count(*) from public.employees where status = 'active'),
    'separatedEmployeeCount', (select count(*) from public.employees where status <> 'active'),
    'personIdentifierCount', (select count(*) from private.hr_person_identifiers),
    'workerIdentifierCount', (select count(*) from private.hr_worker_identifiers),
    'unresolvedEmployeeCount', (
      select count(*) from public.employees employee
      left join private.hr_person_identifiers person on person.employee_id = employee.id
      where person.id is null
    ),
    'duplicateEmployeeMappings', (
      select count(*) from (
        select employee_id from private.hr_person_identifiers group by employee_id having count(*) > 1
      ) duplicate
    ),
    'orphanWorkerCount', (
      select count(*) from private.hr_worker_identifiers worker
      left join private.hr_person_identifiers person on person.id = worker.person_id
      where person.id is null
    ),
    'generatedAt', clock_timestamp()
  )
$$;

create function private.assert_hris_core_integrity()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  report jsonb;
begin
  report := private.hris_core_reconciliation_report();
  if (report ->> 'duplicateEmployeeMappings')::bigint <> 0
    or (report ->> 'orphanWorkerCount')::bigint <> 0 then
    raise exception 'HRIS core identity integrity check failed.';
  end if;
  return report || jsonb_build_object('integrity', 'passed');
end
$$;

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'hr_person_identifiers',
    'hr_worker_identifiers',
    'hr_legal_entities',
    'hr_organization_units',
    'hr_work_locations',
    'hr_job_profiles',
    'hr_positions',
    'hr_employment_relationships',
    'hr_assignments',
    'hr_manager_relationships',
    'hr_employment_changes',
    'hr_compensation_changes'
  ] loop
    execute format('alter table private.%I enable row level security', relation_name);
    execute format('create trigger %I after insert or update or delete on private.%I for each row execute function private.write_audit_event()', relation_name || '_audit', relation_name);
  end loop;

  foreach relation_name in array array[
    'hr_person_identifiers',
    'hr_worker_identifiers',
    'hr_employment_changes'
  ] loop
    execute format('create trigger %I before update or delete on private.%I for each row execute function private.prevent_append_only_change()', relation_name || '_append_only', relation_name);
  end loop;

  foreach relation_name in array array[
    'hr_legal_entities',
    'hr_organization_units',
    'hr_work_locations',
    'hr_job_profiles',
    'hr_positions'
  ] loop
    execute format('create trigger %I before delete on private.%I for each row execute function private.hris_prevent_delete()', relation_name || '_no_delete', relation_name);
    execute format('create trigger %I before update on private.%I for each row execute function private.set_updated_at()', relation_name || '_updated_at', relation_name);
  end loop;

  foreach relation_name in array array[
    'hr_employment_relationships',
    'hr_assignments',
    'hr_manager_relationships',
    'hr_compensation_changes'
  ] loop
    execute format('create trigger %I before update or delete on private.%I for each row execute function private.hris_protect_effective_record()', relation_name || '_history_protection', relation_name);
    execute format('create trigger %I before insert or update on private.%I for each row execute function private.hris_prevent_effective_overlap()', relation_name || '_overlap', relation_name);
  end loop;
end
$$;

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  ('hr.people.view', 'HR & Finance', 'View HR employee records', 'View approved non-restricted employment records.', 'sensitive', true, true, true),
  ('hr.people.manage', 'HR & Finance', 'Manage HR employee records', 'Create and maintain approved effective-dated HR records.', 'critical', true, true, true),
  ('hr.people.restricted', 'HR & Finance', 'View restricted HR records', 'View restricted HR employee information when separately authorized.', 'critical', true, true, true),
  ('hr.total_rewards.view', 'HR & Finance', 'View total rewards', 'View approved compensation and total-rewards summaries.', 'critical', true, true, true),
  ('hr.total_rewards.manage', 'HR & Finance', 'Manage total rewards', 'Maintain effective-dated compensation and total-rewards records.', 'critical', true, true, true),
  ('hr.total_rewards.restricted', 'HR & Finance', 'View restricted total rewards', 'View restricted compensation details when separately authorized.', 'critical', true, true, true)
on conflict (code) do nothing;

revoke all on
  private.hr_person_identifiers,
  private.hr_worker_identifiers,
  private.hr_legal_entities,
  private.hr_organization_units,
  private.hr_work_locations,
  private.hr_job_profiles,
  private.hr_positions,
  private.hr_employment_relationships,
  private.hr_assignments,
  private.hr_manager_relationships,
  private.hr_employment_changes,
  private.hr_compensation_changes
from public, anon, authenticated;

grant select, insert on private.hr_person_identifiers, private.hr_worker_identifiers, private.hr_employment_changes to service_role;
grant select, insert, update on
  private.hr_legal_entities,
  private.hr_organization_units,
  private.hr_work_locations,
  private.hr_job_profiles,
  private.hr_positions,
  private.hr_employment_relationships,
  private.hr_assignments,
  private.hr_manager_relationships,
  private.hr_compensation_changes
to service_role;

revoke all on function private.hris_core_reconciliation_report() from public, anon, authenticated;
revoke all on function private.assert_hris_core_integrity() from public, anon, authenticated;
grant execute on function private.hris_core_reconciliation_report() to service_role;
grant execute on function private.assert_hris_core_integrity() to service_role;

do $$
declare
  baseline_employee_count bigint;
  baseline_employee_role_count bigint;
  baseline_role_permission_count bigint;
  baseline_override_count bigint;
begin
  select employee_count, employee_role_count, role_permission_count, override_count
    into baseline_employee_count, baseline_employee_role_count, baseline_role_permission_count, baseline_override_count
  from hris_stage2_preservation_baseline;

  if baseline_employee_count <> (select count(*) from public.employees)
    or baseline_employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline_role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline_override_count <> (select count(*) from public.employee_permission_overrides) then
    raise exception 'Stage 2 migration changed protected employee or access-control records.';
  end if;
end
$$;

commit;
