begin;

-- One canonical, set-based row source powers both the interactive report and
-- the audited export.  It intentionally combines the current published plan
-- with corrected punch occurrences, rather than treating payroll rows as a
-- substitute for the schedule.
create or replace function private.get_workforce_activity_report_rows(
  target_from_date date,
  target_through_date date
)
returns table (
  id text,
  operational_date date,
  employee_id uuid,
  employee_name text,
  employee_number text,
  employment_type public.employment_type,
  shift_id uuid,
  assignment_id uuid,
  client_id uuid,
  client_name text,
  event_id uuid,
  event_name text,
  site_id uuid,
  site_code text,
  site_name text,
  post_id uuid,
  post_name text,
  location_label text,
  location_detail text,
  time_zone text,
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  scheduled_minutes integer,
  actual_start_at timestamptz,
  actual_end_at timestamptz,
  worked_minutes integer,
  unpaid_break_minutes integer,
  outcome text,
  payroll_ready boolean,
  notes text[],
  has_actual boolean,
  is_replacement boolean,
  is_call_off boolean,
  is_vacancy boolean,
  is_salary_confirmed boolean,
  needs_review boolean
)
language sql
stable
security definer
set search_path = ''
as $$
with current_schedules as materialized (
  select distinct on (schedule.week_starts_on)
    schedule.id,
    schedule.week_starts_on,
    schedule.revision
  from public.schedules schedule
  where schedule.status = 'published'
  order by schedule.week_starts_on, schedule.revision desc, schedule.id
), current_shifts as materialized (
  select
    shift.*,
    schedule.week_starts_on,
    schedule.revision
  from public.shifts shift
  join current_schedules schedule on schedule.id = shift.schedule_id
  where shift.canceled_at is null
    and private.shift_assignment_type(shift.id) <> 'dispatch_phone_duty'
    and (shift.starts_at at time zone shift.time_zone)::date
      between target_from_date and target_through_date
), current_assignments as materialized (
  select
    assignment.id,
    assignment.employee_id,
    assignment.status,
    shift.id as shift_id,
    shift.week_starts_on,
    shift.post_id,
    shift.event_id,
    shift.starts_at,
    shift.ends_at,
    shift.time_zone,
    shift.headcount_required,
    shift.requires_armed,
    shift.assignment_type,
    shift.coverage_source_shift_id,
    shift.notes as shift_notes,
    shift.revision
  from current_shifts shift
  join public.shift_assignments assignment on assignment.shift_id = shift.id
  where assignment.status in ('assigned', 'confirmed', 'completed')
    and assignment.canceled_at is null
), effective_event_details as materialized (
  select
    event.id,
    event.location_override_name,
    event.location_override_time_zone
  from private.get_effective_time_events() event
  where not event.voided
    and event.effective_at >= (target_from_date::timestamp at time zone 'UTC') - interval '2 days'
    and event.effective_at < ((target_through_date + 1)::timestamp at time zone 'UTC') + interval '2 days'
), scoped_events as materialized (
  select
    event.*,
    detail.location_override_name,
    detail.location_override_time_zone
  from private.get_effective_time_events_with_occurrence() event
  left join effective_event_details detail on detail.id = event.id
  where not event.voided
    and (
      event.original_shift_id is null
      or coalesce(private.shift_assignment_type(event.original_shift_id), 'standard') <> 'dispatch_phone_duty'
    )
    and event.assignment_anchor >= (target_from_date::timestamp at time zone 'UTC') - interval '2 days'
    and event.assignment_anchor < ((target_through_date + 1)::timestamp at time zone 'UTC') + interval '2 days'
), sequenced_events as materialized (
  select
    event.*,
    row_number() over occurrence as event_number,
    count(*) over occurrence as event_count,
    lag(event.kind) over occurrence as previous_kind,
    lead(event.kind) over occurrence as next_kind,
    lead(event.effective_at) over occurrence as next_effective_at
  from scoped_events event
  window occurrence as (
    partition by event.employee_id, event.occurrence_key
    order by event.effective_at, event.recorded_at, event.id
    rows between unbounded preceding and unbounded following
  )
), actual_occurrences as materialized (
  select
    event.employee_id,
    event.occurrence_key,
    min(event.assignment_anchor) as assignment_anchor,
    min(event.original_shift_id::text)::uuid as original_shift_id,
    min(event.shift_id::text)::uuid as display_shift_id,
    min(event.effective_at) filter (where event.kind = 'clock_in') as actual_start_at,
    max(event.effective_at) filter (where event.kind = 'clock_out') as actual_end_at,
    greatest(0, round(sum(
      case
        when event.kind in ('clock_in', 'break_end')
          and event.next_kind in ('break_start', 'clock_out')
          and event.next_effective_at >= event.effective_at
          then extract(epoch from (event.next_effective_at - event.effective_at)) / 60.0
        else 0
      end
    ))::integer) as worked_minutes,
    greatest(0, round(sum(
      case
        when event.kind = 'break_start'
          and event.next_kind = 'break_end'
          and event.next_effective_at >= event.effective_at
          then extract(epoch from (event.next_effective_at - event.effective_at)) / 60.0
        else 0
      end
    ))::integer) as unpaid_break_minutes,
    bool_or(event.has_approved_correction) as has_approved_correction,
    (array_agg(event.location_override_name order by event.effective_at desc, event.id desc)
      filter (where event.location_override_name is not null))[1] as location_override_name,
    (array_agg(event.location_override_time_zone order by event.effective_at desc, event.id desc)
      filter (where event.location_override_time_zone is not null))[1] as location_override_time_zone,
    bool_and(
      case
        when event.event_number = 1 then event.kind = 'clock_in'
        else (event.previous_kind, event.kind) in (
          ('clock_in'::public.time_event_kind, 'break_start'::public.time_event_kind),
          ('clock_in'::public.time_event_kind, 'clock_out'::public.time_event_kind),
          ('break_start'::public.time_event_kind, 'break_end'::public.time_event_kind),
          ('break_end'::public.time_event_kind, 'break_start'::public.time_event_kind),
          ('break_end'::public.time_event_kind, 'clock_out'::public.time_event_kind)
        )
      end
    )
      and (array_agg(event.kind order by event.event_number))[event.event_count] = 'clock_out'
      as sequence_complete
  from sequenced_events event
  group by event.employee_id, event.occurrence_key, event.event_count
), matched_actual as materialized (
  select
    actual.*,
    matched.assignment_id as matched_assignment_id,
    matched.shift_id as matched_shift_id
  from actual_occurrences actual
  left join lateral (
    select
      assignment.id as assignment_id,
      assignment.shift_id
    from current_assignments assignment
    where assignment.employee_id = actual.employee_id
      and actual.original_shift_id is not null
      and (
        assignment.shift_id = actual.original_shift_id
        or private.same_scheduled_occurrence(assignment.shift_id, actual.original_shift_id)
      )
    order by
      (assignment.shift_id = actual.original_shift_id) desc,
      assignment.revision desc,
      assignment.id
    limit 1
  ) matched on true
), assignment_context as materialized (
  select
    assignment.*,
    employee.employee_number,
    btrim(concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name)) as employee_name,
    employee.employment_type,
    employee.time_zone as employee_time_zone,
    event.client_id as event_client_id,
    event.name as event_name,
    event.location_name as event_location_name,
    event.address_line_1 as event_address_line_1,
    event.city as event_city,
    event.region as event_region,
    event.postal_code as event_postal_code,
    coalesce(post_site.id, event_site.id) as site_id,
    coalesce(post_site.client_id, event_site.client_id) as site_client_id,
    coalesce(post_site.code, event_site.code) as site_code,
    coalesce(post_site.name, event_site.name) as site_name,
    coalesce(post_site.address_line_1, event_site.address_line_1) as site_address_line_1,
    coalesce(post_site.city, event_site.city) as site_city,
    coalesce(post_site.region, event_site.region) as site_region,
    coalesce(post_site.postal_code, event_site.postal_code) as site_postal_code,
    post.name as post_name,
    client.id as client_id,
    client.display_name as client_name,
    actual.actual_start_at,
    actual.actual_end_at,
    actual.worked_minutes,
    actual.unpaid_break_minutes,
    actual.has_approved_correction,
    actual.sequence_complete,
    actual.occurrence_key,
    call_off.call_off_report_id,
    call_off.coverage_case_id,
    call_off.coverage_status,
    call_off.replacement_employee_id,
    salary_marker.action as salary_action,
    salary_marker.note as salary_note
  from current_assignments assignment
  join public.employees employee on employee.id = assignment.employee_id
  left join public.posts post on post.id = assignment.post_id
  left join public.sites post_site on post_site.id = post.site_id
  left join public.events event on event.id = assignment.event_id
  left join public.sites event_site on event_site.id = event.site_id
  left join public.clients client
    on client.id = coalesce(event.client_id, post_site.client_id, event_site.client_id)
  left join matched_actual actual on actual.matched_assignment_id = assignment.id
  left join lateral (
    select
      report.id as call_off_report_id,
      coverage.id as coverage_case_id,
      coverage.status as coverage_status,
      coverage.replacement_employee_id
    from public.call_off_reports report
    left join public.shift_coverage_cases coverage on coverage.call_off_report_id = report.id
    where report.employee_id = assignment.employee_id
      and report.canceled_at is null
      and private.same_scheduled_occurrence(report.shift_id, assignment.shift_id)
    order by report.reported_at desc, report.id desc
    limit 1
  ) call_off on true
  left join lateral (
    select presence.action, presence.note
    from private.salaried_shift_presence_events presence
    join private.salaried_shift_equivalent_assignments(assignment.id) equivalent
      on equivalent.assignment_id = presence.shift_assignment_id
    order by presence.created_at desc, presence.id desc
    limit 1
  ) salary_marker on employee.employment_type = 'salary'
), scheduled_rows as (
  select
    'assignment:' || context.id::text as id,
    (context.starts_at at time zone context.time_zone)::date as operational_date,
    context.employee_id,
    context.employee_name,
    context.employee_number,
    context.employment_type,
    context.shift_id,
    context.id as assignment_id,
    context.client_id,
    context.client_name,
    context.event_id,
    context.event_name,
    context.site_id,
    context.site_code,
    context.site_name,
    context.post_id,
    context.post_name,
    coalesce(context.event_name, context.site_name, 'Location unavailable') as location_label,
    nullif(concat_ws(' · ',
      case when context.event_id is not null then context.event_location_name else context.post_name end,
      nullif(concat_ws(', ',
        coalesce(context.event_address_line_1, context.site_address_line_1),
        coalesce(context.event_city, context.site_city),
        coalesce(context.event_region, context.site_region),
        coalesce(context.event_postal_code, context.site_postal_code)
      ), '')
    ), '') as location_detail,
    context.time_zone,
    context.starts_at as scheduled_start_at,
    context.ends_at as scheduled_end_at,
    greatest(0, round(extract(epoch from (context.ends_at - context.starts_at)) / 60.0)::integer) as scheduled_minutes,
    case when context.employment_type = 'salary' then null else context.actual_start_at end as actual_start_at,
    case when context.employment_type = 'salary' then null else context.actual_end_at end as actual_end_at,
    case
      when context.employment_type = 'salary' then null
      when context.occurrence_key is null then null
      else context.worked_minutes
    end as worked_minutes,
    case
      when context.employment_type = 'salary' then null
      when context.occurrence_key is null then null
      else context.unpaid_break_minutes
    end as unpaid_break_minutes,
    case
      when context.call_off_report_id is not null then 'called_off'
      when context.employment_type = 'salary' and context.salary_action = 'worked'
        then 'salary_worked_confirmed'
      when context.employment_type <> 'salary'
        and context.occurrence_key is not null and not context.sequence_complete
        then 'needs_time_correction'
      when context.employment_type <> 'salary'
        and context.occurrence_key is not null
        and (
          context.coverage_source_shift_id is not null
          or context.replacement_employee_id = context.employee_id
        ) then 'replacement_worked'
      when context.employment_type <> 'salary' and context.occurrence_key is not null
        then 'worked_as_scheduled'
      else 'scheduled_no_work_record'
    end as outcome,
    case
      when context.call_off_report_id is not null then false
      when context.employment_type = 'salary' then false
      else context.occurrence_key is not null and context.sequence_complete
    end as payroll_ready,
    array_remove(array[
      case when context.call_off_report_id is not null
        then concat('Call-off recorded', case when context.coverage_status is not null then '; coverage status: ' || replace(context.coverage_status, '_', ' ') end)
      end,
      case when context.coverage_source_shift_id is not null
        or context.replacement_employee_id = context.employee_id
        then 'Replacement coverage assignment'
      end,
      case when context.employment_type = 'salary' and context.salary_action = 'worked'
        then coalesce(context.salary_note, 'Salaried Worked confirmation; actual minutes are intentionally not inferred.')
      end,
      case when context.employment_type = 'salary' and context.salary_action is distinct from 'worked'
        and context.occurrence_key is not null
        then 'Legacy punches are not used as salaried attendance; no Worked confirmation is recorded'
      end,
      case when context.employment_type <> 'salary' and context.has_approved_correction
        then 'Includes an approved time correction'
      end,
      nullif(btrim(context.shift_notes), ''),
      case when context.employment_type <> 'salary'
        and context.occurrence_key is not null and not context.sequence_complete
        then 'Punch sequence is incomplete or out of order'
      end,
      case when context.occurrence_key is null and not (context.employment_type = 'salary' and context.salary_action = 'worked')
        then 'No effective work occurrence is recorded'
      end
    ]::text[], null) as notes,
    context.employment_type <> 'salary' and context.occurrence_key is not null as has_actual,
    context.coverage_source_shift_id is not null
      or coalesce(context.replacement_employee_id = context.employee_id, false) as is_replacement,
    context.call_off_report_id is not null as is_call_off,
    false as is_vacancy,
    context.employment_type = 'salary'
      and coalesce(context.salary_action = 'worked', false) as is_salary_confirmed,
    context.call_off_report_id is not null
      or (context.employment_type <> 'salary' and context.occurrence_key is not null and not context.sequence_complete)
      or (context.employment_type = 'salary' and context.salary_action is distinct from 'worked')
      or (context.employment_type <> 'salary' and context.occurrence_key is null)
      as needs_review
  from assignment_context context
), call_off_only_context as materialized (
  select distinct on (
    report.employee_id,
    source_schedule.week_starts_on,
    source_shift.post_id,
    source_shift.event_id,
    source_shift.starts_at,
    source_shift.ends_at
  )
    report.id as call_off_report_id,
    report.employee_id,
    employee.employee_number,
    btrim(concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name)) as employee_name,
    employee.employment_type,
    source_shift.id as shift_id,
    source_assignment.id as assignment_id,
    source_shift.post_id,
    source_shift.event_id,
    source_shift.starts_at,
    source_shift.ends_at,
    source_shift.time_zone,
    source_shift.notes as shift_notes,
    schedule_event.name as event_name,
    schedule_event.location_name as event_location_name,
    schedule_event.address_line_1 as event_address_line_1,
    schedule_event.city as event_city,
    schedule_event.region as event_region,
    schedule_event.postal_code as event_postal_code,
    coalesce(post_site.id, event_site.id) as site_id,
    coalesce(post_site.code, event_site.code) as site_code,
    coalesce(post_site.name, event_site.name) as site_name,
    coalesce(post_site.address_line_1, event_site.address_line_1) as site_address_line_1,
    coalesce(post_site.city, event_site.city) as site_city,
    coalesce(post_site.region, event_site.region) as site_region,
    coalesce(post_site.postal_code, event_site.postal_code) as site_postal_code,
    post.name as post_name,
    client.id as client_id,
    client.display_name as client_name,
    coverage.status as coverage_status
  from public.call_off_reports report
  join public.shifts source_shift on source_shift.id = report.shift_id
  join public.schedules source_schedule on source_schedule.id = source_shift.schedule_id
  join public.employees employee on employee.id = report.employee_id
  left join public.shift_assignments source_assignment
    on source_assignment.shift_id = report.shift_id
   and source_assignment.employee_id = report.employee_id
  left join public.posts post on post.id = source_shift.post_id
  left join public.sites post_site on post_site.id = post.site_id
  left join public.events schedule_event on schedule_event.id = source_shift.event_id
  left join public.sites event_site on event_site.id = schedule_event.site_id
  left join public.clients client
    on client.id = coalesce(schedule_event.client_id, post_site.client_id, event_site.client_id)
  left join public.shift_coverage_cases coverage on coverage.call_off_report_id = report.id
  where report.canceled_at is null
    and private.shift_assignment_type(source_shift.id) <> 'dispatch_phone_duty'
    and (source_shift.starts_at at time zone source_shift.time_zone)::date
      between target_from_date and target_through_date
    and not exists (
      select 1
      from current_assignments assignment
      where assignment.employee_id = report.employee_id
        and private.same_scheduled_occurrence(report.shift_id, assignment.shift_id)
    )
  order by
    report.employee_id,
    source_schedule.week_starts_on,
    source_shift.post_id,
    source_shift.event_id,
    source_shift.starts_at,
    source_shift.ends_at,
    report.reported_at desc,
    report.id desc
), call_off_only_rows as (
  select
    'call-off:' || context.call_off_report_id::text as id,
    (context.starts_at at time zone context.time_zone)::date as operational_date,
    context.employee_id,
    context.employee_name,
    context.employee_number,
    context.employment_type,
    context.shift_id,
    context.assignment_id,
    context.client_id,
    context.client_name,
    context.event_id,
    context.event_name,
    context.site_id,
    context.site_code,
    context.site_name,
    context.post_id,
    context.post_name,
    coalesce(context.event_name, context.site_name, 'Location unavailable') as location_label,
    nullif(concat_ws(' · ',
      case when context.event_id is not null then context.event_location_name else context.post_name end,
      nullif(concat_ws(', ',
        coalesce(context.event_address_line_1, context.site_address_line_1),
        coalesce(context.event_city, context.site_city),
        coalesce(context.event_region, context.site_region),
        coalesce(context.event_postal_code, context.site_postal_code)
      ), '')
    ), '') as location_detail,
    context.time_zone,
    context.starts_at as scheduled_start_at,
    context.ends_at as scheduled_end_at,
    greatest(0, round(extract(epoch from (context.ends_at - context.starts_at)) / 60.0)::integer) as scheduled_minutes,
    null::timestamptz as actual_start_at,
    null::timestamptz as actual_end_at,
    null::integer as worked_minutes,
    null::integer as unpaid_break_minutes,
    'called_off'::text as outcome,
    false as payroll_ready,
    array_remove(array[
      concat('Call-off retained from the original schedule', case when context.coverage_status is not null then '; coverage status: ' || replace(context.coverage_status, '_', ' ') end),
      nullif(btrim(context.shift_notes), '')
    ]::text[], null) as notes,
    false as has_actual,
    false as is_replacement,
    true as is_call_off,
    false as is_vacancy,
    false as is_salary_confirmed,
    true as needs_review
  from call_off_only_context context
), vacancy_context as materialized (
  select
    shift.*,
    event.name as event_name,
    event.location_name as event_location_name,
    event.address_line_1 as event_address_line_1,
    event.city as event_city,
    event.region as event_region,
    event.postal_code as event_postal_code,
    coalesce(post_site.id, event_site.id) as site_id,
    coalesce(post_site.code, event_site.code) as site_code,
    coalesce(post_site.name, event_site.name) as site_name,
    coalesce(post_site.address_line_1, event_site.address_line_1) as site_address_line_1,
    coalesce(post_site.city, event_site.city) as site_city,
    coalesce(post_site.region, event_site.region) as site_region,
    coalesce(post_site.postal_code, event_site.postal_code) as site_postal_code,
    post.name as post_name,
    client.id as client_id,
    client.display_name as client_name,
    greatest(
      0,
      shift.headcount_required - count(assignment.id)::integer
        + case
          when latest_case.coverage_shift_id is null and latest_case.absent_employee_id is not null
            and bool_or(assignment.employee_id = latest_case.absent_employee_id)
            then 1
          else 0
        end
    ) as vacancy_count,
    latest_case.status as coverage_status
  from current_shifts shift
  left join public.shift_assignments assignment
    on assignment.shift_id = shift.id
   and assignment.status in ('assigned', 'confirmed', 'completed')
   and assignment.canceled_at is null
  left join public.posts post on post.id = shift.post_id
  left join public.sites post_site on post_site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  left join public.clients client
    on client.id = coalesce(event.client_id, post_site.client_id, event_site.client_id)
  left join lateral (
    select
      coverage.coverage_shift_id,
      coverage.absent_employee_id,
      coverage.status
    from public.shift_coverage_cases coverage
    where coverage.status <> 'canceled'
      and (
        (shift.coverage_source_shift_id is null
          and private.same_scheduled_occurrence(coverage.source_shift_id, shift.id))
        or
        (shift.coverage_source_shift_id is not null
          and private.same_scheduled_occurrence(coverage.source_shift_id, shift.coverage_source_shift_id))
      )
    order by coverage.updated_at desc, coverage.id desc
    limit 1
  ) latest_case on true
  group by
    shift.id, shift.schedule_id, shift.post_id, shift.event_id, shift.starts_at,
    shift.ends_at, shift.time_zone, shift.headcount_required, shift.requires_armed,
    shift.is_open, shift.is_overtime, shift.notes, shift.created_by, shift.created_at,
    shift.updated_at, shift.canceled_at, shift.canceled_by, shift.cancellation_reason,
    shift.work_type, shift.time_zone_source, shift.time_zone_employee_id,
    shift.assignment_type, shift.coverage_source_shift_id, shift.week_starts_on,
    shift.revision, event.name, event.location_name, event.address_line_1,
    event.city, event.region, event.postal_code, post_site.id, event_site.id,
    post_site.code, event_site.code, post_site.name, event_site.name,
    post_site.address_line_1, event_site.address_line_1, post_site.city,
    event_site.city, post_site.region, event_site.region, post_site.postal_code,
    event_site.postal_code, post.name, client.id, client.display_name,
    latest_case.coverage_shift_id, latest_case.absent_employee_id,
    latest_case.status
), vacancy_rows as (
  select
    'vacancy:' || context.id::text || ':' || vacancy_number::text as id,
    (context.starts_at at time zone context.time_zone)::date as operational_date,
    null::uuid as employee_id,
    'Open position'::text as employee_name,
    null::text as employee_number,
    null::public.employment_type as employment_type,
    context.id as shift_id,
    null::uuid as assignment_id,
    context.client_id,
    context.client_name,
    context.event_id,
    context.event_name,
    context.site_id,
    context.site_code,
    context.site_name,
    context.post_id,
    context.post_name,
    coalesce(context.event_name, context.site_name, 'Location unavailable') as location_label,
    nullif(concat_ws(' · ',
      case when context.event_id is not null then context.event_location_name else context.post_name end,
      nullif(concat_ws(', ',
        coalesce(context.event_address_line_1, context.site_address_line_1),
        coalesce(context.event_city, context.site_city),
        coalesce(context.event_region, context.site_region),
        coalesce(context.event_postal_code, context.site_postal_code)
      ), '')
    ), '') as location_detail,
    context.time_zone,
    context.starts_at as scheduled_start_at,
    context.ends_at as scheduled_end_at,
    greatest(0, round(extract(epoch from (context.ends_at - context.starts_at)) / 60.0)::integer) as scheduled_minutes,
    null::timestamptz as actual_start_at,
    null::timestamptz as actual_end_at,
    null::integer as worked_minutes,
    null::integer as unpaid_break_minutes,
    'open_unassigned'::text as outcome,
    false as payroll_ready,
    array_remove(array[
      'No employee is assigned to this required position',
      case when context.coverage_status is not null
        then 'Coverage status: ' || replace(context.coverage_status, '_', ' ')
      end,
      nullif(btrim(context.notes), '')
    ]::text[], null) as notes,
    false as has_actual,
    context.coverage_source_shift_id is not null as is_replacement,
    false as is_call_off,
    true as is_vacancy,
    false as is_salary_confirmed,
    true as needs_review
  from vacancy_context context
  cross join lateral generate_series(1, context.vacancy_count) vacancy_number
), actual_only_context as materialized (
  select
    actual.*,
    employee.employee_number,
    btrim(concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name)) as employee_name,
    employee.employment_type,
    employee.time_zone as employee_time_zone,
    coalesce(display_shift.id, original_shift.id) as resolved_shift_id,
    coalesce(display_shift.event_id, original_shift.event_id) as event_id,
    coalesce(display_shift.post_id, original_shift.post_id, manual_entry.post_id) as post_id,
    coalesce(
      display_shift.time_zone,
      original_shift.time_zone,
      manual_site.time_zone,
      actual.location_override_time_zone,
      employee.time_zone,
      'America/Denver'
    ) as resolved_time_zone,
    coalesce(display_shift.notes, original_shift.notes) as shift_notes,
    -- The occurrence shift is immutable report evidence. A display-only shift
    -- override may change location context, but it must not invent or erase the
    -- fact that this work was created as replacement coverage.
    original_shift.coverage_source_shift_id is not null as is_replacement,
    manual_entry.work_date as manual_work_date,
    manual_entry.reason as manual_reason,
    manual_entry.notes as manual_notes
  from matched_actual actual
  join public.employees employee on employee.id = actual.employee_id
  left join public.shifts display_shift on display_shift.id = actual.display_shift_id
  left join public.shifts original_shift on original_shift.id = actual.original_shift_id
  left join public.manual_time_entries manual_entry
    on actual.occurrence_key = 'manual:' || manual_entry.id::text || ':employee:' || manual_entry.employee_id::text
   and manual_entry.approval_status = 'approved'
  left join public.posts manual_post on manual_post.id = manual_entry.post_id
  left join public.sites manual_site on manual_site.id = manual_post.site_id
  where actual.matched_assignment_id is null
    and employee.employment_type <> 'salary'
), actual_only_rows as (
  select
    'actual:' || md5(context.occurrence_key) as id,
    case
      when context.original_shift_id is not null and resolved_shift.id is not null
        then (resolved_shift.starts_at at time zone context.resolved_time_zone)::date
      when context.manual_work_date is not null then context.manual_work_date
      else (context.assignment_anchor at time zone context.resolved_time_zone)::date
    end as operational_date,
    context.employee_id,
    context.employee_name,
    context.employee_number,
    context.employment_type,
    context.resolved_shift_id as shift_id,
    null::uuid as assignment_id,
    client.id as client_id,
    client.display_name as client_name,
    context.event_id,
    event.name as event_name,
    coalesce(post_site.id, event_site.id) as site_id,
    coalesce(post_site.code, event_site.code) as site_code,
    coalesce(post_site.name, event_site.name) as site_name,
    context.post_id,
    post.name as post_name,
    coalesce(
      event.name,
      post_site.name,
      event_site.name,
      context.location_override_name,
      'Unscheduled work'
    ) as location_label,
    nullif(concat_ws(' · ',
      coalesce(
        case when event.id is not null then event.location_name else post.name end,
        context.location_override_name
      ),
      nullif(concat_ws(', ',
        coalesce(event.address_line_1, post_site.address_line_1, event_site.address_line_1),
        coalesce(event.city, post_site.city, event_site.city),
        coalesce(event.region, post_site.region, event_site.region),
        coalesce(event.postal_code, post_site.postal_code, event_site.postal_code)
      ), '')
    ), '') as location_detail,
    context.resolved_time_zone as time_zone,
    null::timestamptz as scheduled_start_at,
    null::timestamptz as scheduled_end_at,
    null::integer as scheduled_minutes,
    context.actual_start_at,
    context.actual_end_at,
    context.worked_minutes,
    context.unpaid_break_minutes,
    case
      when not context.sequence_complete then 'needs_time_correction'
      when context.is_replacement then 'replacement_worked'
      else 'worked_not_scheduled'
    end as outcome,
    context.sequence_complete as payroll_ready,
    array_remove(array[
      'Work was recorded without a matching assignment on the current published schedule',
      nullif(btrim(context.shift_notes), ''),
      nullif(btrim(context.manual_reason), ''),
      nullif(btrim(context.manual_notes), ''),
      case when context.is_replacement
        then 'Replacement coverage assignment retained from the original shift'
      end,
      case when context.location_override_name is not null
        then 'Corrected location: ' || context.location_override_name
      end,
      case when context.has_approved_correction then 'Includes an approved time correction' end,
      case when not context.sequence_complete then 'Punch sequence is incomplete or out of order' end
    ]::text[], null) as notes,
    true as has_actual,
    context.is_replacement,
    false as is_call_off,
    false as is_vacancy,
    false as is_salary_confirmed,
    not context.sequence_complete as needs_review
  from actual_only_context context
  left join public.shifts resolved_shift on resolved_shift.id = context.resolved_shift_id
  left join public.posts post on post.id = context.post_id
  left join public.sites post_site on post_site.id = post.site_id
  left join public.events event on event.id = context.event_id
  left join public.sites event_site on event_site.id = event.site_id
  left join public.clients client
    on client.id = coalesce(event.client_id, post_site.client_id, event_site.client_id)
)
select * from scheduled_rows
union all
select * from call_off_only_rows
union all
select * from vacancy_rows
union all
select * from actual_only_rows
where operational_date between target_from_date and target_through_date
$$;

revoke all on function private.get_workforce_activity_report_rows(date, date)
  from public, anon, authenticated;

create or replace function private.build_workforce_activity_report(
  target_from_date date,
  target_through_date date,
  target_view text,
  target_group_by text,
  target_employee_id uuid,
  target_client_id uuid,
  target_site_id uuid,
  target_event_id uuid,
  target_outcome text,
  target_search text,
  target_page integer,
  target_page_size integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with base_rows as materialized (
  select *
  from private.get_workforce_activity_report_rows(target_from_date, target_through_date)
), filtered_rows as materialized (
  select row.*
  from base_rows row
  where (target_employee_id is null or row.employee_id = target_employee_id)
    and (target_client_id is null or row.client_id = target_client_id)
    and (target_site_id is null or row.site_id = target_site_id)
    and (target_event_id is null or row.event_id = target_event_id)
    and (target_outcome is null or row.outcome = target_outcome)
    and (
      nullif(btrim(coalesce(target_search, '')), '') is null
      or concat_ws(' ',
        row.employee_name, row.employee_number, row.client_name, row.event_name,
        row.site_code, row.site_name, row.post_name, row.location_label,
        row.location_detail, array_to_string(row.notes, ' '), row.outcome
      ) ilike '%' || btrim(target_search) || '%'
    )
    and case target_view
      when 'scheduled' then row.assignment_id is not null or row.is_vacancy
      when 'worked' then row.has_actual or row.is_salary_confirmed
      when 'exceptions' then row.needs_review or row.outcome = 'worked_not_scheduled'
      else true
    end
), numbered_rows as materialized (
  select
    row.*,
    row_number() over (
      order by
        case when target_group_by = 'employee' then lower(coalesce(row.employee_name, '')) end,
        case when target_group_by = 'location' then lower(coalesce(row.location_label, '')) end,
        row.operational_date desc,
        row.scheduled_start_at desc nulls last,
        row.actual_start_at desc nulls last,
        lower(coalesce(row.employee_name, '')),
        row.id
    ) as result_number
  from filtered_rows row
), totals as (
  select count(*)::integer as total_count from filtered_rows
), page_rows as (
  select row.*
  from numbered_rows row
  where target_page_size is null
     or row.result_number between ((target_page - 1) * target_page_size) + 1
       and target_page * target_page_size
)
select jsonb_build_object(
  'reportKey', 'workforceActivity',
  'generatedAt', statement_timestamp(),
  'fromDate', target_from_date,
  'throughDate', target_through_date,
  'view', target_view,
  'groupBy', target_group_by,
  'page', target_page,
  'pageSize', coalesce(target_page_size, totals.total_count),
  'totalCount', totals.total_count,
  'totalPages', case
    when target_page_size is null then case when totals.total_count = 0 then 0 else 1 end
    when totals.total_count = 0 then 0
    else ceil(totals.total_count::numeric / target_page_size)::integer
  end,
  'summary', (
    select jsonb_build_object(
      'scheduledAssignments', count(*) filter (where row.assignment_id is not null),
      'actualWorkers', count(distinct row.employee_id) filter (where row.has_actual or row.is_salary_confirmed),
      'scheduledMinutes', coalesce(sum(row.scheduled_minutes), 0),
      'workedMinutes', coalesce(sum(row.worked_minutes), 0),
      'callOffs', count(*) filter (where row.is_call_off),
      'replacements', count(*) filter (where row.is_replacement),
      'openPositions', count(*) filter (where row.is_vacancy),
      'salaryConfirmed', count(*) filter (where row.is_salary_confirmed),
      'needsReview', count(*) filter (where row.needs_review)
    ) from filtered_rows row
  ),
  'filterOptions', jsonb_build_object(
    'views', jsonb_build_array(
      jsonb_build_object('value', 'all', 'label', 'All activity'),
      jsonb_build_object('value', 'scheduled', 'label', 'Scheduled'),
      jsonb_build_object('value', 'worked', 'label', 'Worked'),
      jsonb_build_object('value', 'exceptions', 'label', 'Needs attention')
    ),
    'groupings', jsonb_build_array(
      jsonb_build_object('value', 'day', 'label', 'Day'),
      jsonb_build_object('value', 'employee', 'label', 'Employee'),
      jsonb_build_object('value', 'location', 'label', 'Location')
    ),
    'employees', coalesce((
      select jsonb_agg(option.value order by option.label, option.employee_number)
      from (
        select distinct
          row.employee_name as label,
          row.employee_number,
          jsonb_build_object(
            'id', row.employee_id,
            'label', row.employee_name,
            'employeeNumber', row.employee_number
          ) as value
        from base_rows row
        where row.employee_id is not null
      ) option
    ), '[]'::jsonb),
    'clients', coalesce((
      select jsonb_agg(option.value order by option.label)
      from (
        select distinct row.client_name as label,
          jsonb_build_object('id', row.client_id, 'label', row.client_name) as value
        from base_rows row where row.client_id is not null
      ) option
    ), '[]'::jsonb),
    'sites', coalesce((
      select jsonb_agg(option.value order by option.label)
      from (
        select distinct coalesce(row.site_name, row.site_code) as label,
          jsonb_build_object('id', row.site_id, 'label', coalesce(row.site_name, row.site_code)) as value
        from base_rows row where row.site_id is not null
      ) option
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(option.value order by option.label)
      from (
        select distinct row.event_name as label,
          jsonb_build_object('id', row.event_id, 'label', row.event_name) as value
        from base_rows row where row.event_id is not null
      ) option
    ), '[]'::jsonb),
    'outcomes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'value', outcome.value,
        'label', replace(initcap(replace(outcome.value, '_', ' ')), 'As ', 'as '),
        'count', outcome.row_count
      ) order by outcome.value)
      from (
        select row.outcome as value, count(*) as row_count
        from base_rows row group by row.outcome
      ) outcome
    ), '[]'::jsonb)
  ),
  'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', row.id,
      'operationalDate', row.operational_date,
      'employeeId', row.employee_id,
      'employeeName', row.employee_name,
      'employeeNumber', row.employee_number,
      'employmentType', row.employment_type,
      'shiftId', row.shift_id,
      'assignmentId', row.assignment_id,
      'clientId', row.client_id,
      'clientName', row.client_name,
      'eventId', row.event_id,
      'eventName', row.event_name,
      'siteId', row.site_id,
      'siteCode', row.site_code,
      'siteName', row.site_name,
      'postId', row.post_id,
      'postName', row.post_name,
      'locationLabel', row.location_label,
      'locationDetail', row.location_detail,
      'timeZone', row.time_zone,
      'scheduledStartAt', row.scheduled_start_at,
      'scheduledEndAt', row.scheduled_end_at,
      'scheduledMinutes', row.scheduled_minutes,
      'actualStartAt', row.actual_start_at,
      'actualEndAt', row.actual_end_at,
      'workedMinutes', row.worked_minutes,
      'unpaidBreakMinutes', row.unpaid_break_minutes,
      'outcome', row.outcome,
      'payrollReady', coalesce(row.payroll_ready, false),
      'notes', to_jsonb(coalesce(row.notes, array[]::text[]))
    ) order by row.result_number)
    from page_rows row
  ), '[]'::jsonb)
)
from totals
$$;

revoke all on function private.build_workforce_activity_report(
  date, date, text, text, uuid, uuid, uuid, uuid, text, text, integer, integer
) from public, anon, authenticated;

create or replace function public.get_workforce_activity_report_page(
  target_from_date date,
  target_through_date date,
  target_view text default 'all',
  target_group_by text default 'day',
  target_employee_id uuid default null,
  target_client_id uuid default null,
  target_site_id uuid default null,
  target_event_id uuid default null,
  target_outcome text default null,
  target_search text default null,
  target_page integer default 1,
  target_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_view text := lower(btrim(coalesce(target_view, 'all')));
  normalized_group_by text := lower(btrim(coalesce(target_group_by, 'day')));
  normalized_outcome text := nullif(lower(btrim(coalesce(target_outcome, ''))), '');
begin
  perform private.timekeeping_require_permission('time.reports.view');

  if target_from_date is null or target_through_date is null
    or target_through_date < target_from_date
    or target_through_date - target_from_date > 366
  then
    raise check_violation using message = 'Choose a valid date range of 366 days or fewer.';
  end if;
  if normalized_view not in ('all', 'scheduled', 'worked', 'exceptions') then
    raise check_violation using message = 'Choose a supported workforce activity view.';
  end if;
  if normalized_group_by not in ('day', 'employee', 'location') then
    raise check_violation using message = 'Choose day, employee, or location grouping.';
  end if;
  if normalized_outcome is not null and normalized_outcome not in (
    'worked_as_scheduled', 'replacement_worked', 'worked_not_scheduled',
    'salary_worked_confirmed', 'scheduled_no_work_record', 'called_off',
    'open_unassigned', 'needs_time_correction'
  ) then
    raise check_violation using message = 'Choose a supported workforce activity outcome.';
  end if;
  if target_page is null or target_page < 1 then
    raise check_violation using message = 'Page must be at least 1.';
  end if;
  if target_page_size is null or target_page_size < 1 or target_page_size > 200 then
    raise check_violation using message = 'Page size must be between 1 and 200.';
  end if;

  return private.build_workforce_activity_report(
    target_from_date,
    target_through_date,
    normalized_view,
    normalized_group_by,
    target_employee_id,
    target_client_id,
    target_site_id,
    target_event_id,
    normalized_outcome,
    nullif(btrim(coalesce(target_search, '')), ''),
    target_page,
    target_page_size
  );
end
$$;

revoke all on function public.get_workforce_activity_report_page(
  date, date, text, text, uuid, uuid, uuid, uuid, text, text, integer, integer
) from public, anon;
grant execute on function public.get_workforce_activity_report_page(
  date, date, text, text, uuid, uuid, uuid, uuid, text, text, integer, integer
) to authenticated;

create or replace function public.export_workforce_activity_report(
  target_from_date date,
  target_through_date date,
  target_view text default 'all',
  target_group_by text default 'day',
  target_employee_id uuid default null,
  target_client_id uuid default null,
  target_site_id uuid default null,
  target_event_id uuid default null,
  target_outcome text default null,
  target_search text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  export_id uuid := gen_random_uuid();
  normalized_view text := lower(btrim(coalesce(target_view, 'all')));
  normalized_group_by text := lower(btrim(coalesce(target_group_by, 'day')));
  normalized_outcome text := nullif(lower(btrim(coalesce(target_outcome, ''))), '');
  payload jsonb;
begin
  actor_id := private.timekeeping_require_permission('time.reports.view');
  if not public.has_effective_permission('reports.export') then
    raise insufficient_privilege using message = 'Workforce activity export permission is required.';
  end if;

  if target_from_date is null or target_through_date is null
    or target_through_date < target_from_date
    or target_through_date - target_from_date > 366
  then
    raise check_violation using message = 'Choose a valid date range of 366 days or fewer.';
  end if;
  if normalized_view not in ('all', 'scheduled', 'worked', 'exceptions') then
    raise check_violation using message = 'Choose a supported workforce activity view.';
  end if;
  if normalized_group_by not in ('day', 'employee', 'location') then
    raise check_violation using message = 'Choose day, employee, or location grouping.';
  end if;
  if normalized_outcome is not null and normalized_outcome not in (
    'worked_as_scheduled', 'replacement_worked', 'worked_not_scheduled',
    'salary_worked_confirmed', 'scheduled_no_work_record', 'called_off',
    'open_unassigned', 'needs_time_correction'
  ) then
    raise check_violation using message = 'Choose a supported workforce activity outcome.';
  end if;

  payload := private.build_workforce_activity_report(
    target_from_date,
    target_through_date,
    normalized_view,
    normalized_group_by,
    target_employee_id,
    target_client_id,
    target_site_id,
    target_event_id,
    normalized_outcome,
    nullif(btrim(coalesce(target_search, '')), ''),
    1,
    null
  );

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    auth.uid(),
    actor_id,
    'public',
    'workforce_activity_report',
    'EXPORT',
    export_id::text,
    jsonb_build_object(
      'fromDate', target_from_date,
      'throughDate', target_through_date,
      'view', normalized_view,
      'groupBy', normalized_group_by,
      'employeeId', target_employee_id,
      'clientId', target_client_id,
      'siteId', target_site_id,
      'eventId', target_event_id,
      'outcome', normalized_outcome,
      'recordCount', payload -> 'totalCount'
    )
  );

  return payload || jsonb_build_object('mode', 'export', 'exportId', export_id);
end
$$;

revoke all on function public.export_workforce_activity_report(
  date, date, text, text, uuid, uuid, uuid, uuid, text, text
) from public, anon;
grant execute on function public.export_workforce_activity_report(
  date, date, text, text, uuid, uuid, uuid, uuid, text, text
) to authenticated;

commit;
