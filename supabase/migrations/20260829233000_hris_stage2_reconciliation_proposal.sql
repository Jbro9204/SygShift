begin;

-- Stage 2, run 2 creates a deterministic, service-only mapping proposal. It does
-- not backfill HR identifiers, change live employees, or open the HR feature gate.
create temporary table hris_stage2_run2_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.hr_person_identifiers) as person_identifier_count,
  (select count(*) from private.hr_worker_identifiers) as worker_identifier_count;

create function private.hris_deterministic_uuid(scope text, source_id uuid)
returns uuid
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  hash_value text;
begin
  if btrim(scope) = '' then
    raise exception 'HRIS deterministic identifier scope is required.';
  end if;

  hash_value := encode(
    extensions.digest(convert_to(scope || ':' || source_id::text, 'UTF8'), 'sha256'),
    'hex'
  );

  return (
    substr(hash_value, 1, 8) || '-' ||
    substr(hash_value, 9, 4) || '-' ||
    '5' || substr(hash_value, 14, 3) || '-' ||
    'a' || substr(hash_value, 18, 3) || '-' ||
    substr(hash_value, 21, 12)
  )::uuid;
end
$$;

create function private.hris_stage2_mapping_proposal()
returns table (
  source_employee_id uuid,
  source_status text,
  lifecycle text,
  proposed_person_id uuid,
  proposed_worker_id uuid,
  proposed_worker_reference text,
  existing_person_id uuid,
  existing_worker_id uuid,
  mapping_state text,
  blocker_codes text[],
  warning_codes text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with proposed as (
    select
      employee.id as source_employee_id,
      employee.status::text as source_status,
      case
        when employee.status::text in ('active', 'leave', 'onboarding') then 'current'
        else 'historical'
      end as lifecycle,
      private.hris_deterministic_uuid('sygshift-hr-person-v1', employee.id) as proposed_person_id,
      private.hris_deterministic_uuid('sygshift-hr-worker-v1', employee.id) as proposed_worker_id,
      'SYG-' || employee.id::text as proposed_worker_reference,
      employee.employee_number,
      employee.hired_on,
      employee.separated_on
    from public.employees employee
  ), inspected as (
    select
      proposed.*,
      existing_person.id as existing_person_id,
      existing_worker.id as existing_worker_id,
      array_remove(array[
        case when existing_person.id is not null and existing_person.id <> proposed.proposed_person_id
          then 'existing_person_id_mismatch' end,
        case when existing_person.id is not null and existing_person.source_system <> 'sygshift_employee'
          then 'existing_person_source_mismatch' end,
        case when person_collision.id is not null then 'person_id_collision' end,
        case when existing_worker.id is not null and existing_worker.id <> proposed.proposed_worker_id
          then 'existing_worker_id_mismatch' end,
        case when existing_worker.id is not null
          and existing_worker.worker_reference <> proposed.proposed_worker_reference
          then 'existing_worker_reference_mismatch' end,
        case when worker_collision.id is not null then 'worker_id_collision' end,
        case when reference_collision.id is not null then 'worker_reference_collision' end
      ]::text[], null) as blocker_codes,
      array_remove(array[
        case when proposed.employee_number is null or btrim(proposed.employee_number) = ''
          then 'employee_number_missing' end,
        case when proposed.hired_on is null then 'hire_date_missing' end,
        case when proposed.source_status = 'separated' and proposed.separated_on is null
          then 'separation_date_missing' end
      ]::text[], null) as warning_codes
    from proposed
    left join private.hr_person_identifiers existing_person
      on existing_person.employee_id = proposed.source_employee_id
    left join private.hr_worker_identifiers existing_worker
      on existing_worker.person_id = existing_person.id
    left join private.hr_person_identifiers person_collision
      on person_collision.id = proposed.proposed_person_id
      and person_collision.employee_id <> proposed.source_employee_id
    left join private.hr_worker_identifiers worker_collision
      on worker_collision.id = proposed.proposed_worker_id
      and worker_collision.person_id <> proposed.proposed_person_id
    left join private.hr_worker_identifiers reference_collision
      on reference_collision.worker_reference = proposed.proposed_worker_reference
      and reference_collision.person_id <> proposed.proposed_person_id
  )
  select
    inspected.source_employee_id,
    inspected.source_status,
    inspected.lifecycle,
    inspected.proposed_person_id,
    inspected.proposed_worker_id,
    inspected.proposed_worker_reference,
    inspected.existing_person_id,
    inspected.existing_worker_id,
    case
      when cardinality(inspected.blocker_codes) > 0 then 'blocked'
      when inspected.existing_person_id = inspected.proposed_person_id
        and inspected.existing_worker_id = inspected.proposed_worker_id then 'already_mapped'
      when inspected.existing_person_id = inspected.proposed_person_id then 'worker_ready'
      else 'identity_ready'
    end as mapping_state,
    inspected.blocker_codes,
    inspected.warning_codes
  from inspected
  order by inspected.source_employee_id
$$;

create function private.hris_stage2_reconciliation_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with proposal as (
    select * from private.hris_stage2_mapping_proposal()
  )
  select jsonb_build_object(
    'employeeCount', count(*),
    'currentEmployeeCount', count(*) filter (where lifecycle = 'current'),
    'historicalEmployeeCount', count(*) filter (where lifecycle = 'historical'),
    'readyCount', count(*) filter (where mapping_state in ('identity_ready', 'worker_ready')),
    'alreadyMappedCount', count(*) filter (where mapping_state = 'already_mapped'),
    'blockedCount', count(*) filter (where mapping_state = 'blocked'),
    'warningCount', count(*) filter (where cardinality(warning_codes) > 0),
    'missingEmployeeNumberWarningCount', count(*) filter (where 'employee_number_missing' = any(warning_codes)),
    'missingHireDateWarningCount', count(*) filter (where 'hire_date_missing' = any(warning_codes)),
    'missingSeparationDateWarningCount', count(*) filter (where 'separation_date_missing' = any(warning_codes)),
    'protectedBackfillAllowed', false,
    'generatedAt', clock_timestamp()
  )
  from proposal
$$;

create function private.assert_hris_stage2_reconciliation_ready()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  summary jsonb;
begin
  summary := private.hris_stage2_reconciliation_summary();

  if (summary ->> 'blockedCount')::bigint <> 0 then
    raise exception 'HRIS Stage 2 reconciliation contains blocked identity mappings.';
  end if;

  return summary || jsonb_build_object(
    'proposalIntegrity', 'passed',
    'releaseGate', 'proposal_ready_backfill_disabled'
  );
end
$$;

revoke all on function private.hris_deterministic_uuid(text, uuid) from public, anon, authenticated;
revoke all on function private.hris_stage2_mapping_proposal() from public, anon, authenticated;
revoke all on function private.hris_stage2_reconciliation_summary() from public, anon, authenticated;
revoke all on function private.assert_hris_stage2_reconciliation_ready() from public, anon, authenticated;
grant execute on function private.hris_deterministic_uuid(text, uuid) to service_role;
grant execute on function private.hris_stage2_mapping_proposal() to service_role;
grant execute on function private.hris_stage2_reconciliation_summary() to service_role;
grant execute on function private.assert_hris_stage2_reconciliation_ready() to service_role;

do $$
declare
  baseline record;
  reconciliation jsonb;
begin
  select * into baseline from hris_stage2_run2_preservation_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.person_identifier_count <> (select count(*) from private.hr_person_identifiers)
    or baseline.worker_identifier_count <> (select count(*) from private.hr_worker_identifiers) then
    raise exception 'Stage 2 run 2 changed protected employee, access, or HR identity records.';
  end if;

  reconciliation := private.assert_hris_stage2_reconciliation_ready();
  raise notice 'HRIS Stage 2 reconciliation proposal validated: %', reconciliation;
end
$$;

commit;
