begin;

create table if not exists private.recently_deleted_records (
  id uuid primary key default gen_random_uuid(),
  record_type text not null,
  record_id uuid not null,
  display_name text not null,
  metadata jsonb not null default '{}'::jsonb,
  deleted_by uuid references public.employees(id) on delete set null,
  deleted_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '14 days'),
  constraint recently_deleted_records_type_check check (record_type in ('employee', 'site', 'post')),
  constraint recently_deleted_records_display_name_present check (btrim(display_name) <> '')
);

create index if not exists recently_deleted_records_visible_idx
  on private.recently_deleted_records(record_type, expires_at, deleted_at desc);

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked)
values
  ('admin.users.basic', 'Administration', 'Manage basic user details', 'Create employees and edit profile, contact, employment, and non-destructive role details.', 'sensitive', true, true),
  ('admin.users.separate', 'Administration', 'Separate users', 'Mark employees separated and trigger account and future-work cleanup.', 'critical', true, true),
  ('admin.users.delete', 'Administration', 'Delete separated unused users', 'Permanently delete separated employee records only when no operational history exists.', 'critical', true, true)
on conflict (code) do update
set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  locked = excluded.locked,
  active = true,
  updated_at = now();

update public.permission_catalog
set
  name = 'Manage login access',
  description = 'Create and reset login accounts, email login instructions, disable accounts, and revoke remembered devices.',
  risk_level = 'critical',
  requires_mfa = true,
  locked = true,
  active = true,
  updated_at = now()
where code = 'admin.users.manage';

insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, permission.code, true
from public.access_roles access_role
join public.permission_catalog permission on permission.code in (
  'admin.users.basic',
  'admin.users.separate',
  'admin.users.delete'
)
where access_role.code = 'system_admin'
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

create or replace function private.require_any_user_admin_permission(
  required_permissions text[],
  admin_role_required boolean default false
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  has_required_permission boolean;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required for user administration.';
  end if;

  if admin_role_required and not public.is_admin() then
    raise insufficient_privilege using message = 'Admin role is required for this destructive action.';
  end if;

  select exists (
    select 1
    from unnest(required_permissions) required_permission(code)
    where public.has_effective_permission(required_permission.code)
  ) into has_required_permission;

  if not has_required_permission and not public.is_admin() then
    raise insufficient_privilege using message = 'User administration permission is required.';
  end if;

  return actor_id;
end
$$;

create or replace function private.require_user_admin_permission(
  required_permission text,
  admin_role_required boolean default false
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.require_any_user_admin_permission(array[required_permission], admin_role_required)
$$;

create or replace function private.require_sites_manager()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to manage sites and posts.';
  end if;

  if not public.has_effective_permission('sites.manage') and not public.is_admin() then
    raise insufficient_privilege using message = 'Sites and posts management permission is required.';
  end if;

  return actor_id;
end
$$;

create or replace function public.get_overview_metrics_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := private.current_employee_id();
  active_clock_count integer;
  open_shift_count integer;
  pending_request_count integer;
  clock_exception_count integer;
begin
  if viewer_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view dashboard metrics.';
  end if;

  if not (
    public.has_effective_permission('operations.view')
    or public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin')
  ) then
    raise insufficient_privilege using message = 'Operations dashboard permission is required.';
  end if;

  with latest_correction as (
    select distinct on (correction.time_event_id)
      correction.time_event_id,
      correction.replacement_time,
      correction.voided
    from public.time_event_corrections correction
    where correction.approved_at is not null
    order by correction.time_event_id, correction.approved_at desc, correction.id desc
  ),
  latest_event as (
    select distinct on (event.employee_id)
      event.employee_id,
      event.kind,
      coalesce(latest_correction.replacement_time, event.recorded_at) as effective_at
    from public.time_events event
    left join latest_correction on latest_correction.time_event_id = event.id
    where coalesce(latest_correction.voided, false) = false
      and coalesce(latest_correction.replacement_time, event.recorded_at) >= clock_timestamp() - interval '18 hours'
    order by event.employee_id, coalesce(latest_correction.replacement_time, event.recorded_at) desc, event.created_at desc
  )
  select count(*) into active_clock_count
  from latest_event event
  where event.kind in ('clock_in', 'break_start', 'break_end');

  select count(*) into open_shift_count
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  where schedule.status = 'published'
    and shift.is_open
    and shift.ends_at > clock_timestamp()
    and shift.starts_at < clock_timestamp() + interval '14 days';

  select
    (
      select count(*) from public.time_off_requests request where request.status = 'pending'
    )
    + (
      select count(*) from public.shift_requests request
      join public.shifts shift on shift.id = request.shift_id
      where request.status = 'pending'
        and shift.ends_at > clock_timestamp()
    )
    + (
      select count(*) from public.call_off_reports report
      join public.shifts shift on shift.id = report.shift_id
      where report.announcement_id is null
        and report.resolved_at is null
        and shift.ends_at > clock_timestamp()
    )
  into pending_request_count;

  select count(*) into clock_exception_count
  from public.time_event_corrections correction
  where correction.approved_at is null
    and correction.declined_at is null;

  return jsonb_build_object(
    'onDutyNow', active_clock_count,
    'openShifts', open_shift_count,
    'pendingRequests', pending_request_count,
    'clockExceptions', clock_exception_count
  );
end
$$;

create or replace function public.get_sites_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.current_employee_id() is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view sites and posts.';
  end if;

  if not (
    public.has_effective_permission('sites.view')
    or public.has_effective_permission('sites.manage')
    or public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin')
  ) then
    raise insufficient_privilege using message = 'Sites and posts permission is required.';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', site.id,
      'code', site.code,
      'name', site.name,
      'address_line_1', site.address_line_1,
      'city', site.city,
      'region', site.region,
      'postal_code', site.postal_code,
      'time_zone', site.time_zone,
      'active', site.active,
      'posts', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', post.id,
          'name', post.name,
          'requires_armed', post.requires_armed,
          'active', post.active,
          'default_start_time', post.default_start_time,
          'default_end_time', post.default_end_time
        ) order by post.active desc, post.name)
        from public.posts post
        where post.site_id = site.id
      ), '[]'::jsonb)
    ) order by site.active desc, site.name), '[]'::jsonb)
    from public.sites site
  );
end
$$;

create or replace function public.get_recently_deleted_records(target_record_type text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  requested_type text := nullif(btrim(coalesce(target_record_type, '')), '');
begin
  if requested_type is not null and requested_type not in ('employee', 'site', 'post') then
    raise check_violation using message = 'Recently deleted record type is not supported.';
  end if;

  if requested_type in ('site', 'post') then
    perform private.require_sites_manager();
  else
    perform private.require_any_user_admin_permission(
      array['admin.users.view', 'admin.users.basic', 'admin.users.manage', 'admin.users.separate', 'admin.users.delete'],
      false
    );
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', deleted.id,
      'recordType', deleted.record_type,
      'recordId', deleted.record_id,
      'displayName', deleted.display_name,
      'metadata', deleted.metadata,
      'deletedBy', deleted.deleted_by,
      'deletedAt', deleted.deleted_at,
      'expiresAt', deleted.expires_at
    ) order by deleted.deleted_at desc)
    from private.recently_deleted_records deleted
    where deleted.expires_at > clock_timestamp()
      and (requested_type is null or deleted.record_type = requested_type)
  ), '[]'::jsonb);
end
$$;

create or replace function public.get_admin_user_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  records jsonb;
begin
  actor_id := private.require_any_user_admin_permission(
    array['admin.users.view', 'admin.users.basic', 'admin.users.manage', 'admin.users.separate', 'admin.users.delete'],
    false
  );

  select coalesce(jsonb_agg(private.admin_user_record(employee.id) order by employee.last_name, employee.first_name, employee.id), '[]'::jsonb)
  into records
  from public.employees employee;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'currentEmployeeId', actor_id,
    'users', records
  );
end
$$;

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
  actor_id := private.require_any_user_admin_permission(array['admin.users.basic', 'admin.users.manage'], false);

  if target_status = 'separated' then
    actor_id := private.require_user_admin_permission('admin.users.separate');
  end if;

  if target_role = 'admin' and not public.is_admin() then
    raise insufficient_privilege using message = 'Only Admin role users can create another Admin user.';
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
  actor_id := private.require_any_user_admin_permission(array['admin.users.basic', 'admin.users.manage'], false);
  before_record := private.admin_user_record(target_employee_id);

  if before_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if (before_record ->> 'role') = 'admin' or target_role = 'admin' then
    if not public.is_admin() then
      raise insufficient_privilege using message = 'Only Admin role users can create, edit, demote, or separate Admin users.';
    end if;
  end if;

  if target_status = 'separated' or (before_record ->> 'status') = 'separated' then
    actor_id := private.require_user_admin_permission('admin.users.separate');
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

  update public.employees employee
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
      when target_status = 'separated' then coalesce(employee.separated_on, (clock_timestamp() at time zone 'America/Denver')::date)
      when target_status = 'active' then null
      else employee.separated_on
    end,
    updated_at = clock_timestamp()
  where employee.id = target_employee_id;

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
    request_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id',
    'public',
    'employees',
    'UPDATE',
    target_employee_id::text,
    before_record,
    after_record
  );

  return after_record;
end
$$;

create or replace function public.admin_separate_employee(
  target_employee_id uuid,
  separation_reason text default null,
  target_separated_on date default null
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
  separation_result jsonb;
begin
  actor_id := private.require_user_admin_permission('admin.users.separate');
  before_record := private.admin_user_record(target_employee_id);

  if before_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if (before_record ->> 'role') = 'admin' and not public.is_admin() then
    raise insufficient_privilege using message = 'Only Admin role users can separate Admin users.';
  end if;

  separation_result := private.separate_employee_account_and_future_work(
    target_employee_id,
    actor_id,
    separation_reason,
    target_separated_on
  );

  return private.admin_user_record(target_employee_id) || separation_result;
end
$$;

create or replace function public.admin_set_employee_account_state(
  target_employee_id uuid,
  target_disabled boolean
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
  actor_id := private.require_user_admin_permission('admin.users.manage');
  before_record := private.admin_user_record(target_employee_id);

  if before_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if (before_record ->> 'role') = 'admin'
    and target_disabled
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one active admin account must remain.';
  end if;

  if not exists (select 1 from private.employee_accounts account where account.employee_id = target_employee_id) then
    raise check_violation using message = 'A login account has not been created for this employee yet.';
  end if;

  update private.employee_accounts
  set
    disabled_at = case when target_disabled then coalesce(disabled_at, clock_timestamp()) else null end,
    updated_at = clock_timestamp()
  where employee_id = target_employee_id;

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
    'private',
    'employee_accounts',
    case when target_disabled then 'ADMIN_DISABLE' else 'ADMIN_ENABLE' end,
    target_employee_id::text,
    before_record,
    after_record
  );

  return after_record;
end
$$;

create or replace function public.admin_revoke_employee_trusted_devices(target_employee_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  revoked_count integer;
begin
  actor_id := private.require_user_admin_permission('admin.users.manage');

  update private.trusted_devices trusted_device
  set
    revoked_at = clock_timestamp(),
    revoked_by = actor_id
  where trusted_device.employee_id = target_employee_id
    and trusted_device.revoked_at is null
    and trusted_device.expires_at > now();

  get diagnostics revoked_count = row_count;
  return revoked_count;
end
$$;

create or replace function public.admin_delete_separated_employee(target_employee_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  before_record jsonb;
  deleted_record_id uuid;
begin
  actor_id := private.require_user_admin_permission('admin.users.delete', true);
  before_record := private.admin_user_record(target_employee_id);

  if before_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if before_record ->> 'status' <> 'separated' then
    raise check_violation using message = 'Only separated employees can be deleted.';
  end if;

  if before_record ->> 'role' = 'admin' and private.active_admin_account_count() <= 1 then
    raise check_violation using message = 'At least one active admin account must remain.';
  end if;

  if exists (select 1 from public.shift_assignments where employee_id = target_employee_id)
    or exists (select 1 from public.shift_requests where employee_id = target_employee_id)
    or exists (select 1 from public.time_off_requests where employee_id = target_employee_id)
    or exists (select 1 from public.call_off_reports where employee_id = target_employee_id)
    or exists (select 1 from public.time_events where employee_id = target_employee_id)
    or exists (select 1 from public.time_event_corrections where requested_by = target_employee_id or approved_by = target_employee_id or declined_by = target_employee_id)
    or exists (select 1 from public.announcements where created_by = target_employee_id)
    or exists (select 1 from private.audit_events where employee_id = target_employee_id)
  then
    raise check_violation using message = 'This separated employee has operational history and cannot be deleted. Keep the separated record for audit and payroll history.';
  end if;

  insert into private.recently_deleted_records (
    record_type,
    record_id,
    display_name,
    metadata,
    deleted_by
  ) values (
    'employee',
    target_employee_id,
    before_record ->> 'displayName',
    before_record,
    actor_id
  )
  returning id into deleted_record_id;

  delete from private.trusted_devices where employee_id = target_employee_id;
  delete from private.employee_accounts where employee_id = target_employee_id;
  delete from private.employee_contacts where employee_id = target_employee_id;
  delete from public.employee_credentials where employee_id = target_employee_id;
  delete from public.employee_availability where employee_id = target_employee_id;
  delete from public.employee_access_roles where employee_id = target_employee_id;
  delete from public.employee_permission_overrides where employee_id = target_employee_id;
  delete from public.employees where id = target_employee_id;

  return jsonb_build_object(
    'deletedId', deleted_record_id,
    'employeeId', target_employee_id,
    'displayName', before_record ->> 'displayName',
    'expiresAt', (select expires_at from private.recently_deleted_records where id = deleted_record_id)
  );
exception
  when foreign_key_violation then
    raise check_violation using message = 'This separated employee is still referenced by protected system history and cannot be deleted.';
end
$$;

create or replace function public.upsert_site(
  target_site_id uuid default null,
  target_code text default null,
  target_name text default null,
  target_address_line_1 text default null,
  target_city text default null,
  target_region text default null,
  target_postal_code text default null,
  target_time_zone text default 'America/Denver',
  target_active boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  saved_site_id uuid;
begin
  actor_id := private.require_sites_manager();

  if btrim(coalesce(target_name, '')) = '' then
    raise check_violation using message = 'Site name is required.';
  end if;

  if target_site_id is null then
    insert into public.sites (
      code,
      name,
      address_line_1,
      city,
      region,
      postal_code,
      time_zone,
      active
    ) values (
      nullif(upper(btrim(coalesce(target_code, ''))), ''),
      btrim(target_name),
      nullif(btrim(coalesce(target_address_line_1, '')), ''),
      nullif(btrim(coalesce(target_city, '')), ''),
      nullif(upper(btrim(coalesce(target_region, ''))), ''),
      nullif(btrim(coalesce(target_postal_code, '')), ''),
      coalesce(nullif(btrim(coalesce(target_time_zone, '')), ''), 'America/Denver'),
      coalesce(target_active, true)
    )
    returning id into saved_site_id;
  else
    update public.sites site
    set
      code = nullif(upper(btrim(coalesce(target_code, ''))), ''),
      name = btrim(target_name),
      address_line_1 = nullif(btrim(coalesce(target_address_line_1, '')), ''),
      city = nullif(btrim(coalesce(target_city, '')), ''),
      region = nullif(upper(btrim(coalesce(target_region, ''))), ''),
      postal_code = nullif(btrim(coalesce(target_postal_code, '')), ''),
      time_zone = coalesce(nullif(btrim(coalesce(target_time_zone, '')), ''), 'America/Denver'),
      active = coalesce(target_active, true),
      updated_at = clock_timestamp()
    where site.id = target_site_id
    returning site.id into saved_site_id;

    if saved_site_id is null then
      raise no_data_found using message = 'The site record was not found.';
    end if;
  end if;

  insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'sites', case when target_site_id is null then 'INSERT' else 'UPDATE' end, saved_site_id::text, (
    select to_jsonb(site) from public.sites site where site.id = saved_site_id
  ));

  return public.get_sites_payload();
end
$$;

create or replace function public.upsert_post(
  target_post_id uuid default null,
  target_site_id uuid default null,
  target_name text default null,
  target_requires_armed boolean default false,
  target_active boolean default true,
  target_default_start_time time default null,
  target_default_end_time time default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  saved_post_id uuid;
begin
  actor_id := private.require_sites_manager();

  if target_site_id is null then
    raise check_violation using message = 'A site is required for this post.';
  end if;

  if btrim(coalesce(target_name, '')) = '' then
    raise check_violation using message = 'Post name is required.';
  end if;

  if target_default_start_time is not null
    and target_default_end_time is not null
    and target_default_start_time = target_default_end_time
  then
    raise check_violation using message = 'Default start and end times cannot match.';
  end if;

  if target_post_id is null then
    insert into public.posts (
      site_id,
      name,
      requires_armed,
      active,
      default_start_time,
      default_end_time
    ) values (
      target_site_id,
      btrim(target_name),
      coalesce(target_requires_armed, false),
      coalesce(target_active, true),
      target_default_start_time,
      target_default_end_time
    )
    returning id into saved_post_id;
  else
    update public.posts post
    set
      site_id = target_site_id,
      name = btrim(target_name),
      requires_armed = coalesce(target_requires_armed, false),
      active = coalesce(target_active, true),
      default_start_time = target_default_start_time,
      default_end_time = target_default_end_time,
      updated_at = clock_timestamp()
    where post.id = target_post_id
    returning post.id into saved_post_id;

    if saved_post_id is null then
      raise no_data_found using message = 'The post record was not found.';
    end if;
  end if;

  insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'posts', case when target_post_id is null then 'INSERT' else 'UPDATE' end, saved_post_id::text, (
    select to_jsonb(post) from public.posts post where post.id = saved_post_id
  ));

  return public.get_sites_payload();
end
$$;

create or replace function public.delete_unused_post(target_post_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  post_record jsonb;
begin
  actor_id := private.require_sites_manager();

  select jsonb_build_object(
    'id', post.id,
    'siteId', post.site_id,
    'siteName', site.name,
    'name', post.name,
    'requiresArmed', post.requires_armed,
    'active', post.active,
    'defaultStartTime', post.default_start_time,
    'defaultEndTime', post.default_end_time
  )
  into post_record
  from public.posts post
  join public.sites site on site.id = post.site_id
  where post.id = target_post_id;

  if post_record is null then
    raise no_data_found using message = 'The post record was not found.';
  end if;

  if exists (select 1 from public.shifts shift where shift.post_id = target_post_id)
    or exists (select 1 from public.credential_requirements requirement where requirement.post_id = target_post_id)
  then
    raise check_violation using message = 'This post has schedule or credential history and cannot be deleted. Deactivate it instead.';
  end if;

  insert into private.recently_deleted_records (record_type, record_id, display_name, metadata, deleted_by)
  values ('post', target_post_id, concat(post_record ->> 'siteName', ' / ', post_record ->> 'name'), post_record, actor_id);

  delete from public.posts where id = target_post_id;
  return public.get_sites_payload();
exception
  when foreign_key_violation then
    raise check_violation using message = 'This post is still referenced by protected system history and cannot be deleted.';
end
$$;

create or replace function public.delete_unused_site(target_site_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  site_record jsonb;
begin
  actor_id := private.require_sites_manager();

  select jsonb_build_object(
    'id', site.id,
    'code', site.code,
    'name', site.name,
    'addressLine1', site.address_line_1,
    'city', site.city,
    'region', site.region,
    'postalCode', site.postal_code,
    'timeZone', site.time_zone,
    'active', site.active,
    'posts', coalesce((
      select jsonb_agg(to_jsonb(post) order by post.name)
      from public.posts post
      where post.site_id = site.id
    ), '[]'::jsonb)
  )
  into site_record
  from public.sites site
  where site.id = target_site_id;

  if site_record is null then
    raise no_data_found using message = 'The site record was not found.';
  end if;

  if exists (
    select 1
    from public.posts post
    join public.shifts shift on shift.post_id = post.id
    where post.site_id = target_site_id
  )
    or exists (select 1 from public.events event where event.site_id = target_site_id)
    or exists (select 1 from public.credential_requirements requirement where requirement.site_id = target_site_id)
  then
    raise check_violation using message = 'This site has schedule, event, or credential history and cannot be deleted. Deactivate it instead.';
  end if;

  insert into private.recently_deleted_records (record_type, record_id, display_name, metadata, deleted_by)
  values ('site', target_site_id, site_record ->> 'name', site_record, actor_id);

  delete from private.site_secrets where site_id = target_site_id;
  delete from public.posts where site_id = target_site_id;
  delete from public.sites where id = target_site_id;
  return public.get_sites_payload();
exception
  when foreign_key_violation then
    raise check_violation using message = 'This site is still referenced by protected system history and cannot be deleted.';
end
$$;

revoke all on table private.recently_deleted_records from public, anon, authenticated;
revoke all on function private.require_any_user_admin_permission(text[], boolean) from public, anon, authenticated;
revoke all on function private.require_user_admin_permission(text, boolean) from public, anon, authenticated;
revoke all on function private.require_sites_manager() from public, anon, authenticated;

revoke all on function public.get_overview_metrics_payload() from public, anon;
revoke all on function public.get_sites_payload() from public, anon;
revoke all on function public.get_recently_deleted_records(text) from public, anon;
revoke all on function public.admin_create_employee(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) from public, anon;
revoke all on function public.admin_update_employee(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) from public, anon;
revoke all on function public.admin_separate_employee(uuid, text, date) from public, anon;
revoke all on function public.admin_set_employee_account_state(uuid, boolean) from public, anon;
revoke all on function public.admin_revoke_employee_trusted_devices(uuid) from public, anon;
revoke all on function public.admin_delete_separated_employee(uuid) from public, anon;
revoke all on function public.upsert_site(uuid, text, text, text, text, text, text, text, boolean) from public, anon;
revoke all on function public.upsert_post(uuid, uuid, text, boolean, boolean, time, time) from public, anon;
revoke all on function public.delete_unused_post(uuid) from public, anon;
revoke all on function public.delete_unused_site(uuid) from public, anon;

grant execute on function public.get_overview_metrics_payload() to authenticated;
grant execute on function public.get_sites_payload() to authenticated;
grant execute on function public.get_recently_deleted_records(text) to authenticated;
grant execute on function public.admin_create_employee(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) to authenticated;
grant execute on function public.admin_update_employee(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) to authenticated;
grant execute on function public.admin_separate_employee(uuid, text, date) to authenticated;
grant execute on function public.admin_set_employee_account_state(uuid, boolean) to authenticated;
grant execute on function public.admin_revoke_employee_trusted_devices(uuid) to authenticated;
grant execute on function public.admin_delete_separated_employee(uuid) to authenticated;
grant execute on function public.upsert_site(uuid, text, text, text, text, text, text, text, boolean) to authenticated;
grant execute on function public.upsert_post(uuid, uuid, text, boolean, boolean, time, time) to authenticated;
grant execute on function public.delete_unused_post(uuid) to authenticated;
grant execute on function public.delete_unused_site(uuid) to authenticated;

commit;
