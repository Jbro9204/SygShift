alter table private.employee_accounts
  add column if not exists disabled_by uuid references public.employees(id) on delete restrict,
  add column if not exists disabled_reason text;

create table if not exists private.employee_separation_events (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  separated_by uuid not null references public.employees(id) on delete restrict,
  separated_at timestamptz not null default clock_timestamp(),
  access_disabled_at timestamptz not null,
  reason text,
  previous_status public.employee_status,
  previous_account_disabled_at timestamptz,
  future_assignments_released integer not null default 0,
  pending_shift_requests_canceled integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists employee_separation_events_employee_idx
  on private.employee_separation_events(employee_id, separated_at desc);

revoke all on table private.employee_separation_events from public, anon, authenticated;

create or replace function private.separate_employee_account_and_future_work(
  target_employee_id uuid,
  actor_id uuid,
  separation_reason text default null,
  separated_on date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  account_record private.employee_accounts%rowtype;
  clean_reason text := nullif(btrim(coalesce(separation_reason, '')), '');
  disabled_time timestamptz := clock_timestamp();
  released_count integer := 0;
  request_count integer := 0;
begin
  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if employee_record.id is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  select * into account_record
  from private.employee_accounts account
  where account.employee_id = target_employee_id
  for update;

  if employee_record.role = 'admin'
    and employee_record.status = 'active'
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one active admin account must remain.';
  end if;

  update public.employees
  set
    status = 'separated',
    separated_on = coalesce(separated_on, (disabled_time at time zone 'America/Denver')::date),
    updated_at = disabled_time
  where id = target_employee_id;

  update private.employee_accounts
  set
    disabled_at = coalesce(disabled_at, disabled_time),
    disabled_by = actor_id,
    disabled_reason = coalesce(clean_reason, 'Employee separated in SygShift.'),
    updated_at = disabled_time
  where employee_id = target_employee_id;

  update private.trusted_devices trusted_device
  set
    revoked_at = disabled_time,
    revoked_by = actor_id
  where trusted_device.employee_id = target_employee_id
    and trusted_device.revoked_at is null;

  update public.shift_assignments assignment
  set
    status = 'canceled',
    canceled_at = disabled_time,
    cancellation_reason = coalesce(clean_reason, 'Employee separated from SygShift.'),
    updated_at = disabled_time
  from public.shifts shift
  where assignment.shift_id = shift.id
    and assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed')
    and shift.canceled_at is null
    and (shift.starts_at at time zone shift.time_zone)::date >= (disabled_time at time zone 'America/Denver')::date;

  get diagnostics released_count = row_count;

  update public.shifts shift
  set
    is_open = true,
    updated_at = disabled_time
  where shift.canceled_at is null
    and (shift.starts_at at time zone shift.time_zone)::date >= (disabled_time at time zone 'America/Denver')::date
    and exists (
      select 1
      from public.shift_assignments assignment
      where assignment.shift_id = shift.id
        and assignment.employee_id = target_employee_id
        and assignment.canceled_at = disabled_time
    )
    and (
      select count(*)
      from public.shift_assignments active_assignment
      where active_assignment.shift_id = shift.id
        and active_assignment.status in ('assigned', 'confirmed', 'completed')
    ) < shift.headcount_required;

  update public.shift_requests request
  set
    status = 'canceled',
    decision_note = coalesce(clean_reason, 'Employee separated from SygShift.'),
    decided_by = actor_id,
    decided_at = disabled_time,
    updated_at = disabled_time
  from public.shifts shift
  where request.shift_id = shift.id
    and request.employee_id = target_employee_id
    and request.status = 'pending'
    and (shift.starts_at at time zone shift.time_zone)::date >= (disabled_time at time zone 'America/Denver')::date;

  get diagnostics request_count = row_count;

  insert into private.employee_separation_events (
    employee_id,
    separated_by,
    separated_at,
    access_disabled_at,
    reason,
    previous_status,
    previous_account_disabled_at,
    future_assignments_released,
    pending_shift_requests_canceled
  ) values (
    target_employee_id,
    actor_id,
    disabled_time,
    disabled_time,
    clean_reason,
    employee_record.status,
    account_record.disabled_at,
    released_count,
    request_count
  );

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
    'SEPARATE_EMPLOYEE',
    target_employee_id::text,
    to_jsonb(employee_record),
    jsonb_build_object(
      'employeeId', target_employee_id,
      'status', 'separated',
      'separatedAt', disabled_time,
      'accessDisabledAt', disabled_time,
      'futureAssignmentsReleased', released_count,
      'pendingShiftRequestsCanceled', request_count,
      'reason', clean_reason
    )
  );

  return jsonb_build_object(
    'employeeId', target_employee_id,
    'accessDisabledAt', disabled_time,
    'futureAssignmentsReleased', released_count,
    'pendingShiftRequestsCanceled', request_count
  );
end
$$;

create or replace function public.admin_separate_employee(
  target_employee_id uuid,
  separation_reason text default null,
  separated_on date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  separation_result jsonb;
begin
  actor_id := private.require_admin_mfa();
  separation_result := private.separate_employee_account_and_future_work(
    target_employee_id,
    actor_id,
    separation_reason,
    separated_on
  );

  return private.admin_user_record(target_employee_id) || separation_result;
end
$$;

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
    status = target_status,
    separated_on = case
      when target_status = 'separated' then coalesce(separated_on, (clock_timestamp() at time zone 'America/Denver')::date)
      when target_status = 'active' then null
      else separated_on
    end,
    updated_at = clock_timestamp()
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

  if target_status = 'separated' then
    perform private.separate_employee_account_and_future_work(
      target_employee_id,
      actor_id,
      'Employee marked separated from Users & Access.',
      null
    );
  end if;

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
  where employee.status in ('active', 'leave')
  order by employee.last_name, employee.first_name, employee.id;
end
$$;

revoke all on function public.admin_separate_employee(uuid, text, date) from public, anon;
grant execute on function public.admin_separate_employee(uuid, text, date) to authenticated;
grant execute on function public.admin_update_employee(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) to authenticated;
grant execute on function public.get_employee_directory() to authenticated;
