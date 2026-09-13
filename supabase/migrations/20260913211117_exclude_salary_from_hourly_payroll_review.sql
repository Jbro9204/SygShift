alter function public.get_timekeeping_review(date, date) set schema private;
alter function private.get_timekeeping_review(date, date)
  rename to get_timekeeping_review_salary_payroll_boundary_base;

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
  filtered_rows jsonb;
  filtered_pending_corrections jsonb;
  row_count integer;
  ready_count integer;
  exception_count integer;
  gross_minutes integer;
  paid_minutes integer;
  regular_minutes integer;
  overtime_minutes integer;
  time_off_minutes integer;
  salary_default_minutes integer;
  unique_occurrences integer;
  unresolved_assignments integer;
  reconciliation_passed boolean;
begin
  payload := private.get_timekeeping_review_salary_payroll_boundary_base(
    target_from_date,
    target_through_date
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into filtered_rows
  from jsonb_array_elements(coalesce(payload -> 'rows', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  where coalesce(item.value ->> 'employmentType', '') <> 'salary'
     or item.value ->> 'rowKind' = 'salary_default';

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  into filtered_pending_corrections
  from jsonb_array_elements(coalesce(payload -> 'pendingCorrections', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  left join public.employees employee
    on employee.id::text = item.value ->> 'employeeId'
  where employee.id is null
     or employee.employment_type <> 'salary';

  select
    count(*)::integer,
    count(*) filter (where coalesce((row_item.value ->> 'payrollReady')::boolean, false))::integer,
    count(*) filter (where not coalesce((row_item.value ->> 'payrollReady')::boolean, false))::integer,
    coalesce(sum((row_item.value ->> 'grossMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'paidMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'regularMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'overtimeMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'timeOffMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'salaryDefaultMinutes')::integer), 0)::integer,
    count(distinct nullif(row_item.value ->> 'payrollOccurrenceKey', ''))::integer,
    count(*) filter (where row_item.value ->> 'payrollAssignmentStatus' = 'unresolved')::integer
  into
    row_count,
    ready_count,
    exception_count,
    gross_minutes,
    paid_minutes,
    regular_minutes,
    overtime_minutes,
    time_off_minutes,
    salary_default_minutes,
    unique_occurrences,
    unresolved_assignments
  from jsonb_array_elements(filtered_rows) as row_item(value);

  reconciliation_passed := paid_minutes = regular_minutes + overtime_minutes
    and row_count = unique_occurrences
    and unresolved_assignments = 0;

  return payload || jsonb_build_object(
    'rows', filtered_rows,
    'pendingCorrections', filtered_pending_corrections,
    'summary', coalesce(payload -> 'summary', '{}'::jsonb) || jsonb_build_object(
      'rowCount', row_count,
      'readyCount', ready_count,
      'exceptionCount', exception_count,
      'pendingCorrectionCount', jsonb_array_length(filtered_pending_corrections),
      'grossMinutes', gross_minutes,
      'paidMinutes', paid_minutes,
      'regularMinutes', regular_minutes,
      'overtimeMinutes', overtime_minutes,
      'timeOffMinutes', time_off_minutes,
      'salaryDefaultMinutes', salary_default_minutes
    ),
    'reconciliation', coalesce(payload -> 'reconciliation', '{}'::jsonb) || jsonb_build_object(
      'passed', reconciliation_passed,
      'paidMinutes', paid_minutes,
      'regularMinutes', regular_minutes,
      'overtimeMinutes', overtime_minutes,
      'regularPlusOvertimeMatchesPaid', paid_minutes = regular_minutes + overtime_minutes,
      'rowCount', row_count,
      'uniqueOccurrenceCount', unique_occurrences,
      'duplicateOccurrenceCount', greatest(0, row_count - unique_occurrences),
      'unresolvedAssignmentCount', unresolved_assignments
    )
  );
end
$$;

revoke all on function private.get_timekeeping_review_salary_payroll_boundary_base(date, date) from public, anon, authenticated;
revoke all on function public.get_timekeeping_review(date, date) from public, anon;
grant execute on function public.get_timekeeping_review(date, date) to authenticated;

comment on function public.get_timekeeping_review(date, date) is
  'Returns legal-name timekeeping review data while retaining salary defaults and excluding salaried punch activity from hourly payroll totals, overtime, corrections, and blockers.';
