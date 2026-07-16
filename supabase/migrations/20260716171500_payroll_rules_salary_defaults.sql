set search_path = '';

create table if not exists private.payroll_rules (
  id boolean primary key default true,
  time_zone text not null default 'America/Denver',
  week_starts_on integer not null default 0,
  pay_frequency text not null default 'biweekly',
  pay_date_anchor date not null default date '2026-07-17',
  daily_overtime_minutes integer not null default 720,
  weekly_overtime_minutes integer not null default 2400,
  unpaid_breaks boolean not null default true,
  default_break_minutes integer not null default 30,
  salary_weekly_default_minutes integer not null default 2400,
  salary_time_off_reduces_default boolean not null default true,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references public.employees(id) on delete restrict,
  constraint payroll_rules_singleton check (id),
  constraint payroll_rules_week_start check (week_starts_on between 0 and 6),
  constraint payroll_rules_pay_frequency check (pay_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  constraint payroll_rules_positive_minutes check (
    daily_overtime_minutes > 0
    and weekly_overtime_minutes > 0
    and default_break_minutes >= 0
    and salary_weekly_default_minutes >= 0
  )
);

insert into private.payroll_rules (
  id,
  time_zone,
  week_starts_on,
  pay_frequency,
  pay_date_anchor,
  daily_overtime_minutes,
  weekly_overtime_minutes,
  unpaid_breaks,
  default_break_minutes,
  salary_weekly_default_minutes,
  salary_time_off_reduces_default
)
values (
  true,
  'America/Denver',
  0,
  'biweekly',
  date '2026-07-17',
  720,
  2400,
  true,
  30,
  2400,
  true
)
on conflict (id) do update
set
  time_zone = excluded.time_zone,
  week_starts_on = excluded.week_starts_on,
  pay_frequency = excluded.pay_frequency,
  pay_date_anchor = excluded.pay_date_anchor,
  daily_overtime_minutes = excluded.daily_overtime_minutes,
  weekly_overtime_minutes = excluded.weekly_overtime_minutes,
  unpaid_breaks = excluded.unpaid_breaks,
  default_break_minutes = excluded.default_break_minutes,
  salary_weekly_default_minutes = excluded.salary_weekly_default_minutes,
  salary_time_off_reduces_default = excluded.salary_time_off_reduces_default,
  updated_at = clock_timestamp();

drop trigger if exists payroll_rules_audit on private.payroll_rules;
create trigger payroll_rules_audit
after insert or update on private.payroll_rules
for each row execute function private.write_audit_event();

create or replace function public.get_payroll_rules()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  rules private.payroll_rules%rowtype;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Operations access with MFA is required for payroll rules.';
  end if;

  select * into rules from private.payroll_rules where id = true;

  return jsonb_build_object(
    'timeZone', rules.time_zone,
    'weekStartsOn', rules.week_starts_on,
    'weekStartsOnLabel', 'Sunday',
    'payFrequency', rules.pay_frequency,
    'payDateAnchor', rules.pay_date_anchor,
    'dailyOvertimeMinutes', rules.daily_overtime_minutes,
    'weeklyOvertimeMinutes', rules.weekly_overtime_minutes,
    'unpaidBreaks', rules.unpaid_breaks,
    'defaultBreakMinutes', rules.default_break_minutes,
    'salaryWeeklyDefaultMinutes', rules.salary_weekly_default_minutes,
    'salaryTimeOffReducesDefault', rules.salary_time_off_reduces_default
  );
end
$$;

create or replace function public.get_timekeeping_review(
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
  reviewer_id uuid := private.current_employee_id();
  rules private.payroll_rules%rowtype;
  review_rows jsonb;
  pending_corrections jsonb;
  rows_total integer;
  ready_total integer;
  exception_total integer;
  pending_correction_total integer;
  gross_minutes_total integer;
  paid_minutes_total integer;
  regular_minutes_total integer;
  overtime_minutes_total integer;
  time_off_minutes_total integer;
  salary_default_minutes_total integer;
begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Supervisor or Admin access with MFA is required for time review.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Time review ranges are limited to 46 days.';
  end if;

  select * into rules from private.payroll_rules where id = true;

  with effective_events as (
    select
      event.id,
      event.employee_id,
      event.shift_id,
      event.kind,
      event.recorded_at,
      coalesce((
        select correction.replacement_time
        from public.time_event_corrections correction
        where correction.time_event_id = event.id
          and correction.approved_at is not null
          and correction.voided = false
          and correction.replacement_time is not null
        order by correction.approved_at desc
        limit 1
      ), event.recorded_at) as effective_at,
      exists (
        select 1
        from public.time_event_corrections correction
        where correction.time_event_id = event.id
          and correction.approved_at is not null
          and correction.voided
      ) as voided,
      exists (
        select 1
        from public.time_event_corrections correction
        where correction.time_event_id = event.id
          and correction.approved_at is null
          and correction.declined_at is null
      ) as pending_correction
    from public.time_events event
  ),
  active_events as (
    select *
    from effective_events event
    where not event.voided
      and (event.effective_at at time zone rules.time_zone)::date between target_from_date and target_through_date
  ),
  sequenced as (
    select
      event.*,
      coalesce(event.shift_id::text, 'unscheduled:' || event.employee_id::text || ':' || (event.effective_at at time zone rules.time_zone)::date::text) as group_key,
      (event.effective_at at time zone rules.time_zone)::date as operational_date,
      (((event.effective_at at time zone rules.time_zone)::date - extract(dow from (event.effective_at at time zone rules.time_zone)::date)::integer)::date) as week_starts_on,
      (((event.effective_at at time zone rules.time_zone)::date - extract(dow from (event.effective_at at time zone rules.time_zone)::date)::integer + 6)::date) as week_ends_on,
      lag(event.kind) over (
        partition by event.employee_id, coalesce(event.shift_id::text, 'unscheduled:' || (event.effective_at at time zone rules.time_zone)::date::text)
        order by event.effective_at, event.recorded_at, event.id
      ) as previous_kind,
      lead(event.kind) over (
        partition by event.employee_id, coalesce(event.shift_id::text, 'unscheduled:' || (event.effective_at at time zone rules.time_zone)::date::text)
        order by event.effective_at, event.recorded_at, event.id
      ) as next_kind,
      lead(event.effective_at) over (
        partition by event.employee_id, coalesce(event.shift_id::text, 'unscheduled:' || (event.effective_at at time zone rules.time_zone)::date::text)
        order by event.effective_at, event.recorded_at, event.id
      ) as next_effective_at
    from active_events event
  ),
  grouped as (
    select
      event.employee_id,
      event.shift_id,
      event.group_key,
      min(event.operational_date) as operational_date,
      min(event.week_starts_on) as week_starts_on,
      min(event.week_ends_on) as week_ends_on,
      min(event.effective_at) filter (where event.kind = 'clock_in') as first_clock_in,
      max(event.effective_at) filter (where event.kind = 'clock_out') as last_clock_out,
      count(*)::integer as event_count,
      bool_or(event.shift_id is null) as unscheduled,
      bool_or(event.pending_correction) as has_pending_correction,
      bool_or(
        not (
          (event.previous_kind is null and event.kind = 'clock_in')
          or (event.previous_kind = 'clock_in' and event.kind in ('break_start', 'clock_out'))
          or (event.previous_kind = 'break_start' and event.kind = 'break_end')
          or (event.previous_kind = 'break_end' and event.kind in ('break_start', 'clock_out'))
        )
      ) as invalid_sequence,
      (array_agg(event.kind order by event.effective_at, event.recorded_at, event.id))[1] as first_kind,
      (array_agg(event.kind order by event.effective_at desc, event.recorded_at desc, event.id desc))[1] as last_kind,
      coalesce(sum(
        case
          when event.kind in ('clock_in', 'break_end')
            and event.next_kind in ('break_start', 'clock_out')
            and event.next_effective_at > event.effective_at
          then extract(epoch from event.next_effective_at - event.effective_at) / 60
          else 0
        end
      ), 0)::integer as paid_minutes,
      coalesce(sum(
        case
          when event.kind = 'break_start'
            and event.next_kind = 'break_end'
            and event.next_effective_at > event.effective_at
          then extract(epoch from event.next_effective_at - event.effective_at) / 60
          else 0
        end
      ), 0)::integer as break_minutes
    from sequenced event
    group by event.employee_id, event.shift_id, event.group_key
  ),
  decorated as (
    select
      'time_event'::text as row_kind,
      grouped.employee_id,
      grouped.shift_id,
      grouped.group_key,
      grouped.operational_date,
      grouped.week_starts_on,
      grouped.week_ends_on,
      employee.username,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.role,
      employee.employment_type,
      shift.starts_at as scheduled_starts_at,
      shift.ends_at as scheduled_ends_at,
      shift.time_zone,
      shift.requires_armed,
      shift.is_overtime,
      post.name as post_name,
      site.name as site_name,
      site.code as site_code,
      schedule_event.name as event_name,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Unscheduled') as location_name,
      grouped.first_clock_in,
      grouped.last_clock_out,
      grouped.event_count,
      grouped.unscheduled,
      grouped.has_pending_correction,
      grouped.invalid_sequence,
      grouped.first_kind,
      grouped.last_kind,
      grouped.paid_minutes,
      grouped.break_minutes,
      case
        when grouped.first_clock_in is not null and grouped.last_clock_out is not null and grouped.last_clock_out > grouped.first_clock_in
        then (extract(epoch from grouped.last_clock_out - grouped.first_clock_in) / 60)::integer
        else 0
      end as gross_minutes,
      0::integer as salary_default_minutes,
      0::integer as time_off_minutes,
      array_remove(array[
        case when grouped.unscheduled then 'unscheduled' end,
        case when grouped.first_kind is distinct from 'clock_in' then 'missing_clock_in' end,
        case when grouped.last_kind is distinct from 'clock_out' then 'missing_clock_out' end,
        case when grouped.invalid_sequence then 'invalid_sequence' end,
        case when grouped.has_pending_correction then 'pending_correction' end,
        case when grouped.paid_minutes = 0 then 'zero_paid_minutes' end
      ], null) as exception_codes,
      array_remove(array[
        case when grouped.unscheduled then 'Unscheduled time requires supervisor review.' end,
        case when grouped.break_minutes > 0 then 'Break minutes are unpaid.' end
      ], null) as payroll_notes
    from grouped
    join public.employees employee on employee.id = grouped.employee_id
    left join public.shifts shift on shift.id = grouped.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
  ),
  week_span as (
    select generate_series(
      (target_from_date - extract(dow from target_from_date)::integer)::date,
      (target_through_date - extract(dow from target_through_date)::integer)::date,
      interval '7 days'
    )::date as week_starts_on
  ),
  salary_time_off as (
    select
      employee.id as employee_id,
      week_span.week_starts_on,
      least(
        rules.salary_weekly_default_minutes,
        coalesce(sum(
          case
            when request.id is null then 0
            when request.partial_day_start is not null and request.partial_day_end is not null
              then greatest(0, extract(epoch from (request.partial_day_end - request.partial_day_start)) / 60)::integer
            else 480
          end
        ), 0)::integer
      ) as time_off_minutes
    from week_span
    join public.employees employee
      on employee.employment_type = 'salary'
     and employee.status in ('active', 'leave')
    left join public.time_off_requests request
      on request.employee_id = employee.id
     and request.status = 'approved'
     and request.starts_on <= week_span.week_starts_on + 6
     and request.ends_on >= week_span.week_starts_on
    left join lateral generate_series(
      greatest(request.starts_on, week_span.week_starts_on),
      least(request.ends_on, week_span.week_starts_on + 6),
      interval '1 day'
    ) as request_day(day_on) on request.id is not null
    group by employee.id, week_span.week_starts_on
  ),
  salary_rows as (
    select
      'salary_default'::text as row_kind,
      employee.id as employee_id,
      null::uuid as shift_id,
      'salary-default:' || employee.id::text || ':' || week_span.week_starts_on::text as group_key,
      week_span.week_starts_on as operational_date,
      week_span.week_starts_on,
      (week_span.week_starts_on + 6)::date as week_ends_on,
      employee.username,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.role,
      employee.employment_type,
      null::timestamptz as scheduled_starts_at,
      null::timestamptz as scheduled_ends_at,
      rules.time_zone as time_zone,
      false as requires_armed,
      false as is_overtime,
      null::text as post_name,
      null::text as site_name,
      null::text as site_code,
      null::text as event_name,
      'Salary default'::text as location_name,
      null::timestamptz as first_clock_in,
      null::timestamptz as last_clock_out,
      0::integer as event_count,
      false as unscheduled,
      false as has_pending_correction,
      false as invalid_sequence,
      null::public.time_event_kind as first_kind,
      null::public.time_event_kind as last_kind,
      greatest(0, rules.salary_weekly_default_minutes - case when rules.salary_time_off_reduces_default then coalesce(salary_time_off.time_off_minutes, 0) else 0 end)::integer as paid_minutes,
      0::integer as break_minutes,
      greatest(0, rules.salary_weekly_default_minutes - case when rules.salary_time_off_reduces_default then coalesce(salary_time_off.time_off_minutes, 0) else 0 end)::integer as gross_minutes,
      rules.salary_weekly_default_minutes as salary_default_minutes,
      case when rules.salary_time_off_reduces_default then coalesce(salary_time_off.time_off_minutes, 0) else 0 end::integer as time_off_minutes,
      '{}'::text[] as exception_codes,
      array_remove(array[
        'Salary payroll default: ' || (rules.salary_weekly_default_minutes / 60.0)::numeric(10, 2)::text || ' hours for the Sunday-Saturday payroll week.',
        case when coalesce(salary_time_off.time_off_minutes, 0) > 0 and rules.salary_time_off_reduces_default
          then 'Approved time off reduced the salary default by ' || (salary_time_off.time_off_minutes / 60.0)::numeric(10, 2)::text || ' hours.'
        end
      ], null) as payroll_notes
    from week_span
    join public.employees employee
      on employee.employment_type = 'salary'
     and employee.status in ('active', 'leave')
    left join salary_time_off
      on salary_time_off.employee_id = employee.id
     and salary_time_off.week_starts_on = week_span.week_starts_on
  ),
  combined as (
    select * from decorated
    union all
    select * from salary_rows
  ),
  readiness as (
    select
      combined.*,
      case
        when combined.row_kind = 'salary_default' then true
        else (
          combined.first_kind = 'clock_in'
          and combined.last_kind = 'clock_out'
          and not combined.invalid_sequence
          and not combined.has_pending_correction
          and combined.paid_minutes > 0
        )
      end as payroll_ready
    from combined
  ),
  daily_allocated as (
    select
      readiness.*,
      coalesce(sum(readiness.paid_minutes) over (
        partition by readiness.employee_id, readiness.operational_date
        order by readiness.operational_date, readiness.first_clock_in nulls last, readiness.group_key
        rows between unbounded preceding and 1 preceding
      ), 0)::integer as prior_day_paid,
      sum(readiness.paid_minutes) over (
        partition by readiness.employee_id, readiness.operational_date
        order by readiness.operational_date, readiness.first_clock_in nulls last, readiness.group_key
        rows between unbounded preceding and current row
      )::integer as cumulative_day_paid
    from readiness
  ),
  daily_overtime as (
    select
      daily_allocated.*,
      case
        when daily_allocated.row_kind = 'salary_default' then 0
        else (
          greatest(0, daily_allocated.cumulative_day_paid - rules.daily_overtime_minutes)
          - greatest(0, daily_allocated.prior_day_paid - rules.daily_overtime_minutes)
        )::integer
      end as daily_overtime_minutes
    from daily_allocated
  ),
  weekly_allocated as (
    select
      daily_overtime.*,
      greatest(0, daily_overtime.paid_minutes - daily_overtime.daily_overtime_minutes)::integer as weekly_candidate_minutes,
      coalesce(sum(greatest(0, daily_overtime.paid_minutes - daily_overtime.daily_overtime_minutes)) over (
        partition by daily_overtime.employee_id, daily_overtime.week_starts_on
        order by daily_overtime.operational_date, daily_overtime.first_clock_in nulls last, daily_overtime.group_key
        rows between unbounded preceding and 1 preceding
      ), 0)::integer as prior_week_candidate,
      sum(greatest(0, daily_overtime.paid_minutes - daily_overtime.daily_overtime_minutes)) over (
        partition by daily_overtime.employee_id, daily_overtime.week_starts_on
        order by daily_overtime.operational_date, daily_overtime.first_clock_in nulls last, daily_overtime.group_key
        rows between unbounded preceding and current row
      )::integer as cumulative_week_candidate
    from daily_overtime
  ),
  final_rows as (
    select
      weekly_allocated.*,
      case
        when weekly_allocated.row_kind = 'salary_default' then 0
        else (
          greatest(0, weekly_allocated.cumulative_week_candidate - rules.weekly_overtime_minutes)
          - greatest(0, weekly_allocated.prior_week_candidate - rules.weekly_overtime_minutes)
        )::integer
      end as weekly_overtime_minutes
    from weekly_allocated
  ),
  output_rows as (
    select
      *,
      case
        when row_kind = 'salary_default' then paid_minutes
        else greatest(0, paid_minutes - daily_overtime_minutes - weekly_overtime_minutes)
      end::integer as regular_minutes,
      case
        when row_kind = 'salary_default' then 0
        else (daily_overtime_minutes + weekly_overtime_minutes)
      end::integer as overtime_minutes,
      array_remove(payroll_notes || array[
        case when daily_overtime_minutes > 0 then 'Daily OT: over 12 paid hours in one day.' end,
        case when weekly_overtime_minutes > 0 then 'Weekly OT: over 40 non-daily-OT paid hours in the Sunday-Saturday payroll week.' end
      ], null) as final_payroll_notes
    from final_rows
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'rowKind', row_kind,
      'employeeId', employee_id,
      'username', username,
      'employeeName', employee_name,
      'role', role,
      'employmentType', employment_type,
      'shiftId', shift_id,
      'operationalDate', operational_date,
      'weekStartsOn', week_starts_on,
      'weekEndsOn', week_ends_on,
      'siteName', site_name,
      'siteCode', site_code,
      'postName', post_name,
      'eventName', event_name,
      'locationName', location_name,
      'scheduledStartsAt', scheduled_starts_at,
      'scheduledEndsAt', scheduled_ends_at,
      'timeZone', coalesce(time_zone, rules.time_zone),
      'firstClockIn', first_clock_in,
      'lastClockOut', last_clock_out,
      'grossMinutes', gross_minutes,
      'breakMinutes', break_minutes,
      'paidMinutes', paid_minutes,
      'regularMinutes', regular_minutes,
      'overtimeMinutes', overtime_minutes,
      'salaryDefaultMinutes', salary_default_minutes,
      'timeOffMinutes', time_off_minutes,
      'eventCount', event_count,
      'requiresArmed', coalesce(requires_armed, false),
      'isOvertime', coalesce(is_overtime, false) or overtime_minutes > 0,
      'payrollReady', payroll_ready,
      'exceptionCodes', to_jsonb(exception_codes),
      'payrollNotes', to_jsonb(final_payroll_notes)
    ) order by week_starts_on, operational_date, employee_name, first_clock_in nulls first, row_kind), '[]'::jsonb),
    count(*)::integer,
    count(*) filter (where payroll_ready)::integer,
    count(*) filter (where not payroll_ready)::integer,
    coalesce(sum(gross_minutes), 0)::integer,
    coalesce(sum(paid_minutes), 0)::integer,
    coalesce(sum(regular_minutes), 0)::integer,
    coalesce(sum(overtime_minutes), 0)::integer,
    coalesce(sum(time_off_minutes), 0)::integer,
    coalesce(sum(salary_default_minutes), 0)::integer
  into
    review_rows,
    rows_total,
    ready_total,
    exception_total,
    gross_minutes_total,
    paid_minutes_total,
    regular_minutes_total,
    overtime_minutes_total,
    time_off_minutes_total,
    salary_default_minutes_total
  from output_rows;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', correction.id,
    'timeEventId', correction.time_event_id,
    'employeeId', event.employee_id,
    'employeeName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'username', employee.username,
    'kind', event.kind,
    'recordedAt', event.recorded_at,
    'replacementTime', correction.replacement_time,
    'voided', correction.voided,
    'reason', correction.reason,
    'requestedBy', correction.requested_by,
    'requestedAt', correction.created_at,
    'shiftId', event.shift_id
  ) order by correction.created_at), '[]'::jsonb)
  into pending_corrections
  from public.time_event_corrections correction
  join public.time_events event on event.id = correction.time_event_id
  join public.employees employee on employee.id = event.employee_id
  where correction.approved_at is null
    and correction.declined_at is null
    and (event.recorded_at at time zone rules.time_zone)::date between target_from_date and target_through_date;

  pending_correction_total := jsonb_array_length(pending_corrections);

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'operationalTimeZone', rules.time_zone,
    'payrollRules', jsonb_build_object(
      'timeZone', rules.time_zone,
      'weekStartsOn', rules.week_starts_on,
      'weekStartsOnLabel', 'Sunday',
      'payFrequency', rules.pay_frequency,
      'payDateAnchor', rules.pay_date_anchor,
      'dailyOvertimeMinutes', rules.daily_overtime_minutes,
      'weeklyOvertimeMinutes', rules.weekly_overtime_minutes,
      'unpaidBreaks', rules.unpaid_breaks,
      'defaultBreakMinutes', rules.default_break_minutes,
      'salaryWeeklyDefaultMinutes', rules.salary_weekly_default_minutes,
      'salaryTimeOffReducesDefault', rules.salary_time_off_reduces_default
    ),
    'summary', jsonb_build_object(
      'rowCount', rows_total,
      'readyCount', ready_total,
      'exceptionCount', exception_total,
      'pendingCorrectionCount', pending_correction_total,
      'grossMinutes', gross_minutes_total,
      'paidMinutes', paid_minutes_total,
      'regularMinutes', regular_minutes_total,
      'overtimeMinutes', overtime_minutes_total,
      'timeOffMinutes', time_off_minutes_total,
      'salaryDefaultMinutes', salary_default_minutes_total
    ),
    'rows', review_rows,
    'pendingCorrections', pending_corrections
  );
end
$$;

revoke all on function public.get_payroll_rules() from public, anon;
revoke all on function public.get_timekeeping_review(date, date) from public, anon;

grant execute on function public.get_payroll_rules() to authenticated;
grant execute on function public.get_timekeeping_review(date, date) to authenticated;
