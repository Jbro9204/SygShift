begin;

-- Additive v2 workspace contract for guided PDF completion. The existing
-- document inventory contract remains available to older Workers while the
-- new contract adds only non-contact employment details already visible to HR.
create or replace function public.service_get_hr_document_workspace_v2(
  target_actor_id uuid,
  target_search text default null,
  target_employee_id uuid default null,
  target_vault_code text default null,
  target_include_archived boolean default false,
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  enriched_employees jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  result := public.service_get_hr_document_workspace(
    target_actor_id,
    target_search,
    target_employee_id,
    target_vault_code,
    target_include_archived,
    target_page,
    target_page_size
  );

  select coalesce(jsonb_agg(
    listed.employee_json || jsonb_build_object(
      'jobTitle', employee.job_title,
      'employmentType', employee.employment_type::text,
      'role', employee.role::text,
      'hiredOn', employee.hired_on,
      'locationText', profile.location_text,
      'supervisorLabel', profile.supervisor_label
    )
    order by lower(listed.employee_json ->> 'legalName'), listed.employee_json ->> 'id'
  ), '[]'::jsonb)
  into enriched_employees
  from jsonb_array_elements(coalesce(result -> 'employees', '[]'::jsonb)) listed(employee_json)
  join public.employees employee on employee.id = (listed.employee_json ->> 'id')::uuid
  left join private.employee_operational_profiles profile on profile.employee_id = employee.id;

  return jsonb_set(result, '{employees}', enriched_employees, true);
end
$$;

revoke all on function public.service_get_hr_document_workspace_v2(uuid, text, uuid, text, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function public.service_get_hr_document_workspace_v2(uuid, text, uuid, text, boolean, integer, integer)
  to service_role;

commit;
