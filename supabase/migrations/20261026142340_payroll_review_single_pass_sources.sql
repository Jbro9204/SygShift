begin;
set local lock_timeout = '2s';
set local statement_timeout = '8s';

-- Build the requested and payroll-prefix sources from one authoritative review
-- pipeline. The public review still receives the same two logical payloads;
-- this helper only prevents their shared effective-punch/category work from
-- being rebuilt twice.
create function private.get_timekeeping_review_partitioned_sources(
  target_from_date date,
  target_through_date date,
  target_context_from_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  source_payload jsonb;
  main_source_payload jsonb;
  context_source_payload jsonb;
  main_rows jsonb := '[]'::jsonb;
  context_rows jsonb := '[]'::jsonb;
  main_pending_corrections jsonb := '[]'::jsonb;
  context_pending_corrections jsonb := '[]'::jsonb;
  main_exception_history jsonb := '[]'::jsonb;
  context_exception_history jsonb := '[]'::jsonb;
begin
  if target_from_date is null
    or target_through_date is null
    or target_context_from_date is null
    or target_context_from_date > target_from_date
    or target_through_date < target_from_date
  then
    raise check_violation using message = 'A valid time-review source range is required.';
  end if;

  -- The mature calculator intentionally caps one source request at 46 days.
  -- Ordinary payroll periods that begin on the configured payroll-week
  -- boundary plus their prefix fit inside that cap and use one pipeline
  -- execution. A mid-week range must retain two bounded source calls: widening
  -- the main source backward would otherwise change its carried isOvertime and
  -- payrollNotes fields before the elapsed-time allocator applies context. The
  -- same exact-contract fallback applies to the full 46-day review range.
  if target_through_date - target_context_from_date > 45
    or target_context_from_date < target_from_date - 1
  then
    main_source_payload := private.get_timekeeping_review_pre_payroll_week_allocation(
      target_from_date,
      target_through_date
    );
    context_source_payload := private.get_timekeeping_review_pre_payroll_week_allocation(
      target_context_from_date,
      target_from_date - 1
    );

    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into context_rows
    from jsonb_array_elements(coalesce(context_source_payload -> 'rows', '[]'::jsonb))
      with ordinality as item(value, ordinality)
    where item.value ->> 'rowKind' = 'time_event';

    return jsonb_build_object(
      'mainPayload', main_source_payload,
      'contextPayload', context_source_payload || jsonb_build_object(
        'rows', context_rows
      )
    );
  end if;

  source_payload := private.get_timekeeping_review_pre_payroll_week_allocation(
    target_context_from_date,
    target_through_date
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into main_rows
  from jsonb_array_elements(coalesce(source_payload -> 'rows', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  where (
      item.value ->> 'rowKind' = 'salary_default'
      and coalesce(
        nullif(item.value ->> 'weekStartsOn', '')::date,
        nullif(item.value ->> 'operationalDate', '')::date
      ) <= target_through_date
      and coalesce(
        nullif(item.value ->> 'weekEndsOn', '')::date,
        nullif(item.value ->> 'operationalDate', '')::date
      ) >= target_from_date
    )
    or (
      item.value ->> 'rowKind' <> 'salary_default'
      and (item.value ->> 'operationalDate')::date
        between target_from_date and target_through_date
    );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into context_rows
  from jsonb_array_elements(coalesce(source_payload -> 'rows', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  where item.value ->> 'rowKind' = 'time_event'
    and (item.value ->> 'operationalDate')::date
      between target_context_from_date and target_from_date - 1;

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into main_pending_corrections
  from jsonb_array_elements(coalesce(source_payload -> 'pendingCorrections', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  where exists (
    select 1
    from jsonb_array_elements(main_rows) returned(row_value)
    cross join lateral jsonb_array_elements(
      coalesce(returned.row_value -> 'eventTimeline', '[]'::jsonb)
    ) timeline(event_value)
    where timeline.event_value ->> 'id' = item.value ->> 'timeEventId'
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into context_pending_corrections
  from jsonb_array_elements(coalesce(source_payload -> 'pendingCorrections', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  where exists (
    select 1
    from jsonb_array_elements(context_rows) returned(row_value)
    cross join lateral jsonb_array_elements(
      coalesce(returned.row_value -> 'eventTimeline', '[]'::jsonb)
    ) timeline(event_value)
    where timeline.event_value ->> 'id' = item.value ->> 'timeEventId'
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into main_exception_history
  from jsonb_array_elements(coalesce(source_payload -> 'exceptionResolutionHistory', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  where exists (
    select 1
    from jsonb_array_elements(main_rows) returned(row_value)
    where returned.row_value ->> 'rowKind' = 'time_event'
      and returned.row_value ->> 'employeeId' = item.value ->> 'employeeId'
      and returned.row_value ->> 'operationalDate' = item.value ->> 'operationalDate'
      and nullif(returned.row_value ->> 'shiftId', '') is not distinct from
        nullif(item.value ->> 'shiftId', '')
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into context_exception_history
  from jsonb_array_elements(coalesce(source_payload -> 'exceptionResolutionHistory', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  where exists (
    select 1
    from jsonb_array_elements(context_rows) returned(row_value)
    where returned.row_value ->> 'rowKind' = 'time_event'
      and returned.row_value ->> 'employeeId' = item.value ->> 'employeeId'
      and returned.row_value ->> 'operationalDate' = item.value ->> 'operationalDate'
      and nullif(returned.row_value ->> 'shiftId', '') is not distinct from
        nullif(item.value ->> 'shiftId', '')
  );

  return jsonb_build_object(
    'mainPayload', source_payload || jsonb_build_object(
      'fromDate', target_from_date,
      'throughDate', target_through_date,
      'rows', main_rows,
      'pendingCorrections', main_pending_corrections,
      'exceptionResolutionHistory', main_exception_history
    ),
    'contextPayload', source_payload || jsonb_build_object(
      'fromDate', target_context_from_date,
      'throughDate', target_from_date - 1,
      'rows', context_rows,
      'pendingCorrections', context_pending_corrections,
      'exceptionResolutionHistory', context_exception_history
    )
  );
end;
$$;

revoke all on function private.get_timekeeping_review_partitioned_sources(date, date, date)
  from public, anon, authenticated;

do $single_pass_timekeeping_sources$
declare
  signature constant regprocedure := 'public.get_timekeeping_review(date,date)'::regprocedure;
  original_function pg_catalog.pg_proc%rowtype;
  revised_function pg_catalog.pg_proc%rowtype;
  original_sql text;
  revised_sql text;
  partition_token text;
  corrected_filter_token text;
begin
  select * into strict original_function
  from pg_catalog.pg_proc
  where oid = signature;
  original_sql := pg_get_functiondef(signature);

  if md5(original_sql) = 'e244e55e85645ca05e7496588d860e8c' then
    return;
  end if;
  if md5(original_sql) <> '9656bc6ff66fdf926a0c09c5f4852d24' then
    raise check_violation using message =
      'Payroll review source changed after the verified timeout baseline; review before applying.';
  end if;

  partition_token := $old_partition$
  payload := private.get_timekeeping_review_pre_payroll_week_allocation(
    target_from_date,
    target_through_date
  );

  -- Prefix context starts on the operational day before the current overtime
  -- week (at most seven days earlier). This includes the prior Saturday
  -- occurrence even when a caller starts a partial-week review after Sunday.
  context_from_date := target_from_date - mod(
    extract(dow from target_from_date)::integer - rules.week_starts_on + 7,
    7
  ) - 1;

  if context_from_date <= target_from_date - 1 then
    context_payload := private.get_timekeeping_review_pre_payroll_week_allocation(
      context_from_date,
      target_from_date - 1
    );
  end if;
$old_partition$;

  if cardinality(string_to_array(original_sql, partition_token)) <> 2 then
    raise check_violation using message = 'Payroll review source-partition token is not unique.';
  end if;

  revised_sql := replace(original_sql, partition_token, $new_partition$
  -- Prefix context starts on the operational day before the current overtime
  -- week (at most seven days earlier). This includes the prior Saturday
  -- occurrence even when a caller starts a partial-week review after Sunday.
  context_from_date := target_from_date - mod(
    extract(dow from target_from_date)::integer - rules.week_starts_on + 7,
    7
  ) - 1;

  corrected_payload := private.get_timekeeping_review_partitioned_sources(
    target_from_date,
    target_through_date,
    context_from_date
  );
  payload := corrected_payload -> 'mainPayload';
  context_payload := corrected_payload -> 'contextPayload';
  corrected_payload := '{}'::jsonb;
$new_partition$);

  corrected_filter_token := $old_corrected_filter$
      and coalesce(
        (shift.starts_at at time zone shift.time_zone)::date,
        (assignment.assignment_anchor at time zone rules.time_zone)::date
      ) is not null
$old_corrected_filter$;

  if cardinality(string_to_array(revised_sql, corrected_filter_token)) <> 2 then
    raise check_violation using message = 'Corrected payroll source token is not unique.';
  end if;

  revised_sql := replace(revised_sql, corrected_filter_token, $new_corrected_filter$
      and coalesce(
        (shift.starts_at at time zone shift.time_zone)::date,
        (assignment.assignment_anchor at time zone rules.time_zone)::date
      ) is not null
      and not (
        coalesce(
          (shift.starts_at at time zone shift.time_zone)::date,
          (assignment.assignment_anchor at time zone rules.time_zone)::date
        ) between context_from_date and target_through_date
      )
$new_corrected_filter$);

  if md5(revised_sql) <> 'e244e55e85645ca05e7496588d860e8c' then
    raise check_violation using message =
      'Payroll review single-pass candidate differs from the independently verified source.';
  end if;

  execute revised_sql;
  select * into strict revised_function
  from pg_catalog.pg_proc
  where oid = signature;

  if pg_get_functiondef(signature) <> revised_sql
    or revised_function.proowner is distinct from original_function.proowner
    or revised_function.proacl is distinct from original_function.proacl
    or revised_function.proconfig is distinct from original_function.proconfig
    or revised_function.prosecdef is distinct from original_function.prosecdef
    or revised_function.provolatile is distinct from original_function.provolatile
    or revised_function.proargdefaults is distinct from original_function.proargdefaults
  then
    raise check_violation using message =
      'Payroll review single-pass change did not preserve the verified function boundary.';
  end if;
end
$single_pass_timekeeping_sources$;

comment on function private.get_timekeeping_review_partitioned_sources(date, date, date) is
  'Builds requested and prefix review sources from one authoritative timekeeping pipeline execution.';

commit;
