-- Rollback-only rollout proof for the single-pass payroll review source.
-- Run after the candidate migration. It compares the candidate partitions to
-- the prior two-call source contract without changing punches or payroll data.
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
      'No active MFA time viewer is available for the payroll review regression.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_id,
    'role', 'authenticated',
    'aal', 'aal2'
  )::text, true);
end
$diagnostic_actor$;

create temp table payroll_review_single_pass_results (
  case_name text primary key,
  main_equal boolean not null,
  context_equal boolean not null,
  baseline_ms numeric not null,
  candidate_ms numeric not null,
  candidate_under_app_timeout boolean not null
) on commit drop;

do $compare_partitioned_sources$
declare
  target record;
  rules private.payroll_rules%rowtype;
  context_from_date date;
  baseline_main jsonb;
  baseline_context jsonb;
  candidate jsonb;
  baseline_started_at timestamptz;
  candidate_started_at timestamptz;
  baseline_elapsed_ms numeric;
  candidate_elapsed_ms numeric;
  main_equal boolean;
  context_equal boolean;
begin
  select * into strict rules from private.payroll_rules where id = true;

  for target in
    select * from (values
      ('prior_period', date '2026-10-04', date '2026-10-17'),
      ('current_period', date '2026-10-18', date '2026-10-31'),
      ('partial_week', date '2026-10-19', date '2026-10-24'),
      ('maximum_range', date '2026-09-04', date '2026-10-19'),
      ('empty_future', date '2099-01-04', date '2099-01-17')
    ) cases(case_name, from_date, through_date)
  loop
    context_from_date := target.from_date - mod(
      extract(dow from target.from_date)::integer - rules.week_starts_on + 7,
      7
    ) - 1;

    -- Vary order so the candidate is not always measured after two baseline
    -- scans have warmed the same effective-punch and correction pages.
    if target.case_name in ('current_period', 'empty_future') then
      candidate_started_at := clock_timestamp();
      candidate := private.get_timekeeping_review_partitioned_sources(
        target.from_date,
        target.through_date,
        context_from_date
      );
      candidate_elapsed_ms := extract(epoch from clock_timestamp() - candidate_started_at) * 1000;

      baseline_started_at := clock_timestamp();
      baseline_main := private.get_timekeeping_review_pre_payroll_week_allocation(
        target.from_date,
        target.through_date
      );
      baseline_context := private.get_timekeeping_review_pre_payroll_week_allocation(
        context_from_date,
        target.from_date - 1
      );
      baseline_elapsed_ms := extract(epoch from clock_timestamp() - baseline_started_at) * 1000;
    else
      baseline_started_at := clock_timestamp();
      baseline_main := private.get_timekeeping_review_pre_payroll_week_allocation(
        target.from_date,
        target.through_date
      );
      baseline_context := private.get_timekeeping_review_pre_payroll_week_allocation(
        context_from_date,
        target.from_date - 1
      );
      baseline_elapsed_ms := extract(epoch from clock_timestamp() - baseline_started_at) * 1000;

      candidate_started_at := clock_timestamp();
      candidate := private.get_timekeeping_review_partitioned_sources(
        target.from_date,
        target.through_date,
        context_from_date
      );
      candidate_elapsed_ms := extract(epoch from clock_timestamp() - candidate_started_at) * 1000;
    end if;

    main_equal :=
      candidate -> 'mainPayload' -> 'rows'
        = baseline_main -> 'rows'
      and candidate -> 'mainPayload' -> 'pendingCorrections'
        = baseline_main -> 'pendingCorrections'
      and candidate -> 'mainPayload' -> 'exceptionResolutionHistory'
        = baseline_main -> 'exceptionResolutionHistory';

    context_equal :=
      candidate -> 'contextPayload' -> 'rows'
        = coalesce((
          select jsonb_agg(item.value order by item.ordinality)
          from jsonb_array_elements(coalesce(baseline_context -> 'rows', '[]'::jsonb))
            with ordinality as item(value, ordinality)
          where item.value ->> 'rowKind' = 'time_event'
        ), '[]'::jsonb)
      and candidate -> 'contextPayload' -> 'pendingCorrections'
        = baseline_context -> 'pendingCorrections'
      and candidate -> 'contextPayload' -> 'exceptionResolutionHistory'
        = baseline_context -> 'exceptionResolutionHistory';

    insert into payroll_review_single_pass_results values (
      target.case_name,
      main_equal,
      context_equal,
      round(baseline_elapsed_ms, 3),
      round(candidate_elapsed_ms, 3),
      candidate_elapsed_ms < 8000
    );
  end loop;

  if exists (
    select 1
    from payroll_review_single_pass_results result
    where not result.main_equal
      or not result.context_equal
      or not result.candidate_under_app_timeout
  ) then
    raise check_violation using message =
      'Single-pass payroll review changed source payloads or exceeded the application timeout.';
  end if;
end
$compare_partitioned_sources$;

select jsonb_build_object(
  'status', 'passed',
  'cases', jsonb_agg(to_jsonb(result) order by result.case_name)
) as payroll_review_single_pass_regression
from payroll_review_single_pass_results result;

rollback;
