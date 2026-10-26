-- Rollback-only verification for the complete one-request review contract.
-- This suite proves payload parity and exact event-bound work classification;
-- it does not create or alter punches, corrections, schedules or payroll rows.
begin isolation level repeatable read;

set local statement_timeout = '90s';
set local lock_timeout = '250ms';

do $diagnostic_actor$
declare
  actor_auth_id uuid;
begin
  select account.auth_user_id into actor_auth_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and 'time.view' = any(private.employee_effective_permissions(employee.id))
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  if actor_auth_id is null then
    raise insufficient_privilege using message =
      'No active MFA time viewer is available for the canonical review regression.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_id,
    'role', 'authenticated',
    'aal', 'aal2'
  )::text, true);
end
$diagnostic_actor$;

create temp table canonical_review_results (
  case_name text primary key,
  base_payload_preserved boolean not null,
  classifications_match_events boolean not null,
  candidate_elapsed_ms numeric not null,
  repeated_candidate_elapsed_ms numeric not null,
  repeated_candidate_equal boolean not null,
  candidate_under_app_timeout boolean not null
) on commit drop;

do $verify_contract$
declare
  target record;
  baseline jsonb;
  candidate jsonb;
  repeated_candidate jsonb;
  candidate_without_enrichment jsonb;
  started_at timestamptz;
  elapsed_ms numeric;
  repeated_elapsed_ms numeric;
  base_payload_preserved boolean;
  classifications_match_events boolean;
begin
  for target in
    select * from (values
      ('prior_period', date '2026-10-04', date '2026-10-17'),
      ('current_period', date '2026-10-18', date '2026-10-31'),
      ('maximum_range', date '2026-09-04', date '2026-10-19'),
      ('empty_future', date '2099-01-04', date '2099-01-17')
    ) cases(case_name, from_date, through_date)
  loop
    -- Deliberately vary execution order so the candidate does not receive a
    -- baseline-warmed cache in every case.
    if target.case_name in ('current_period', 'empty_future') then
      started_at := clock_timestamp();
      candidate := public.get_timekeeping_review_v2(target.from_date, target.through_date);
      elapsed_ms := extract(epoch from clock_timestamp() - started_at) * 1000;
      baseline := public.get_timekeeping_review(target.from_date, target.through_date);
    else
      baseline := public.get_timekeeping_review(target.from_date, target.through_date);
      started_at := clock_timestamp();
      candidate := public.get_timekeeping_review_v2(target.from_date, target.through_date);
      elapsed_ms := extract(epoch from clock_timestamp() - started_at) * 1000;
    end if;

    started_at := clock_timestamp();
    repeated_candidate := public.get_timekeeping_review_v2(target.from_date, target.through_date);
    repeated_elapsed_ms := extract(epoch from clock_timestamp() - started_at) * 1000;

    select (candidate - 'reviewContractVersion') || jsonb_build_object(
      'rows', coalesce(jsonb_agg(
        row_item.value
          - 'workType'
          - 'workTypeLabel'
          - 'payCode'
          - 'workTypePaid'
          - 'workTypeOvertimeEligible'
          - 'workTypeRateSource'
          - 'mixedWorkTypes'
        order by row_item.ordinality
      ), '[]'::jsonb)
    )
    into candidate_without_enrichment
    from jsonb_array_elements(coalesce(candidate -> 'rows', '[]'::jsonb))
      with ordinality as row_item(value, ordinality);

    -- Server timestamps are observation metadata, not calculation output.
    base_payload_preserved :=
      candidate_without_enrichment - 'serverTimestamp'
        = baseline - 'serverTimestamp';

    select not exists (
      select 1
      from jsonb_array_elements(coalesce(candidate -> 'rows', '[]'::jsonb))
        with ordinality as review_row(value, ordinality)
      left join lateral (
        select
          case when count(distinct event_type.work_type) = 1
            then min(event_type.work_type) else 'post' end as work_type,
          count(distinct event_type.work_type) > 1 as mixed_work_types
        from (
          select coalesce(correction.work_type, event.work_type, 'post') as work_type
          from jsonb_array_elements(
            coalesce(review_row.value -> 'eventTimeline', '[]'::jsonb)
          ) timeline(event_value)
          join public.time_events event
            on event.id = nullif(timeline.event_value ->> 'id', '')::uuid
          left join lateral (
            select item.work_type
            from public.time_event_work_type_corrections item
            where item.time_event_id = event.id
            order by item.corrected_at desc, item.id desc
            limit 1
          ) correction on true
        ) event_type
      ) expected on true
      where review_row.value ->> 'rowKind' = 'time_event'
        and (
          review_row.value ->> 'workType'
            is distinct from coalesce(expected.work_type, 'post')
          or coalesce((review_row.value ->> 'mixedWorkTypes')::boolean, false)
            is distinct from coalesce(expected.mixed_work_types, false)
          or review_row.value ->> 'payCode' is null
          or review_row.value ->> 'workTypeLabel' is null
        )
    ) into classifications_match_events;

    insert into canonical_review_results values (
      target.case_name,
      base_payload_preserved,
      classifications_match_events,
      round(elapsed_ms, 3),
      round(repeated_elapsed_ms, 3),
      repeated_candidate - 'serverTimestamp' = candidate - 'serverTimestamp',
      greatest(elapsed_ms, repeated_elapsed_ms) < 8000
    );
  end loop;

  if exists (
    select 1
    from canonical_review_results result
    where not result.base_payload_preserved
      or not result.classifications_match_events
      or not result.repeated_candidate_equal
      or not result.candidate_under_app_timeout
  ) then
    raise check_violation using message =
      'Canonical review changed payroll output, misclassified an event, or exceeded the application timeout.';
  end if;
end
$verify_contract$;

-- Anonymous callers cannot use the definer wrapper to bypass the mature
-- review authorization boundary.
do $anonymous_denied$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon","aal":"aal1"}', true);

  begin
    perform public.get_timekeeping_review_v2(date '2026-10-04', date '2026-10-17');
    raise check_violation using message = 'Anonymous canonical payroll review unexpectedly succeeded.';
  exception
    when insufficient_privilege then null;
  end;
end
$anonymous_denied$;

-- An authenticated but not currently MFA-verified caller must be rejected by
-- the same mature review boundary. The v2 wrapper must not turn authentication
-- alone into access to payroll detail.
do $aal1_denied$
declare
  actor_auth_id uuid;
begin
  select account.auth_user_id into actor_auth_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and 'time.view' = any(private.employee_effective_permissions(employee.id))
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  if actor_auth_id is null then
    raise insufficient_privilege using message =
      'No active time viewer is available for the AAL1 denial regression.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_id,
    'role', 'authenticated',
    'aal', 'aal1'
  )::text, true);

  begin
    perform public.get_timekeeping_review_v2(date '2026-10-04', date '2026-10-17');
    raise check_violation using message =
      'Authenticated AAL1 canonical payroll review unexpectedly succeeded.';
  exception
    when insufficient_privilege then null;
  end;
end
$aal1_denied$;

select jsonb_build_object(
  'status', 'passed',
  'cases', jsonb_agg(to_jsonb(result) order by result.case_name)
) as canonical_timekeeping_review_contract_regression
from canonical_review_results result;

rollback;
