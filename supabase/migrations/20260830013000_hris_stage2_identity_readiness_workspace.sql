begin;

create temporary table hris_stage2_readiness_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.hr_person_identifiers) as person_identifier_count,
  (select count(*) from private.hr_worker_identifiers) as worker_identifier_count,
  (select gate.enabled from private.hr_stage2_backfill_gate gate where gate.singleton) as gate_enabled;

create function public.get_hris_stage2_identity_readiness(
  target_search text default null,
  target_status text default 'all',
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hris_stage2_manager();
  clean_search text := nullif(btrim(target_search), '');
  clean_status text := lower(coalesce(nullif(btrim(target_status), ''), 'all'));
  safe_page integer := greatest(coalesce(target_page, 1), 1);
  safe_page_size integer := least(greatest(coalesce(target_page_size, 10), 1), 10);
  total_count bigint;
  item_rows jsonb;
  control_status jsonb;
  proposal_summary jsonb;
  preservation_snapshot jsonb;
begin
  perform actor_id;

  if clean_status not in ('all', 'onboarding', 'active', 'leave', 'inactive', 'separated') then
    raise check_violation using message = 'The selected employment status is not supported.';
  end if;

  control_status := private.hris_stage2_control_status();
  proposal_summary := private.hris_stage2_reconciliation_summary();
  preservation_snapshot := private.hris_stage2_preservation_snapshot();

  with readiness as (
    select
      employee.id as employee_id,
      concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name) as legal_name,
      employee.employee_number,
      employee.status::text as employment_status,
      employee.employment_type::text as employment_type,
      employee.role::text as primary_role,
      effective.hired_on as effective_hired_on,
      effective.separated_on as effective_separated_on,
      employee.hired_on as permanent_hired_on,
      employee.separated_on as permanent_separated_on,
      effective.source_type as date_source_type,
      effective.authorized_at as authorization_recorded_at,
      proposal.mapping_state,
      proposal.blocker_codes,
      proposal.warning_codes
    from public.employees employee
    join private.hris_stage2_effective_dates() effective on effective.employee_id = employee.id
    join private.hris_stage2_mapping_proposal() proposal on proposal.source_employee_id = employee.id
    where (clean_status = 'all' or employee.status::text = clean_status)
      and (
        clean_search is null
        or concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name) ilike '%' || clean_search || '%'
        or coalesce(employee.employee_number, '') ilike '%' || clean_search || '%'
      )
  )
  select count(*) into total_count from readiness;

  with readiness as (
    select
      employee.id as employee_id,
      concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name) as legal_name,
      employee.employee_number,
      employee.status::text as employment_status,
      employee.employment_type::text as employment_type,
      employee.role::text as primary_role,
      effective.hired_on as effective_hired_on,
      effective.separated_on as effective_separated_on,
      employee.hired_on as permanent_hired_on,
      employee.separated_on as permanent_separated_on,
      effective.source_type as date_source_type,
      effective.authorized_at as authorization_recorded_at,
      proposal.mapping_state,
      proposal.blocker_codes,
      proposal.warning_codes
    from public.employees employee
    join private.hris_stage2_effective_dates() effective on effective.employee_id = employee.id
    join private.hris_stage2_mapping_proposal() proposal on proposal.source_employee_id = employee.id
    where (clean_status = 'all' or employee.status::text = clean_status)
      and (
        clean_search is null
        or concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name) ilike '%' || clean_search || '%'
        or coalesce(employee.employee_number, '') ilike '%' || clean_search || '%'
      )
  ), paged as (
    select *
    from readiness
    order by legal_name, employee_id
    limit safe_page_size
    offset (safe_page - 1) * safe_page_size
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'employeeId', paged.employee_id,
      'legalName', paged.legal_name,
      'employeeNumber', paged.employee_number,
      'status', paged.employment_status,
      'employmentType', paged.employment_type,
      'primaryRole', paged.primary_role,
      'effectiveHiredOn', paged.effective_hired_on,
      'effectiveSeparatedOn', paged.effective_separated_on,
      'permanentHiredOn', paged.permanent_hired_on,
      'permanentSeparatedOn', paged.permanent_separated_on,
      'hireDateLocked', paged.permanent_hired_on is not null,
      'separationDateLocked', paged.permanent_separated_on is not null,
      'dateSourceType', paged.date_source_type,
      'authorizationRecordedAt', paged.authorization_recorded_at,
      'mappingState', paged.mapping_state,
      'blockerCodes', paged.blocker_codes,
      'warningCodes', paged.warning_codes,
      'canaryEligible',
        cardinality(paged.blocker_codes) = 0
        and paged.effective_hired_on is not null
        and (paged.employment_status <> 'separated' or paged.effective_separated_on is not null)
    ) order by paged.legal_name, paged.employee_id
  ), '[]'::jsonb)
  into item_rows
  from paged;

  return jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'page', safe_page,
    'pageSize', safe_page_size,
    'totalCount', total_count,
    'totalPages', greatest(ceil(total_count::numeric / safe_page_size)::integer, 1),
    'items', item_rows,
    'summary', proposal_summary,
    'control', control_status,
    'preservation', preservation_snapshot,
    'canaryReadiness', jsonb_build_object(
      'eligibleEmployeeCount', (
        select count(*)
        from private.hris_stage2_mapping_proposal() proposal
        join private.hris_stage2_effective_dates() effective on effective.employee_id = proposal.source_employee_id
        join public.employees employee on employee.id = proposal.source_employee_id
        where cardinality(proposal.blocker_codes) = 0
          and effective.hired_on is not null
          and (employee.status::text <> 'separated' or effective.separated_on is not null)
      ),
      'prerequisitesSatisfied',
        (control_status ->> 'missingHireDateCount')::integer = 0
        and (control_status ->> 'missingSeparationDateCount')::integer = 0
        and (proposal_summary ->> 'blockedCount')::integer = 0
        and (control_status ->> 'currentRecoveryEvidence')::boolean,
      'recoveryEvidenceCurrent', (control_status ->> 'currentRecoveryEvidence')::boolean,
      'backfillGateEnabled', (control_status ->> 'gateEnabled')::boolean,
      'browserExecutionAvailable', false
    )
  );
end
$$;

revoke all on function public.get_hris_stage2_identity_readiness(text, text, integer, integer) from public, anon;
grant execute on function public.get_hris_stage2_identity_readiness(text, text, integer, integer) to authenticated;

comment on function public.get_hris_stage2_identity_readiness(text, text, integer, integer) is
  'MFA-protected HR employment-date readiness workspace. Returns legal-name reconciliation status only and never exposes identity-backfill execution controls.';

do $$
declare
  baseline record;
begin
  select * into baseline from hris_stage2_readiness_preservation_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.person_identifier_count <> (select count(*) from private.hr_person_identifiers)
    or baseline.worker_identifier_count <> (select count(*) from private.hr_worker_identifiers) then
    raise exception 'Stage 2 readiness workspace changed protected employee, access, or HR identity records.';
  end if;

  if baseline.gate_enabled or exists (
    select 1 from private.hr_stage2_backfill_gate gate where gate.singleton and gate.enabled
  ) then
    raise exception 'Stage 2 readiness workspace requires the HR identity backfill gate to remain closed.';
  end if;
end
$$;

commit;
