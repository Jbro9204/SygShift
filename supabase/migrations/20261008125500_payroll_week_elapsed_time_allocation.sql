begin;

-- Payroll batches keep their configured Sunday 00:00 America/Denver boundary,
-- but completed worked-time occurrences now contribute only the elapsed minutes
-- that fall inside each payroll week. The canonical shift and punch occurrence
-- remain unchanged; this policy applies only to derived review/export slices.
alter table private.payroll_rules
  drop constraint if exists payroll_rules_cross_boundary_policy_check,
  add constraint payroll_rules_cross_boundary_policy_check
    check (cross_boundary_grouping_policy in (
      'scheduled_shift_start',
      'elapsed_time_boundary_split'
    ));

update private.payroll_rules
set
  cross_boundary_grouping_policy = 'elapsed_time_boundary_split',
  payroll_policy_effective_from = date '2026-10-08',
  payroll_configuration_version = case
    when payroll_calculation_policy_version = 'payroll-batch-v2'
      and cross_boundary_grouping_policy = 'elapsed_time_boundary_split'
    then payroll_configuration_version
    else greatest(payroll_configuration_version + 1, 2)
  end,
  payroll_calculation_policy_version = 'payroll-batch-v2',
  updated_at = clock_timestamp()
where id = true;

create index if not exists payroll_batch_assignments_corrected_week_idx
  on private.payroll_batch_assignments (assigned_week_start)
  where assignment_status = 'corrected';

create index if not exists payroll_export_rows_occurrence_key_idx
  on private.payroll_export_rows ((row_payload ->> 'payrollOccurrenceKey'))
  where nullif(row_payload ->> 'payrollOccurrenceKey', '') is not null;

create index if not exists payroll_export_rows_week_allocations_gin_idx
  on private.payroll_export_rows
  using gin ((row_payload -> 'payrollWeekAllocations'))
  where jsonb_typeof(row_payload -> 'payrollWeekAllocations') = 'array';

-- Produce deterministic minute buckets for one canonical occurrence. Buckets
-- are split at both payroll-week and requested-range boundaries. Whole-minute
-- rounding uses a largest-remainder allocation so the buckets add back to the
-- already-reviewed whole occurrence without changing punch evidence.
create function private.get_payroll_boundary_minute_slices(
  target_row jsonb,
  target_range_start timestamptz,
  target_range_end_exclusive timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with rules as (
  select rule.*
  from private.payroll_rules rule
  where rule.id = true
), occurrence_limits as (
  select
    nullif(target_row ->> 'firstClockIn', '')::timestamptz as occurrence_start,
    nullif(target_row ->> 'lastClockOut', '')::timestamptz as occurrence_end,
    greatest(coalesce((target_row ->> 'grossMinutes')::integer, 0), 0) as gross_target,
    greatest(coalesce((target_row ->> 'paidMinutes')::integer, 0), 0) as paid_target,
    greatest(coalesce((target_row ->> 'breakMinutes')::integer, 0), 0) as break_target,
    greatest(coalesce((target_row ->> 'unpaidGapMinutes')::integer, 0), 0) as unpaid_gap_target,
    coalesce(target_row ->> 'payrollAssignmentStatus' = 'corrected', false)
      and nullif(target_row ->> 'payrollBatchWeekStartsOn', '') is not null
      as corrected_assignment,
    nullif(target_row ->> 'payrollBatchWeekStartsOn', '')::date as corrected_week_start
), event_rows as (
  select
    event_item.ordinality::integer as sequence_number,
    event_item.value ->> 'kind' as kind,
    nullif(event_item.value ->> 'effectiveAt', '')::timestamptz as effective_at
  from jsonb_array_elements(coalesce(target_row -> 'eventTimeline', '[]'::jsonb))
    with ordinality as event_item(value, ordinality)
  where not coalesce((event_item.value ->> 'voided')::boolean, false)
    and nullif(event_item.value ->> 'effectiveAt', '') is not null
), sequenced_events as (
  select
    event.sequence_number,
    event.kind,
    event.effective_at,
    lead(event.kind) over (
      order by event.effective_at, event.sequence_number
    ) as next_kind,
    lead(event.effective_at) over (
      order by event.effective_at, event.sequence_number
    ) as next_effective_at
  from event_rows event
), paid_intervals as (
  select event.effective_at as starts_at, event.next_effective_at as ends_at
  from sequenced_events event
  where event.kind in ('clock_in', 'break_end')
    and event.next_kind in ('break_start', 'clock_out')
    and event.next_effective_at > event.effective_at
), break_intervals as (
  select event.effective_at as starts_at, event.next_effective_at as ends_at
  from sequenced_events event
  where event.kind = 'break_start'
    and event.next_kind = 'break_end'
    and event.next_effective_at > event.effective_at
), unpaid_gap_intervals as (
  select event.effective_at as starts_at, event.next_effective_at as ends_at
  from sequenced_events event
  where event.kind = 'clock_out'
    and event.next_kind = 'clock_in'
    and event.next_effective_at > event.effective_at
), week_limits as (
  select
    (private.get_payroll_batch_week(limits.occurrence_start) ->> 'weekStartsOn')::date
      as first_week_start,
    (private.get_payroll_batch_week(limits.occurrence_end - interval '1 microsecond') ->> 'weekStartsOn')::date
      as last_week_start
  from occurrence_limits limits
  where limits.occurrence_start is not null
    and limits.occurrence_end > limits.occurrence_start
    and not limits.corrected_assignment
), week_bounds as (
  select
    week_start::date as week_starts_on,
    (week_start::date + 6) as week_ends_on,
    (week_start::date::timestamp + rules.payroll_week_start_time)
      at time zone rules.time_zone as starts_at,
    ((week_start::date + 7)::timestamp + rules.payroll_week_start_time)
      at time zone rules.time_zone as ends_at_exclusive
  from week_limits
  cross join rules
  cross join lateral generate_series(
    week_limits.first_week_start,
    week_limits.last_week_start,
    interval '7 days'
  ) week_start
  union all
  select
    limits.corrected_week_start,
    limits.corrected_week_start + 6,
    (limits.corrected_week_start::timestamp + rules.payroll_week_start_time)
      at time zone rules.time_zone,
    ((limits.corrected_week_start + 7)::timestamp + rules.payroll_week_start_time)
      at time zone rules.time_zone
  from occurrence_limits limits
  cross join rules
  where limits.corrected_assignment
    and limits.occurrence_start is not null
    and limits.occurrence_end > limits.occurrence_start
), boundary_points as (
  select limits.occurrence_start as boundary_at
  from occurrence_limits limits
  where limits.occurrence_start is not null
  union
  select limits.occurrence_end
  from occurrence_limits limits
  where limits.occurrence_end is not null
  union
  select week.starts_at
  from week_bounds week
  cross join occurrence_limits limits
  where not limits.corrected_assignment
    and week.starts_at > limits.occurrence_start
    and week.starts_at < limits.occurrence_end
  union
  select week.ends_at_exclusive
  from week_bounds week
  cross join occurrence_limits limits
  where not limits.corrected_assignment
    and week.ends_at_exclusive > limits.occurrence_start
    and week.ends_at_exclusive < limits.occurrence_end
  union
  select target_range_start
  from occurrence_limits limits
  where not limits.corrected_assignment
    and target_range_start > limits.occurrence_start
    and target_range_start < limits.occurrence_end
  union
  select target_range_end_exclusive
  from occurrence_limits limits
  where not limits.corrected_assignment
    and target_range_end_exclusive > limits.occurrence_start
    and target_range_end_exclusive < limits.occurrence_end
), ordered_boundaries as (
  select
    boundary.boundary_at as starts_at,
    lead(boundary.boundary_at) over (order by boundary.boundary_at) as ends_at
  from boundary_points boundary
), buckets as (
  select
    row_number() over (order by boundary.starts_at)::integer as bucket_number,
    week.week_starts_on,
    week.week_ends_on,
    week.starts_at as week_starts_at,
    week.ends_at_exclusive as week_ends_at_exclusive,
    boundary.starts_at,
    boundary.ends_at,
    case
      when limits.corrected_assignment then
        week.starts_at < target_range_end_exclusive
          and week.ends_at_exclusive > target_range_start
      else boundary.starts_at >= target_range_start
        and boundary.ends_at <= target_range_end_exclusive
    end as in_requested_range
  from ordered_boundaries boundary
  cross join occurrence_limits limits
  join week_bounds week
    on limits.corrected_assignment
    or (
      boundary.starts_at >= week.starts_at
      and boundary.starts_at < week.ends_at_exclusive
    )
  where boundary.ends_at > boundary.starts_at
), raw_seconds as (
  select
    bucket.*,
    extract(epoch from bucket.ends_at - bucket.starts_at)::numeric as gross_seconds,
    coalesce((
      select sum(extract(epoch from
        least(paid.ends_at, bucket.ends_at)
        - greatest(paid.starts_at, bucket.starts_at)
      ))
      from paid_intervals paid
      where paid.starts_at < bucket.ends_at
        and paid.ends_at > bucket.starts_at
    ), 0)::numeric as paid_seconds,
    coalesce((
      select sum(extract(epoch from
        least(break_time.ends_at, bucket.ends_at)
        - greatest(break_time.starts_at, bucket.starts_at)
      ))
      from break_intervals break_time
      where break_time.starts_at < bucket.ends_at
        and break_time.ends_at > bucket.starts_at
    ), 0)::numeric as break_seconds,
    coalesce((
      select sum(extract(epoch from
        least(gap.ends_at, bucket.ends_at)
        - greatest(gap.starts_at, bucket.starts_at)
      ))
      from unpaid_gap_intervals gap
      where gap.starts_at < bucket.ends_at
        and gap.ends_at > bucket.starts_at
    ), 0)::numeric as unpaid_gap_seconds
  from buckets bucket
), base_minutes as (
  select
    raw.*,
    floor(raw.gross_seconds / 60)::integer as gross_floor,
    floor(raw.paid_seconds / 60)::integer as paid_floor,
    floor(raw.break_seconds / 60)::integer as break_floor,
    floor(raw.unpaid_gap_seconds / 60)::integer as unpaid_gap_floor,
    raw.gross_seconds - floor(raw.gross_seconds / 60) * 60 as gross_remainder,
    raw.paid_seconds - floor(raw.paid_seconds / 60) * 60 as paid_remainder,
    raw.break_seconds - floor(raw.break_seconds / 60) * 60 as break_remainder,
    raw.unpaid_gap_seconds - floor(raw.unpaid_gap_seconds / 60) * 60 as unpaid_gap_remainder
  from raw_seconds raw
), ranked_minutes as (
  select
    base.*,
    sum(base.gross_floor) over ()::integer as gross_floor_total,
    sum(base.paid_floor) over ()::integer as paid_floor_total,
    sum(base.break_floor) over ()::integer as break_floor_total,
    sum(base.unpaid_gap_floor) over ()::integer as unpaid_gap_floor_total,
    row_number() over (
      order by base.gross_remainder desc, base.starts_at, base.bucket_number
    )::integer as gross_rank,
    row_number() over (
      order by base.paid_remainder desc, base.starts_at, base.bucket_number
    )::integer as paid_rank,
    row_number() over (
      order by base.break_remainder desc, base.starts_at, base.bucket_number
    )::integer as break_rank,
    row_number() over (
      order by base.unpaid_gap_remainder desc, base.starts_at, base.bucket_number
    )::integer as unpaid_gap_rank
  from base_minutes base
), apportioned as (
  select
    ranked.bucket_number,
    ranked.week_starts_on,
    ranked.week_ends_on,
    ranked.week_starts_at,
    ranked.week_ends_at_exclusive,
    ranked.starts_at,
    ranked.ends_at,
    ranked.in_requested_range,
    ranked.gross_floor + case
      when ranked.gross_rank <= greatest(limits.gross_target - ranked.gross_floor_total, 0)
      then 1 else 0 end as gross_minutes,
    ranked.paid_floor + case
      when ranked.paid_rank <= greatest(limits.paid_target - ranked.paid_floor_total, 0)
      then 1 else 0 end as paid_minutes,
    ranked.break_floor + case
      when ranked.break_rank <= greatest(limits.break_target - ranked.break_floor_total, 0)
      then 1 else 0 end as break_minutes,
    ranked.unpaid_gap_floor + case
      when ranked.unpaid_gap_rank <= greatest(
        limits.unpaid_gap_target - ranked.unpaid_gap_floor_total,
        0
      ) then 1 else 0 end as unpaid_gap_minutes
  from ranked_minutes ranked
  cross join occurrence_limits limits
)
select coalesce(jsonb_agg(jsonb_build_object(
  'bucketNumber', slice.bucket_number,
  'weekStartsOn', slice.week_starts_on,
  'weekEndsOn', slice.week_ends_on,
  'weekStartsAt', slice.week_starts_at,
  'weekEndsAtExclusive', slice.week_ends_at_exclusive,
  'startsAt', slice.starts_at,
  'endsAtExclusive', slice.ends_at,
  'inRequestedRange', slice.in_requested_range,
  'grossMinutes', slice.gross_minutes,
  'breakMinutes', slice.break_minutes,
  'unpaidGapMinutes', slice.unpaid_gap_minutes,
  'paidMinutes', slice.paid_minutes
) order by slice.starts_at, slice.bucket_number), '[]'::jsonb)
from apportioned slice
$$;

revoke all on function private.get_payroll_boundary_minute_slices(
  jsonb,
  timestamptz,
  timestamptz
) from public, anon, authenticated;

-- Repair the mature category-lock trigger before v2 exports exercise it. The
-- former local variable name collided with event.occurrence_key under the
-- database's PL/pgSQL ambiguity checks; behavior and privilege boundaries stay
-- otherwise unchanged.
create or replace function private.validate_payroll_export_row_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_occurrence_key text;
  effective_category text;
  category_count integer := 0;
  payload_category text := lower(nullif(new.row_payload ->> 'payrollCategory', ''));
  category_minutes integer;
begin
  target_occurrence_key := nullif(new.row_payload ->> 'payrollOccurrenceKey', '');
  if target_occurrence_key is null then
    raise check_violation using message =
      'Payroll category could not be tied to an authoritative worked-time occurrence.';
  end if;

  perform private.lock_payroll_category_occurrence(target_occurrence_key);

  select
    count(distinct event.payroll_category)::integer,
    min(event.payroll_category)
  into category_count, effective_category
  from private.get_effective_time_event_payroll_categories(new.employee_id) event
  where not event.voided
    and event.occurrence_key = target_occurrence_key;

  if category_count = 0 then
    raise check_violation using message =
      'Payroll category could not be verified for this locked worked-time row.';
  end if;

  if category_count <> 1
    or coalesce((new.row_payload ->> 'mixedPayrollCategories')::boolean, false)
  then
    raise check_violation using message =
      'Payroll cannot be locked while a worked-time occurrence has mixed payroll categories.';
  end if;

  if payload_category is null or payload_category <> effective_category then
    raise check_violation using message =
      'Payroll category changed while payroll was being locked. Refresh and review again.';
  end if;

  category_minutes :=
    coalesce((new.row_payload ->> 'regularCategoryMinutes')::integer, 0)
    + coalesce((new.row_payload ->> 'epMinutes')::integer, 0)
    + coalesce((new.row_payload ->> 'truepMinutes')::integer, 0)
    + coalesce((new.row_payload ->> 'unclassifiedCategoryMinutes')::integer, 0);

  if category_minutes <> new.paid_minutes
    or coalesce((new.row_payload ->> 'unclassifiedCategoryMinutes')::integer, 0) <> 0
  then
    raise check_violation using message =
      'Payroll category minute totals do not reconcile to paid minutes.';
  end if;

  new.row_payload := new.row_payload || jsonb_build_object(
    'payrollCategory', effective_category,
    'payrollCategoryLabel', case effective_category
      when 'ep' then 'EP'
      when 'truep' then 'TRUEP'
      else 'Regular'
    end,
    'payrollCategoryResolved', true,
    'mixedPayrollCategories', false
  );

  return new;
end;
$$;

revoke all on function private.validate_payroll_export_row_category()
  from public, anon, authenticated;

-- Serialize allocation ownership by canonical occurrence. Distinct week keys
-- may be locked by distinct v2 batches, while an already locked key cannot be
-- paid twice. A legacy locked row has no slice key, so it continues to own its
-- entire occurrence and blocks v2 reallocation.
create function private.validate_payroll_export_row_allocation_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  occurrence_key text := nullif(new.row_payload ->> 'payrollOccurrenceKey', '');
  allocations jsonb := new.row_payload -> 'payrollWeekAllocations';
  allocation_item jsonb;
  allocation_key text;
  duplicate_key text;
  week_starts_on date;
  week_ends_on date;
  allocation_paid integer := 0;
  allocation_gross integer := 0;
  allocation_break integer := 0;
  allocation_unpaid_gap integer := 0;
  allocation_regular integer := 0;
  allocation_overtime integer := 0;
  allocation_regular_category integer := 0;
  allocation_ep integer := 0;
  allocation_truep integer := 0;
  allocation_unclassified integer := 0;
begin
  if occurrence_key is null then
    raise check_violation using message =
      'Payroll allocation could not be tied to an authoritative worked-time occurrence.';
  end if;

  if new.row_payload ->> 'payrollPolicyVersion' is distinct from 'payroll-batch-v2'
    or jsonb_typeof(allocations) is distinct from 'array'
    or coalesce(case
      when jsonb_typeof(allocations) = 'array' then jsonb_array_length(allocations)
      else 0
    end, 0) = 0
  then
    raise check_violation using message =
      'A payroll-batch-v2 worked-time row requires at least one authoritative week allocation.';
  end if;

  perform private.lock_payroll_category_occurrence(occurrence_key);

  select candidate.allocation_key
  into duplicate_key
  from (
    select item.value ->> 'allocationKey' as allocation_key, count(*)
    from jsonb_array_elements(allocations) item(value)
    group by item.value ->> 'allocationKey'
    having count(*) > 1 or nullif(item.value ->> 'allocationKey', '') is null
  ) candidate
  limit 1;

  if duplicate_key is not null
    or exists (
      select 1
      from jsonb_array_elements(allocations) item(value)
      where nullif(item.value ->> 'allocationKey', '') is null
    )
  then
    raise check_violation using message =
      'Payroll week allocations require distinct, non-empty allocation keys.';
  end if;

  for allocation_item in
    select item.value
    from jsonb_array_elements(allocations) item(value)
  loop
    allocation_key := allocation_item ->> 'allocationKey';
    week_starts_on := nullif(allocation_item ->> 'weekStartsOn', '')::date;
    week_ends_on := nullif(allocation_item ->> 'weekEndsOn', '')::date;

    if week_starts_on is null
      or week_ends_on is null
      or extract(dow from week_starts_on)::integer <> 0
      or week_ends_on <> week_starts_on + 6
      or allocation_key <> occurrence_key || '|' || week_starts_on::text
      or coalesce((allocation_item ->> 'grossMinutes')::integer, -1) < 0
      or coalesce((allocation_item ->> 'breakMinutes')::integer, -1) < 0
      or coalesce((allocation_item ->> 'unpaidGapMinutes')::integer, -1) < 0
      or coalesce((allocation_item ->> 'paidMinutes')::integer, -1) < 0
      or coalesce((allocation_item ->> 'regularMinutes')::integer, -1) < 0
      or coalesce((allocation_item ->> 'overtimeMinutes')::integer, -1) < 0
      or coalesce((allocation_item ->> 'regularCategoryMinutes')::integer, -1) < 0
      or coalesce((allocation_item ->> 'epMinutes')::integer, -1) < 0
      or coalesce((allocation_item ->> 'truepMinutes')::integer, -1) < 0
      or coalesce((allocation_item ->> 'unclassifiedCategoryMinutes')::integer, -1) < 0
      or coalesce((allocation_item ->> 'regularMinutes')::integer, 0)
        + coalesce((allocation_item ->> 'overtimeMinutes')::integer, 0)
        <> coalesce((allocation_item ->> 'paidMinutes')::integer, 0)
      or coalesce((allocation_item ->> 'regularCategoryMinutes')::integer, 0)
        + coalesce((allocation_item ->> 'epMinutes')::integer, 0)
        + coalesce((allocation_item ->> 'truepMinutes')::integer, 0)
        + coalesce((allocation_item ->> 'unclassifiedCategoryMinutes')::integer, 0)
        <> coalesce((allocation_item ->> 'paidMinutes')::integer, 0)
    then
      raise check_violation using message =
        'Payroll week allocation fields are invalid or do not reconcile.';
    end if;

    allocation_paid := allocation_paid
      + (allocation_item ->> 'paidMinutes')::integer;
    allocation_gross := allocation_gross
      + (allocation_item ->> 'grossMinutes')::integer;
    allocation_break := allocation_break
      + (allocation_item ->> 'breakMinutes')::integer;
    allocation_unpaid_gap := allocation_unpaid_gap
      + (allocation_item ->> 'unpaidGapMinutes')::integer;
    allocation_regular := allocation_regular
      + (allocation_item ->> 'regularMinutes')::integer;
    allocation_overtime := allocation_overtime
      + (allocation_item ->> 'overtimeMinutes')::integer;
    allocation_regular_category := allocation_regular_category
      + (allocation_item ->> 'regularCategoryMinutes')::integer;
    allocation_ep := allocation_ep
      + (allocation_item ->> 'epMinutes')::integer;
    allocation_truep := allocation_truep
      + (allocation_item ->> 'truepMinutes')::integer;
    allocation_unclassified := allocation_unclassified
      + (allocation_item ->> 'unclassifiedCategoryMinutes')::integer;
  end loop;

  if allocation_paid <> new.paid_minutes
    or allocation_gross <> new.gross_minutes
    or allocation_break <> coalesce((new.row_payload ->> 'breakMinutes')::integer, 0)
    or allocation_unpaid_gap <> coalesce((new.row_payload ->> 'unpaidGapMinutes')::integer, 0)
    or allocation_regular <> coalesce((new.row_payload ->> 'regularMinutes')::integer, 0)
    or allocation_overtime <> coalesce((new.row_payload ->> 'overtimeMinutes')::integer, 0)
    or allocation_regular_category
      <> coalesce((new.row_payload ->> 'regularCategoryMinutes')::integer, 0)
    or allocation_ep <> coalesce((new.row_payload ->> 'epMinutes')::integer, 0)
    or allocation_truep <> coalesce((new.row_payload ->> 'truepMinutes')::integer, 0)
    or allocation_unclassified
      <> coalesce((new.row_payload ->> 'unclassifiedCategoryMinutes')::integer, 0)
  then
    raise check_violation using message =
      'Payroll week allocations do not reconcile to the locked row totals.';
  end if;

  if exists (
    select 1
    from private.payroll_export_rows locked_row
    where locked_row.employee_id = new.employee_id
      and (
        locked_row.row_payload ->> 'payrollOccurrenceKey' = occurrence_key
        or (
          nullif(locked_row.row_payload ->> 'payrollOccurrenceKey', '') is null
          and locked_row.shift_id is not distinct from new.shift_id
          and (
            new.shift_id is not null
            or nullif(locked_row.row_payload ->> 'firstClockIn', '')::timestamptz
              is not distinct from nullif(new.row_payload ->> 'firstClockIn', '')::timestamptz
          )
        )
      )
      and case
        when jsonb_typeof(locked_row.row_payload -> 'payrollWeekAllocations') = 'array'
          then jsonb_array_length(locked_row.row_payload -> 'payrollWeekAllocations') = 0
        else true
      end
  ) then
    raise check_violation using message =
      'This occurrence is already owned by a legacy locked payroll export and cannot be reallocated.';
  end if;

  select new_allocation.value ->> 'allocationKey'
  into duplicate_key
  from jsonb_array_elements(allocations) new_allocation(value)
  where exists (
    select 1
    from private.payroll_export_rows locked_row
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(locked_row.row_payload -> 'payrollWeekAllocations') = 'array'
          then locked_row.row_payload -> 'payrollWeekAllocations'
        else '[]'::jsonb
      end
    ) locked_allocation(value)
    where locked_row.employee_id = new.employee_id
      and locked_row.row_payload ->> 'payrollOccurrenceKey' = occurrence_key
      and locked_allocation.value ->> 'allocationKey'
        = new_allocation.value ->> 'allocationKey'
  )
  limit 1;

  if duplicate_key is not null then
    raise check_violation using message =
      'This payroll week allocation is already present in a locked payroll export.';
  end if;

  return new;
end;
$$;

revoke all on function private.validate_payroll_export_row_allocation_lock()
  from public, anon, authenticated;

drop trigger if exists payroll_export_rows_allocation_lock on private.payroll_export_rows;
create trigger payroll_export_rows_allocation_lock
before insert on private.payroll_export_rows
for each row execute function private.validate_payroll_export_row_allocation_lock();

-- Retain the mature authorization, occurrence, correction, classification, and
-- readiness pipeline as the source. The new public wrapper adds one bounded
-- context query for the prior overtime-week days, derives allocation slices,
-- and then recomputes weekly overtime against the actual allocation week.
alter function public.get_timekeeping_review(date, date) set schema private;
alter function private.get_timekeeping_review(date, date)
  rename to get_timekeeping_review_pre_payroll_week_allocation;

create function public.get_timekeeping_review(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  rules private.payroll_rules%rowtype;
  payload jsonb;
  context_payload jsonb := '{}'::jsonb;
  corrected_payload jsonb := '{}'::jsonb;
  corrected_rows jsonb := '[]'::jsonb;
  corrected_pending_corrections jsonb := '[]'::jsonb;
  corrected_exception_history jsonb := '[]'::jsonb;
  context_from_date date;
  corrected_operational_date date;
  range_starts_at timestamptz;
  range_ends_at_exclusive timestamptz;
  combined_rows jsonb := '[]'::jsonb;
  working_rows jsonb := '[]'::jsonb;
  final_rows jsonb := '[]'::jsonb;
  pending_corrections jsonb := '[]'::jsonb;
  exception_history jsonb := '[]'::jsonb;
  row_count integer := 0;
  ready_count integer := 0;
  exception_count integer := 0;
  gross_minutes integer := 0;
  paid_minutes integer := 0;
  regular_minutes integer := 0;
  overtime_minutes integer := 0;
  regular_category_minutes integer := 0;
  ep_minutes integer := 0;
  truep_minutes integer := 0;
  unclassified_category_minutes integer := 0;
  time_off_minutes integer := 0;
  salary_default_minutes integer := 0;
  worked_time_paid_minutes integer := 0;
  unique_occurrences integer := 0;
  unresolved_assignments integer := 0;
  allocation_gross_minutes integer := 0;
  allocation_paid_minutes integer := 0;
  allocation_break_minutes integer := 0;
  allocation_unpaid_gap_minutes integer := 0;
  allocation_regular_minutes integer := 0;
  allocation_overtime_minutes integer := 0;
  allocation_regular_category_minutes integer := 0;
  allocation_ep_minutes integer := 0;
  allocation_truep_minutes integer := 0;
  allocation_unclassified_category_minutes integer := 0;
  allocation_count integer := 0;
  allocation_blocked_row_count integer := 0;
  allocations_match boolean := false;
  reconciliation_passed boolean := false;
begin
  if target_from_date is null
    or target_through_date is null
    or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Time review ranges are limited to 46 days.';
  end if;

  select * into rules from private.payroll_rules where id = true;
  range_starts_at := (target_from_date::timestamp + rules.payroll_week_start_time)
    at time zone rules.time_zone;
  range_ends_at_exclusive := ((target_through_date + 1)::timestamp + rules.payroll_week_start_time)
    at time zone rules.time_zone;

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

  -- A pre-v2 authorized correction remains an explicit whole-occurrence week
  -- override. Pull corrected occurrences whose authorized week intersects this
  -- request even when their operational date is outside the normal prefix.
  for corrected_operational_date in
    select distinct coalesce(
      (shift.starts_at at time zone shift.time_zone)::date,
      (assignment.assignment_anchor at time zone rules.time_zone)::date
    )
    from private.payroll_batch_assignments assignment
    left join public.shifts shift on shift.id = assignment.shift_id
    where assignment.assignment_status = 'corrected'
      and assignment.assigned_week_start <= target_through_date
      and assignment.assigned_week_start + 6 >= target_from_date
      and coalesce(
        (shift.starts_at at time zone shift.time_zone)::date,
        (assignment.assignment_anchor at time zone rules.time_zone)::date
      ) is not null
  loop
    corrected_payload := private.get_timekeeping_review_pre_payroll_week_allocation(
      corrected_operational_date,
      corrected_operational_date
    );

    select corrected_rows || coalesce(jsonb_agg(item.value), '[]'::jsonb)
    into corrected_rows
    from jsonb_array_elements(coalesce(corrected_payload -> 'rows', '[]'::jsonb)) item(value)
    where item.value ->> 'rowKind' = 'time_event'
      and item.value ->> 'payrollAssignmentStatus' = 'corrected'
      and (item.value ->> 'payrollBatchWeekStartsOn')::date <= target_through_date
      and (item.value ->> 'payrollBatchWeekStartsOn')::date + 6 >= target_from_date;

    corrected_pending_corrections := corrected_pending_corrections
      || coalesce(corrected_payload -> 'pendingCorrections', '[]'::jsonb);
    corrected_exception_history := corrected_exception_history
      || coalesce(corrected_payload -> 'exceptionResolutionHistory', '[]'::jsonb);
  end loop;

  -- Main rows win if a key appears in more than one source. Prefix and
  -- corrected-week context contribute only worked occurrences; salary
  -- defaults remain scoped exactly as before.
  select coalesce(jsonb_agg(source.row_value order by source.source_rank, source.row_number), '[]'::jsonb)
  into combined_rows
  from (
    select
      main.row_value || jsonb_build_object('_payrollRangeSource', 'main') as row_value,
      0::integer as source_rank,
      main.row_number::integer as row_number
    from jsonb_array_elements(coalesce(payload -> 'rows', '[]'::jsonb))
      with ordinality as main(row_value, row_number)

    union all

    select
      context.row_value || jsonb_build_object('_payrollRangeSource', 'context') as row_value,
      1::integer as source_rank,
      context.row_number::integer as row_number
    from jsonb_array_elements(coalesce(context_payload -> 'rows', '[]'::jsonb))
      with ordinality as context(row_value, row_number)
    where context.row_value ->> 'rowKind' = 'time_event'
      and not exists (
        select 1
        from jsonb_array_elements(coalesce(payload -> 'rows', '[]'::jsonb)) main(row_value)
        where nullif(main.row_value ->> 'payrollOccurrenceKey', '') is not null
          and main.row_value ->> 'payrollOccurrenceKey'
            = context.row_value ->> 'payrollOccurrenceKey'
      )

    union all

    select
      corrected.row_value || jsonb_build_object('_payrollRangeSource', 'corrected') as row_value,
      2::integer as source_rank,
      corrected.row_number::integer as row_number
    from jsonb_array_elements(corrected_rows)
      with ordinality as corrected(row_value, row_number)
    where not exists (
        select 1
        from jsonb_array_elements(coalesce(payload -> 'rows', '[]'::jsonb)) main(row_value)
        where nullif(main.row_value ->> 'payrollOccurrenceKey', '') is not null
          and main.row_value ->> 'payrollOccurrenceKey'
            = corrected.row_value ->> 'payrollOccurrenceKey'
      )
      and not exists (
        select 1
        from jsonb_array_elements(coalesce(context_payload -> 'rows', '[]'::jsonb)) context(row_value)
        where nullif(context.row_value ->> 'payrollOccurrenceKey', '') is not null
          and context.row_value ->> 'payrollOccurrenceKey'
            = corrected.row_value ->> 'payrollOccurrenceKey'
      )
  ) source;

  -- Keep full occurrence facts alongside the private minute buckets. These
  -- fields are later retained on the public row even when top-level minutes
  -- are clipped to the requested payroll range.
  select coalesce(jsonb_agg(
    case
      when source.row_value ->> 'rowKind' <> 'time_event' then source.row_value
      else source.row_value || jsonb_build_object(
        '_payrollBoundarySlices', private.get_payroll_boundary_minute_slices(
          source.row_value,
          range_starts_at,
          range_ends_at_exclusive
        ),
        'occurrenceGrossMinutes', coalesce((source.row_value ->> 'grossMinutes')::integer, 0),
        'occurrenceBreakMinutes', coalesce((source.row_value ->> 'breakMinutes')::integer, 0),
        'occurrenceUnpaidGapMinutes', coalesce((source.row_value ->> 'unpaidGapMinutes')::integer, 0),
        'occurrencePaidMinutes', coalesce((source.row_value ->> 'paidMinutes')::integer, 0),
        'occurrenceRegularCategoryMinutes', coalesce((source.row_value ->> 'regularCategoryMinutes')::integer, 0),
        'occurrenceEpMinutes', coalesce((source.row_value ->> 'epMinutes')::integer, 0),
        'occurrenceTruepMinutes', coalesce((source.row_value ->> 'truepMinutes')::integer, 0),
        'occurrenceUnclassifiedCategoryMinutes', coalesce((source.row_value ->> 'unclassifiedCategoryMinutes')::integer, 0)
      )
    end
    order by source.row_number
  ), '[]'::jsonb)
  into working_rows
  from jsonb_array_elements(combined_rows) with ordinality as source(row_value, row_number);

  -- Daily overtime stays on the existing operational day. It is assigned to
  -- the occurrence's latest worked buckets. Weekly overtime is then calculated
  -- from non-daily-OT candidates partitioned by the bucket's actual Sunday week.
  with row_source as (
    select
      row_item.ordinality::integer as row_number,
      row_item.value as row_value,
      row_item.value ->> 'rowKind' as row_kind,
      row_item.value ->> 'employeeId' as employee_id,
      row_item.value ->> 'payrollOccurrenceKey' as occurrence_key,
      (row_item.value ->> 'operationalDate')::date as operational_date,
      nullif(row_item.value ->> 'firstClockIn', '')::timestamptz as first_clock_in,
      coalesce((row_item.value ->> 'occurrencePaidMinutes')::integer, 0) as occurrence_paid_minutes
    from jsonb_array_elements(working_rows) with ordinality as row_item(value, ordinality)
  ), daily_window as (
    select
      source.*,
      coalesce(sum(source.occurrence_paid_minutes) over (
        partition by source.employee_id, source.operational_date
        order by source.first_clock_in nulls last, source.occurrence_key, source.row_number
        rows between unbounded preceding and 1 preceding
      ), 0)::integer as prior_day_paid,
      sum(source.occurrence_paid_minutes) over (
        partition by source.employee_id, source.operational_date
        order by source.first_clock_in nulls last, source.occurrence_key, source.row_number
        rows between unbounded preceding and current row
      )::integer as cumulative_day_paid
    from row_source source
    where source.row_kind = 'time_event'
  ), daily_totals as (
    select
      daily.*,
      (
        greatest(0, daily.cumulative_day_paid - daily_policy.daily_overtime_minutes)
        - greatest(0, daily.prior_day_paid - daily_policy.daily_overtime_minutes)
      )::integer as daily_overtime_minutes
    from daily_window daily
    cross join (
      select current_rules.daily_overtime_minutes
      from private.payroll_rules current_rules
      where current_rules.id = true
    ) daily_policy
  ), slice_source as (
    select
      daily.row_number,
      daily.employee_id,
      daily.occurrence_key,
      daily.first_clock_in,
      daily.daily_overtime_minutes,
      slice_item.ordinality::integer as slice_number,
      slice_item.value as slice_value,
      (slice_item.value ->> 'weekStartsOn')::date as week_starts_on,
      (slice_item.value ->> 'weekEndsOn')::date as week_ends_on,
      (slice_item.value ->> 'startsAt')::timestamptz as slice_starts_at,
      (slice_item.value ->> 'endsAtExclusive')::timestamptz as slice_ends_at_exclusive,
      coalesce((slice_item.value ->> 'inRequestedRange')::boolean, false) as in_requested_range,
      coalesce((slice_item.value ->> 'grossMinutes')::integer, 0) as gross_minutes,
      coalesce((slice_item.value ->> 'breakMinutes')::integer, 0) as break_minutes,
      coalesce((slice_item.value ->> 'unpaidGapMinutes')::integer, 0) as unpaid_gap_minutes,
      coalesce((slice_item.value ->> 'paidMinutes')::integer, 0) as paid_minutes
    from daily_totals daily
    join row_source source on source.row_number = daily.row_number
    cross join lateral jsonb_array_elements(
      coalesce(source.row_value -> '_payrollBoundarySlices', '[]'::jsonb)
    ) with ordinality as slice_item(value, ordinality)
  ), daily_slice_window as (
    select
      slice.*,
      coalesce(sum(slice.paid_minutes) over (
        partition by slice.row_number
        order by slice.slice_starts_at desc, slice.slice_number desc
        rows between unbounded preceding and 1 preceding
      ), 0)::integer as later_occurrence_paid
    from slice_source slice
  ), daily_slices as (
    select
      slice.*,
      least(
        slice.paid_minutes,
        greatest(0, slice.daily_overtime_minutes - slice.later_occurrence_paid)
      )::integer as daily_overtime_slice,
      greatest(
        0,
        slice.paid_minutes - least(
          slice.paid_minutes,
          greatest(0, slice.daily_overtime_minutes - slice.later_occurrence_paid)
        )
      )::integer as weekly_candidate_minutes
    from daily_slice_window slice
  ), weekly_window as (
    select
      slice.*,
      coalesce(sum(slice.weekly_candidate_minutes) over (
        partition by slice.employee_id, slice.week_starts_on
        order by slice.slice_starts_at, slice.occurrence_key, slice.slice_number
        rows between unbounded preceding and 1 preceding
      ), 0)::integer as prior_week_candidate,
      sum(slice.weekly_candidate_minutes) over (
        partition by slice.employee_id, slice.week_starts_on
        order by slice.slice_starts_at, slice.occurrence_key, slice.slice_number
        rows between unbounded preceding and current row
      )::integer as cumulative_week_candidate
    from daily_slices slice
  ), finalized_slices as (
    select
      weekly.*,
      (
        greatest(0, weekly.cumulative_week_candidate - weekly_policy.weekly_overtime_minutes)
        - greatest(0, weekly.prior_week_candidate - weekly_policy.weekly_overtime_minutes)
      )::integer as weekly_overtime_slice
    from weekly_window weekly
    cross join (
      select current_rules.weekly_overtime_minutes
      from private.payroll_rules current_rules
      where current_rules.id = true
    ) weekly_policy
  ), classified_slices as (
    select
      slice.*,
      (slice.daily_overtime_slice + slice.weekly_overtime_slice)::integer as overtime_minutes,
      greatest(
        0,
        slice.paid_minutes - slice.daily_overtime_slice - slice.weekly_overtime_slice
      )::integer as regular_minutes,
      case
        when coalesce((source.row_value ->> 'payrollCategoryResolved')::boolean, false)
          and not coalesce((source.row_value ->> 'mixedPayrollCategories')::boolean, false)
          and source.row_value ->> 'payrollCategory' = 'regular'
        then slice.paid_minutes else 0 end::integer as regular_category_minutes,
      case
        when coalesce((source.row_value ->> 'payrollCategoryResolved')::boolean, false)
          and not coalesce((source.row_value ->> 'mixedPayrollCategories')::boolean, false)
          and source.row_value ->> 'payrollCategory' = 'ep'
        then slice.paid_minutes else 0 end::integer as ep_minutes,
      case
        when coalesce((source.row_value ->> 'payrollCategoryResolved')::boolean, false)
          and not coalesce((source.row_value ->> 'mixedPayrollCategories')::boolean, false)
          and source.row_value ->> 'payrollCategory' = 'truep'
        then slice.paid_minutes else 0 end::integer as truep_minutes,
      case
        when not coalesce((source.row_value ->> 'payrollCategoryResolved')::boolean, false)
          or coalesce((source.row_value ->> 'mixedPayrollCategories')::boolean, false)
        then slice.paid_minutes else 0 end::integer as unclassified_category_minutes
    from finalized_slices slice
    join row_source source on source.row_number = slice.row_number
  ), occurrence_totals as (
    select
      slice.row_number,
      coalesce(sum(slice.regular_minutes), 0)::integer as occurrence_regular_minutes,
      coalesce(sum(slice.overtime_minutes), 0)::integer as occurrence_overtime_minutes
    from classified_slices slice
    group by slice.row_number
  ), in_range_week_totals as (
    select
      slice.row_number,
      slice.occurrence_key,
      slice.week_starts_on,
      slice.week_ends_on,
      min(slice.slice_starts_at) as first_slice_starts_at,
      sum(slice.gross_minutes)::integer as gross_minutes,
      sum(slice.break_minutes)::integer as break_minutes,
      sum(slice.unpaid_gap_minutes)::integer as unpaid_gap_minutes,
      sum(slice.paid_minutes)::integer as paid_minutes,
      sum(slice.regular_minutes)::integer as regular_minutes,
      sum(slice.overtime_minutes)::integer as overtime_minutes,
      sum(slice.regular_category_minutes)::integer as regular_category_minutes,
      sum(slice.ep_minutes)::integer as ep_minutes,
      sum(slice.truep_minutes)::integer as truep_minutes,
      sum(slice.unclassified_category_minutes)::integer as unclassified_category_minutes
    from classified_slices slice
    where slice.in_requested_range
    group by
      slice.row_number,
      slice.occurrence_key,
      slice.week_starts_on,
      slice.week_ends_on
  ), row_allocations as (
    select
      allocation.row_number,
      jsonb_agg(jsonb_build_object(
        'allocationKey', allocation.occurrence_key || '|' || allocation.week_starts_on::text,
        'weekStartsOn', allocation.week_starts_on,
        'weekEndsOn', allocation.week_ends_on,
        'grossMinutes', allocation.gross_minutes,
        'breakMinutes', allocation.break_minutes,
        'unpaidGapMinutes', allocation.unpaid_gap_minutes,
        'paidMinutes', allocation.paid_minutes,
        'regularMinutes', allocation.regular_minutes,
        'overtimeMinutes', allocation.overtime_minutes,
        'regularCategoryMinutes', allocation.regular_category_minutes,
        'epMinutes', allocation.ep_minutes,
        'truepMinutes', allocation.truep_minutes,
        'unclassifiedCategoryMinutes', allocation.unclassified_category_minutes
      ) order by allocation.week_starts_on, allocation.first_slice_starts_at) as allocations,
      sum(allocation.gross_minutes)::integer as gross_minutes,
      sum(allocation.break_minutes)::integer as break_minutes,
      sum(allocation.unpaid_gap_minutes)::integer as unpaid_gap_minutes,
      sum(allocation.paid_minutes)::integer as paid_minutes,
      sum(allocation.regular_minutes)::integer as regular_minutes,
      sum(allocation.overtime_minutes)::integer as overtime_minutes,
      sum(allocation.regular_category_minutes)::integer as regular_category_minutes,
      sum(allocation.ep_minutes)::integer as ep_minutes,
      sum(allocation.truep_minutes)::integer as truep_minutes,
      sum(allocation.unclassified_category_minutes)::integer as unclassified_category_minutes
    from in_range_week_totals allocation
    group by allocation.row_number
  ), rebuilt_rows as (
    select
      source.row_number,
      case
        when source.row_kind <> 'time_event' then source.row_value - '_payrollRangeSource'
        when allocation.row_number is null
          and not coalesce((source.row_value ->> 'payrollReady')::boolean, false)
          and (
            source.row_value ->> '_payrollRangeSource' = 'main'
            or (
              source.row_value ->> '_payrollRangeSource' = 'context'
              and source.operational_date = target_from_date - 1
              and source.first_clock_in < range_ends_at_exclusive
              and nullif(source.row_value ->> 'lastClockOut', '') is null
            )
          )
        then (
          source.row_value
          - '_payrollRangeSource'
          - '_payrollBoundarySlices'
        ) || jsonb_build_object(
          'occurrenceRegularMinutes', coalesce(
            (source.row_value ->> 'regularMinutes')::integer,
            0
          ),
          'occurrenceOvertimeMinutes', coalesce(
            (source.row_value ->> 'overtimeMinutes')::integer,
            0
          ),
          'grossMinutes', 0,
          'breakMinutes', 0,
          'unpaidGapMinutes', 0,
          'paidMinutes', 0,
          'regularMinutes', 0,
          'overtimeMinutes', 0,
          'regularCategoryMinutes', 0,
          'epMinutes', 0,
          'truepMinutes', 0,
          'unclassifiedCategoryMinutes', 0,
          'payrollWeekAllocations', '[]'::jsonb,
          'payrollAssignmentExplanation',
            'No completed elapsed-time interval is available for payroll-week allocation.',
          'payrollGroupingPolicy', policy.cross_boundary_grouping_policy,
          'payrollPolicyVersion', policy.payroll_calculation_policy_version,
          'payrollConfigurationVersion', policy.payroll_configuration_version
        )
        when allocation.row_number is null then null
        else (
          source.row_value
          - '_payrollRangeSource'
          - '_payrollBoundarySlices'
        ) || jsonb_build_object(
          'occurrenceRegularMinutes', coalesce(occurrence.occurrence_regular_minutes, 0),
          'occurrenceOvertimeMinutes', coalesce(occurrence.occurrence_overtime_minutes, 0),
          'grossMinutes', allocation.gross_minutes,
          'breakMinutes', allocation.break_minutes,
          'unpaidGapMinutes', allocation.unpaid_gap_minutes,
          'paidMinutes', allocation.paid_minutes,
          'regularMinutes', allocation.regular_minutes,
          'overtimeMinutes', allocation.overtime_minutes,
          'regularCategoryMinutes', allocation.regular_category_minutes,
          'epMinutes', allocation.ep_minutes,
          'truepMinutes', allocation.truep_minutes,
          'unclassifiedCategoryMinutes', allocation.unclassified_category_minutes,
          'payrollWeekAllocations', allocation.allocations,
          'payrollAssignmentExplanation',
            'Worked minutes are allocated at Sunday 12:00 AM America/Denver without splitting the canonical timekeeping occurrence.',
          'payrollGroupingPolicy', policy.cross_boundary_grouping_policy,
          'payrollPolicyVersion', policy.payroll_calculation_policy_version,
          'payrollConfigurationVersion', policy.payroll_configuration_version
        )
      end as row_value
    from row_source source
    left join row_allocations allocation on allocation.row_number = source.row_number
    left join occurrence_totals occurrence on occurrence.row_number = source.row_number
    cross join (
      select
        rules.cross_boundary_grouping_policy,
        rules.payroll_calculation_policy_version,
        rules.payroll_configuration_version
    ) policy
    where source.row_kind <> 'time_event'
      or allocation.paid_minutes > 0
      or (
        not coalesce((source.row_value ->> 'payrollReady')::boolean, false)
        and (
          source.row_value ->> '_payrollRangeSource' = 'main'
          or (
            source.row_value ->> '_payrollRangeSource' = 'context'
            and source.operational_date = target_from_date - 1
            and source.first_clock_in < range_ends_at_exclusive
            and nullif(source.row_value ->> 'lastClockOut', '') is null
          )
        )
      )
  )
  select coalesce(jsonb_agg(rebuilt.row_value order by rebuilt.row_number), '[]'::jsonb)
  into final_rows
  from rebuilt_rows rebuilt
  where rebuilt.row_value is not null;

  -- Keep the main range's pending corrections. Add only prefix corrections that
  -- belong to an event on a returned cross-boundary occurrence.
  select coalesce(jsonb_agg(correction.value order by correction.requested_at, correction.id), '[]'::jsonb)
  into pending_corrections
  from (
    select distinct on (candidate.value ->> 'id')
      candidate.value,
      candidate.value ->> 'requestedAt' as requested_at,
      candidate.value ->> 'id' as id,
      candidate.priority
    from (
      select item.value, 0::integer as priority
      from jsonb_array_elements(coalesce(payload -> 'pendingCorrections', '[]'::jsonb)) item(value)
      union all
      select item.value, 1::integer as priority
      from jsonb_array_elements(coalesce(context_payload -> 'pendingCorrections', '[]'::jsonb)) item(value)
      where exists (
        select 1
        from jsonb_array_elements(final_rows) returned(row_value)
        cross join lateral jsonb_array_elements(
          coalesce(returned.row_value -> 'eventTimeline', '[]'::jsonb)
        ) timeline(event_value)
        where timeline.event_value ->> 'id' = item.value ->> 'timeEventId'
      )
      union all
      select item.value, 2::integer as priority
      from jsonb_array_elements(corrected_pending_corrections) item(value)
      where exists (
        select 1
        from jsonb_array_elements(final_rows) returned(row_value)
        cross join lateral jsonb_array_elements(
          coalesce(returned.row_value -> 'eventTimeline', '[]'::jsonb)
        ) timeline(event_value)
        where timeline.event_value ->> 'id' = item.value ->> 'timeEventId'
      )
    ) candidate
    order by candidate.value ->> 'id', candidate.priority
  ) correction;

  select coalesce(jsonb_agg(history.value order by history.resolved_at, history.id), '[]'::jsonb)
  into exception_history
  from (
    select distinct on (candidate.value ->> 'id')
      candidate.value,
      candidate.value ->> 'resolvedAt' as resolved_at,
      candidate.value ->> 'id' as id,
      candidate.priority
    from (
      select item.value, 0::integer as priority
      from jsonb_array_elements(coalesce(payload -> 'exceptionResolutionHistory', '[]'::jsonb)) item(value)
      union all
      select item.value, 1::integer as priority
      from jsonb_array_elements(coalesce(context_payload -> 'exceptionResolutionHistory', '[]'::jsonb)) item(value)
      where exists (
        select 1
        from jsonb_array_elements(final_rows) returned(row_value)
        where returned.row_value ->> 'rowKind' = 'time_event'
          and returned.row_value ->> 'employeeId' = item.value ->> 'employeeId'
          and returned.row_value ->> 'operationalDate' = item.value ->> 'operationalDate'
          and nullif(returned.row_value ->> 'shiftId', '') is not distinct from
            nullif(item.value ->> 'shiftId', '')
      )
      union all
      select item.value, 2::integer as priority
      from jsonb_array_elements(corrected_exception_history) item(value)
      where exists (
        select 1
        from jsonb_array_elements(final_rows) returned(row_value)
        where returned.row_value ->> 'rowKind' = 'time_event'
          and returned.row_value ->> 'employeeId' = item.value ->> 'employeeId'
          and returned.row_value ->> 'operationalDate' = item.value ->> 'operationalDate'
          and nullif(returned.row_value ->> 'shiftId', '') is not distinct from
            nullif(item.value ->> 'shiftId', '')
      )
    ) candidate
    order by candidate.value ->> 'id', candidate.priority
  ) history;

  select
    count(*)::integer,
    count(*) filter (
      where coalesce((row_item.value ->> 'payrollReady')::boolean, false)
    )::integer,
    count(*) filter (
      where not coalesce((row_item.value ->> 'payrollReady')::boolean, false)
    )::integer,
    coalesce(sum((row_item.value ->> 'grossMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'paidMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'regularMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'overtimeMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'regularCategoryMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'epMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'truepMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'unclassifiedCategoryMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'timeOffMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'salaryDefaultMinutes')::integer), 0)::integer,
    count(distinct nullif(row_item.value ->> 'payrollOccurrenceKey', ''))::integer,
    count(*) filter (
      where row_item.value ->> 'payrollAssignmentStatus' = 'unresolved'
    )::integer
  into
    row_count,
    ready_count,
    exception_count,
    gross_minutes,
    paid_minutes,
    regular_minutes,
    overtime_minutes,
    regular_category_minutes,
    ep_minutes,
    truep_minutes,
    unclassified_category_minutes,
    time_off_minutes,
    salary_default_minutes,
    unique_occurrences,
    unresolved_assignments
  from jsonb_array_elements(final_rows) row_item(value);

  select
    coalesce(sum((row_item.value ->> 'paidMinutes')::integer), 0)::integer,
    count(*) filter (
      where not coalesce((row_item.value ->> 'payrollReady')::boolean, false)
    )::integer
  into worked_time_paid_minutes, allocation_blocked_row_count
  from jsonb_array_elements(final_rows) row_item(value)
  where row_item.value ->> 'rowKind' = 'time_event';

  select
    coalesce(sum((allocation.value ->> 'grossMinutes')::integer), 0)::integer,
    coalesce(sum((allocation.value ->> 'paidMinutes')::integer), 0)::integer,
    coalesce(sum((allocation.value ->> 'breakMinutes')::integer), 0)::integer,
    coalesce(sum((allocation.value ->> 'unpaidGapMinutes')::integer), 0)::integer,
    coalesce(sum((allocation.value ->> 'regularMinutes')::integer), 0)::integer,
    coalesce(sum((allocation.value ->> 'overtimeMinutes')::integer), 0)::integer,
    coalesce(sum((allocation.value ->> 'regularCategoryMinutes')::integer), 0)::integer,
    coalesce(sum((allocation.value ->> 'epMinutes')::integer), 0)::integer,
    coalesce(sum((allocation.value ->> 'truepMinutes')::integer), 0)::integer,
    coalesce(sum((allocation.value ->> 'unclassifiedCategoryMinutes')::integer), 0)::integer,
    count(*)::integer
  into
    allocation_gross_minutes,
    allocation_paid_minutes,
    allocation_break_minutes,
    allocation_unpaid_gap_minutes,
    allocation_regular_minutes,
    allocation_overtime_minutes,
    allocation_regular_category_minutes,
    allocation_ep_minutes,
    allocation_truep_minutes,
    allocation_unclassified_category_minutes,
    allocation_count
  from jsonb_array_elements(final_rows) row_item(value)
  cross join lateral jsonb_array_elements(
    coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
  ) allocation(value);

  allocations_match := not exists (
    select 1
    from jsonb_array_elements(final_rows) row_item(value)
    where row_item.value ->> 'rowKind' = 'time_event'
      and (
        coalesce((row_item.value ->> 'grossMinutes')::integer, 0) is distinct from coalesce((
          select sum((allocation.value ->> 'grossMinutes')::integer)
          from jsonb_array_elements(
            coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
          ) allocation(value)
        ), 0)
        or coalesce((row_item.value ->> 'paidMinutes')::integer, 0) is distinct from coalesce((
          select sum((allocation.value ->> 'paidMinutes')::integer)
          from jsonb_array_elements(
            coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
          ) allocation(value)
        ), 0)
        or coalesce((row_item.value ->> 'breakMinutes')::integer, 0) is distinct from coalesce((
          select sum((allocation.value ->> 'breakMinutes')::integer)
          from jsonb_array_elements(
            coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
          ) allocation(value)
        ), 0)
        or coalesce((row_item.value ->> 'unpaidGapMinutes')::integer, 0) is distinct from coalesce((
          select sum((allocation.value ->> 'unpaidGapMinutes')::integer)
          from jsonb_array_elements(
            coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
          ) allocation(value)
        ), 0)
        or coalesce((row_item.value ->> 'regularMinutes')::integer, 0) is distinct from coalesce((
          select sum((allocation.value ->> 'regularMinutes')::integer)
          from jsonb_array_elements(
            coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
          ) allocation(value)
        ), 0)
        or coalesce((row_item.value ->> 'overtimeMinutes')::integer, 0) is distinct from coalesce((
          select sum((allocation.value ->> 'overtimeMinutes')::integer)
          from jsonb_array_elements(
            coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
          ) allocation(value)
        ), 0)
        or coalesce((row_item.value ->> 'regularCategoryMinutes')::integer, 0) is distinct from coalesce((
          select sum((allocation.value ->> 'regularCategoryMinutes')::integer)
          from jsonb_array_elements(
            coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
          ) allocation(value)
        ), 0)
        or coalesce((row_item.value ->> 'epMinutes')::integer, 0) is distinct from coalesce((
          select sum((allocation.value ->> 'epMinutes')::integer)
          from jsonb_array_elements(
            coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
          ) allocation(value)
        ), 0)
        or coalesce((row_item.value ->> 'truepMinutes')::integer, 0) is distinct from coalesce((
          select sum((allocation.value ->> 'truepMinutes')::integer)
          from jsonb_array_elements(
            coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
          ) allocation(value)
        ), 0)
        or coalesce((row_item.value ->> 'unclassifiedCategoryMinutes')::integer, 0) is distinct from coalesce((
          select sum((allocation.value ->> 'unclassifiedCategoryMinutes')::integer)
          from jsonb_array_elements(
            coalesce(row_item.value -> 'payrollWeekAllocations', '[]'::jsonb)
          ) allocation(value)
        ), 0)
        or coalesce((row_item.value ->> 'regularMinutes')::integer, 0)
          + coalesce((row_item.value ->> 'overtimeMinutes')::integer, 0)
          <> coalesce((row_item.value ->> 'paidMinutes')::integer, 0)
        or coalesce((row_item.value ->> 'regularCategoryMinutes')::integer, 0)
          + coalesce((row_item.value ->> 'epMinutes')::integer, 0)
          + coalesce((row_item.value ->> 'truepMinutes')::integer, 0)
          + coalesce((row_item.value ->> 'unclassifiedCategoryMinutes')::integer, 0)
          <> coalesce((row_item.value ->> 'paidMinutes')::integer, 0)
      )
  );

  reconciliation_passed := paid_minutes = regular_minutes + overtime_minutes
    and worked_time_paid_minutes = regular_category_minutes + ep_minutes + truep_minutes
      + unclassified_category_minutes
    and row_count = unique_occurrences
    and unresolved_assignments = 0
    and allocation_paid_minutes = worked_time_paid_minutes
    and allocation_regular_minutes + allocation_overtime_minutes = allocation_paid_minutes
    and allocation_regular_category_minutes + allocation_ep_minutes
      + allocation_truep_minutes + allocation_unclassified_category_minutes
      = allocation_paid_minutes
    and not exists (
      select 1
      from jsonb_array_elements(final_rows) row_item(value)
      where row_item.value ->> 'rowKind' = 'time_event'
        and (
          coalesce((row_item.value ->> 'mixedPayrollCategories')::boolean, false)
          or not coalesce((row_item.value ->> 'payrollCategoryResolved')::boolean, false)
          or coalesce((row_item.value ->> 'unclassifiedCategoryMinutes')::integer, 0) > 0
        )
    )
    and allocations_match;

  return payload || jsonb_build_object(
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'payrollRules', coalesce(payload -> 'payrollRules', '{}'::jsonb) || jsonb_build_object(
      'crossBoundaryGroupingPolicy', rules.cross_boundary_grouping_policy,
      'payrollPolicyEffectiveFrom', rules.payroll_policy_effective_from,
      'payrollConfigurationVersion', rules.payroll_configuration_version,
      'payrollCalculationPolicyVersion', rules.payroll_calculation_policy_version
    ),
    'summary', coalesce(payload -> 'summary', '{}'::jsonb) || jsonb_build_object(
      'rowCount', row_count,
      'readyCount', ready_count,
      'exceptionCount', exception_count,
      'pendingCorrectionCount', jsonb_array_length(pending_corrections),
      'grossMinutes', gross_minutes,
      'paidMinutes', paid_minutes,
      'regularMinutes', regular_minutes,
      'overtimeMinutes', overtime_minutes,
      'regularCategoryMinutes', regular_category_minutes,
      'epMinutes', ep_minutes,
      'truepMinutes', truep_minutes,
      'unclassifiedCategoryMinutes', unclassified_category_minutes,
      'timeOffMinutes', time_off_minutes,
      'salaryDefaultMinutes', salary_default_minutes
    ),
    'rows', final_rows,
    'pendingCorrections', pending_corrections,
    'exceptionResolutionHistory', exception_history,
    'reconciliation', coalesce(payload -> 'reconciliation', '{}'::jsonb) || jsonb_build_object(
      'passed', reconciliation_passed,
      'paidMinutes', paid_minutes,
      'regularMinutes', regular_minutes,
      'overtimeMinutes', overtime_minutes,
      'regularPlusOvertimeMatchesPaid', paid_minutes = regular_minutes + overtime_minutes,
      'regularCategoryMinutes', regular_category_minutes,
      'epMinutes', ep_minutes,
      'truepMinutes', truep_minutes,
      'unclassifiedCategoryMinutes', unclassified_category_minutes,
      'categoryMinutesMatchPaid', worked_time_paid_minutes = regular_category_minutes + ep_minutes
        + truep_minutes + unclassified_category_minutes,
      'payrollWeekAllocationGrossMinutes', allocation_gross_minutes,
      'payrollWeekAllocationPaidMinutes', allocation_paid_minutes,
      'payrollWeekAllocationBreakMinutes', allocation_break_minutes,
      'payrollWeekAllocationUnpaidGapMinutes', allocation_unpaid_gap_minutes,
      'payrollWeekAllocationRegularMinutes', allocation_regular_minutes,
      'payrollWeekAllocationOvertimeMinutes', allocation_overtime_minutes,
      'payrollWeekAllocationRegularCategoryMinutes', allocation_regular_category_minutes,
      'payrollWeekAllocationEpMinutes', allocation_ep_minutes,
      'payrollWeekAllocationTruepMinutes', allocation_truep_minutes,
      'payrollWeekAllocationUnclassifiedCategoryMinutes', allocation_unclassified_category_minutes,
      'payrollWeekAllocationCount', allocation_count,
      'payrollWeekAllocationBlockedRowCount', allocation_blocked_row_count,
      'payrollWeekAllocationsReadyForLock', allocation_blocked_row_count = 0,
      'payrollWeekAllocationsMatchPaid', allocations_match,
      'rowCount', row_count,
      'uniqueOccurrenceCount', unique_occurrences,
      'duplicateOccurrenceCount', greatest(0, row_count - unique_occurrences),
      'unresolvedAssignmentCount', unresolved_assignments,
      'policyVersion', rules.payroll_calculation_policy_version,
      'configurationVersion', rules.payroll_configuration_version
    )
  );
end;
$$;

revoke all on function private.get_timekeeping_review_pre_payroll_week_allocation(date, date)
  from public, anon, authenticated;
revoke all on function public.get_timekeeping_review(date, date) from public, anon;
grant execute on function public.get_timekeeping_review(date, date) to authenticated;

comment on function private.get_payroll_boundary_minute_slices(jsonb, timestamptz, timestamptz) is
  'Builds exact derived elapsed-time buckets at configured payroll-week and requested-range boundaries without changing canonical shifts or punches.';
comment on function public.get_timekeeping_review(date, date) is
  'Returns range-scoped payroll minutes with Sunday 00:00 America/Denver week allocations and preserved whole-occurrence totals.';

notify pgrst, 'reload schema';

commit;
