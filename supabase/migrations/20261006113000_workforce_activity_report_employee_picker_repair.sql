begin;

-- Keep the report's grouped vacancy source stable when public.shifts gains a
-- new column. The live definition includes the later call-off canonicalization
-- repair, so patch just this unsafe projection instead of reverting that work.
do $workforce_activity_explicit_shift_fields$
declare
  definition text;
  prior_pattern text := 'select[[:space:]]+shift[.][*][[:space:]]*,[[:space:]]+schedule[.]week_starts_on[[:space:]]*,[[:space:]]+schedule[.]revision[[:space:]]+from[[:space:]]+public[.]shifts[[:space:]]+shift';
  match_count integer;
  replacement text := 'select
    shift.id,
    shift.schedule_id,
    shift.post_id,
    shift.event_id,
    shift.starts_at,
    shift.ends_at,
    shift.time_zone,
    shift.headcount_required,
    shift.requires_armed,
    shift.is_open,
    shift.is_overtime,
    shift.notes,
    shift.created_by,
    shift.created_at,
    shift.updated_at,
    shift.canceled_at,
    shift.canceled_by,
    shift.cancellation_reason,
    shift.work_type,
    shift.time_zone_source,
    shift.time_zone_employee_id,
    shift.assignment_type,
    shift.coverage_source_shift_id,
    schedule.week_starts_on,
    schedule.revision
  from public.shifts shift';
begin
  select pg_catalog.pg_get_functiondef(
    'private.get_workforce_activity_report_rows(date,date)'::pg_catalog.regprocedure
  ) into definition;
  select count(*)::integer
  into match_count
  from pg_catalog.regexp_matches(definition, prior_pattern, 'g');

  if definition is null or match_count <> 1 then
    raise exception 'The Workforce Activity shift projection changed; this repair requires review.';
  end if;

  execute pg_catalog.regexp_replace(definition, prior_pattern, replacement);
end
$workforce_activity_explicit_shift_fields$;

revoke all on function private.get_workforce_activity_report_rows(date, date)
  from public, anon, authenticated;

-- Report users need an independent roster: the daily "Who Worked" result is
-- intentionally allowed to be empty for a selected employee. This returns
-- only the minimum identifier needed to target the already-protected report.
create or replace function public.get_workforce_activity_report_employee_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.timekeeping_require_permission('time.reports.view');

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', employee.id,
        'label', btrim(concat_ws(
          ' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name
        )),
        'employeeNumber', employee.employee_number
      )
      order by
        lower(btrim(concat_ws(
          ' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name
        )),
        employee.employee_number nulls last,
        employee.id
    )
    from public.employees employee
    where employee.status::text in ('active', 'leave', 'inactive', 'separated')
  ), '[]'::jsonb);
end
$$;

revoke all on function public.get_workforce_activity_report_employee_options()
  from public, anon, authenticated;
grant execute on function public.get_workforce_activity_report_employee_options()
  to authenticated;

notify pgrst, 'reload schema';

commit;
