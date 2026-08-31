begin;

create temporary table hris_stage2_release_hardening_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.hr_person_identifiers) as person_identifier_count,
  (select count(*) from private.hr_worker_identifiers) as worker_identifier_count,
  (select gate.enabled from private.hr_stage2_backfill_gate gate where gate.singleton) as gate_enabled;

create table private.hr_stage2_canary_verifications (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null unique references private.hr_stage2_backfill_executions(id) on delete restrict,
  recovery_evidence_id uuid not null references private.hr_stage2_recovery_evidence(id) on delete restrict,
  verified_by uuid not null references public.employees(id) on delete restrict,
  verified_at timestamptz not null default clock_timestamp(),
  employee_count integer not null,
  mapping_count integer not null,
  verification_reference text not null,
  verification_sha256 text not null,
  preservation_snapshot jsonb not null,
  proposal_summary jsonb not null,
  result text not null,
  constraint hr_stage2_canary_verification_employee_count check (employee_count between 1 and 3),
  constraint hr_stage2_canary_verification_mapping_count check (mapping_count = employee_count),
  constraint hr_stage2_canary_verification_reference_present check (btrim(verification_reference) <> ''),
  constraint hr_stage2_canary_verification_digest check (verification_sha256 ~ '^[a-f0-9]{64}$'),
  constraint hr_stage2_canary_verification_preservation_object check (jsonb_typeof(preservation_snapshot) = 'object'),
  constraint hr_stage2_canary_verification_proposal_object check (jsonb_typeof(proposal_summary) = 'object'),
  constraint hr_stage2_canary_verification_result check (result = 'passed')
);

create index hr_stage2_canary_verifications_verified_at_idx
  on private.hr_stage2_canary_verifications (verified_at desc);

alter table private.hr_stage2_canary_verifications enable row level security;

create trigger hr_stage2_canary_verifications_audit
after insert or update or delete on private.hr_stage2_canary_verifications
for each row execute function private.write_audit_event();

create trigger hr_stage2_canary_verifications_append_only
before update or delete on private.hr_stage2_canary_verifications
for each row execute function private.prevent_append_only_change();

create function private.close_hris_stage2_gate_after_execution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.hr_stage2_backfill_gate
  set enabled = false,
      reason = case
        when new.scope = 'canary' then 'Canary execution completed. Independent verification and a new authorization are required before any further backfill.'
        else 'Full identity backfill execution completed. The protected gate closed automatically.'
      end,
      changed_by = new.executed_by,
      changed_at = clock_timestamp()
  where singleton and enabled;

  return new;
end
$$;

create trigger hr_stage2_backfill_execution_close_gate
after insert on private.hr_stage2_backfill_executions
for each row execute function private.close_hris_stage2_gate_after_execution();

create function private.verify_hris_stage2_canary_execution(
  target_execution_id uuid,
  target_verification_reference text,
  target_verification_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  execution_record private.hr_stage2_backfill_executions%rowtype;
  authorization_record private.hr_stage2_backfill_authorizations%rowtype;
  proposal_summary jsonb;
  mapped_count integer;
  saved_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Canary verification is service-only.';
  end if;

  if coalesce(btrim(target_verification_reference), '') = '' then
    raise check_violation using message = 'A verification evidence reference is required.';
  end if;

  if coalesce(target_verification_sha256, '') !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'A lowercase SHA-256 verification digest is required.';
  end if;

  select execution.* into execution_record
  from private.hr_stage2_backfill_executions execution
  where execution.id = target_execution_id;

  if not found then
    raise no_data_found using message = 'The canary execution does not exist.';
  end if;

  if execution_record.scope <> 'canary'
    or execution_record.employee_count not between 1 and 3
    or execution_record.result <> 'completed' then
    raise check_violation using message = 'Only a completed one-to-three-person canary can be verified.';
  end if;

  if execution_record.before_snapshot <> execution_record.after_snapshot then
    raise check_violation using message = 'The canary did not preserve protected operational records.';
  end if;

  select authz.* into authorization_record
  from private.hr_stage2_backfill_authorizations authz
  where authz.id = execution_record.authorization_id;

  if not found or authorization_record.scope <> 'canary'
    or cardinality(authorization_record.employee_ids) <> execution_record.employee_count then
    raise check_violation using message = 'The canary authorization and execution target do not match.';
  end if;

  if not exists (
    select 1
    from private.hr_stage2_recovery_evidence evidence
    where evidence.id = authorization_record.recovery_evidence_id
      and evidence.expires_at > clock_timestamp()
  ) then
    raise check_violation using message = 'The canary recovery evidence is missing or expired.';
  end if;

  proposal_summary := private.assert_hris_stage2_reconciliation_ready();

  if exists (
    select 1
    from private.hris_stage2_mapping_proposal() proposal
    where proposal.source_employee_id = any(authorization_record.employee_ids)
      and proposal.mapping_state = 'blocked'
  ) then
    raise check_violation using message = 'The canary contains a blocked identity mapping.';
  end if;

  select count(*) into mapped_count
  from private.hris_stage2_mapping_proposal() proposal
  join private.hr_person_identifiers person
    on person.employee_id = proposal.source_employee_id
   and person.id = proposal.proposed_person_id
   and person.source_system = 'sygshift_employee'
  join private.hr_worker_identifiers worker
    on worker.person_id = person.id
   and worker.id = proposal.proposed_worker_id
   and worker.worker_reference = proposal.proposed_worker_reference
  where proposal.source_employee_id = any(authorization_record.employee_ids);

  if mapped_count <> execution_record.employee_count then
    raise check_violation using message = 'Canary identity mapping verification failed.';
  end if;

  insert into private.hr_stage2_canary_verifications (
    execution_id,
    recovery_evidence_id,
    verified_by,
    employee_count,
    mapping_count,
    verification_reference,
    verification_sha256,
    preservation_snapshot,
    proposal_summary,
    result
  ) values (
    execution_record.id,
    authorization_record.recovery_evidence_id,
    execution_record.executed_by,
    execution_record.employee_count,
    mapped_count,
    btrim(target_verification_reference),
    target_verification_sha256,
    execution_record.after_snapshot,
    proposal_summary,
    'passed'
  ) returning id into saved_id;

  return jsonb_build_object(
    'verificationId', saved_id,
    'executionId', execution_record.id,
    'employeeCount', execution_record.employee_count,
    'mappingCount', mapped_count,
    'operationalInvariantsPreserved', true,
    'gateEnabled', (select gate.enabled from private.hr_stage2_backfill_gate gate where gate.singleton),
    'result', 'passed'
  );
end
$$;

create or replace function public.authorize_hris_stage2_backfill(
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

  if target_scope = 'full' and not exists (
    select 1
    from private.hr_stage2_canary_verifications verification
    join private.hr_stage2_backfill_executions execution
      on execution.id = verification.execution_id
    where verification.recovery_evidence_id = recovery_id
      and verification.result = 'passed'
      and verification.employee_count between 1 and 3
      and verification.mapping_count = verification.employee_count
      and execution.scope = 'canary'
      and execution.result = 'completed'
  ) then
    raise check_violation using message = 'A verified canary using the current recovery evidence is required before full authorization.';
  end if;

  if target_scope = 'canary' and exists (
    select 1
    from private.hris_stage2_mapping_proposal() proposal
    where proposal.source_employee_id = any(clean_employee_ids)
      and proposal.mapping_state not in ('identity_ready', 'worker_ready')
  ) then
    raise check_violation using message = 'Canary employees must be unmapped, reconciliation-ready identities.';
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

create function private.hris_stage2_release_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with current_recovery as (
    select evidence.id, evidence.expires_at
    from private.hr_stage2_recovery_evidence evidence
    where evidence.expires_at > clock_timestamp()
    order by evidence.verified_at desc
    limit 1
  ), latest_canary as (
    select
      verification.id,
      verification.execution_id,
      verification.recovery_evidence_id,
      verification.employee_count,
      verification.verified_at
    from private.hr_stage2_canary_verifications verification
    order by verification.verified_at desc
    limit 1
  )
  select jsonb_build_object(
    'gateEnabled', (select gate.enabled from private.hr_stage2_backfill_gate gate where gate.singleton),
    'currentRecoveryEvidence', exists (select 1 from current_recovery),
    'currentRecoveryEvidenceExpiresAt', (select expires_at from current_recovery),
    'canaryExecutionCount', (select count(*) from private.hr_stage2_backfill_executions execution where execution.scope = 'canary'),
    'verifiedCanaryCount', (select count(*) from private.hr_stage2_canary_verifications),
    'latestCanaryVerifiedAt', (select verified_at from latest_canary),
    'latestCanaryEmployeeCount', (select employee_count from latest_canary),
    'verifiedCanaryMatchesCurrentRecovery', exists (
      select 1
      from latest_canary canary
      join current_recovery recovery on recovery.id = canary.recovery_evidence_id
    ),
    'fullExecutionCount', (select count(*) from private.hr_stage2_backfill_executions execution where execution.scope = 'full'),
    'personIdentifierCount', (select count(*) from private.hr_person_identifiers),
    'workerIdentifierCount', (select count(*) from private.hr_worker_identifiers),
    'generatedAt', clock_timestamp()
  )
$$;

revoke all on private.hr_stage2_canary_verifications from public, anon, authenticated;
grant select on private.hr_stage2_canary_verifications to service_role;

revoke all on function private.close_hris_stage2_gate_after_execution() from public, anon, authenticated;
revoke all on function private.verify_hris_stage2_canary_execution(uuid, text, text) from public, anon, authenticated;
revoke all on function private.hris_stage2_release_status() from public, anon, authenticated;
grant execute on function private.verify_hris_stage2_canary_execution(uuid, text, text) to service_role;
grant execute on function private.hris_stage2_release_status() to service_role;

revoke all on function public.authorize_hris_stage2_backfill(text, uuid[], text) from public, anon;
grant execute on function public.authorize_hris_stage2_backfill(text, uuid[], text) to authenticated;

do $$
declare
  baseline record;
  gate_record private.hr_stage2_backfill_gate%rowtype;
begin
  select * into baseline from hris_stage2_release_hardening_baseline;
  select * into gate_record from private.hr_stage2_backfill_gate where singleton;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.person_identifier_count <> (select count(*) from private.hr_person_identifiers)
    or baseline.worker_identifier_count <> (select count(*) from private.hr_worker_identifiers) then
    raise exception 'Stage 2 release hardening changed protected employee, access, or HR identity records.';
  end if;

  if gate_record.enabled is distinct from baseline.gate_enabled then
    raise exception 'Stage 2 release hardening changed the protected backfill gate state.';
  end if;

  if exists (select 1 from private.hr_stage2_canary_verifications) then
    raise exception 'Stage 2 release hardening must not fabricate canary verification evidence.';
  end if;
end
$$;

commit;
