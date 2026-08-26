create or replace function private.legalize_timekeeping_employee_array(source_array jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      case
        when employee.id is null then item.value
        else item.value || jsonb_build_object(
          'employeeName',
          btrim(concat_ws(
            ' ',
            employee.first_name,
            nullif(btrim(coalesce(employee.middle_name, '')), ''),
            employee.last_name
          ))
        )
      end
      order by item.ordinality
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(
    case when jsonb_typeof(source_array) = 'array' then source_array else '[]'::jsonb end
  ) with ordinality as item(value, ordinality)
  left join public.employees employee
    on employee.id::text = item.value ->> 'employeeId'
$$;

revoke all on function private.legalize_timekeeping_employee_array(jsonb) from public, anon, authenticated;

alter function public.get_timekeeping_review(date, date) set schema private;
alter function private.get_timekeeping_review(date, date)
  rename to get_timekeeping_review_preferred_name_boundary_base;

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
begin
  payload := private.get_timekeeping_review_preferred_name_boundary_base(
    target_from_date,
    target_through_date
  );

  payload := jsonb_set(
    payload,
    '{rows}',
    private.legalize_timekeeping_employee_array(payload -> 'rows'),
    true
  );
  payload := jsonb_set(
    payload,
    '{pendingCorrections}',
    private.legalize_timekeeping_employee_array(payload -> 'pendingCorrections'),
    true
  );
  payload := jsonb_set(
    payload,
    '{exceptionResolutionHistory}',
    private.legalize_timekeeping_employee_array(payload -> 'exceptionResolutionHistory'),
    true
  );

  return payload;
end
$$;

revoke all on function private.get_timekeeping_review_preferred_name_boundary_base(date, date) from public, anon, authenticated;
revoke all on function public.get_timekeeping_review(date, date) from public, anon;
grant execute on function public.get_timekeeping_review(date, date) to authenticated;

comment on function public.get_timekeeping_review(date, date) is
  'Returns payroll and timekeeping review data with legal employee names. Preferred names remain schedule-facing only.';
