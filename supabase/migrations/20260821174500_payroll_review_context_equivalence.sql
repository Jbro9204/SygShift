begin;

-- The set-based payroll source is authoritative for ordinary completed punch
-- pairs. Complex or incomplete rows still need the occurrence-aware scope that
-- follows mapped shifts and cross-midnight work sessions. Limiting that lookup
-- to the rows that need it keeps the review fast without changing exception
-- fingerprints or previously recorded resolution history.
do $preserve_complex_occurrence_context$
declare
  function_sql text;
  updated_sql text;
  context_start integer;
  codes_start integer;
  replacement text := $replacement$if not coalesce((base_row ->> 'sequenceComplete')::boolean, false)
      or coalesce((base_row ->> 'eventCount')::integer, 0) > 2 then
      occurrence_context := private.get_timekeeping_occurrence_context(
        (base_row ->> 'employeeId')::uuid,
        nullif(base_row ->> 'shiftId', '')::uuid,
        (base_row ->> 'operationalDate')::date,
        nullif(base_row ->> 'firstClockIn', '')::timestamptz
      );
    else
      occurrence_context := jsonb_build_object(
        'eventCount', coalesce((base_row ->> 'eventCount')::integer, 0),
        'segmentCount', jsonb_array_length(coalesce(base_row -> 'workedSegments', '[]'::jsonb)),
        'validSequence', coalesce((base_row ->> 'validSequence')::boolean, false),
        'sequenceComplete', coalesce((base_row ->> 'sequenceComplete')::boolean, false),
        'firstClockIn', base_row -> 'firstClockIn',
        'lastClockOut', base_row -> 'lastClockOut',
        'paidMinutes', coalesce((base_row ->> 'paidMinutes')::integer, 0),
        'breakMinutes', coalesce((base_row ->> 'breakMinutes')::integer, 0),
        'unpaidGapMinutes', coalesce((base_row ->> 'unpaidGapMinutes')::integer, 0),
        'hasApprovedCorrection', coalesce(base_row ->> 'reviewStatus' = 'corrected', false),
        'events', coalesce(base_row -> 'eventTimeline', '[]'::jsonb),
        'segments', coalesce(base_row -> 'workedSegments', '[]'::jsonb),
        'unpaidGaps', coalesce(base_row -> 'unpaidGaps', '[]'::jsonb),
        'occurrenceFingerprint', base_row ->> 'occurrenceFingerprintSeed'
      );
    end if;

    $replacement$;
begin
  select pg_get_functiondef('private.get_timekeeping_review_base(date,date)'::regprocedure)
  into function_sql;
  updated_sql := replace(
    function_sql,
    E'      ''sequenceComplete'', coalesce((occurrence_context ->> ''sequenceComplete'')::boolean, row_kind = ''salary_default''),',
    E'      ''validSequence'', coalesce((occurrence_context ->> ''validSequence'')::boolean, row_kind = ''salary_default''),\n      ''sequenceComplete'', coalesce((occurrence_context ->> ''sequenceComplete'')::boolean, row_kind = ''salary_default''),'
  );
  if updated_sql = function_sql or position('''validSequence'', coalesce' in updated_sql) = 0 then
    raise check_violation using message = 'The payroll base could not expose sequence validity safely.';
  end if;
  execute updated_sql;

  select pg_get_functiondef('private.get_timekeeping_review_operations_base(date,date)'::regprocedure)
  into function_sql;
  context_start := position('occurrence_context := jsonb_build_object(' in function_sql);
  codes_start := position('select coalesce(array_agg(value)' in function_sql);
  if context_start = 0 or codes_start <= context_start then
    raise check_violation using message = 'The payroll exception context boundaries could not be found.';
  end if;
  updated_sql := substring(function_sql from 1 for context_start - 1)
    || replacement
    || substring(function_sql from codes_start);
  if position('get_timekeeping_occurrence_context(' in updated_sql) = 0
    or position('eventCount' in updated_sql) = 0
    or position('firstClockIn' in updated_sql) = 0 then
    raise check_violation using message = 'Complex payroll occurrences could not retain their authoritative context.';
  end if;
  execute updated_sql;
end
$preserve_complex_occurrence_context$;

notify pgrst, 'reload schema';
commit;
