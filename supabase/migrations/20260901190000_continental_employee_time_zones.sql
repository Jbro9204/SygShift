begin;

create temporary table remote_time_zone_release_baseline on commit drop as
select
  (select count(*) from public.shifts) as shift_count,
  (
    select md5(coalesce(string_agg(concat_ws(':', shift.id::text, shift.schedule_id::text, coalesce(shift.post_id::text, ''), coalesce(shift.event_id::text, ''), shift.starts_at::text, shift.ends_at::text, shift.time_zone, shift.headcount_required::text, shift.requires_armed::text, shift.is_open::text, shift.is_overtime::text), '|' order by shift.id), ''))
    from public.shifts shift
  ) as shift_fingerprint,
  (select count(*) from public.time_events) as time_event_count,
  (
    select md5(coalesce(string_agg(concat_ws(':', event.id::text, event.employee_id::text, coalesce(event.shift_id::text, ''), event.kind::text, event.recorded_at::text, coalesce(event.client_recorded_at::text, ''), event.source::text, event.idempotency_key), '|' order by event.id), ''))
    from public.time_events event
  ) as time_event_fingerprint;

alter table public.employees
  add column if not exists time_zone text not null default 'America/Denver';

alter table public.employees
  drop constraint if exists employees_continental_us_time_zone;

alter table public.employees
  add constraint employees_continental_us_time_zone check (
    time_zone in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles')
  );

-- Zach's already-corrected 09/01 assignment remains the same absolute instant.
-- Only his profile/display zone changes, so 07:00 Mountain presents as 08:00 Central.
update public.employees employee
set time_zone = 'America/Chicago',
    updated_at = clock_timestamp()
where employee.username = 'zward'
  and employee.time_zone is distinct from 'America/Chicago';

insert into private.audit_events (
  schema_name,
  table_name,
  operation,
  row_id,
  new_record
)
select
  'public',
  'employees',
  'TIME_ZONE_RELEASE',
  employee.id::text,
  jsonb_build_object(
    'username', employee.username,
    'timeZone', employee.time_zone,
    'existingShiftsChanged', false,
    'existingTimeEventsChanged', false
  )
from public.employees employee
where employee.username = 'zward';

alter table public.shifts
  add column if not exists time_zone_source text not null default 'site',
  add column if not exists time_zone_employee_id uuid references public.employees(id) on delete restrict;

alter table public.shifts
  drop constraint if exists shifts_time_zone_source_check,
  drop constraint if exists shifts_time_zone_employee_source_check;

alter table public.shifts
  add constraint shifts_time_zone_source_check check (time_zone_source in ('site', 'employee', 'explicit')),
  add constraint shifts_time_zone_employee_source_check check (
    (time_zone_source = 'employee' and time_zone_employee_id is not null)
    or (time_zone_source <> 'employee' and time_zone_employee_id is null)
  );

create or replace function private.set_shift_security_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inherited_requires_armed boolean;
  inherited_time_zone text;
  employee_time_zone text;
  source_changed boolean := false;
begin
  if new.post_id is not null then
    select post.requires_armed, site.time_zone
      into inherited_requires_armed, inherited_time_zone
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = new.post_id;
  else
    select event.requires_armed, event.time_zone
      into inherited_requires_armed, inherited_time_zone
    from public.events event
    where event.id = new.event_id;
  end if;

  if inherited_time_zone is null then
    raise check_violation using message = 'The selected Site/Post or event could not be found.';
  end if;

  if tg_op = 'UPDATE' then
    source_changed := new.post_id is distinct from old.post_id
      or new.event_id is distinct from old.event_id;
  end if;

  if new.time_zone_source = 'employee' then
    select employee.time_zone
      into employee_time_zone
    from public.employees employee
    where employee.id = new.time_zone_employee_id;

    if employee_time_zone is null then
      raise check_violation using message = 'The employee time zone could not be found.';
    end if;

    new.time_zone := employee_time_zone;
  elsif new.time_zone_source = 'explicit' then
    new.time_zone_employee_id := null;
    if new.time_zone is null or not exists (
      select 1 from pg_catalog.pg_timezone_names zone where zone.name = new.time_zone
    ) then
      raise check_violation using message = 'Choose a valid IANA time zone.';
    end if;
  elsif tg_op = 'INSERT'
    and new.time_zone is not null
    and new.time_zone is distinct from inherited_time_zone
  then
    -- Copy/revision workflows already carry the authoritative shift time zone.
    -- Preserve it rather than silently converting an employee-local occurrence.
    new.time_zone_source := 'explicit';
    new.time_zone_employee_id := null;
  else
    new.time_zone_source := 'site';
    new.time_zone_employee_id := null;
    new.time_zone := inherited_time_zone;
  end if;

  if new.requires_armed is null
    or (source_changed and new.requires_armed is not distinct from old.requires_armed)
  then
    new.requires_armed := inherited_requires_armed;
  end if;

  return new;
end
$$;

drop trigger if exists shifts_set_security_fields on public.shifts;
create trigger shifts_set_security_fields
before insert or update of post_id, event_id, requires_armed, time_zone_source, time_zone_employee_id on public.shifts
for each row execute function private.set_shift_security_fields();

revoke all on function private.set_shift_security_fields() from public, anon, authenticated;

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
    'timeZone', employee.time_zone,
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
      'activatedAt', coalesce(account.activated_at, auth_user.last_sign_in_at),
      'disabledAt', account.disabled_at,
      'lastSignInAt', coalesce(auth_user.last_sign_in_at, account.last_sign_in_at),
      'mustChangePassword', account.must_change_password,
      'passwordChangedAt', account.password_changed_at,
      'mfaEnrolledAt', account.mfa_enrolled_at,
      'isBootstrapAdmin', account.is_bootstrap_admin,
      'status', case when account.disabled_at is not null then 'disabled' else 'active' end,
      'trustedDeviceCount', (
        select count(*)::integer
        from private.trusted_devices trusted_device
        where trusted_device.employee_id = employee.id
          and trusted_device.revoked_at is null
          and trusted_device.expires_at > now()
      )
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
  left join auth.users auth_user on auth_user.id = account.auth_user_id
  where employee.id = target_employee_id
$$;

revoke all on function private.admin_user_record(uuid) from public, anon, authenticated;

create or replace function public.admin_set_employee_time_zone(
  target_employee_id uuid,
  target_time_zone text
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
  actor_id := private.require_any_user_admin_permission(array['admin.users.basic', 'admin.users.manage'], false);

  if target_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles') then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, or Pacific Time.';
  end if;

  before_record := private.admin_user_record(target_employee_id);
  if before_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  update public.employees employee
  set time_zone = target_time_zone,
      updated_at = clock_timestamp()
  where employee.id = target_employee_id;

  after_record := private.admin_user_record(target_employee_id);

  if before_record ->> 'timeZone' is distinct from after_record ->> 'timeZone' then
    insert into private.audit_events (
      auth_user_id, employee_id, request_id, schema_name, table_name,
      operation, row_id, old_record, new_record
    ) values (
      (select auth.uid()), actor_id,
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id',
      'public', 'employees', 'UPDATE_TIME_ZONE', target_employee_id::text,
      jsonb_build_object('timeZone', before_record ->> 'timeZone'),
      jsonb_build_object('timeZone', after_record ->> 'timeZone')
    );
  end if;

  return after_record;
end
$$;

revoke all on function public.admin_set_employee_time_zone(uuid, text) from public, anon;
grant execute on function public.admin_set_employee_time_zone(uuid, text) to authenticated;

create or replace function public.admin_create_employee_with_time_zone(
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
  target_mobile_phone text default null,
  target_time_zone text default 'America/Denver'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  created_record jsonb;
begin
  created_record := public.admin_create_employee(
    target_first_name,
    target_middle_name,
    target_last_name,
    target_preferred_name,
    target_role,
    target_employment_type,
    target_status,
    target_employee_number,
    target_job_title,
    target_personal_email,
    target_company_email,
    target_mobile_phone
  );

  return public.admin_set_employee_time_zone((created_record ->> 'id')::uuid, target_time_zone);
end
$$;

create or replace function public.admin_update_employee_with_time_zone(
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
  target_mobile_phone text default null,
  target_time_zone text default 'America/Denver'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.admin_update_employee(
    target_employee_id,
    target_first_name,
    target_middle_name,
    target_last_name,
    target_preferred_name,
    target_role,
    target_employment_type,
    target_status,
    target_employee_number,
    target_job_title,
    target_personal_email,
    target_company_email,
    target_mobile_phone
  );

  return public.admin_set_employee_time_zone(target_employee_id, target_time_zone);
end
$$;

revoke all on function public.admin_create_employee_with_time_zone(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text) from public, anon;
revoke all on function public.admin_update_employee_with_time_zone(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text) from public, anon;
grant execute on function public.admin_create_employee_with_time_zone(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text) to authenticated;
grant execute on function public.admin_update_employee_with_time_zone(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text) to authenticated;

drop function if exists public.get_session_context();

create function public.get_session_context()
returns table (
  employee_id uuid,
  username text,
  display_name text,
  role public.app_role,
  must_change_password boolean,
  password_changed_at timestamptz,
  mfa_enrolled_at timestamptz,
  mfa_required boolean,
  has_mfa boolean,
  permissions text[],
  time_zone text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise insufficient_privilege using message = 'A signed-in SygShift account is required.';
  end if;

  return query
  select
    employee.id,
    employee.username,
    coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
    employee.role,
    account.must_change_password,
    account.password_changed_at,
    account.mfa_enrolled_at,
    (
      employee.role in ('dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
      or exists (
        select 1
        from public.access_roles access_role
        join public.employee_access_roles assignment on assignment.role_id = access_role.id
        where assignment.employee_id = employee.id
          and access_role.mfa_required
          and access_role.active
      )
      or exists (
        select 1
        from public.employee_permission_overrides override
        join public.permission_catalog catalog on catalog.code = override.permission_code
        where override.employee_id = employee.id
          and override.active
          and override.effect = 'grant'
          and catalog.requires_mfa
          and catalog.active
      )
    ),
    public.has_mfa(),
    public.get_effective_permissions(),
    employee.time_zone
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.auth_user_id = (select auth.uid())
    and account.disabled_at is null
    and employee.status = 'active'
  limit 1;
end
$$;

revoke all on function public.get_session_context() from public, anon;
grant execute on function public.get_session_context() to authenticated;

create or replace function public.get_schedule_builder_options()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'posts',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', post.id,
        'name', post.name,
        'requires_armed', post.requires_armed,
        'site', jsonb_build_object(
          'id', site.id,
          'code', site.code,
          'name', site.name,
          'time_zone', site.time_zone
        )
      ) order by site.name, post.name)
      from public.posts post
      join public.sites site on site.id = post.site_id
      where post.active and site.active
    ), '[]'::jsonb),
    'employees',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'first_name', employee.first_name,
        'last_name', employee.last_name,
        'preferred_name', employee.preferred_name,
        'employee_number', employee.employee_number,
        'role', employee.role,
        'employment_type', employee.employment_type,
        'time_zone', employee.time_zone,
        'has_armed_guard_credential', public.has_valid_credential(employee.id, 'armed_guard', current_date)
      ) order by employee.last_name, employee.first_name, employee.id)
      from public.employees employee
      where employee.status = 'active'
        and employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
    ), '[]'::jsonb)
  )
  where private.can_manage_schedule_drafts()
    or public.has_effective_permission('scheduler.view')
$$;

revoke all on function public.get_schedule_builder_options() from public, anon;
grant execute on function public.get_schedule_builder_options() to authenticated;

alter function public.get_timekeeping_dashboard(date) rename to get_timekeeping_dashboard_site_time;

revoke all on function public.get_timekeeping_dashboard_site_time(date) from public, anon, authenticated;

create function public.get_timekeeping_dashboard(target_operational_date date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_time_zone text;
  payload jsonb;
begin
  select employee.time_zone into viewer_time_zone
  from public.employees employee
  where employee.id = viewer_employee_id;

  if viewer_time_zone is null then
    raise insufficient_privilege using message = 'An active employee account is required for timekeeping.';
  end if;

  payload := public.get_timekeeping_dashboard_site_time(
    coalesce(target_operational_date, (clock_timestamp() at time zone viewer_time_zone)::date)
  );

  return jsonb_set(
    payload,
    '{employee,timeZone}',
    to_jsonb(viewer_time_zone),
    true
  );
end
$$;

revoke all on function public.get_timekeeping_dashboard(date) from public, anon;
grant execute on function public.get_timekeeping_dashboard(date) to authenticated;

create or replace function public.scheduler_create_employee_local_coverage_plan(
  target_week_starts_on date,
  target_post_id uuid,
  event_name text,
  event_location_name text,
  event_site_id uuid,
  event_time_zone text,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_armed_headcount integer,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  publish_announcement boolean default false,
  target_employee_id uuid default null,
  target_assignment_requires_armed boolean default false,
  target_availability_override_note text default null,
  target_credential_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  employee_time_zone text;
  source_time_zone text;
  localized_starts_at timestamptz;
  localized_ends_at timestamptz;
  source_operational_date date;
  source_start_time time;
  source_end_time time;
  result jsonb;
  created_shift_ids uuid[];
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create employee-local coverage.';
  end if;

  if target_employee_id is null then
    raise check_violation using message = 'Choose an employee before using employee-local time.';
  end if;

  if target_headcount <> 1 or target_armed_headcount not in (0, 1) then
    raise check_violation using message = 'Employee-local time is limited to a one-person assigned shift. Multi-person coverage remains in the Site/Post time zone.';
  end if;

  select employee.time_zone into employee_time_zone
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status = 'active';

  if employee_time_zone is null then
    raise check_violation using message = 'The selected active employee does not have a supported time zone.';
  end if;

  if target_post_id is not null then
    select site.time_zone into source_time_zone
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active;
  else
    source_time_zone := coalesce(nullif(btrim(event_time_zone), ''), 'America/Denver');
  end if;

  if source_time_zone is null then
    raise check_violation using message = 'The selected Site/Post or event time zone could not be found.';
  end if;

  localized_starts_at := (shift_operational_date + shift_start_time) at time zone employee_time_zone;
  localized_ends_at := (
    (shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time
  ) at time zone employee_time_zone;

  source_operational_date := (localized_starts_at at time zone source_time_zone)::date;
  source_start_time := (localized_starts_at at time zone source_time_zone)::time;
  source_end_time := (localized_ends_at at time zone source_time_zone)::time;

  result := public.scheduler_create_coverage_plan(
    target_week_starts_on,
    target_post_id,
    event_name,
    event_location_name,
    event_site_id,
    source_time_zone,
    source_operational_date,
    source_start_time,
    source_end_time,
    target_headcount,
    target_armed_headcount,
    target_is_overtime,
    target_notes,
    target_work_type,
    false,
    target_employee_id,
    target_assignment_requires_armed,
    target_availability_override_note,
    target_credential_override_note
  );

  select array_agg(value::uuid) into created_shift_ids
  from jsonb_array_elements_text(result -> 'shift_ids') value;

  update public.shifts shift
  set time_zone_source = 'employee',
      time_zone_employee_id = target_employee_id,
      updated_at = clock_timestamp()
  where shift.id = any(created_shift_ids);

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    (select auth.uid()), actor_id, 'public', 'shifts', 'CREATE_EMPLOYEE_LOCAL_COVERAGE',
    result ->> 'schedule_id',
    jsonb_build_object(
      'shiftIds', to_jsonb(created_shift_ids),
      'assignedEmployeeId', target_employee_id,
      'employeeTimeZone', employee_time_zone,
      'enteredDate', shift_operational_date,
      'enteredStartTime', shift_start_time,
      'enteredEndTime', shift_end_time,
      'startsAt', localized_starts_at,
      'endsAt', localized_ends_at,
      'existingRecordsChanged', false
    )
  );

  return jsonb_set(result, '{time_zone}', to_jsonb(employee_time_zone), true);
end
$$;

revoke all on function public.scheduler_create_employee_local_coverage_plan(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text) from public, anon;
grant execute on function public.scheduler_create_employee_local_coverage_plan(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text) to authenticated;

comment on function public.scheduler_create_employee_local_coverage_plan(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text) is
  'Creates a one-person assigned shift from the employee local wall-clock time while keeping secure UTC timestamps and the Site/Post work location.';

do $$
declare
  baseline remote_time_zone_release_baseline%rowtype;
  current_shift_count bigint;
  current_shift_fingerprint text;
  current_time_event_count bigint;
  current_time_event_fingerprint text;
begin
  select * into strict baseline from remote_time_zone_release_baseline;

  select count(*), md5(coalesce(string_agg(concat_ws(':', shift.id::text, shift.schedule_id::text, coalesce(shift.post_id::text, ''), coalesce(shift.event_id::text, ''), shift.starts_at::text, shift.ends_at::text, shift.time_zone, shift.headcount_required::text, shift.requires_armed::text, shift.is_open::text, shift.is_overtime::text), '|' order by shift.id), ''))
    into current_shift_count, current_shift_fingerprint
  from public.shifts shift;

  select count(*), md5(coalesce(string_agg(concat_ws(':', event.id::text, event.employee_id::text, coalesce(event.shift_id::text, ''), event.kind::text, event.recorded_at::text, coalesce(event.client_recorded_at::text, ''), event.source::text, event.idempotency_key), '|' order by event.id), ''))
    into current_time_event_count, current_time_event_fingerprint
  from public.time_events event;

  if current_shift_count <> baseline.shift_count
    or current_shift_fingerprint <> baseline.shift_fingerprint
    or current_time_event_count <> baseline.time_event_count
    or current_time_event_fingerprint <> baseline.time_event_fingerprint
  then
    raise exception 'Continental time-zone release changed existing shift or time-event records; the migration was rolled back.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
