begin;

-- Payroll review is used by the readiness cards, exception workbench, payroll
-- lock, and export. Keep one set-based effective-punch source so those callers
-- do not repeatedly re-read the append-only correction and override history.
create or replace function private.get_effective_time_events(
  target_employee_id uuid default null
)
returns table (
  id uuid,
  employee_id uuid,
  original_shift_id uuid,
  shift_id uuid,
  location_override_name text,
  location_override_time_zone text,
  kind public.time_event_kind,
  recorded_at timestamptz,
  effective_at timestamptz,
  has_approved_correction boolean,
  voided boolean,
  pending_correction boolean,
  manual_entry_id uuid,
  manual_clock_in_at timestamptz,
  original_shift_starts_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
with source_events as materialized (
  select event.*
  from public.time_events event
  where target_employee_id is null or event.employee_id = target_employee_id
),
latest_time as (
  select distinct on (correction.time_event_id)
    correction.time_event_id,
    correction.replacement_time
  from public.time_event_corrections correction
  join source_events event on event.id = correction.time_event_id
  where correction.approved_at is not null
    and not correction.voided
    and correction.replacement_time is not null
  order by correction.time_event_id, correction.approved_at desc, correction.created_at desc, correction.id desc
),
latest_kind as (
  select distinct on (correction.time_event_id)
    correction.time_event_id,
    correction.replacement_kind
  from public.time_event_corrections correction
  join source_events event on event.id = correction.time_event_id
  where correction.approved_at is not null
    and correction.replacement_kind is not null
  order by correction.time_event_id, correction.approved_at desc, correction.created_at desc, correction.id desc
),
correction_flags as (
  select
    correction.time_event_id,
    bool_or(correction.approved_at is not null) as has_approved_correction,
    bool_or(correction.approved_at is not null and correction.voided) as voided,
    bool_or(correction.approved_at is null and correction.declined_at is null) as pending_correction
  from public.time_event_corrections correction
  join source_events event on event.id = correction.time_event_id
  group by correction.time_event_id
),
latest_shift_override as (
  select distinct on (override.time_event_id)
    override.time_event_id,
    override.shift_id
  from public.time_event_shift_overrides override
  join source_events event on event.id = override.time_event_id
  order by override.time_event_id, override.created_at desc, override.id desc
),
latest_location_override as (
  select distinct on (override.time_event_id)
    override.time_event_id,
    override.location_name,
    override.time_zone
  from public.time_event_location_overrides override
  join source_events event on event.id = override.time_event_id
  order by override.time_event_id, override.created_at desc, override.id desc
),
manual_map as (
  select distinct on (mapped.time_event_id)
    mapped.time_event_id,
    mapped.manual_entry_id,
    mapped.clock_in_at
  from (
    select entry.clock_in_event_id as time_event_id, entry.id as manual_entry_id, entry.clock_in_at, entry.created_at
    from public.manual_time_entries entry
    where entry.clock_in_event_id is not null
    union all
    select entry.clock_out_event_id, entry.id, entry.clock_in_at, entry.created_at
    from public.manual_time_entries entry
    where entry.clock_out_event_id is not null
  ) mapped
  join source_events event on event.id = mapped.time_event_id
  order by mapped.time_event_id, mapped.created_at desc, mapped.manual_entry_id desc
)
select
  event.id,
  event.employee_id,
  event.shift_id as original_shift_id,
  coalesce(shift_override.shift_id, event.shift_id) as shift_id,
  location_override.location_name,
  location_override.time_zone,
  coalesce(kind_correction.replacement_kind, event.kind) as kind,
  event.recorded_at,
  coalesce(time_correction.replacement_time, event.recorded_at) as effective_at,
  coalesce(flags.has_approved_correction, false),
  coalesce(flags.voided, false),
  coalesce(flags.pending_correction, false),
  manual.manual_entry_id,
  manual.clock_in_at,
  source_shift.starts_at
from source_events event
left join latest_time time_correction on time_correction.time_event_id = event.id
left join latest_kind kind_correction on kind_correction.time_event_id = event.id
left join correction_flags flags on flags.time_event_id = event.id
left join latest_shift_override shift_override on shift_override.time_event_id = event.id
left join latest_location_override location_override on location_override.time_event_id = event.id
left join manual_map manual on manual.time_event_id = event.id
left join public.shifts source_shift on source_shift.id = event.shift_id
$$;

revoke all on function private.get_effective_time_events(uuid) from public, anon, authenticated;

create index if not exists time_event_corrections_effective_lookup_idx
  on public.time_event_corrections (time_event_id, approved_at desc, created_at desc, id desc);
create index if not exists manual_time_entries_clock_in_event_idx
  on public.manual_time_entries (clock_in_event_id) where clock_in_event_id is not null;
create index if not exists manual_time_entries_clock_out_event_idx
  on public.manual_time_entries (clock_out_event_id) where clock_out_event_id is not null;

do $optimize_payroll_review_base$
declare
  function_sql text;
  updated_sql text;
  effective_start integer;
  grouped_start integer;
  optimized_source text := $source$effective_events as materialized (
    select event.*
    from private.get_effective_time_events() event
    where can_view_team_time or event.employee_id = reviewer_id
  ),
  identified_events as materialized (
    select
      event.*,
      case
        when event.manual_entry_id is not null
          then 'manual:' || event.manual_entry_id::text || ':employee:' || event.employee_id::text
        when event.original_shift_id is not null
          then 'shift:' || event.original_shift_id::text || ':employee:' || event.employee_id::text
        when session.session_event_id is not null
          then 'unscheduled-session:' || session.session_event_id::text || ':employee:' || event.employee_id::text
        else 'unscheduled:' || event.employee_id::text || ':' || (event.effective_at at time zone rules.time_zone)::date::text
      end as group_key,
      coalesce(
        event.manual_clock_in_at,
        event.original_shift_starts_at,
        session.session_started_at,
        event.effective_at
      ) as assignment_anchor
    from effective_events event
    left join lateral (
      select occurrence.session_event_id, occurrence.session_started_at
      from private.get_unscheduled_time_session_start(event.id, event.employee_id, event.effective_at) occurrence
      where event.original_shift_id is null
        and event.manual_entry_id is null
    ) session on true
    where not event.voided
  ),
  active_events as materialized (
    select event.*
    from identified_events event
    where (event.assignment_anchor at time zone rules.time_zone)::date between target_from_date and target_through_date
  ),
  sequenced as (
    select
      event.*,
      (event.effective_at at time zone rules.time_zone)::date as operational_date,
      (((event.effective_at at time zone rules.time_zone)::date - extract(dow from (event.effective_at at time zone rules.time_zone)::date)::integer)::date) as week_starts_on,
      (((event.effective_at at time zone rules.time_zone)::date - extract(dow from (event.effective_at at time zone rules.time_zone)::date)::integer + 6)::date) as week_ends_on,
      lag(event.kind) over (
        partition by event.employee_id, event.group_key
        order by event.effective_at, event.recorded_at, event.id
      ) as previous_kind,
      lead(event.kind) over (
        partition by event.employee_id, event.group_key
        order by event.effective_at, event.recorded_at, event.id
      ) as next_kind,
      lead(event.effective_at) over (
        partition by event.employee_id, event.group_key
        order by event.effective_at, event.recorded_at, event.id
      ) as next_effective_at,
      sum(case when event.kind = 'clock_in' then 1 else 0 end) over (
        partition by event.employee_id, event.group_key
        order by event.effective_at, event.recorded_at, event.id
        rows between unbounded preceding and current row
      )::integer as segment_number
    from active_events event
  ),
  $source$;
  context_ctes text := $context$),
  occurrence_segment_rows as (
    select
      event.employee_id,
      event.group_key,
      event.segment_number,
      min(event.effective_at) filter (where event.kind = 'clock_in') as starts_at,
      max(event.effective_at) filter (where event.kind = 'clock_out') as ends_at,
      coalesce(sum(case
        when event.kind in ('clock_in', 'break_end')
          and event.next_kind in ('break_start', 'clock_out')
          and event.next_effective_at > event.effective_at
        then extract(epoch from event.next_effective_at - event.effective_at) / 60
        else 0
      end), 0)::integer as paid_minutes,
      coalesce(sum(case
        when event.kind = 'break_start'
          and event.next_kind = 'break_end'
          and event.next_effective_at > event.effective_at
        then extract(epoch from event.next_effective_at - event.effective_at) / 60
        else 0
      end), 0)::integer as break_minutes
    from sequenced event
    where event.segment_number > 0
    group by event.employee_id, event.group_key, event.segment_number
  ),
  occurrence_segments as (
    select
      segment.employee_id,
      segment.group_key,
      jsonb_agg(jsonb_build_object(
        'segmentNumber', segment.segment_number,
        'startsAt', segment.starts_at,
        'endsAt', segment.ends_at,
        'paidMinutes', segment.paid_minutes,
        'breakMinutes', segment.break_minutes
      ) order by segment.segment_number) as segments
    from occurrence_segment_rows segment
    group by segment.employee_id, segment.group_key
  ),
  occurrence_gaps as (
    select
      event.employee_id,
      event.group_key,
      coalesce(sum(extract(epoch from event.next_effective_at - event.effective_at) / 60), 0)::integer as unpaid_gap_minutes,
      jsonb_agg(jsonb_build_object(
        'startsAt', event.effective_at,
        'endsAt', event.next_effective_at,
        'minutes', (extract(epoch from event.next_effective_at - event.effective_at) / 60)::integer
      ) order by event.effective_at) as unpaid_gaps
    from sequenced event
    where event.kind = 'clock_out'
      and event.next_kind = 'clock_in'
      and event.next_effective_at > event.effective_at
    group by event.employee_id, event.group_key
  ),
  occurrence_contexts as (
    select
      event.employee_id,
      event.group_key,
      jsonb_build_object(
        'eventCount', count(*)::integer,
        'segmentCount', count(*) filter (where event.kind = 'clock_in')::integer,
        'validSequence', coalesce(bool_and(
          (event.previous_kind is null and event.kind = 'clock_in')
          or (event.previous_kind = 'clock_in' and event.kind in ('break_start', 'clock_out'))
          or (event.previous_kind = 'break_start' and event.kind = 'break_end')
          or (event.previous_kind = 'break_end' and event.kind in ('break_start', 'clock_out'))
          or (event.previous_kind = 'clock_out' and event.kind = 'clock_in')
        ), false),
        'sequenceComplete', coalesce(bool_and(
          (event.previous_kind is null and event.kind = 'clock_in')
          or (event.previous_kind = 'clock_in' and event.kind in ('break_start', 'clock_out'))
          or (event.previous_kind = 'break_start' and event.kind = 'break_end')
          or (event.previous_kind = 'break_end' and event.kind in ('break_start', 'clock_out'))
          or (event.previous_kind = 'clock_out' and event.kind = 'clock_in')
        ), false)
          and (array_agg(event.kind order by event.effective_at, event.recorded_at, event.id))[1] = 'clock_in'
          and (array_agg(event.kind order by event.effective_at desc, event.recorded_at desc, event.id desc))[1] = 'clock_out',
        'firstClockIn', min(event.effective_at) filter (where event.kind = 'clock_in'),
        'lastClockOut', max(event.effective_at) filter (where event.kind = 'clock_out'),
        'paidMinutes', coalesce(sum(case
          when event.kind in ('clock_in', 'break_end')
            and event.next_kind in ('break_start', 'clock_out')
            and event.next_effective_at > event.effective_at
          then extract(epoch from event.next_effective_at - event.effective_at) / 60
          else 0
        end), 0)::integer,
        'breakMinutes', coalesce(sum(case
          when event.kind = 'break_start'
            and event.next_kind = 'break_end'
            and event.next_effective_at > event.effective_at
          then extract(epoch from event.next_effective_at - event.effective_at) / 60
          else 0
        end), 0)::integer,
        'unpaidGapMinutes', coalesce(gap.unpaid_gap_minutes, 0),
        'hasApprovedCorrection', bool_or(event.has_approved_correction),
        'events', jsonb_agg(jsonb_build_object(
          'id', event.id,
          'employeeId', event.employee_id,
          'shiftId', event.shift_id,
          'kind', event.kind,
          'recordedAt', event.recorded_at,
          'effectiveAt', event.effective_at,
          'hasApprovedCorrection', event.has_approved_correction,
          'voided', false
        ) order by event.effective_at, event.recorded_at, event.id),
        'segments', coalesce(segment.segments, '[]'::jsonb),
        'unpaidGaps', coalesce(gap.unpaid_gaps, '[]'::jsonb),
        'occurrenceFingerprint', encode(extensions.digest(convert_to(jsonb_build_object(
          'employeeId', event.employee_id,
          'shiftId', grouped.shift_id,
          'operationalDate', grouped.operational_date,
          'events', jsonb_agg(jsonb_build_object(
            'id', event.id,
            'kind', event.kind,
            'recordedAt', event.recorded_at,
            'effectiveAt', event.effective_at,
            'shiftId', event.shift_id
          ) order by event.effective_at, event.recorded_at, event.id)
        )::text, 'UTF8'), 'sha256'), 'hex'),
        'occurrenceKey', event.group_key,
        'assignmentAnchor', min(event.assignment_anchor)
      ) as occurrence_context
    from sequenced event
    join grouped
      on grouped.employee_id = event.employee_id
     and grouped.group_key = event.group_key
    left join occurrence_segments segment
      on segment.employee_id = event.employee_id
     and segment.group_key = event.group_key
    left join occurrence_gaps gap
      on gap.employee_id = event.employee_id
     and gap.group_key = event.group_key
    group by event.employee_id, event.group_key, grouped.shift_id, grouped.operational_date,
      segment.segments, gap.unpaid_gap_minutes, gap.unpaid_gaps
  ),
  decorated as ($context$;
begin
  select pg_get_functiondef('private.get_timekeeping_review_base(date,date)'::regprocedure)
  into function_sql;

  effective_start := position('effective_events as (' in function_sql);
  grouped_start := position('grouped as (' in function_sql);
  if effective_start = 0 or grouped_start <= effective_start then
    raise check_violation using message = 'Payroll review source boundaries could not be found.';
  end if;

  updated_sql := substring(function_sql from 1 for effective_start - 1)
    || optimized_source
    || substring(function_sql from grouped_start);

  updated_sql := replace(
    updated_sql,
    E'      event.group_key,\n      (array_remove(array_agg(event.location_override_name',
    E'      event.group_key,\n      min(event.assignment_anchor) as assignment_anchor,\n      (array_remove(array_agg(event.location_override_name'
  );
  updated_sql := replace(
    updated_sql,
    E'          or (event.previous_kind = ''break_end'' and event.kind in (''break_start'', ''clock_out''))\n        )',
    E'          or (event.previous_kind = ''break_end'' and event.kind in (''break_start'', ''clock_out''))\n          or (event.previous_kind = ''clock_out'' and event.kind = ''clock_in'')\n        )'
  );
  updated_sql := replace(updated_sql, E'  ),\n  decorated as (', context_ctes);
  updated_sql := replace(
    updated_sql,
    E'      grouped.break_minutes,\n      case',
    E'      grouped.break_minutes,\n      context.occurrence_context,\n      case'
  );
  updated_sql := replace(
    updated_sql,
    E'    from grouped\n    join public.employees employee',
    E'    from grouped\n    join occurrence_contexts context\n      on context.employee_id = grouped.employee_id\n     and context.group_key = grouped.group_key\n    join public.employees employee'
  );
  updated_sql := replace(
    updated_sql,
    E'      0::integer as break_minutes,\n      greatest(0, rules.salary_weekly_default_minutes',
    E'      0::integer as break_minutes,\n      ''{}''::jsonb as occurrence_context,\n      greatest(0, rules.salary_weekly_default_minutes'
  );
  updated_sql := replace(
    updated_sql,
    E'      ''eventCount'', event_count,\n      ''requiresArmed'',',
    E'      ''eventCount'', event_count,\n      ''eventTimeline'', coalesce(occurrence_context -> ''events'', ''[]''::jsonb),\n      ''workedSegments'', coalesce(occurrence_context -> ''segments'', ''[]''::jsonb),\n      ''unpaidGaps'', coalesce(occurrence_context -> ''unpaidGaps'', ''[]''::jsonb),\n      ''unpaidGapMinutes'', coalesce((occurrence_context ->> ''unpaidGapMinutes'')::integer, 0),\n      ''sequenceComplete'', coalesce((occurrence_context ->> ''sequenceComplete'')::boolean, row_kind = ''salary_default''),\n      ''occurrenceFingerprintSeed'', occurrence_context ->> ''occurrenceFingerprint'',\n      ''payrollOccurrenceKeySeed'', occurrence_context ->> ''occurrenceKey'',\n      ''payrollAssignmentAnchorSeed'', occurrence_context ->> ''assignmentAnchor'',\n      ''requiresArmed'','
  );

  if updated_sql = function_sql
    or position('private.get_effective_time_events()' in updated_sql) = 0
    or position('occurrence_contexts as (' in updated_sql) = 0
    or position('eventTimeline' in updated_sql) = 0
    or position('private.get_timekeeping_occurrence_key(event.id' in updated_sql) > 0
    or position('private.get_payroll_assignment_anchor(event.shift_id' in updated_sql) > 0 then
    raise check_violation using message = 'Payroll review could not be converted to the set-based source safely.';
  end if;

  execute updated_sql;
end
$optimize_payroll_review_base$;

-- The exception layer consumes the occurrence context already calculated by
-- the authoritative base instead of rebuilding the same timeline per row.
do $reuse_payroll_occurrence_context$
declare
  function_sql text;
  updated_sql text;
  context_start integer;
  codes_start integer;
  replacement text := $replacement$occurrence_context := jsonb_build_object(
      'eventCount', coalesce((base_row ->> 'eventCount')::integer, 0),
      'segmentCount', jsonb_array_length(coalesce(base_row -> 'workedSegments', '[]'::jsonb)),
      'validSequence', coalesce((base_row ->> 'sequenceComplete')::boolean, false),
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

    $replacement$;
begin
  select pg_get_functiondef('private.get_timekeeping_review_operations_base(date,date)'::regprocedure)
  into function_sql;
  context_start := position('occurrence_context := private.get_timekeeping_occurrence_context(' in function_sql);
  codes_start := position('select coalesce(array_agg(value)' in function_sql);
  if context_start = 0 or codes_start <= context_start then
    raise check_violation using message = 'Exception review occurrence boundaries could not be found.';
  end if;
  updated_sql := substring(function_sql from 1 for context_start - 1)
    || replacement
    || substring(function_sql from codes_start);
  if position('get_timekeeping_occurrence_context(' in updated_sql) > 0
    or position('occurrenceFingerprintSeed' in updated_sql) = 0 then
    raise check_violation using message = 'Exception review could not reuse the authoritative occurrence context.';
  end if;
  execute updated_sql;
end
$reuse_payroll_occurrence_context$;

-- The final payroll assignment layer reuses the occurrence identity and anchor
-- emitted by the base. This avoids a third traversal of every punch session.
do $reuse_payroll_assignment_identity$
declare
  function_sql text;
  updated_sql text;
  assignment_start integer;
  occurrence_start integer;
  occurrence_end integer;
  assignment_replacement text := $assignment$assignment_anchor := case
      when base_row ->> 'rowKind' = 'salary_default'
        then ((base_row ->> 'operationalDate')::date::timestamp + time '12:00:00') at time zone rules.time_zone
      else nullif(base_row ->> 'payrollAssignmentAnchorSeed', '')::timestamptz
    end;

    $assignment$;
  occurrence_replacement text := $occurrence$calculated_occurrence_key := case
      when base_row ->> 'rowKind' = 'salary_default'
        then 'salary:' || (base_row ->> 'employeeId') || ':' || (base_row ->> 'operationalDate')
      else coalesce(
        nullif(base_row ->> 'payrollOccurrenceKeySeed', ''),
        'unresolved:' || (base_row ->> 'employeeId') || ':' || (base_row ->> 'operationalDate')
      )
    end;

    $occurrence$;
begin
  select pg_get_functiondef('public.get_timekeeping_review(date,date)'::regprocedure)
  into function_sql;

  assignment_start := position('assignment_anchor := case' in function_sql);
  occurrence_start := position('calculated_occurrence_key := case' in function_sql);
  if assignment_start = 0 or occurrence_start <= assignment_start then
    raise check_violation using message = 'Payroll assignment reuse boundaries could not be found.';
  end if;
  updated_sql := substring(function_sql from 1 for assignment_start - 1)
    || assignment_replacement
    || substring(function_sql from occurrence_start);

  occurrence_start := position('calculated_occurrence_key := case' in updated_sql);
  occurrence_end := position('calculated_occurrence_fingerprint :=' in updated_sql);
  if occurrence_start = 0 or occurrence_end <= occurrence_start then
    raise check_violation using message = 'Payroll occurrence reuse boundaries could not be found.';
  end if;
  updated_sql := substring(updated_sql from 1 for occurrence_start - 1)
    || occurrence_replacement
    || substring(updated_sql from occurrence_end);

  if position('payrollAssignmentAnchorSeed' in updated_sql) = 0
    or position('payrollOccurrenceKeySeed' in updated_sql) = 0
    or position('private.get_timekeeping_occurrence_key(' in substring(updated_sql from assignment_start for 1600)) > 0
    or position('private.get_payroll_assignment_anchor(' in substring(updated_sql from assignment_start for 1600)) > 0 then
    raise check_violation using message = 'Payroll assignment identity could not be reused safely.';
  end if;
  execute updated_sql;
end
$reuse_payroll_assignment_identity$;

notify pgrst, 'reload schema';
commit;
