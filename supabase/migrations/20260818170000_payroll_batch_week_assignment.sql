begin;

alter table private.payroll_rules
  add column if not exists payroll_week_start_time time without time zone not null default time '00:00:00',
  add column if not exists cross_boundary_grouping_policy text not null default 'scheduled_shift_start',
  add column if not exists payroll_policy_effective_from date not null default date '2026-08-16',
  add column if not exists payroll_configuration_version integer not null default 1,
  add column if not exists payroll_calculation_policy_version text not null default 'payroll-batch-v1',
  add column if not exists overtime_time_zone text not null default 'America/Denver',
  add column if not exists overtime_week_starts_on integer not null default 0,
  add column if not exists overtime_week_start_time time without time zone not null default time '00:00:00',
  add column if not exists overtime_policy_version text not null default 'colorado-daily-weekly-v1';

alter table private.payroll_rules
  drop constraint if exists payroll_rules_cross_boundary_policy_check,
  add constraint payroll_rules_cross_boundary_policy_check
    check (cross_boundary_grouping_policy in ('scheduled_shift_start')),
  drop constraint if exists payroll_rules_configuration_version_check,
  add constraint payroll_rules_configuration_version_check
    check (payroll_configuration_version > 0),
  drop constraint if exists payroll_rules_overtime_week_start_check,
  add constraint payroll_rules_overtime_week_start_check
    check (overtime_week_starts_on between 0 and 6);

update private.payroll_rules
set
  time_zone = 'America/Denver',
  week_starts_on = 0,
  payroll_week_start_time = time '00:00:00',
  cross_boundary_grouping_policy = 'scheduled_shift_start',
  payroll_policy_effective_from = date '2026-08-16',
  payroll_configuration_version = greatest(payroll_configuration_version, 1),
  payroll_calculation_policy_version = 'payroll-batch-v1',
  overtime_time_zone = coalesce(nullif(overtime_time_zone, ''), 'America/Denver'),
  overtime_week_starts_on = 0,
  overtime_week_start_time = time '00:00:00',
  overtime_policy_version = coalesce(nullif(overtime_policy_version, ''), 'colorado-daily-weekly-v1'),
  updated_at = clock_timestamp()
where id = true;

insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
)
values (
  'time.override_payroll_assignment',
  'Time & Attendance',
  'Correct payroll batch assignment',
  'Correct the payroll batch week for an unlocked time occurrence with a required reason and permanent audit history.',
  'critical',
  true,
  false,
  true
)
on conflict (code) do update
set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  active = true,
  updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, 'time.override_payroll_assignment', true
from public.access_roles role
where role.code = 'system_admin'
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

create table if not exists private.payroll_batch_assignments (
  occurrence_key text primary key,
  occurrence_fingerprint text not null,
  employee_id uuid not null references public.employees(id) on delete restrict,
  shift_id uuid references public.shifts(id) on delete restrict,
  assignment_source text not null,
  assignment_status text not null default 'derived',
  assignment_anchor timestamptz,
  original_week_start date,
  assigned_week_start date,
  policy_version text not null,
  configuration_version integer not null,
  cross_boundary boolean not null default false,
  correction_reason text,
  corrected_by uuid references public.employees(id) on delete restrict,
  corrected_at timestamptz,
  recalculated_at timestamptz not null default clock_timestamp(),
  constraint payroll_batch_assignments_occurrence_key_present check (btrim(occurrence_key) <> ''),
  constraint payroll_batch_assignments_fingerprint_format check (occurrence_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint payroll_batch_assignments_source_check check (
    assignment_source in ('scheduled_shift', 'replacement_assignment', 'manual_linked_shift', 'manual_entry', 'unscheduled_actual_punch', 'salary_default', 'authorized_correction', 'unresolved')
  ),
  constraint payroll_batch_assignments_status_check check (assignment_status in ('derived', 'corrected', 'unresolved')),
  constraint payroll_batch_assignments_version_check check (configuration_version > 0),
  constraint payroll_batch_assignments_correction_check check (
    (assignment_status = 'corrected' and correction_reason is not null and corrected_by is not null and corrected_at is not null)
    or assignment_status <> 'corrected'
  )
);

create index if not exists payroll_batch_assignments_employee_idx
  on private.payroll_batch_assignments (employee_id, assigned_week_start, recalculated_at desc);
create index if not exists payroll_batch_assignments_shift_idx
  on private.payroll_batch_assignments (shift_id) where shift_id is not null;

create table if not exists public.payroll_batch_assignment_history (
  id uuid primary key default gen_random_uuid(),
  occurrence_key text not null,
  occurrence_fingerprint text not null,
  employee_id uuid not null references public.employees(id) on delete restrict,
  shift_id uuid references public.shifts(id) on delete restrict,
  action text not null,
  original_week_start date,
  assigned_week_start date,
  assignment_source text not null,
  reason text not null,
  policy_version text not null,
  configuration_version integer not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  idempotency_key text not null unique,
  snapshot jsonb not null,
  constraint payroll_batch_assignment_history_action_check check (action in ('derived', 'recalculated', 'corrected', 'reverted', 'unresolved')),
  constraint payroll_batch_assignment_history_reason_present check (btrim(reason) <> ''),
  constraint payroll_batch_assignment_history_snapshot_object check (jsonb_typeof(snapshot) = 'object')
);

create index if not exists payroll_batch_assignment_history_occurrence_idx
  on public.payroll_batch_assignment_history (occurrence_key, created_at desc);
create index if not exists payroll_batch_assignment_history_actor_idx
  on public.payroll_batch_assignment_history (actor_id, created_at desc);

alter table public.payroll_batch_assignment_history enable row level security;
revoke all on table public.payroll_batch_assignment_history from public, anon, authenticated;

drop trigger if exists payroll_batch_assignment_history_append_only on public.payroll_batch_assignment_history;
create trigger payroll_batch_assignment_history_append_only
before update or delete on public.payroll_batch_assignment_history
for each row execute function private.prevent_append_only_change();

drop trigger if exists payroll_batch_assignment_history_audit on public.payroll_batch_assignment_history;
create trigger payroll_batch_assignment_history_audit
after insert on public.payroll_batch_assignment_history
for each row execute function private.write_audit_event();

create table if not exists private.payroll_batch_recalculation_runs (
  id uuid primary key default gen_random_uuid(),
  from_date date not null,
  through_date date not null,
  dry_run boolean not null,
  policy_version text not null,
  configuration_version integer not null,
  row_count integer not null,
  changed_count integer not null,
  unchanged_count integer not null,
  unresolved_count integer not null,
  locked_skipped_count integer not null,
  paid_minutes integer not null,
  regular_minutes integer not null,
  overtime_minutes integer not null,
  run_by uuid not null references public.employees(id) on delete restrict,
  run_at timestamptz not null default clock_timestamp(),
  result_payload jsonb not null,
  constraint payroll_batch_recalculation_range_check check (through_date >= from_date),
  constraint payroll_batch_recalculation_counts_check check (
    row_count >= 0 and changed_count >= 0 and unchanged_count >= 0 and unresolved_count >= 0 and locked_skipped_count >= 0
  ),
  constraint payroll_batch_recalculation_minutes_check check (paid_minutes >= 0 and regular_minutes >= 0 and overtime_minutes >= 0),
  constraint payroll_batch_recalculation_payload_check check (jsonb_typeof(result_payload) = 'object')
);

create or replace function private.payroll_week_bounds(
  assignment_anchor timestamptz,
  target_time_zone text,
  target_week_starts_on integer,
  target_week_start_time time without time zone
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  local_anchor timestamp without time zone;
  local_date date;
  candidate_date date;
  days_since_start integer;
  starts_at timestamptz;
  ends_at_exclusive timestamptz;
begin
  if assignment_anchor is null then
    return jsonb_build_object(
      'resolved', false,
      'weekStartsOn', null,
      'weekEndsOn', null,
      'startsAt', null,
      'endsAtExclusive', null,
      'timeZone', target_time_zone
    );
  end if;

  if target_week_starts_on not between 0 and 6 then
    raise check_violation using message = 'Payroll week start day must be between Sunday (0) and Saturday (6).';
  end if;

  local_anchor := assignment_anchor at time zone target_time_zone;
  local_date := local_anchor::date;
  days_since_start := mod(extract(dow from local_date)::integer - target_week_starts_on + 7, 7);
  candidate_date := local_date - days_since_start;

  if days_since_start = 0 and local_anchor::time < target_week_start_time then
    candidate_date := candidate_date - 7;
  end if;

  starts_at := (candidate_date::timestamp + target_week_start_time) at time zone target_time_zone;
  ends_at_exclusive := ((candidate_date + 7)::timestamp + target_week_start_time) at time zone target_time_zone;

  return jsonb_build_object(
    'resolved', true,
    'weekStartsOn', candidate_date,
    'weekEndsOn', candidate_date + 6,
    'startsAt', starts_at,
    'endsAtExclusive', ends_at_exclusive,
    'timeZone', target_time_zone
  );
end
$$;

create or replace function private.get_payroll_batch_week(assignment_anchor timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rules private.payroll_rules%rowtype;
  bounds jsonb;
begin
  select * into rules from private.payroll_rules where id = true;
  bounds := private.payroll_week_bounds(
    assignment_anchor,
    rules.time_zone,
    rules.week_starts_on,
    rules.payroll_week_start_time
  );
  return bounds || jsonb_build_object(
    'policy', rules.cross_boundary_grouping_policy,
    'policyVersion', rules.payroll_calculation_policy_version,
    'configurationVersion', rules.payroll_configuration_version,
    'effectiveFrom', rules.payroll_policy_effective_from
  );
end
$$;

create or replace function private.allocate_hours_to_overtime_workweek(work_anchor timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rules private.payroll_rules%rowtype;
  bounds jsonb;
begin
  select * into rules from private.payroll_rules where id = true;
  bounds := private.payroll_week_bounds(
    work_anchor,
    rules.overtime_time_zone,
    rules.overtime_week_starts_on,
    rules.overtime_week_start_time
  );
  return bounds || jsonb_build_object(
    'policyVersion', rules.overtime_policy_version,
    'dailyOvertimeMinutes', rules.daily_overtime_minutes,
    'weeklyOvertimeMinutes', rules.weekly_overtime_minutes
  );
end
$$;

create or replace function private.get_payroll_period_for_week(target_week_start date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rules private.payroll_rules%rowtype;
  period_length integer;
  anchor_period_end date;
  anchor_period_start date;
  period_offset integer;
  period_start date;
begin
  select * into rules from private.payroll_rules where id = true;
  if target_week_start is null then
    return jsonb_build_object('resolved', false, 'periodStartsOn', null, 'periodEndsOn', null);
  end if;

  period_length := case when rules.pay_frequency = 'biweekly' then 14 else 7 end;
  anchor_period_end := rules.pay_date_anchor - mod(extract(dow from rules.pay_date_anchor)::integer - ((rules.week_starts_on + 6) % 7) + 7, 7);
  anchor_period_start := anchor_period_end - (period_length - 1);
  period_offset := floor((target_week_start - anchor_period_start)::numeric / period_length)::integer;
  period_start := anchor_period_start + (period_offset * period_length);

  return jsonb_build_object(
    'resolved', true,
    'periodStartsOn', period_start,
    'periodEndsOn', period_start + (period_length - 1),
    'payFrequency', rules.pay_frequency
  );
end
$$;

create or replace function private.get_timekeeping_occurrence_key(
  target_event_id uuid,
  target_employee_id uuid,
  target_shift_id uuid,
  target_effective_at timestamptz,
  target_time_zone text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
select case
  when target_shift_id is not null then 'shift:' || target_shift_id::text || ':employee:' || target_employee_id::text
  when manual.id is not null then 'manual:' || manual.id::text || ':employee:' || target_employee_id::text
  when target_effective_at is not null
    then 'unscheduled:' || target_employee_id::text || ':' || (target_effective_at at time zone target_time_zone)::date::text
  else 'unresolved-event:' || target_event_id::text || ':employee:' || target_employee_id::text
end
from (select 1) seed
left join lateral (
  select entry.id
  from public.manual_time_entries entry
  where target_event_id in (entry.clock_in_event_id, entry.clock_out_event_id)
  order by entry.created_at desc, entry.id desc
  limit 1
) manual on true
$$;

create or replace function private.get_payroll_assignment_anchor(
  target_shift_id uuid,
  target_event_id uuid,
  fallback_clock_in timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
select coalesce(
  (select shift.starts_at from public.shifts shift where shift.id = target_shift_id),
  (
    select entry.clock_in_at
    from public.manual_time_entries entry
    where target_event_id in (entry.clock_in_event_id, entry.clock_out_event_id)
    order by entry.created_at desc, entry.id desc
    limit 1
  ),
  fallback_clock_in
)
$$;

do $patch_timekeeping_base_for_payroll_assignment$
declare
  function_sql text;
  long_group_key text := 'coalesce(event.shift_id::text, ''unscheduled:'' || event.employee_id::text || '':'' || (event.effective_at at time zone rules.time_zone)::date::text)';
  short_group_key text := 'coalesce(event.shift_id::text, ''unscheduled:'' || (event.effective_at at time zone rules.time_zone)::date::text)';
  assignment_key text := 'private.get_timekeeping_occurrence_key(event.id, event.employee_id, event.shift_id, event.effective_at, rules.time_zone)';
begin
  select pg_get_functiondef('private.get_timekeeping_review_base(date, date)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'The timekeeping review base function was not found.';
  end if;

  if position('get_payroll_assignment_anchor' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      'and (event.effective_at at time zone rules.time_zone)::date between target_from_date and target_through_date',
      'and (private.get_payroll_assignment_anchor(event.shift_id, event.id, event.effective_at) at time zone rules.time_zone)::date between target_from_date and target_through_date'
    );
  end if;

  function_sql := replace(function_sql, long_group_key, assignment_key);
  function_sql := replace(function_sql, short_group_key, assignment_key);

  if position('get_payroll_assignment_anchor' in function_sql) = 0
    or position('get_timekeeping_occurrence_key' in function_sql) = 0 then
    raise check_violation using message = 'Payroll assignment could not be applied to the timekeeping review base.';
  end if;

  execute function_sql;
end
$patch_timekeeping_base_for_payroll_assignment$;

do $create_manual_occurrence_context_overload$
declare
  function_sql text;
begin
  select pg_get_functiondef('private.get_timekeeping_occurrence_context(uuid, uuid, date)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'The timekeeping occurrence context function was not found.';
  end if;

  function_sql := replace(
    function_sql,
    'private.get_timekeeping_occurrence_context(target_employee_id uuid, target_shift_id uuid, target_operational_date date)',
    'private.get_timekeeping_occurrence_context(target_employee_id uuid, target_shift_id uuid, target_operational_date date, target_first_clock_in timestamptz)'
  );

  function_sql := replace(
    function_sql,
    'target_shift_id is null
        and event.shift_id is null
        and (event.effective_at at time zone ''America/Denver'')::date = target_operational_date',
    'target_shift_id is null
        and event.shift_id is null
        and (
          exists (
            select 1
            from public.manual_time_entries entry
            where entry.employee_id = target_employee_id
              and entry.clock_in_at = target_first_clock_in
              and event.id in (entry.clock_in_event_id, entry.clock_out_event_id)
          )
          or (
            not exists (
              select 1
              from public.manual_time_entries entry
              where entry.employee_id = target_employee_id
                and entry.clock_in_at = target_first_clock_in
            )
            and (event.effective_at at time zone ''America/Denver'')::date = target_operational_date
          )
        )'
  );

  if position('target_first_clock_in timestamptz' in function_sql) = 0
    or position('entry.clock_in_at = target_first_clock_in' in function_sql) = 0 then
    raise check_violation using message = 'Manual-entry occurrence isolation could not be installed.';
  end if;

  execute function_sql;
end
$create_manual_occurrence_context_overload$;

do $patch_operations_review_for_manual_occurrence$
declare
  function_sql text;
begin
  select pg_get_functiondef('private.get_timekeeping_review_operations_base(date, date)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'The timekeeping operations review function was not found.';
  end if;

  if position('firstClockIn' in substring(function_sql from position('get_timekeeping_occurrence_context' in function_sql) for 700)) = 0 then
    function_sql := replace(
      function_sql,
      '(base_row ->> ''operationalDate'')::date
    );',
      '(base_row ->> ''operationalDate'')::date,
      nullif(base_row ->> ''firstClockIn'', '''')::timestamptz
    );'
    );
  end if;

  if position('nullif(base_row ->> ''firstClockIn''' in function_sql) = 0 then
    raise check_violation using message = 'Manual-entry occurrence isolation could not be applied to payroll exception review.';
  end if;

  execute function_sql;
end
$patch_operations_review_for_manual_occurrence$;

create or replace function private.payroll_assignment_is_locked(
  target_occurrence_key text,
  target_employee_id uuid,
  target_shift_id uuid,
  target_first_clock_in timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
select exists (
  select 1
  from private.payroll_export_rows export_row
  where export_row.employee_id = target_employee_id
    and (
      export_row.row_payload ->> 'payrollOccurrenceKey' = target_occurrence_key
      or (
        nullif(export_row.row_payload ->> 'payrollOccurrenceKey', '') is null
        and export_row.shift_id is not distinct from target_shift_id
        and (
          target_shift_id is not null
          or nullif(export_row.row_payload ->> 'firstClockIn', '')::timestamptz is not distinct from target_first_clock_in
        )
      )
    )
)
$$;

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
    'payrollWeekStartTime', rules.payroll_week_start_time,
    'crossBoundaryGroupingPolicy', rules.cross_boundary_grouping_policy,
    'payrollPolicyEffectiveFrom', rules.payroll_policy_effective_from,
    'payrollConfigurationVersion', rules.payroll_configuration_version,
    'payrollCalculationPolicyVersion', rules.payroll_calculation_policy_version,
    'payFrequency', rules.pay_frequency,
    'payDateAnchor', rules.pay_date_anchor,
    'dailyOvertimeMinutes', rules.daily_overtime_minutes,
    'weeklyOvertimeMinutes', rules.weekly_overtime_minutes,
    'overtimeTimeZone', rules.overtime_time_zone,
    'overtimeWeekStartsOn', rules.overtime_week_starts_on,
    'overtimeWeekStartTime', rules.overtime_week_start_time,
    'overtimePolicyVersion', rules.overtime_policy_version,
    'unpaidBreaks', rules.unpaid_breaks,
    'defaultBreakMinutes', rules.default_break_minutes,
    'salaryWeeklyDefaultMinutes', rules.salary_weekly_default_minutes,
    'salaryTimeOffReducesDefault', rules.salary_time_off_reduces_default,
    'updatedAt', rules.updated_at,
    'updatedBy', rules.updated_by
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
  payload jsonb;
  base_row jsonb;
  enriched_row jsonb;
  enriched_rows jsonb := '[]'::jsonb;
  rules private.payroll_rules%rowtype;
  first_event_id uuid;
  assignment_anchor timestamptz;
  assignment_source text;
  calculated_occurrence_key text;
  calculated_occurrence_fingerprint text;
  batch_week jsonb;
  end_batch_week jsonb;
  overtime_week jsonb;
  payroll_period jsonb;
  assignment_record private.payroll_batch_assignments%rowtype;
  assigned_week_start date;
  assignment_status text;
  assignment_reason text;
  assignment_candidates jsonb;
  cross_boundary boolean;
  effective_exception_codes jsonb;
  detected_exception_codes jsonb;
  payroll_ready boolean;
  row_count integer := 0;
  ready_count integer := 0;
  exception_count integer := 0;
  total_paid integer := 0;
  total_regular integer := 0;
  total_overtime integer := 0;
  unique_occurrences integer := 0;
  unresolved_assignments integer := 0;
  reconciliation_passed boolean;
begin
  payload := private.get_timekeeping_review_operations_base(target_from_date, target_through_date);
  select * into rules from private.payroll_rules where id = true;

  for base_row in
    select row_value
    from jsonb_array_elements(coalesce(payload -> 'rows', '[]'::jsonb)) row_payload(row_value)
  loop
    first_event_id := nullif(base_row -> 'eventTimeline' -> 0 ->> 'id', '')::uuid;
    assignment_anchor := case
      when base_row ->> 'rowKind' = 'salary_default'
        then ((base_row ->> 'operationalDate')::date::timestamp + time '12:00:00') at time zone rules.time_zone
      else private.get_payroll_assignment_anchor(
        nullif(base_row ->> 'shiftId', '')::uuid,
        first_event_id,
        nullif(base_row ->> 'firstClockIn', '')::timestamptz
      )
    end;

    calculated_occurrence_key := case
      when base_row ->> 'rowKind' = 'salary_default'
        then 'salary:' || (base_row ->> 'employeeId') || ':' || (base_row ->> 'operationalDate')
      when nullif(base_row ->> 'shiftId', '') is not null
        then 'shift:' || (base_row ->> 'shiftId') || ':employee:' || (base_row ->> 'employeeId')
      when first_event_id is not null
        then private.get_timekeeping_occurrence_key(
          first_event_id,
          (base_row ->> 'employeeId')::uuid,
          null,
          coalesce(nullif(base_row ->> 'firstClockIn', '')::timestamptz, assignment_anchor),
          rules.time_zone
        )
      else 'unresolved:' || (base_row ->> 'employeeId') || ':' || (base_row ->> 'operationalDate')
    end;

    calculated_occurrence_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
      'occurrenceKey', calculated_occurrence_key,
      'employeeId', base_row ->> 'employeeId',
      'shiftId', base_row ->> 'shiftId',
      'firstClockIn', base_row ->> 'firstClockIn',
      'lastClockOut', base_row ->> 'lastClockOut',
      'paidMinutes', base_row ->> 'paidMinutes',
      'events', coalesce(base_row -> 'eventTimeline', '[]'::jsonb)
    )::text, 'UTF8'), 'sha256'), 'hex');

    batch_week := private.get_payroll_batch_week(assignment_anchor);
    overtime_week := private.allocate_hours_to_overtime_workweek(coalesce(nullif(base_row ->> 'firstClockIn', '')::timestamptz, assignment_anchor));
    payroll_period := private.get_payroll_period_for_week(nullif(batch_week ->> 'weekStartsOn', '')::date);

    assignment_source := case
      when assignment_anchor is null then 'unresolved'
      when base_row ->> 'rowKind' = 'salary_default' then 'salary_default'
      when nullif(base_row ->> 'shiftId', '') is not null and exists (
        select 1 from public.manual_time_entries manual
        where first_event_id in (manual.clock_in_event_id, manual.clock_out_event_id)
      ) then 'manual_linked_shift'
      when nullif(base_row ->> 'shiftId', '') is not null and exists (
        select 1 from public.shift_assignments assignment
        where assignment.shift_id = nullif(base_row ->> 'shiftId', '')::uuid
          and assignment.employee_id = (base_row ->> 'employeeId')::uuid
          and assignment.canceled_at is null
          and assignment.status in ('assigned', 'confirmed', 'completed')
      ) then 'scheduled_shift'
      when nullif(base_row ->> 'shiftId', '') is not null then 'replacement_assignment'
      when exists (
        select 1 from public.manual_time_entries manual
        where first_event_id in (manual.clock_in_event_id, manual.clock_out_event_id)
      ) then 'manual_entry'
      else 'unscheduled_actual_punch'
    end;

    select * into assignment_record
    from private.payroll_batch_assignments current_assignment
    where current_assignment.occurrence_key = calculated_occurrence_key
      and current_assignment.occurrence_fingerprint = calculated_occurrence_fingerprint
    limit 1;

    assigned_week_start := coalesce(
      case when assignment_record.assignment_status = 'corrected' then assignment_record.assigned_week_start end,
      nullif(batch_week ->> 'weekStartsOn', '')::date
    );
    assignment_status := case
      when assignment_record.assignment_status = 'corrected' then 'corrected'
      when assignment_anchor is null then 'unresolved'
      else 'derived'
    end;
    assignment_reason := case
      when assignment_record.assignment_status = 'corrected' then assignment_record.correction_reason
      when assignment_anchor is null then 'No scheduled shift, manual entry clock-in, or actual clock-in was available.'
      when assignment_source in ('scheduled_shift', 'replacement_assignment', 'manual_linked_shift') then 'Entire occurrence follows the scheduled shift start in America/Denver.'
      when assignment_source = 'manual_entry' then 'Standalone manual time follows the manual clock-in.'
      when assignment_source = 'unscheduled_actual_punch' then 'Unscheduled work follows the actual clock-in.'
      else 'Configured payroll-batch policy applied.'
    end;

    if assignment_record.assignment_status = 'corrected' then
      payroll_period := private.get_payroll_period_for_week(assigned_week_start);
      assignment_source := 'authorized_correction';
    end if;

    end_batch_week := private.get_payroll_batch_week(
      coalesce(
        nullif(base_row ->> 'lastClockOut', '')::timestamptz,
        nullif(base_row ->> 'scheduledEndsAt', '')::timestamptz,
        assignment_anchor
      ) - interval '1 microsecond'
    );
    cross_boundary := assignment_anchor is not null
      and nullif(end_batch_week ->> 'weekStartsOn', '')::date is distinct from nullif(batch_week ->> 'weekStartsOn', '')::date;

    if assignment_anchor is null and assignment_record.assignment_status is distinct from 'corrected' then
      select coalesce(jsonb_agg(jsonb_build_object(
        'shiftId', shift.id,
        'startsAt', shift.starts_at,
        'endsAt', shift.ends_at,
        'timeZone', shift.time_zone,
        'locationName', coalesce(site.name, post.name, schedule_event.location_name, schedule_event.name, 'Scheduled shift')
      ) order by
        abs((shift.starts_at at time zone shift.time_zone)::date - (base_row ->> 'operationalDate')::date),
        shift.starts_at,
        shift.id), '[]'::jsonb)
      into assignment_candidates
      from public.shifts shift
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events schedule_event on schedule_event.id = shift.event_id
      where shift.canceled_at is null
        and (shift.starts_at at time zone shift.time_zone)::date between (base_row ->> 'operationalDate')::date - 1 and (base_row ->> 'operationalDate')::date + 1;
    else
      assignment_candidates := '[]'::jsonb;
    end if;

    effective_exception_codes := coalesce(base_row -> 'exceptionCodes', '[]'::jsonb);
    detected_exception_codes := coalesce(base_row -> 'detectedExceptionCodes', effective_exception_codes);
    if assignment_anchor is null and assignment_record.assignment_status is distinct from 'corrected' then
      effective_exception_codes := effective_exception_codes || jsonb_build_array('payroll_assignment_unresolved');
      detected_exception_codes := detected_exception_codes || jsonb_build_array('payroll_assignment_unresolved');
    end if;
    payroll_ready := coalesce((base_row ->> 'payrollReady')::boolean, false) and assigned_week_start is not null;

    enriched_row := base_row || jsonb_build_object(
      'shiftNotes', case when nullif(base_row ->> 'shiftId', '') is null then null else (
        select shift.notes from public.shifts shift where shift.id = (base_row ->> 'shiftId')::uuid
      ) end,
      'payrollOccurrenceKey', calculated_occurrence_key,
      'payrollOccurrenceFingerprint', calculated_occurrence_fingerprint,
      'payrollAssignmentAnchor', assignment_anchor,
      'payrollBatchWeekStartsOn', assigned_week_start,
      'payrollBatchWeekEndsOn', case when assigned_week_start is null then null else assigned_week_start + 6 end,
      'payrollPeriodStartsOn', payroll_period ->> 'periodStartsOn',
      'payrollPeriodEndsOn', payroll_period ->> 'periodEndsOn',
      'payrollAssignmentSource', assignment_source,
      'payrollAssignmentStatus', assignment_status,
      'payrollAssignmentExplanation', assignment_reason,
      'payrollAssignmentCandidates', assignment_candidates,
      'crossesPayrollBoundary', cross_boundary,
      'payrollGroupingPolicy', rules.cross_boundary_grouping_policy,
      'payrollPolicyVersion', rules.payroll_calculation_policy_version,
      'payrollConfigurationVersion', rules.payroll_configuration_version,
      'overtimeWorkweekStartsOn', overtime_week ->> 'weekStartsOn',
      'overtimeWorkweekEndsOn', overtime_week ->> 'weekEndsOn',
      'overtimePolicyVersion', rules.overtime_policy_version,
      'manualAdjustment', exists (
        select 1
        from public.time_event_corrections correction
        join public.time_events event on event.id = correction.time_event_id
        where correction.approved_at is not null
          and event.employee_id = (base_row ->> 'employeeId')::uuid
          and (
            event.shift_id is not distinct from nullif(base_row ->> 'shiftId', '')::uuid
            or event.id = first_event_id
          )
      ),
      'payrollReady', payroll_ready,
      'exceptionCodes', effective_exception_codes,
      'detectedExceptionCodes', detected_exception_codes
    );
    enriched_rows := enriched_rows || jsonb_build_array(enriched_row);
  end loop;

  select
    count(*)::integer,
    count(*) filter (where coalesce((row_value ->> 'payrollReady')::boolean, false))::integer,
    count(*) filter (where not coalesce((row_value ->> 'payrollReady')::boolean, false))::integer,
    coalesce(sum((row_value ->> 'paidMinutes')::integer), 0)::integer,
    coalesce(sum((row_value ->> 'regularMinutes')::integer), 0)::integer,
    coalesce(sum((row_value ->> 'overtimeMinutes')::integer), 0)::integer,
    count(distinct row_value ->> 'payrollOccurrenceKey')::integer,
    count(*) filter (where row_value ->> 'payrollAssignmentStatus' = 'unresolved')::integer
  into row_count, ready_count, exception_count, total_paid, total_regular, total_overtime, unique_occurrences, unresolved_assignments
  from jsonb_array_elements(enriched_rows) rows(row_value);

  reconciliation_passed := total_paid = total_regular + total_overtime
    and row_count = unique_occurrences
    and unresolved_assignments = 0;

  return payload || jsonb_build_object(
    'rows', enriched_rows,
    'payrollRules', jsonb_build_object(
      'timeZone', rules.time_zone,
      'weekStartsOn', rules.week_starts_on,
      'weekStartsOnLabel', 'Sunday',
      'payrollWeekStartTime', rules.payroll_week_start_time,
      'crossBoundaryGroupingPolicy', rules.cross_boundary_grouping_policy,
      'payrollPolicyEffectiveFrom', rules.payroll_policy_effective_from,
      'payrollConfigurationVersion', rules.payroll_configuration_version,
      'payrollCalculationPolicyVersion', rules.payroll_calculation_policy_version,
      'payFrequency', rules.pay_frequency,
      'payDateAnchor', rules.pay_date_anchor,
      'dailyOvertimeMinutes', rules.daily_overtime_minutes,
      'weeklyOvertimeMinutes', rules.weekly_overtime_minutes,
      'overtimeTimeZone', rules.overtime_time_zone,
      'overtimeWeekStartsOn', rules.overtime_week_starts_on,
      'overtimeWeekStartTime', rules.overtime_week_start_time,
      'overtimePolicyVersion', rules.overtime_policy_version,
      'unpaidBreaks', rules.unpaid_breaks,
      'defaultBreakMinutes', rules.default_break_minutes,
      'salaryWeeklyDefaultMinutes', rules.salary_weekly_default_minutes,
      'salaryTimeOffReducesDefault', rules.salary_time_off_reduces_default,
      'updatedAt', rules.updated_at,
      'updatedBy', rules.updated_by
    ),
    'summary', (payload -> 'summary') || jsonb_build_object(
      'rowCount', row_count,
      'readyCount', ready_count,
      'exceptionCount', exception_count
    ),
    'reconciliation', jsonb_build_object(
      'passed', reconciliation_passed,
      'paidMinutes', total_paid,
      'regularMinutes', total_regular,
      'overtimeMinutes', total_overtime,
      'regularPlusOvertimeMatchesPaid', total_paid = total_regular + total_overtime,
      'rowCount', row_count,
      'uniqueOccurrenceCount', unique_occurrences,
      'duplicateOccurrenceCount', greatest(0, row_count - unique_occurrences),
      'unresolvedAssignmentCount', unresolved_assignments,
      'policyVersion', rules.payroll_calculation_policy_version,
      'configurationVersion', rules.payroll_configuration_version
    )
  );
end
$$;

create or replace function public.correct_payroll_batch_assignment(
  target_occurrence_key text,
  target_occurrence_fingerprint text,
  target_employee_id uuid,
  target_shift_id uuid,
  target_first_clock_in timestamptz,
  target_original_week_start date,
  target_assigned_week_start date,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  rules private.payroll_rules%rowtype;
  clean_reason text := btrim(coalesce(target_reason, ''));
  current_assignment private.payroll_batch_assignments%rowtype;
  history_idempotency_key text;
begin
  if actor_id is null or not public.has_mfa() or not public.has_effective_permission('time.override_payroll_assignment') then
    raise insufficient_privilege using message = 'Payroll batch correction permission with MFA is required.';
  end if;
  if btrim(coalesce(target_occurrence_key, '')) = ''
    or target_occurrence_fingerprint !~ '^[a-f0-9]{64}$'
    or target_employee_id is null
    or target_assigned_week_start is null then
    raise check_violation using message = 'A current payroll occurrence and corrected payroll week are required.';
  end if;
  if extract(dow from target_assigned_week_start)::integer <> 0 then
    raise check_violation using message = 'The corrected payroll batch week must begin on Sunday.';
  end if;
  if char_length(clean_reason) < 12 then
    raise check_violation using message = 'Enter a correction reason of at least 12 characters.';
  end if;
  if private.payroll_assignment_is_locked(target_occurrence_key, target_employee_id, target_shift_id, target_first_clock_in) then
    raise check_violation using message = 'This occurrence is in a locked payroll export and cannot be reassigned.';
  end if;

  select * into rules from private.payroll_rules where id = true;
  perform pg_advisory_xact_lock(hashtext('payroll-assignment:' || target_occurrence_key));

  insert into private.payroll_batch_assignments (
    occurrence_key, occurrence_fingerprint, employee_id, shift_id, assignment_source, assignment_status,
    assignment_anchor, original_week_start, assigned_week_start, policy_version, configuration_version,
    cross_boundary, correction_reason, corrected_by, corrected_at, recalculated_at
  ) values (
    target_occurrence_key, target_occurrence_fingerprint, target_employee_id, target_shift_id,
    'authorized_correction', 'corrected', target_first_clock_in, target_original_week_start,
    target_assigned_week_start, rules.payroll_calculation_policy_version, rules.payroll_configuration_version,
    target_original_week_start is distinct from target_assigned_week_start, clean_reason, actor_id, clock_timestamp(), clock_timestamp()
  )
  on conflict (occurrence_key) do update set
    occurrence_fingerprint = excluded.occurrence_fingerprint,
    employee_id = excluded.employee_id,
    shift_id = excluded.shift_id,
    assignment_source = excluded.assignment_source,
    assignment_status = excluded.assignment_status,
    assignment_anchor = excluded.assignment_anchor,
    original_week_start = excluded.original_week_start,
    assigned_week_start = excluded.assigned_week_start,
    policy_version = excluded.policy_version,
    configuration_version = excluded.configuration_version,
    cross_boundary = excluded.cross_boundary,
    correction_reason = excluded.correction_reason,
    corrected_by = excluded.corrected_by,
    corrected_at = excluded.corrected_at,
    recalculated_at = excluded.recalculated_at
  returning * into current_assignment;

  history_idempotency_key := encode(extensions.digest(convert_to(concat_ws(':',
    target_occurrence_key, target_occurrence_fingerprint, target_assigned_week_start, clean_reason, actor_id
  ), 'UTF8'), 'sha256'), 'hex');

  insert into public.payroll_batch_assignment_history (
    occurrence_key, occurrence_fingerprint, employee_id, shift_id, action, original_week_start,
    assigned_week_start, assignment_source, reason, policy_version, configuration_version,
    actor_id, idempotency_key, snapshot
  ) values (
    target_occurrence_key, target_occurrence_fingerprint, target_employee_id, target_shift_id, 'corrected',
    target_original_week_start, target_assigned_week_start, 'authorized_correction', clean_reason,
    rules.payroll_calculation_policy_version, rules.payroll_configuration_version, actor_id,
    history_idempotency_key, to_jsonb(current_assignment)
  ) on conflict (idempotency_key) do nothing;

  return jsonb_build_object(
    'occurrenceKey', current_assignment.occurrence_key,
    'originalWeekStartsOn', current_assignment.original_week_start,
    'assignedWeekStartsOn', current_assignment.assigned_week_start,
    'assignmentStatus', current_assignment.assignment_status,
    'reason', current_assignment.correction_reason,
    'correctedBy', current_assignment.corrected_by,
    'correctedAt', current_assignment.corrected_at
  );
end
$$;

create or replace function public.recalculate_open_payroll_batch_assignments(
  target_from_date date,
  target_through_date date,
  target_dry_run boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  rules private.payroll_rules%rowtype;
  review_payload jsonb;
  row_value jsonb;
  existing_assignment private.payroll_batch_assignments%rowtype;
  changed_count integer := 0;
  unchanged_count integer := 0;
  unresolved_count integer := 0;
  locked_skipped_count integer := 0;
  row_count integer := 0;
  paid_minutes integer := 0;
  regular_minutes integer := 0;
  overtime_minutes integer := 0;
  history_idempotency_key text;
  result_payload jsonb;
  run_record private.payroll_batch_recalculation_runs%rowtype;
begin
  if actor_id is null or not public.has_mfa() or not public.has_effective_permission('time.override_payroll_assignment') then
    raise insufficient_privilege using message = 'Payroll batch recalculation permission with MFA is required.';
  end if;
  if target_from_date is null or target_through_date is null or target_through_date < target_from_date
    or target_through_date - target_from_date > 92 then
    raise check_violation using message = 'Choose a valid recalculation range of 93 days or fewer.';
  end if;

  select * into rules from private.payroll_rules where id = true;
  review_payload := public.get_timekeeping_review(target_from_date, target_through_date);

  for row_value in
    select item from jsonb_array_elements(coalesce(review_payload -> 'rows', '[]'::jsonb)) rows(item)
    where item ->> 'rowKind' = 'time_event'
  loop
    row_count := row_count + 1;
    paid_minutes := paid_minutes + coalesce((row_value ->> 'paidMinutes')::integer, 0);
    regular_minutes := regular_minutes + coalesce((row_value ->> 'regularMinutes')::integer, 0);
    overtime_minutes := overtime_minutes + coalesce((row_value ->> 'overtimeMinutes')::integer, 0);

    if row_value ->> 'payrollAssignmentStatus' = 'unresolved' then
      unresolved_count := unresolved_count + 1;
      continue;
    end if;
    if private.payroll_assignment_is_locked(
      row_value ->> 'payrollOccurrenceKey',
      (row_value ->> 'employeeId')::uuid,
      nullif(row_value ->> 'shiftId', '')::uuid,
      nullif(row_value ->> 'firstClockIn', '')::timestamptz
    ) then
      locked_skipped_count := locked_skipped_count + 1;
      continue;
    end if;

    select * into existing_assignment
    from private.payroll_batch_assignments assignment
    where assignment.occurrence_key = row_value ->> 'payrollOccurrenceKey';

    if existing_assignment.occurrence_key is not null
      and existing_assignment.occurrence_fingerprint = row_value ->> 'payrollOccurrenceFingerprint'
      and existing_assignment.assigned_week_start = (row_value ->> 'payrollBatchWeekStartsOn')::date then
      unchanged_count := unchanged_count + 1;
      continue;
    end if;

    changed_count := changed_count + 1;
    if not target_dry_run and coalesce(existing_assignment.assignment_status, 'derived') <> 'corrected' then
      insert into private.payroll_batch_assignments (
        occurrence_key, occurrence_fingerprint, employee_id, shift_id, assignment_source, assignment_status,
        assignment_anchor, original_week_start, assigned_week_start, policy_version, configuration_version,
        cross_boundary, recalculated_at
      ) values (
        row_value ->> 'payrollOccurrenceKey', row_value ->> 'payrollOccurrenceFingerprint',
        (row_value ->> 'employeeId')::uuid, nullif(row_value ->> 'shiftId', '')::uuid,
        row_value ->> 'payrollAssignmentSource', 'derived', nullif(row_value ->> 'payrollAssignmentAnchor', '')::timestamptz,
        (row_value ->> 'payrollBatchWeekStartsOn')::date, (row_value ->> 'payrollBatchWeekStartsOn')::date,
        rules.payroll_calculation_policy_version, rules.payroll_configuration_version,
        coalesce((row_value ->> 'crossesPayrollBoundary')::boolean, false), clock_timestamp()
      )
      on conflict (occurrence_key) do update set
        occurrence_fingerprint = excluded.occurrence_fingerprint,
        employee_id = excluded.employee_id,
        shift_id = excluded.shift_id,
        assignment_source = excluded.assignment_source,
        assignment_status = excluded.assignment_status,
        assignment_anchor = excluded.assignment_anchor,
        original_week_start = excluded.original_week_start,
        assigned_week_start = excluded.assigned_week_start,
        policy_version = excluded.policy_version,
        configuration_version = excluded.configuration_version,
        cross_boundary = excluded.cross_boundary,
        correction_reason = null,
        corrected_by = null,
        corrected_at = null,
        recalculated_at = excluded.recalculated_at
      where private.payroll_batch_assignments.assignment_status <> 'corrected';

      history_idempotency_key := encode(extensions.digest(convert_to(concat_ws(':',
        'recalculate', row_value ->> 'payrollOccurrenceKey', row_value ->> 'payrollOccurrenceFingerprint',
        row_value ->> 'payrollBatchWeekStartsOn', rules.payroll_calculation_policy_version
      ), 'UTF8'), 'sha256'), 'hex');
      insert into public.payroll_batch_assignment_history (
        occurrence_key, occurrence_fingerprint, employee_id, shift_id, action, original_week_start,
        assigned_week_start, assignment_source, reason, policy_version, configuration_version,
        actor_id, idempotency_key, snapshot
      ) values (
        row_value ->> 'payrollOccurrenceKey', row_value ->> 'payrollOccurrenceFingerprint',
        (row_value ->> 'employeeId')::uuid, nullif(row_value ->> 'shiftId', '')::uuid, 'recalculated',
        nullif(row_value ->> 'payrollBatchWeekStartsOn', '')::date,
        nullif(row_value ->> 'payrollBatchWeekStartsOn', '')::date,
        row_value ->> 'payrollAssignmentSource', 'Open occurrence recalculated under the active payroll-batch policy.',
        rules.payroll_calculation_policy_version, rules.payroll_configuration_version, actor_id,
        history_idempotency_key, row_value
      ) on conflict (idempotency_key) do nothing;
    end if;
  end loop;

  result_payload := jsonb_build_object(
    'dryRun', target_dry_run,
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'rowCount', row_count,
    'changedCount', changed_count,
    'unchangedCount', unchanged_count,
    'unresolvedCount', unresolved_count,
    'lockedSkippedCount', locked_skipped_count,
    'paidMinutes', paid_minutes,
    'regularMinutes', regular_minutes,
    'overtimeMinutes', overtime_minutes,
    'policyVersion', rules.payroll_calculation_policy_version,
    'configurationVersion', rules.payroll_configuration_version,
    'reconciliationPassed', paid_minutes = regular_minutes + overtime_minutes
  );

  insert into private.payroll_batch_recalculation_runs (
    from_date, through_date, dry_run, policy_version, configuration_version, row_count,
    changed_count, unchanged_count, unresolved_count, locked_skipped_count, paid_minutes,
    regular_minutes, overtime_minutes, run_by, result_payload
  ) values (
    target_from_date, target_through_date, target_dry_run, rules.payroll_calculation_policy_version,
    rules.payroll_configuration_version, row_count, changed_count, unchanged_count, unresolved_count,
    locked_skipped_count, paid_minutes, regular_minutes, overtime_minutes, actor_id, result_payload
  ) returning * into run_record;

  return result_payload || jsonb_build_object('runId', run_record.id, 'runAt', run_record.run_at);
end
$$;

alter table private.payroll_export_batches
  add column if not exists payroll_configuration_version integer,
  add column if not exists payroll_calculation_policy_version text,
  add column if not exists payroll_time_zone text,
  add column if not exists cross_boundary_grouping_policy text;

create or replace function private.stamp_payroll_export_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rules private.payroll_rules%rowtype;
begin
  select * into rules from private.payroll_rules where id = true;
  new.payroll_configuration_version := coalesce(new.payroll_configuration_version, rules.payroll_configuration_version);
  new.payroll_calculation_policy_version := coalesce(new.payroll_calculation_policy_version, rules.payroll_calculation_policy_version);
  new.payroll_time_zone := coalesce(new.payroll_time_zone, rules.time_zone);
  new.cross_boundary_grouping_policy := coalesce(new.cross_boundary_grouping_policy, rules.cross_boundary_grouping_policy);
  return new;
end
$$;

drop trigger if exists payroll_export_batches_policy_stamp on private.payroll_export_batches;
create trigger payroll_export_batches_policy_stamp
before insert on private.payroll_export_batches
for each row execute function private.stamp_payroll_export_policy();

do $patch_export_reconciliation_guard$
declare
  function_sql text;
begin
  select pg_get_functiondef('public.create_payroll_export_batch(date, date, text)'::regprocedure)
  into function_sql;
  if function_sql is null then
    raise undefined_function using message = 'The payroll export lock function was not found.';
  end if;
  if position('regularPlusOvertimeMatchesPaid' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      'review_rows := coalesce(review_payload -> ''rows'', ''[]''::jsonb);',
      'review_rows := coalesce(review_payload -> ''rows'', ''[]''::jsonb);
  if not coalesce((review_payload -> ''reconciliation'' ->> ''passed'')::boolean, false)
    or not coalesce((review_payload -> ''reconciliation'' ->> ''regularPlusOvertimeMatchesPaid'')::boolean, false) then
    raise check_violation using message = ''Payroll reconciliation failed. Resolve duplicate, unassigned, or minute-allocation issues before locking.'';
  end if;'
    );
  end if;
  if position('regularPlusOvertimeMatchesPaid' in function_sql) = 0 then
    raise check_violation using message = 'Payroll reconciliation guard could not be applied to the export lock.';
  end if;
  execute function_sql;
end
$patch_export_reconciliation_guard$;

revoke all on function private.payroll_week_bounds(timestamptz, text, integer, time without time zone) from public, anon, authenticated;
revoke all on function private.get_payroll_batch_week(timestamptz) from public, anon, authenticated;
revoke all on function private.allocate_hours_to_overtime_workweek(timestamptz) from public, anon, authenticated;
revoke all on function private.get_payroll_period_for_week(date) from public, anon, authenticated;
revoke all on function private.get_timekeeping_occurrence_key(uuid, uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function private.get_payroll_assignment_anchor(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.payroll_assignment_is_locked(text, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.get_timekeeping_occurrence_context(uuid, uuid, date, timestamptz) from public, anon, authenticated;

revoke all on function public.get_payroll_rules() from public, anon;
revoke all on function public.get_timekeeping_review(date, date) from public, anon;
revoke all on function public.correct_payroll_batch_assignment(text, text, uuid, uuid, timestamptz, date, date, text) from public, anon;
revoke all on function public.recalculate_open_payroll_batch_assignments(date, date, boolean) from public, anon;

grant execute on function public.get_payroll_rules() to authenticated;
grant execute on function public.get_timekeeping_review(date, date) to authenticated;
grant execute on function public.correct_payroll_batch_assignment(text, text, uuid, uuid, timestamptz, date, date, text) to authenticated;
grant execute on function public.recalculate_open_payroll_batch_assignments(date, date, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
