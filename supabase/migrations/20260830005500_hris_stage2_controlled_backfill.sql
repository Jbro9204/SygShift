begin;

-- Stage 2, run 3 installs the controlled identity-backfill plane. The release
-- gate is created closed. This migration does not backfill a production record.
create temporary table hris_stage2_run3_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.hr_person_identifiers) as person_identifier_count,
  (select count(*) from private.hr_worker_identifiers) as worker_identifier_count;

create table private.hr_stage2_effective_date_authorizations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  hired_on date not null,
  separated_on date,
  source_type text not null,
  source_reference text not null,
  reason text not null,
  source_status text not null,
  authorized_by uuid not null references public.employees(id) on delete restrict,
  authorized_at timestamptz not null default clock_timestamp(),
  supersedes_id uuid unique references private.hr_stage2_effective_date_authorizations(id) on delete restrict,
  constraint hr_stage2_effective_dates_order check (separated_on is null or separated_on >= hired_on),
  constraint hr_stage2_effective_dates_source check (
    source_type in ('hr_export', 'employee_file', 'verified_hr_record', 'verified_manual')
  ),
  constraint hr_stage2_effective_dates_reference_present check (btrim(source_reference) <> ''),
  constraint hr_stage2_effective_dates_reason_present check (btrim(reason) <> ''),
  constraint hr_stage2_effective_dates_status_present check (btrim(source_status) <> '')
);

create index hr_stage2_effective_dates_employee_idx
  on private.hr_stage2_effective_date_authorizations (employee_id, authorized_at desc);

create table private.hr_stage2_recovery_evidence (
  id uuid primary key default gen_random_uuid(),
  evidence_type text not null,
  evidence_reference text not null,
  evidence_sha256 text not null,
  notes text not null,
  verified_by uuid not null references public.employees(id) on delete restrict,
  verified_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint hr_stage2_recovery_evidence_type check (evidence_type = 'isolated_restore_test'),
  constraint hr_stage2_recovery_evidence_reference_present check (btrim(evidence_reference) <> ''),
  constraint hr_stage2_recovery_evidence_digest check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  constraint hr_stage2_recovery_evidence_notes_present check (btrim(notes) <> ''),
  constraint hr_stage2_recovery_evidence_expiry check (expires_at > verified_at)
);

create index hr_stage2_recovery_evidence_validity_idx
  on private.hr_stage2_recovery_evidence (expires_at desc, verified_at desc);

create table private.hr_stage2_backfill_gate (
  singleton boolean primary key default true,
  enabled boolean not null default false,
  reason text not null default 'Stage 2 protected backfill remains disabled.',
  changed_by uuid references public.employees(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp(),
  constraint hr_stage2_backfill_gate_singleton check (singleton),
  constraint hr_stage2_backfill_gate_reason_present check (btrim(reason) <> '')
);

insert into private.hr_stage2_backfill_gate (singleton, enabled, reason)
values (true, false, 'Stage 2 protected backfill remains disabled.');

create table private.hr_stage2_backfill_authorizations (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  employee_ids uuid[] not null default array[]::uuid[],
  reason text not null,
  authorized_by uuid not null references public.employees(id) on delete restrict,
  authorized_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  recovery_evidence_id uuid not null references private.hr_stage2_recovery_evidence(id) on delete restrict,
  proposal_summary jsonb not null,
  authorization_snapshot jsonb not null,
  constraint hr_stage2_backfill_authorization_scope check (scope in ('canary', 'full')),
  constraint hr_stage2_backfill_authorization_reason_present check (btrim(reason) <> ''),
  constraint hr_stage2_backfill_authorization_expiry check (expires_at > authorized_at),
  constraint hr_stage2_backfill_authorization_summary_object check (jsonb_typeof(proposal_summary) = 'object'),
  constraint hr_stage2_backfill_authorization_snapshot_object check (jsonb_typeof(authorization_snapshot) = 'object'),
  constraint hr_stage2_backfill_authorization_targets check (
    (scope = 'canary' and cardinality(employee_ids) between 1 and 3)
    or (scope = 'full' and cardinality(employee_ids) = 0)
  )
);

create table private.hr_stage2_backfill_executions (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid not null unique references private.hr_stage2_backfill_authorizations(id) on delete restrict,
  scope text not null,
  employee_count integer not null,
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  executed_by uuid not null references public.employees(id) on delete restrict,
  executed_at timestamptz not null default clock_timestamp(),
  result text not null,
  constraint hr_stage2_backfill_execution_scope check (scope in ('canary', 'full')),
  constraint hr_stage2_backfill_execution_employee_count check (employee_count > 0),
  constraint hr_stage2_backfill_execution_before_object check (jsonb_typeof(before_snapshot) = 'object'),
  constraint hr_stage2_backfill_execution_after_object check (jsonb_typeof(after_snapshot) = 'object'),
  constraint hr_stage2_backfill_execution_result check (result = 'completed')
);

create function private.validate_hr_stage2_effective_date_authorization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior_record private.hr_stage2_effective_date_authorizations%rowtype;
begin
  if new.supersedes_id is null then
    if exists (
      select 1
      from private.hr_stage2_effective_date_authorizations authz
      where authz.employee_id = new.employee_id
        and not exists (
          select 1
          from private.hr_stage2_effective_date_authorizations replacement
          where replacement.supersedes_id = authz.id
        )
    ) then
      raise exception 'The employee already has an active effective-date authorization. Supersede it explicitly.';
    end if;
    return new;
  end if;

  select * into prior_record
  from private.hr_stage2_effective_date_authorizations authz
  where authz.id = new.supersedes_id;

  if not found or prior_record.employee_id <> new.employee_id then
    raise exception 'The superseded effective-date authorization must belong to the same employee.';
  end if;

  if exists (
    select 1
    from private.hr_stage2_effective_date_authorizations replacement
    where replacement.supersedes_id = new.supersedes_id
  ) then
    raise exception 'The selected effective-date authorization has already been superseded.';
  end if;

  return new;
end
$$;

create trigger hr_stage2_effective_dates_validate
before insert on private.hr_stage2_effective_date_authorizations
for each row execute function private.validate_hr_stage2_effective_date_authorization();

create function private.require_hris_stage2_manager()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'Verified MFA is required for HRIS backfill controls.';
  end if;

  if not public.has_effective_permission('hr.people.manage') then
    raise insufficient_privilege using message = 'HR employee-management permission is required.';
  end if;

  return actor_id;
end
$$;

create function private.hris_stage2_effective_dates()
returns table (
  employee_id uuid,
  hired_on date,
  separated_on date,
  source_type text,
  source_reference text,
  authorized_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    employee.id,
    coalesce(employee.hired_on, authz.hired_on),
    coalesce(employee.separated_on, authz.separated_on),
    coalesce(authz.source_type, 'employee_record'),
    coalesce(authz.source_reference, 'public.employees'),
    authz.authorized_at
  from public.employees employee
  left join private.hr_stage2_effective_date_authorizations authz
    on authz.employee_id = employee.id
   and not exists (
     select 1
     from private.hr_stage2_effective_date_authorizations replacement
     where replacement.supersedes_id = authz.id
   )
$$;

create function private.hris_stage2_preservation_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'employees', (select count(*) from public.employees),
    'employeeRoleMemberships', (select count(*) from public.employee_access_roles),
    'rolePermissions', (select count(*) from public.access_role_permissions),
    'employeePermissionOverrides', (select count(*) from public.employee_permission_overrides),
    'employeeAccounts', (select count(*) from private.employee_accounts),
    'employeeCredentials', (select count(*) from public.employee_credentials),
    'schedules', (select count(*) from public.schedules),
    'shifts', (select count(*) from public.shifts),
    'shiftAssignments', (select count(*) from public.shift_assignments),
    'timeEvents', (select count(*) from public.time_events),
    'timeOffRequests', (select count(*) from public.time_off_requests),
    'payrollExportBatches', (select count(*) from private.payroll_export_batches),
    'payrollExportRows', (select count(*) from private.payroll_export_rows)
  )
$$;

create function private.hris_stage2_control_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with effective_dates as (
    select * from private.hris_stage2_effective_dates()
  ), current_recovery as (
    select evidence.id, evidence.expires_at
    from private.hr_stage2_recovery_evidence evidence
    where evidence.expires_at > clock_timestamp()
    order by evidence.verified_at desc
    limit 1
  )
  select jsonb_build_object(
    'gateEnabled', (select gate.enabled from private.hr_stage2_backfill_gate gate where gate.singleton),
    'employeeCount', (select count(*) from effective_dates),
    'missingHireDateCount', (select count(*) from effective_dates where hired_on is null),
    'missingSeparationDateCount', (
      select count(*)
      from effective_dates dates
      join public.employees employee on employee.id = dates.employee_id
      where employee.status::text = 'separated' and dates.separated_on is null
    ),
    'currentRecoveryEvidence', exists (select 1 from current_recovery),
    'currentRecoveryEvidenceExpiresAt', (select expires_at from current_recovery),
    'executionCount', (select count(*) from private.hr_stage2_backfill_executions),
    'generatedAt', clock_timestamp()
  )
$$;

create function public.authorize_hris_stage2_effective_dates(
  target_employee_id uuid,
  target_hired_on date,
  target_separated_on date,
  target_source_type text,
  target_source_reference text,
  target_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hris_stage2_manager();
  employee_record public.employees%rowtype;
  active_authorization_id uuid;
  saved_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('hris-stage2-effective-date:' || target_employee_id::text, 0));

  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id;

  if not found then
    raise no_data_found using message = 'The selected employee does not exist.';
  end if;

  if target_hired_on is null or target_hired_on > current_date then
    raise check_violation using message = 'A verified hire date on or before today is required.';
  end if;

  if target_separated_on is not null and target_separated_on < target_hired_on then
    raise check_violation using message = 'The separation date cannot be before the hire date.';
  end if;

  if employee_record.status::text = 'separated' and target_separated_on is null then
    raise check_violation using message = 'A separated employee requires a verified separation date.';
  end if;

  if employee_record.hired_on is not null and employee_record.hired_on <> target_hired_on then
    raise check_violation using message = 'The supplied hire date conflicts with the permanent employee record.';
  end if;

  if employee_record.separated_on is not null and employee_record.separated_on <> target_separated_on then
    raise check_violation using message = 'The supplied separation date conflicts with the permanent employee record.';
  end if;

  if coalesce(btrim(target_source_reference), '') = '' or coalesce(btrim(target_reason), '') = '' then
    raise check_violation using message = 'A source reference and audit reason are required.';
  end if;

  select authz.id into active_authorization_id
  from private.hr_stage2_effective_date_authorizations authz
  where authz.employee_id = target_employee_id
    and not exists (
      select 1
      from private.hr_stage2_effective_date_authorizations replacement
      where replacement.supersedes_id = authz.id
    )
  order by authz.authorized_at desc
  limit 1;

  insert into private.hr_stage2_effective_date_authorizations (
    employee_id,
    hired_on,
    separated_on,
    source_type,
    source_reference,
    reason,
    source_status,
    authorized_by,
    supersedes_id
  ) values (
    target_employee_id,
    target_hired_on,
    target_separated_on,
    target_source_type,
    btrim(target_source_reference),
    btrim(target_reason),
    employee_record.status::text,
    actor_id,
    active_authorization_id
  ) returning id into saved_id;

  return saved_id;
end
$$;

create function public.set_hris_stage2_backfill_gate(
  target_enabled boolean,
  target_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hris_stage2_manager();
  control_status jsonb;
  proposal_summary jsonb;
begin
  if coalesce(btrim(target_reason), '') = '' then
    raise check_violation using message = 'An audit reason is required.';
  end if;

  if target_enabled then
    control_status := private.hris_stage2_control_status();
    proposal_summary := private.assert_hris_stage2_reconciliation_ready();

    if (control_status ->> 'missingHireDateCount')::integer <> 0
      or (control_status ->> 'missingSeparationDateCount')::integer <> 0 then
      raise check_violation using message = 'Authoritative hire and separation dates are incomplete.';
    end if;

    if not (control_status ->> 'currentRecoveryEvidence')::boolean then
      raise check_violation using message = 'Current isolated recovery evidence is required.';
    end if;

    if (proposal_summary ->> 'blockedCount')::integer <> 0 then
      raise check_violation using message = 'The reconciliation proposal still contains blockers.';
    end if;
  end if;

  update private.hr_stage2_backfill_gate
  set enabled = target_enabled,
      reason = btrim(target_reason),
      changed_by = actor_id,
      changed_at = clock_timestamp()
  where singleton;

  return private.hris_stage2_control_status();
end
$$;

create function public.authorize_hris_stage2_backfill(
  target_scope text,
  target_employee_ids uuid[],
  target_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hris_stage2_manager();
  clean_employee_ids uuid[] := coalesce(
    (
      select array_agg(distinct requested.target_id order by requested.target_id)
      from unnest(coalesce(target_employee_ids, array[]::uuid[])) as requested(target_id)
    ),
    array[]::uuid[]
  );
  recovery_id uuid;
  proposal_summary jsonb;
  saved_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('hris-stage2-backfill-authorization', 0));

  if not exists (select 1 from private.hr_stage2_backfill_gate gate where gate.singleton and gate.enabled) then
    raise check_violation using message = 'The protected Stage 2 backfill gate is closed.';
  end if;

  if target_scope not in ('canary', 'full') then
    raise check_violation using message = 'Backfill scope must be canary or full.';
  end if;

  if (target_scope = 'canary' and cardinality(clean_employee_ids) not between 1 and 3)
    or (target_scope = 'full' and cardinality(clean_employee_ids) <> 0) then
    raise check_violation using message = 'Canary scope requires one to three employees; full scope does not accept a target list.';
  end if;

  if coalesce(btrim(target_reason), '') = '' then
    raise check_violation using message = 'An audit reason is required.';
  end if;

  if exists (
    select 1
    from unnest(clean_employee_ids) as requested(requested_id)
    left join public.employees employee on employee.id = requested.requested_id
    where employee.id is null
  ) then
    raise no_data_found using message = 'One or more selected employees no longer exist.';
  end if;

  select evidence.id into recovery_id
  from private.hr_stage2_recovery_evidence evidence
  where evidence.expires_at > clock_timestamp()
  order by evidence.verified_at desc
  limit 1;

  if recovery_id is null then
    raise check_violation using message = 'Current isolated recovery evidence is required.';
  end if;

  if exists (
    select 1
    from private.hris_stage2_effective_dates() dates
    join public.employees employee on employee.id = dates.employee_id
    where (target_scope = 'full' or dates.employee_id = any(clean_employee_ids))
      and (dates.hired_on is null or (employee.status::text = 'separated' and dates.separated_on is null))
  ) then
    raise check_violation using message = 'Authoritative effective dates are incomplete for the requested scope.';
  end if;

  proposal_summary := private.assert_hris_stage2_reconciliation_ready();

  insert into private.hr_stage2_backfill_authorizations (
    scope,
    employee_ids,
    reason,
    authorized_by,
    expires_at,
    recovery_evidence_id,
    proposal_summary,
    authorization_snapshot
  ) values (
    target_scope,
    clean_employee_ids,
    btrim(target_reason),
    actor_id,
    clock_timestamp() + interval '15 minutes',
    recovery_id,
    proposal_summary,
    private.hris_stage2_preservation_snapshot()
  ) returning id into saved_id;

  return saved_id;
end
$$;

create function private.execute_hris_stage2_identity_backfill(target_authorization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorization_record private.hr_stage2_backfill_authorizations%rowtype;
  before_snapshot jsonb;
  after_snapshot jsonb;
  target_count integer;
  proposal_summary jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise insufficient_privilege using message = 'The protected identity backfill is service-only.';
  end if;

  select * into authorization_record
  from private.hr_stage2_backfill_authorizations authz
  where authz.id = target_authorization_id
  for update;

  if not found then
    raise no_data_found using message = 'The backfill authorization does not exist.';
  end if;

  if authorization_record.expires_at <= clock_timestamp() then
    raise check_violation using message = 'The backfill authorization has expired.';
  end if;

  if exists (
    select 1 from private.hr_stage2_backfill_executions execution
    where execution.authorization_id = target_authorization_id
  ) then
    raise unique_violation using message = 'The backfill authorization has already been used.';
  end if;

  if not exists (select 1 from private.hr_stage2_backfill_gate gate where gate.singleton and gate.enabled) then
    raise check_violation using message = 'The protected Stage 2 backfill gate is closed.';
  end if;

  if not exists (
    select 1
    from private.hr_stage2_recovery_evidence evidence
    where evidence.id = authorization_record.recovery_evidence_id
      and evidence.expires_at > clock_timestamp()
  ) then
    raise check_violation using message = 'The recovery evidence is missing or expired.';
  end if;

  proposal_summary := private.assert_hris_stage2_reconciliation_ready();
  before_snapshot := private.hris_stage2_preservation_snapshot();

  if before_snapshot <> authorization_record.authorization_snapshot then
    raise check_violation using message = 'Protected operational state changed after authorization; issue a new authorization.';
  end if;

  create temporary table hris_stage2_execution_targets on commit drop as
  select proposal.*
  from private.hris_stage2_mapping_proposal() proposal
  where authorization_record.scope = 'full'
     or proposal.source_employee_id = any(authorization_record.employee_ids);

  select count(*) into target_count from hris_stage2_execution_targets;

  if target_count = 0
    or (authorization_record.scope = 'canary' and target_count > 3) then
    raise check_violation using message = 'The protected backfill target set is invalid.';
  end if;

  if exists (
    select 1
    from hris_stage2_execution_targets target
    left join private.hris_stage2_effective_dates() dates on dates.employee_id = target.source_employee_id
    where dates.hired_on is null
       or (target.source_status = 'separated' and dates.separated_on is null)
  ) then
    raise check_violation using message = 'Authoritative effective dates are incomplete for the execution target.';
  end if;

  if exists (select 1 from hris_stage2_execution_targets where mapping_state = 'blocked') then
    raise check_violation using message = 'The execution target contains a blocked identity mapping.';
  end if;

  insert into private.hr_person_identifiers (id, employee_id, source_system, created_by)
  select target.proposed_person_id, target.source_employee_id, 'sygshift_employee', authorization_record.authorized_by
  from hris_stage2_execution_targets target
  on conflict do nothing;

  insert into private.hr_worker_identifiers (id, person_id, worker_reference, created_by)
  select target.proposed_worker_id, target.proposed_person_id, target.proposed_worker_reference, authorization_record.authorized_by
  from hris_stage2_execution_targets target
  on conflict do nothing;

  if exists (
    select 1
    from hris_stage2_execution_targets target
    left join private.hr_person_identifiers person
      on person.employee_id = target.source_employee_id
    left join private.hr_worker_identifiers worker
      on worker.person_id = person.id
    where person.id is distinct from target.proposed_person_id
       or person.source_system <> 'sygshift_employee'
       or worker.id is distinct from target.proposed_worker_id
       or worker.worker_reference is distinct from target.proposed_worker_reference
  ) then
    raise check_violation using message = 'Post-write identity verification failed; the transaction was rolled back.';
  end if;

  after_snapshot := private.hris_stage2_preservation_snapshot();

  if before_snapshot <> after_snapshot then
    raise check_violation using message = 'A protected operational invariant changed; the transaction was rolled back.';
  end if;

  insert into private.hr_stage2_backfill_executions (
    authorization_id,
    scope,
    employee_count,
    before_snapshot,
    after_snapshot,
    executed_by,
    result
  ) values (
    authorization_record.id,
    authorization_record.scope,
    target_count,
    before_snapshot,
    after_snapshot,
    authorization_record.authorized_by,
    'completed'
  );

  return jsonb_build_object(
    'authorizationId', authorization_record.id,
    'scope', authorization_record.scope,
    'employeeCount', target_count,
    'proposalBlockedCount', (proposal_summary ->> 'blockedCount')::integer,
    'operationalInvariantsPreserved', true,
    'result', 'completed'
  );
end
$$;

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'hr_stage2_effective_date_authorizations',
    'hr_stage2_recovery_evidence',
    'hr_stage2_backfill_gate',
    'hr_stage2_backfill_authorizations',
    'hr_stage2_backfill_executions'
  ] loop
    execute format('alter table private.%I enable row level security', relation_name);
    execute format(
      'create trigger %I after insert or update or delete on private.%I for each row execute function private.write_audit_event()',
      relation_name || '_audit',
      relation_name
    );
  end loop;

  foreach relation_name in array array[
    'hr_stage2_effective_date_authorizations',
    'hr_stage2_recovery_evidence',
    'hr_stage2_backfill_authorizations',
    'hr_stage2_backfill_executions'
  ] loop
    execute format(
      'create trigger %I before update or delete on private.%I for each row execute function private.prevent_append_only_change()',
      relation_name || '_append_only',
      relation_name
    );
  end loop;
end
$$;

revoke all on
  private.hr_stage2_effective_date_authorizations,
  private.hr_stage2_recovery_evidence,
  private.hr_stage2_backfill_gate,
  private.hr_stage2_backfill_authorizations,
  private.hr_stage2_backfill_executions
from public, anon, authenticated;

grant select on
  private.hr_stage2_effective_date_authorizations,
  private.hr_stage2_backfill_authorizations,
  private.hr_stage2_backfill_executions
to service_role;

grant select, insert on private.hr_stage2_recovery_evidence to service_role;

grant select, update on private.hr_stage2_backfill_gate to service_role;

revoke all on function private.validate_hr_stage2_effective_date_authorization() from public, anon, authenticated;
revoke all on function private.require_hris_stage2_manager() from public, anon, authenticated;
revoke all on function private.hris_stage2_effective_dates() from public, anon, authenticated;
revoke all on function private.hris_stage2_preservation_snapshot() from public, anon, authenticated;
revoke all on function private.hris_stage2_control_status() from public, anon, authenticated;
revoke all on function private.execute_hris_stage2_identity_backfill(uuid) from public, anon, authenticated;
grant execute on function private.hris_stage2_effective_dates() to service_role;
grant execute on function private.hris_stage2_preservation_snapshot() to service_role;
grant execute on function private.hris_stage2_control_status() to service_role;
grant execute on function private.execute_hris_stage2_identity_backfill(uuid) to service_role;

revoke all on function public.authorize_hris_stage2_effective_dates(uuid, date, date, text, text, text) from public, anon;
revoke all on function public.set_hris_stage2_backfill_gate(boolean, text) from public, anon;
revoke all on function public.authorize_hris_stage2_backfill(text, uuid[], text) from public, anon;
grant execute on function public.authorize_hris_stage2_effective_dates(uuid, date, date, text, text, text) to authenticated;
grant execute on function public.set_hris_stage2_backfill_gate(boolean, text) to authenticated;
grant execute on function public.authorize_hris_stage2_backfill(text, uuid[], text) to authenticated;

do $$
declare
  baseline record;
  gate_record private.hr_stage2_backfill_gate%rowtype;
begin
  select * into baseline from hris_stage2_run3_preservation_baseline;
  select * into gate_record from private.hr_stage2_backfill_gate where singleton;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.person_identifier_count <> (select count(*) from private.hr_person_identifiers)
    or baseline.worker_identifier_count <> (select count(*) from private.hr_worker_identifiers) then
    raise exception 'Stage 2 run 3 changed protected employee, access, or HR identity records.';
  end if;

  if gate_record.enabled then
    raise exception 'Stage 2 run 3 must finish with the protected backfill gate closed.';
  end if;
end
$$;

commit;
