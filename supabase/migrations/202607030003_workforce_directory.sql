begin;

create function public.get_employee_directory()
returns table (
  id uuid,
  employee_number text,
  username text,
  first_name text,
  middle_name text,
  last_name text,
  preferred_name text,
  role public.app_role,
  employment_type public.employment_type,
  status public.employee_status,
  photo_path text,
  hired_on date,
  personal_email text,
  company_email text,
  mobile_phone text,
  credentials jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege
      using message = 'Supervisor or administrator access with MFA is required.';
  end if;

  return query
  select
    employee.id,
    employee.employee_number,
    employee.username,
    employee.first_name,
    employee.middle_name,
    employee.last_name,
    employee.preferred_name,
    employee.role,
    employee.employment_type,
    employee.status,
    employee.photo_path,
    employee.hired_on,
    contact.personal_email,
    contact.company_email,
    contact.mobile_phone,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'kind', credential.kind,
            'status', credential.status,
            'expires_on', credential.expires_on
          )
          order by credential.kind, credential.expires_on nulls last
        )
        from public.employee_credentials credential
        where credential.employee_id = employee.id
      ),
      '[]'::jsonb
    ) as credentials
  from public.employees employee
  left join private.employee_contacts contact on contact.employee_id = employee.id
  order by employee.last_name, employee.first_name, employee.id;
end
$$;

revoke all on function public.get_employee_directory() from public, anon;
grant execute on function public.get_employee_directory() to authenticated;

commit;
