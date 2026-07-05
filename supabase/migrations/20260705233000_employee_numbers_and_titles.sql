set search_path = '';

alter table public.employees
  add column if not exists job_title text;

alter table public.employees
  drop constraint if exists employees_job_title_length;

alter table public.employees
  add constraint employees_job_title_length
  check (job_title is null or (btrim(job_title) <> '' and char_length(job_title) <= 140));

alter table public.employees
  drop constraint if exists employees_employee_number_format;

alter table public.employees
  add constraint employees_employee_number_format
  check (employee_number is null or employee_number ~ '^SYG-[0-9]{4,}$');

create sequence if not exists public.employee_number_sequence
  as integer
  start with 1001
  increment by 1
  minvalue 1001
  no cycle;

create or replace function private.next_employee_number()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  candidate text;
begin
  loop
    candidate := 'SYG-' || nextval('public.employee_number_sequence')::text;
    exit when not exists (
      select 1
      from public.employees employee
      where employee.employee_number = candidate
    );
  end loop;

  return candidate;
end
$$;

create or replace function private.assign_employee_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(btrim(coalesce(new.employee_number, '')), '') is null then
    new.employee_number := private.next_employee_number();
  else
    new.employee_number := upper(btrim(new.employee_number));
  end if;

  if new.employee_number !~ '^SYG-[0-9]{4,}$' then
    raise check_violation using message = 'Employee ID must follow the SYG-1001 format.';
  end if;

  new.job_title := nullif(btrim(coalesce(new.job_title, '')), '');
  return new;
end
$$;

drop trigger if exists employees_assign_employee_number on public.employees;

create trigger employees_assign_employee_number
before insert or update of employee_number, job_title on public.employees
for each row execute function private.assign_employee_number();

with ordered_employees as (
  select
    employee.id,
    'SYG-' || (1000 + row_number() over (order by employee.created_at, employee.last_name, employee.first_name, employee.id))::text as generated_employee_number
  from public.employees employee
  where nullif(btrim(coalesce(employee.employee_number, '')), '') is null
)
update public.employees employee
set employee_number = ordered_employees.generated_employee_number
from ordered_employees
where employee.id = ordered_employees.id;

select setval(
  'public.employee_number_sequence',
  greatest(
    1001,
    coalesce((
      select max(substring(employee.employee_number from '^SYG-([0-9]+)$')::integer)
      from public.employees employee
      where employee.employee_number ~ '^SYG-[0-9]+$'
    ), 1000)
  ),
  true
);

update public.employees
set
  job_title = 'Chief Systems and Automation Officer',
  role = 'admin',
  employment_type = 'salary',
  status = 'active'
where lower(username) = 'jbrown'
  or (lower(first_name) = 'jordan' and lower(last_name) = 'brown');

update public.employees
set
  job_title = 'Owner',
  role = 'admin',
  employment_type = 'salary',
  status = 'active'
where lower(first_name) = 'michelle'
  and lower(last_name) = 'hood';

create or replace function private.admin_user_record(target_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', employee.id,
    'employeeNumber', employee.employee_number,
    'jobTitle', employee.job_title,
    'username', employee.username,
    'firstName', employee.first_name,
    'middleName', employee.middle_name,
    'lastName', employee.last_name,
    'preferredName', employee.preferred_name,
    'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'role', employee.role,
    'employmentType', employee.employment_type,
    'status', employee.status,
    'photoPath', employee.photo_path,
    'hiredOn', employee.hired_on,
    'separatedOn', employee.separated_on,
    'personalEmail', contact.personal_email,
    'companyEmail', contact.company_email,
    'mobilePhone', contact.mobile_phone,
    'account', case when account.employee_id is null then null else jsonb_build_object(
      'authUserId', account.auth_user_id,
      'invitedAt', account.invited_at,
      'activatedAt', account.activated_at,
      'disabledAt', account.disabled_at,
      'lastSignInAt', account.last_sign_in_at,
      'mustChangePassword', account.must_change_password,
      'passwordChangedAt', account.password_changed_at,
      'mfaEnrolledAt', account.mfa_enrolled_at,
      'isBootstrapAdmin', account.is_bootstrap_admin,
      'status', case when account.disabled_at is not null then 'disabled' else 'active' end
    ) end,
    'accountStatus', case
      when account.employee_id is null then 'not_created'
      when account.disabled_at is not null then 'disabled'
      else 'active'
    end,
    'credentials', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', credential.id,
        'kind', credential.kind,
        'status', credential.status,
        'credentialNumber', credential.credential_number,
        'validFrom', credential.valid_from,
        'expiresOn', credential.expires_on,
        'notes', credential.notes
      ) order by credential.kind, credential.expires_on nulls last)
      from public.employee_credentials credential
      where credential.employee_id = employee.id
    ), '[]'::jsonb)
  )
  from public.employees employee
  left join private.employee_contacts contact on contact.employee_id = employee.id
  left join private.employee_accounts account on account.employee_id = employee.id
  where employee.id = target_employee_id
$$;

drop function if exists public.admin_create_employee(
  text,
  text,
  text,
  text,
  public.app_role,
  public.employment_type,
  public.employee_status,
  text,
  text,
  text,
  text
);

create or replace function public.admin_create_employee(
  target_first_name text,
  target_middle_name text default null,
  target_last_name text default null,
  target_preferred_name text default null,
  target_role public.app_role default 'guard',
  target_employment_type public.employment_type default 'hourly',
  target_status public.employee_status default 'active',
  target_employee_number text default null,
  target_job_title text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  employee_id uuid;
begin
  actor_id := private.require_admin_mfa();

  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;

  if target_personal_email is not null
    and btrim(target_personal_email) <> ''
    and btrim(target_personal_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The personal email address is invalid.';
  end if;

  if target_company_email is not null
    and btrim(target_company_email) <> ''
    and btrim(target_company_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The company email address is invalid.';
  end if;

  insert into public.employees (
    employee_number,
    job_title,
    first_name,
    middle_name,
    last_name,
    preferred_name,
    role,
    employment_type,
    status
  ) values (
    nullif(upper(btrim(coalesce(target_employee_number, ''))), ''),
    nullif(btrim(coalesce(target_job_title, '')), ''),
    btrim(target_first_name),
    nullif(btrim(coalesce(target_middle_name, '')), ''),
    btrim(target_last_name),
    nullif(btrim(coalesce(target_preferred_name, '')), ''),
    target_role,
    target_employment_type,
    target_status
  )
  returning id into employee_id;

  if coalesce(target_personal_email, target_company_email, target_mobile_phone) is not null then
    insert into private.employee_contacts (
      employee_id,
      personal_email,
      company_email,
      mobile_phone
    ) values (
      employee_id,
      nullif(lower(btrim(coalesce(target_personal_email, ''))), ''),
      nullif(lower(btrim(coalesce(target_company_email, ''))), ''),
      nullif(btrim(coalesce(target_mobile_phone, '')), '')
    );
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employees',
    'ADMIN_CREATE',
    employee_id::text,
    private.admin_user_record(employee_id)
  );

  return private.admin_user_record(employee_id);
end
$$;

drop function if exists public.admin_update_employee(
  uuid,
  text,
  text,
  text,
  text,
  public.app_role,
  public.employment_type,
  public.employee_status,
  text,
  text,
  text,
  text
);

create or replace function public.admin_update_employee(
  target_employee_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_preferred_name text,
  target_role public.app_role,
  target_employment_type public.employment_type,
  target_status public.employee_status,
  target_employee_number text default null,
  target_job_title text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  before_record jsonb;
  after_record jsonb;
begin
  actor_id := private.require_admin_mfa();
  before_record := private.admin_user_record(target_employee_id);

  if before_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;

  if target_personal_email is not null
    and btrim(target_personal_email) <> ''
    and btrim(target_personal_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The personal email address is invalid.';
  end if;

  if target_company_email is not null
    and btrim(target_company_email) <> ''
    and btrim(target_company_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The company email address is invalid.';
  end if;

  if (before_record ->> 'role') = 'admin'
    and (
      target_role <> 'admin'
      or target_status <> 'active'
    )
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one active admin account must remain.';
  end if;

  update public.employees
  set
    employee_number = nullif(upper(btrim(coalesce(target_employee_number, ''))), ''),
    job_title = nullif(btrim(coalesce(target_job_title, '')), ''),
    first_name = btrim(target_first_name),
    middle_name = nullif(btrim(coalesce(target_middle_name, '')), ''),
    last_name = btrim(target_last_name),
    preferred_name = nullif(btrim(coalesce(target_preferred_name, '')), ''),
    role = target_role,
    employment_type = target_employment_type,
    status = target_status
  where id = target_employee_id;

  insert into private.employee_contacts (
    employee_id,
    personal_email,
    company_email,
    mobile_phone
  ) values (
    target_employee_id,
    nullif(lower(btrim(coalesce(target_personal_email, ''))), ''),
    nullif(lower(btrim(coalesce(target_company_email, ''))), ''),
    nullif(btrim(coalesce(target_mobile_phone, '')), '')
  )
  on conflict (employee_id) do update set
    personal_email = excluded.personal_email,
    company_email = excluded.company_email,
    mobile_phone = excluded.mobile_phone,
    updated_at = clock_timestamp();

  after_record := private.admin_user_record(target_employee_id);

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employees',
    'ADMIN_UPDATE',
    target_employee_id::text,
    before_record,
    after_record
  );

  return after_record;
end
$$;

drop function if exists public.get_employee_directory();

create function public.get_employee_directory()
returns table (
  id uuid,
  employee_number text,
  job_title text,
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
  credentials jsonb,
  operational_profile jsonb
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
    employee.job_title,
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
            'credential_number', credential.credential_number,
            'valid_from', credential.valid_from,
            'expires_on', credential.expires_on,
            'notes', credential.notes
          )
          order by credential.kind, credential.expires_on nulls last
        )
        from public.employee_credentials credential
        where credential.employee_id = employee.id
      ),
      '[]'::jsonb
    ),
    case when profile.employee_id is null then null else jsonb_build_object(
      'sourceDisplayName', profile.source_display_name,
      'locationText', profile.location_text,
      'scheduleAvailability', profile.schedule_availability,
      'employeeDg', profile.employee_dg,
      'expectedHoursText', profile.expected_hours_text,
      'sourceNotes', profile.source_notes,
      'supervisorLabel', profile.supervisor_label,
      'armedSourceClaim', profile.armed_source_claim
    ) end
  from public.employees employee
  left join private.employee_contacts contact on contact.employee_id = employee.id
  left join private.employee_operational_profiles profile on profile.employee_id = employee.id
  order by employee.last_name, employee.first_name, employee.id;
end
$$;

create or replace function public.service_get_employee_auth_target(
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  account_record private.employee_accounts%rowtype;
begin
  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id;

  if employee_record.id is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if employee_record.status <> 'active' then
    raise check_violation using message = 'Only active employees can receive login accounts.';
  end if;

  select * into account_record
  from private.employee_accounts account
  where account.employee_id = employee_record.id;

  return jsonb_build_object(
    'employeeId', employee_record.id,
    'employeeNumber', employee_record.employee_number,
    'jobTitle', employee_record.job_title,
    'username', employee_record.username,
    'authEmail', employee_record.username || '@accounts.sygshift.invalid',
    'displayName', btrim(coalesce(employee_record.preferred_name, employee_record.first_name) || ' ' || employee_record.last_name),
    'role', employee_record.role,
    'employmentType', employee_record.employment_type,
    'status', employee_record.status,
    'existingAuthUserId', account_record.auth_user_id
  );
end
$$;

create or replace function public.service_get_employee_auth_targets(
  target_include_existing boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'employeeId', employee.id,
      'employeeNumber', employee.employee_number,
      'jobTitle', employee.job_title,
      'username', employee.username,
      'authEmail', employee.username || '@accounts.sygshift.invalid',
      'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
      'role', employee.role,
      'employmentType', employee.employment_type,
      'status', employee.status,
      'existingAuthUserId', account.auth_user_id
    ) order by employee.last_name, employee.first_name)
    from public.employees employee
    left join private.employee_accounts account on account.employee_id = employee.id
    where employee.status = 'active'
      and (target_include_existing or account.employee_id is null)
  ), '[]'::jsonb);
end
$$;

revoke all on sequence public.employee_number_sequence from public, anon, authenticated;
grant usage, select on sequence public.employee_number_sequence to service_role;

revoke all on function private.next_employee_number() from public, anon, authenticated;
revoke all on function private.assign_employee_number() from public, anon, authenticated;
revoke all on function private.admin_user_record(uuid) from public, anon, authenticated;

revoke all on function public.admin_create_employee(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) from public, anon;
revoke all on function public.admin_update_employee(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) from public, anon;
revoke all on function public.get_employee_directory() from public, anon;
revoke all on function public.service_get_employee_auth_target(uuid) from public, anon, authenticated;
revoke all on function public.service_get_employee_auth_targets(boolean) from public, anon, authenticated;

grant execute on function public.admin_create_employee(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) to authenticated;
grant execute on function public.admin_update_employee(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) to authenticated;
grant execute on function public.get_employee_directory() to authenticated;
grant execute on function public.service_get_employee_auth_target(uuid) to service_role;
grant execute on function public.service_get_employee_auth_targets(boolean) to service_role;
