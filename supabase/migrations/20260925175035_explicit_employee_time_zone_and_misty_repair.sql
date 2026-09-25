begin;
set local lock_timeout = '5s';

-- Keep the legacy column default only for bootstrap service workflows and the
-- already-completed, hard-locked Colorado legacy import defined below. Every
-- authenticated interactive employee-creation path in this release requires a
-- supported zone at its audited RPC boundary.

alter table public.employees
  drop constraint if exists employees_continental_us_time_zone;

alter table public.employees
  add constraint employees_continental_us_time_zone check (
    time_zone in (
      'America/New_York', 'America/Chicago', 'America/Denver',
      'America/Phoenix', 'America/Los_Angeles'
    )
  );

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

  if target_time_zone is null
    or target_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles')
  then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
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
  target_time_zone text default null
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
  if target_time_zone is null
    or target_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles')
  then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
  end if;

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
  target_time_zone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_time_zone is null
    or target_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles')
  then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
  end if;

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

create or replace function public.admin_create_employee_with_time_zone_and_access_roles(
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
  target_time_zone text default null,
  target_access_role_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  created_record jsonb;
begin
  if target_time_zone is null
    or target_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles')
  then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
  end if;

  created_record := public.admin_create_employee_with_time_zone(
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
    target_mobile_phone,
    target_time_zone
  );

  perform private.replace_employee_additional_access_roles(
    actor_id,
    (created_record ->> 'id')::uuid,
    target_access_role_ids
  );

  return private.admin_user_record((created_record ->> 'id')::uuid);
end
$$;

create or replace function public.admin_update_employee_with_time_zone_and_access_roles(
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
  target_time_zone text default null,
  target_access_role_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
begin
  if target_time_zone is null
    or target_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles')
  then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
  end if;

  perform public.admin_update_employee_with_time_zone(
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
    target_mobile_phone,
    target_time_zone
  );

  perform private.replace_employee_additional_access_roles(
    actor_id,
    target_employee_id,
    target_access_role_ids
  );

  return private.admin_user_record(target_employee_id);
end
$$;

revoke all on function public.admin_set_employee_time_zone(uuid, text) from public, anon;
revoke all on function public.admin_create_employee_with_time_zone(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text) from public, anon;
revoke all on function public.admin_update_employee_with_time_zone(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text) from public, anon;
revoke all on function public.admin_create_employee_with_time_zone_and_access_roles(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text, uuid[]) from public, anon;
revoke all on function public.admin_update_employee_with_time_zone_and_access_roles(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text, uuid[]) from public, anon;
grant execute on function public.admin_set_employee_time_zone(uuid, text) to authenticated;
grant execute on function public.admin_create_employee_with_time_zone(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text) to authenticated;
grant execute on function public.admin_update_employee_with_time_zone(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text) to authenticated;
grant execute on function public.admin_create_employee_with_time_zone_and_access_roles(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text, uuid[]) to authenticated;
grant execute on function public.admin_update_employee_with_time_zone_and_access_roles(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text, uuid[]) to authenticated;

-- The time-zone wrapper remains SECURITY DEFINER and can call this legacy base
-- routine as its owner. Authenticated clients may not bypass the explicit-zone
-- contract by invoking the base routine directly.
revoke execute on function public.admin_create_employee(
  text, text, text, text, public.app_role, public.employment_type,
  public.employee_status, text, text, text, text, text
) from authenticated;

-- Authenticated application code uses audited SECURITY DEFINER routines for
-- employee mutations. No supported browser/Worker path performs direct table
-- DML, so remove the grant that could otherwise bypass explicit-zone validation
-- and audit logging while preserving SELECT and service-owned workflows.
revoke insert, update, delete on table public.employees from authenticated;

create or replace function private.generate_username(
  target_first_name text,
  target_last_name text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  base_username text;
  candidate text;
  suffix integer := 2;
begin
  base_username := regexp_replace(
    lower(left(target_first_name, 1) || target_last_name),
    '[^a-z0-9]', '', 'g'
  );
  if base_username !~ '^[a-z][a-z0-9]*$' then
    raise check_violation using message = 'A username cannot be generated from the supplied name.';
  end if;

  perform pg_advisory_xact_lock(hashtext(base_username));
  candidate := base_username;
  while exists (
    select 1 from private.username_registry registry where registry.username = candidate
  ) loop
    candidate := base_username || suffix::text;
    suffix := suffix + 1;
  end loop;
  return candidate;
end
$$;

revoke all on function private.generate_username(text, text) from public, anon, authenticated;

create or replace function public.upsert_licensing_employee(
  target_employee_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_preferred_name text,
  target_job_title text,
  target_employment_type public.employment_type,
  target_status public.employee_status,
  target_personal_email text,
  target_company_email text,
  target_mobile_phone text,
  target_role public.app_role,
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
  actor_role public.app_role := public.current_app_role();
  employee_id uuid := target_employee_id;
  existing_role public.app_role;
  persisted_time_zone text;
begin
  actor_id := private.require_licensing_mfa('licensing.manage');

  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;

  if employee_id is null then
    if target_time_zone is null
      or target_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles')
    then
      raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
    end if;

    if actor_role <> 'admin' then
      target_role := 'guard';
    end if;
  elsif target_time_zone is not null then
    raise check_violation using message = 'Use User Accounts to change an existing employee time zone.';
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

  if employee_id is null then
    insert into public.employees (
      username,
      first_name,
      middle_name,
      last_name,
      preferred_name,
      role,
      employment_type,
      status,
      job_title,
      time_zone
    ) values (
      private.generate_username(target_first_name, target_last_name),
      btrim(target_first_name),
      nullif(btrim(coalesce(target_middle_name, '')), ''),
      btrim(target_last_name),
      nullif(btrim(coalesce(target_preferred_name, '')), ''),
      target_role,
      target_employment_type,
      target_status,
      nullif(btrim(coalesce(target_job_title, '')), ''),
      target_time_zone
    )
    returning id, time_zone into employee_id, persisted_time_zone;

    insert into private.employee_contacts (
      employee_id,
      personal_email,
      company_email,
      mobile_phone
    ) values (
      employee_id,
      nullif(btrim(coalesce(target_personal_email, '')), ''),
      nullif(btrim(coalesce(target_company_email, '')), ''),
      nullif(btrim(coalesce(target_mobile_phone, '')), '')
    );
  else
    select employee.role, employee.time_zone
    into existing_role, persisted_time_zone
    from public.employees employee
    where employee.id = employee_id;

    if existing_role is null then
      raise no_data_found using message = 'Employee was not found.';
    end if;

    if actor_role <> 'admin' then
      target_role := existing_role;
    end if;

    update public.employees
    set
      first_name = btrim(target_first_name),
      middle_name = nullif(btrim(coalesce(target_middle_name, '')), ''),
      last_name = btrim(target_last_name),
      preferred_name = nullif(btrim(coalesce(target_preferred_name, '')), ''),
      role = target_role,
      employment_type = target_employment_type,
      status = target_status,
      job_title = nullif(btrim(coalesce(target_job_title, '')), ''),
      updated_at = now()
    where id = employee_id;

    insert into private.employee_contacts (
      employee_id,
      personal_email,
      company_email,
      mobile_phone
    ) values (
      employee_id,
      nullif(btrim(coalesce(target_personal_email, '')), ''),
      nullif(btrim(coalesce(target_company_email, '')), ''),
      nullif(btrim(coalesce(target_mobile_phone, '')), '')
    )
    on conflict on constraint employee_contacts_pkey do update
    set
      personal_email = excluded.personal_email,
      company_email = excluded.company_email,
      mobile_phone = excluded.mobile_phone,
      updated_at = now();
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
    case when target_employee_id is null then 'LICENSING_EMPLOYEE_CREATE' else 'LICENSING_EMPLOYEE_UPDATE' end,
    employee_id::text,
    jsonb_build_object(
      'employeeId', employee_id,
      'firstName', btrim(target_first_name),
      'lastName', btrim(target_last_name),
      'role', target_role,
      'employmentType', target_employment_type,
      'employmentStatus', target_status,
      'timeZone', persisted_time_zone
    )
  );

  return public.get_licensing_center();
end
$$;

-- Keep the deployed 12-argument edit contract during a rolling release. It is
-- update-only: old clients can still save existing profiles, but cannot create a
-- new employee without refreshing into the explicit-zone form.
create or replace function public.upsert_licensing_employee(
  target_employee_id uuid default null,
  target_first_name text default null,
  target_middle_name text default null,
  target_last_name text default null,
  target_preferred_name text default null,
  target_job_title text default null,
  target_employment_type public.employment_type default 'hourly',
  target_status public.employee_status default 'onboarding',
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null,
  target_role public.app_role default 'guard'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_licensing_mfa('licensing.manage');

  if target_employee_id is null then
    raise check_violation using message = 'Refresh this page and choose the employee time zone before creating the employee.';
  end if;

  return public.upsert_licensing_employee(
    target_employee_id,
    target_first_name,
    target_middle_name,
    target_last_name,
    target_preferred_name,
    target_job_title,
    target_employment_type,
    target_status,
    target_personal_email,
    target_company_email,
    target_mobile_phone,
    target_role,
    null
  );
end
$$;

revoke all on function public.upsert_licensing_employee(
  uuid, text, text, text, text, text, public.employment_type,
  public.employee_status, text, text, text, public.app_role, text
) from public, anon;
revoke all on function public.upsert_licensing_employee(
  uuid, text, text, text, text, text, public.employment_type,
  public.employee_status, text, text, text, public.app_role
) from public, anon;
grant execute on function public.upsert_licensing_employee(
  uuid, text, text, text, text, text, public.employment_type,
  public.employee_status, text, text, text, public.app_role, text
) to authenticated;
grant execute on function public.upsert_licensing_employee(
  uuid, text, text, text, text, text, public.employment_type,
  public.employee_status, text, text, text, public.app_role
) to authenticated;

-- The only promoted operational workbook is a completed Colorado/Mountain
-- legacy import. Preserve its history and exact conversion behavior, but remove
-- the generic authenticated employee-creation surface. A fresh import run,
-- different source, or different date scope cannot reuse this wrapper.
alter function public.promote_import_scope(uuid, date, date, boolean, text)
  set schema private;
alter function private.promote_import_scope(uuid, date, date, boolean, text)
  rename to promote_legacy_colorado_import_scope;

revoke all on function private.promote_legacy_colorado_import_scope(uuid, date, date, boolean, text)
  from public, anon, authenticated;

create function public.promote_import_scope(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date,
  target_publish boolean,
  target_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  source_sha256 text;
  promotion_result jsonb;
  promotion_batch_id uuid;
begin
  perform private.require_import_admin();
  actor_id := private.current_employee_id();

  if target_import_run_id <> '68d8dc39-d46b-4306-b82d-e10f3dd0c554'::uuid
    or target_from_date <> date '2026-06-28'
    or target_through_date <> date '2026-08-15'
  then
    raise check_violation using message = 'Operational import is locked to the completed Colorado legacy source and date scope.';
  end if;

  select source.sha256
  into source_sha256
  from private.import_runs import_run
  join private.source_files source on source.id = import_run.source_file_id
  where import_run.id = target_import_run_id;

  if source_sha256 is distinct from '5746f5e6c97a88e267cbb0feb5c6def0ad2a444ecc810d2adcbd997f1c356dc0' then
    raise check_violation using message = 'Operational import source identity did not match the completed Colorado legacy workbook.';
  end if;

  promotion_result := private.promote_legacy_colorado_import_scope(
    target_import_run_id,
    target_from_date,
    target_through_date,
    target_publish,
    target_note
  );
  promotion_batch_id := (promotion_result ->> 'promotionBatchId')::uuid;

  update public.employees employee
  set time_zone = 'America/Denver',
      updated_at = clock_timestamp()
  where exists (
    select 1
    from private.import_entity_links link
    where link.promotion_batch_id = promotion_batch_id
      and link.entity_table = 'employees'
      and link.entity_id = employee.id
  )
    and employee.time_zone <> 'America/Denver';

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    (select auth.uid()), actor_id, 'private', 'import_promotion_batches',
    'LEGACY_COLORADO_IMPORT_PROMOTION', promotion_batch_id::text,
    jsonb_build_object(
      'importRunId', target_import_run_id,
      'sourceSha256', source_sha256,
      'fromDate', target_from_date,
      'throughDate', target_through_date,
      'employeeTimeZone', 'America/Denver',
      'replayAllowed', false
    )
  );

  return promotion_result || jsonb_build_object(
    'employeeTimeZone', 'America/Denver',
    'legacyImportLocked', true
  );
end
$$;

revoke all on function public.promote_import_scope(uuid, date, date, boolean, text)
  from public, anon;
grant execute on function public.promote_import_scope(uuid, date, date, boolean, text)
  to authenticated;

insert into private.audit_events (
  auth_user_id, employee_id, request_id, schema_name, table_name,
  operation, row_id, new_record
)
select
  null, null, 'migration:20260925175035', 'private', 'import_runs',
  'LEGACY_COLORADO_IMPORT_CONTRACT_LOCK', import_run.id::text,
  jsonb_build_object(
    'importRunId', import_run.id,
    'sourceSha256', source.sha256,
    'fromDate', date '2026-06-28',
    'throughDate', date '2026-08-15',
    'employeeTimeZone', 'America/Denver',
    'authenticatedReplayBlocked', true
  )
from private.import_runs import_run
join private.source_files source on source.id = import_run.source_file_id
where import_run.id = '68d8dc39-d46b-4306-b82d-e10f3dd0c554'::uuid
  and source.sha256 = '5746f5e6c97a88e267cbb0feb5c6def0ad2a444ecc810d2adcbd997f1c356dc0'
  and exists (
    select 1
    from private.import_promotion_batches batch
    where batch.import_run_id = import_run.id
      and batch.from_date = date '2026-06-28'
      and batch.through_date = date '2026-08-15'
  )
  and not exists (
    select 1
    from private.audit_events audit
    where audit.operation = 'LEGACY_COLORADO_IMPORT_CONTRACT_LOCK'
      and audit.row_id = import_run.id::text
      and audit.request_id = 'migration:20260925175035'
  );

alter table private.hr_onboarding_profiles
  drop constraint if exists hr_onboarding_profile_state;

alter table private.hr_onboarding_profiles
  add constraint hr_onboarding_profile_state check (work_state in ('CO','CA','AZ','NC'));

create or replace function private.hr_onboarding_ensure_nc_withholding_step(
  target_template_id uuid,
  target_template_version integer,
  target_actor_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_template_id is null or target_template_version is null or target_actor_id is null then
    raise check_violation using message = 'The North Carolina onboarding requirement needs a template, version, and actor.';
  end if;

  insert into private.hr_onboarding_template_steps (
    template_id, template_version, step_code, title, description, task_type,
    responsible_group, required, due_offset_days, source_requirement,
    sort_order, created_by
  ) values (
    target_template_id, target_template_version, 'nc_withholding',
    'North Carolina withholding election',
    'Complete the current North Carolina withholding requirement.',
    'document', 'hr', true, -1,
    '{"states":["NC"],"documentRequired":true,"documentCategory":"nc_withholding","nonWaivable":true}'::jsonb,
    40, target_actor_id
  )
  on conflict (template_id, template_version, step_code) do nothing;
end
$$;

revoke all on function private.hr_onboarding_ensure_nc_withholding_step(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function private.hr_onboarding_ensure_nc_withholding_step(uuid,integer,uuid) to service_role;

-- Bring the current standard version forward now. The calls inside both launch
-- functions below also cover a newly created standard template idempotently.
select private.hr_onboarding_ensure_nc_withholding_step(
  template.id,
  template.current_version,
  coalesce(template.approved_by, template.created_by)
)
from private.hr_onboarding_templates template
where template.name = 'Guardianship Standard Onboarding'
  and template.status = 'active';

create or replace function public.service_hr_onboarding_create_prehire(
  target_actor_id uuid,
  target_payload jsonb,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  created_employee_id uuid := gen_random_uuid();
  created_person_id uuid;
  created_worker_id uuid;
  selected_legal_entity_id uuid;
  selected_template_id uuid;
  selected_template_version integer;
  created_case_id uuid;
  first_name text := btrim(coalesce(target_payload->>'firstName',''));
  middle_name text := nullif(btrim(coalesce(target_payload->>'middleName','')),'');
  last_name text := btrim(coalesce(target_payload->>'lastName',''));
  personal_email_value text := lower(btrim(coalesce(target_payload->>'personalEmail','')));
  mobile_phone text := nullif(btrim(coalesce(target_payload->>'mobilePhone','')),'');
  position_title text := btrim(coalesce(target_payload->>'positionTitle',''));
  work_state text := upper(btrim(coalesce(target_payload->>'workState','')));
  employee_time_zone text := btrim(coalesce(target_payload->>'timeZone',''));
  role_value text := btrim(coalesce(target_payload->>'role','guard'));
  employment_type_value text := btrim(coalesce(target_payload->>'employmentType','hourly'));
  job_family_value text := btrim(coalesce(target_payload->>'jobFamily','other'));
  start_date_value date;
  needs_guard_license boolean;
  needs_armed_credentials boolean;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.manage');
  if btrim(coalesce(target_reason,'')) = '' or char_length(btrim(target_reason)) > 1000 then raise check_violation using message='A concise audit reason is required.'; end if;
  if first_name = '' or last_name = '' or position_title = '' then raise check_violation using message='Legal first name, legal last name, and position title are required.'; end if;
  if personal_email_value = '' or personal_email_value !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise check_violation using message='A valid personal email is required.'; end if;
  if personal_email_value ~* '@guardianshipsecurity\.net$' then raise check_violation using message='Use the employee personal email. Company-domain delivery is temporarily disabled.'; end if;
  if exists(select 1 from private.employee_contacts contact where lower(contact.personal_email)=personal_email_value) then raise unique_violation using message='That personal email is already linked to an employee.'; end if;
  if work_state not in ('CO','CA','AZ','NC') then raise check_violation using message='Choose CO, CA, AZ, or NC as the work state.'; end if;
  if employee_time_zone not in ('America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles') then raise check_violation using message='Choose Eastern, Central, Mountain, Arizona, or Pacific Time.'; end if;
  if employment_type_value not in ('hourly','salary','flex') then raise check_violation using message='Choose hourly, salary, or flex employment.'; end if;
  if job_family_value not in ('guard','administration','operations','other') then raise check_violation using message='Choose a supported job family.'; end if;
  if not exists(select 1 from pg_catalog.pg_enum item join pg_catalog.pg_type enum_type on enum_type.oid=item.enumtypid where enum_type.typname='app_role' and item.enumlabel=role_value) then raise check_violation using message='Choose a supported SygShift role.'; end if;
  begin start_date_value := (target_payload->>'startDate')::date; exception when others then raise check_violation using message='A valid start date is required.'; end;
  needs_guard_license := coalesce((target_payload->>'requiresGuardLicense')::boolean,job_family_value='guard');
  needs_armed_credentials := coalesce((target_payload->>'requiresArmedCredentials')::boolean,false);
  if needs_armed_credentials then needs_guard_license := true; end if;

  insert into public.employees(id,first_name,middle_name,last_name,role,employment_type,status,hired_on,job_title,time_zone)
  values(created_employee_id,first_name,middle_name,last_name,role_value::public.app_role,employment_type_value::public.employment_type,'onboarding',start_date_value,position_title,employee_time_zone);
  insert into private.employee_contacts(employee_id,personal_email,mobile_phone) values(created_employee_id,personal_email_value,mobile_phone);
  insert into private.hr_person_identifiers(employee_id,created_by) values(created_employee_id,target_actor_id) returning id into created_person_id;
  insert into private.hr_worker_identifiers(person_id,worker_reference,created_by)
  select created_person_id,employee.employee_number,target_actor_id from public.employees employee where employee.id=created_employee_id returning id into created_worker_id;
  insert into private.hr_legal_entities(code,name) values('GSL','Guardianship Security LLC')
  on conflict(code) do update set active=true,updated_at=clock_timestamp() returning id into selected_legal_entity_id;
  insert into private.hr_employment_relationships(worker_id,legal_entity_id,status,worker_classification,employment_type,effective_start,change_reason,recorded_by)
  values(created_worker_id,selected_legal_entity_id,'prehire','employee',employment_type_value,start_date_value,'Pre-hire onboarding created',target_actor_id);

  select ensured.template_id, ensured.template_version
  into selected_template_id, selected_template_version
  from private.hr_onboarding_ensure_standard_template(target_actor_id) ensured;

  perform private.hr_onboarding_ensure_nc_withholding_step(
    selected_template_id, selected_template_version, target_actor_id
  );

  insert into private.hr_onboarding_cases(employee_id,template_id,template_version,target_start_date,owner_id,launched_by)
  values(created_employee_id,selected_template_id,selected_template_version,start_date_value,target_actor_id,target_actor_id) returning id into created_case_id;
  insert into private.hr_onboarding_profiles(case_id,work_state,employment_type_snapshot,job_family,position_title,requires_guard_license,requires_armed_credentials)
  values(created_case_id,work_state,employment_type_value,job_family_value,position_title,needs_guard_license,needs_armed_credentials);
  insert into private.hr_onboarding_tasks(case_id,template_step_id,step_code,title,task_type,responsible_group,required,due_at,assignee_id,source_requirement)
  select created_case_id,step.id,step.step_code,step.title,step.task_type,step.responsible_group,step.required,((start_date_value+step.due_offset_days)::timestamp at time zone employee_time_zone),case when step.responsible_group='employee' then created_employee_id else null end,step.source_requirement
  from private.hr_onboarding_template_steps step
  where step.template_id = selected_template_id
    and step.template_version = selected_template_version
    and private.hr_onboarding_step_applies(step.source_requirement,work_state,employment_type_value,job_family_value,needs_guard_license,needs_armed_credentials);
  insert into private.hr_onboarding_events(case_id,action,actor_id,reason,details)
  values(created_case_id,'create_prehire',target_actor_id,btrim(target_reason),jsonb_build_object('employeeId',created_employee_id,'workState',work_state,'timeZone',employee_time_zone,'jobFamily',job_family_value,'requiresGuardLicense',needs_guard_license,'requiresArmedCredentials',needs_armed_credentials));
  perform private.hr_onboarding_recalculate_case(created_case_id);
  return jsonb_build_object(
    'id',created_employee_id,'employeeId',created_employee_id,'caseId',created_case_id,
    'employeeNumber',(select employee_number from public.employees where id=created_employee_id),
    'username',(select username from public.employees where id=created_employee_id),
    'action','create_prehire','caseStatus',(select status from private.hr_onboarding_cases where id=created_case_id)
  );
end
$$;

revoke all on function public.service_hr_onboarding_create_prehire(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.service_hr_onboarding_create_prehire(uuid,jsonb,text) to service_role;

create or replace function public.service_hr_onboarding_launch_existing(
  target_actor_id uuid,
  target_employee_id uuid,
  target_payload jsonb,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  selected_template_id uuid;
  selected_template_version integer;
  created_case_id uuid;
  work_state text := upper(btrim(coalesce(target_payload->>'workState','')));
  employment_type_value text;
  job_family_value text := btrim(coalesce(target_payload->>'jobFamily','other'));
  position_title text;
  start_date_value date;
  needs_guard_license boolean;
  needs_armed_credentials boolean;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id,'hr.onboarding.manage');
  if btrim(coalesce(target_reason,'')) = '' or char_length(btrim(target_reason)) > 1000 then raise check_violation using message='A concise audit reason is required.'; end if;
  select * into employee_record from public.employees employee where employee.id=target_employee_id and employee.status in ('onboarding','active') for update;
  if not found then raise check_violation using message='Choose an active or onboarding employee.'; end if;
  if exists(select 1 from private.hr_onboarding_cases onboarding_case where onboarding_case.employee_id=target_employee_id) then raise unique_violation using message='This employee already has an onboarding case.'; end if;
  if work_state not in ('CO','CA','AZ','NC') then raise check_violation using message='Choose CO, CA, AZ, or NC as the work state.'; end if;
  if employee_record.time_zone not in ('America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles') then raise check_violation using message='Confirm the employee time zone in User Accounts before onboarding.'; end if;
  employment_type_value := coalesce(nullif(btrim(target_payload->>'employmentType'),''),employee_record.employment_type::text);
  if employment_type_value not in ('hourly','salary','flex') then raise check_violation using message='Choose hourly, salary, or flex employment.'; end if;
  if job_family_value not in ('guard','administration','operations','other') then raise check_violation using message='Choose a supported job family.'; end if;
  position_title := coalesce(nullif(btrim(target_payload->>'positionTitle'),''),nullif(btrim(employee_record.job_title),''),initcap(replace(employee_record.role::text,'_',' ')));
  begin start_date_value := coalesce(nullif(target_payload->>'startDate','')::date,employee_record.hired_on,current_date); exception when others then raise check_violation using message='A valid start date is required.'; end;
  needs_guard_license := coalesce((target_payload->>'requiresGuardLicense')::boolean,job_family_value='guard');
  needs_armed_credentials := coalesce((target_payload->>'requiresArmedCredentials')::boolean,false);
  if needs_armed_credentials then needs_guard_license := true; end if;

  select ensured.template_id, ensured.template_version into selected_template_id, selected_template_version
  from private.hr_onboarding_ensure_standard_template(target_actor_id) ensured;
  perform private.hr_onboarding_ensure_nc_withholding_step(
    selected_template_id, selected_template_version, target_actor_id
  );
  insert into private.hr_onboarding_cases(employee_id,template_id,template_version,target_start_date,owner_id,launched_by)
  values(target_employee_id,selected_template_id,selected_template_version,start_date_value,target_actor_id,target_actor_id) returning id into created_case_id;
  insert into private.hr_onboarding_profiles(case_id,work_state,employment_type_snapshot,job_family,position_title,requires_guard_license,requires_armed_credentials)
  values(created_case_id,work_state,employment_type_value,job_family_value,position_title,needs_guard_license,needs_armed_credentials);
  insert into private.hr_onboarding_tasks(case_id,template_step_id,step_code,title,task_type,responsible_group,required,due_at,assignee_id,source_requirement)
  select created_case_id,step.id,step.step_code,step.title,step.task_type,step.responsible_group,step.required,((start_date_value+step.due_offset_days)::timestamp at time zone employee_record.time_zone),case when step.responsible_group='employee' then target_employee_id else null end,step.source_requirement
  from private.hr_onboarding_template_steps step
  where step.template_id = selected_template_id
    and step.template_version = selected_template_version
    and private.hr_onboarding_step_applies(step.source_requirement,work_state,employment_type_value,job_family_value,needs_guard_license,needs_armed_credentials);
  insert into private.hr_onboarding_events(case_id,action,actor_id,reason,details)
  values(created_case_id,'launch_existing_employee',target_actor_id,btrim(target_reason),jsonb_build_object('employeeId',target_employee_id,'priorEmployeeStatus',employee_record.status,'workState',work_state,'timeZone',employee_record.time_zone,'jobFamily',job_family_value));
  perform private.hr_onboarding_recalculate_case(created_case_id);
  return jsonb_build_object('id',target_employee_id,'employeeId',target_employee_id,'caseId',created_case_id,'action','launch_existing_employee','caseStatus',(select status from private.hr_onboarding_cases where id=created_case_id));
end
$$;

revoke all on function public.service_hr_onboarding_launch_existing(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.service_hr_onboarding_launch_existing(uuid,uuid,jsonb,text) to service_role;

-- Candidate conversion is also an interactive employee-creation boundary.
-- The hard-locked Colorado importer above cannot be reused; candidate review
-- must persist an explicit supported zone before creating the worker.
alter table private.hr_candidate_conversion_requests
  add column if not exists proposed_time_zone text;

do $$
begin
  if exists (
    select 1
    from private.hr_candidate_conversion_requests conversion
    where conversion.proposed_time_zone is null
  ) then
    raise check_violation using message = 'Existing candidate conversions require a reviewed employee time zone before this release can continue.';
  end if;
end
$$;

alter table private.hr_candidate_conversion_requests
  alter column proposed_time_zone set not null;

alter table private.hr_candidate_conversion_requests
  drop constraint if exists hr_candidate_conversion_time_zone;

alter table private.hr_candidate_conversion_requests
  add constraint hr_candidate_conversion_time_zone check (
    proposed_time_zone in ('America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles')
  );

create or replace function public.service_request_candidate_conversion(
  target_actor_id uuid,
  target_application_id uuid,
  target_role public.app_role,
  target_employment_type public.employment_type,
  target_job_title text,
  target_start_date date,
  target_time_zone text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  request_id uuid;
  duplicate_matches jsonb;
  application_record record;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_recruiting_assert_enabled();
  perform private.hr_recruiting_require_actor_permission(target_actor_id, 'hr.recruiting.manage');
  if btrim(coalesce(target_reason,'')) = '' or btrim(coalesce(target_job_title,'')) = '' then
    raise check_violation using message = 'Job title and audit reason are required.';
  end if;
  if target_time_zone is null
    or target_time_zone not in ('America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles')
  then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
  end if;

  select application.*, applicant.converted_employee_id into application_record
  from private.hr_applications application
  join private.hr_applicants applicant on applicant.id = application.applicant_id
  where application.id = target_application_id
  for update of application, applicant;

  if not found or application_record.stage <> 'accepted' or application_record.status <> 'active' then
    raise check_violation using message = 'Only an accepted active candidate can be converted.';
  end if;
  if application_record.converted_employee_id is not null then
    raise unique_violation using message = 'This candidate already has a permanent employee identity.';
  end if;
  if not exists (
    select 1 from private.hr_offers offer
    where offer.application_id = target_application_id and offer.status = 'accepted'
  ) then
    raise check_violation using message = 'An accepted offer is required before conversion.';
  end if;

  duplicate_matches := private.hr_candidate_duplicate_matches(target_application_id);
  if jsonb_array_length(duplicate_matches) > 0 then
    raise unique_violation
      using message = 'Possible duplicate employee found. Resolve the identity match before conversion.',
            detail = duplicate_matches::text;
  end if;

  insert into private.hr_candidate_conversion_requests (
    application_id, proposed_role, proposed_employment_type, proposed_job_title,
    proposed_start_date, proposed_time_zone, requested_by, request_reason, identity_snapshot
  ) values (
    target_application_id, target_role, target_employment_type, btrim(target_job_title),
    target_start_date, target_time_zone, target_actor_id, btrim(target_reason),
    jsonb_build_object('duplicateMatches', duplicate_matches, 'timeZone', target_time_zone)
  ) returning id into request_id;

  insert into private.hr_candidate_conversion_events (
    conversion_request_id, event_type, actor_id, reason, details
  ) values (
    request_id, 'requested', target_actor_id, btrim(target_reason),
    jsonb_build_object('timeZone', target_time_zone)
  );

  return jsonb_build_object(
    'conversionRequestId', request_id,
    'status', 'requested',
    'duplicateMatches', duplicate_matches,
    'timeZone', target_time_zone
  );
end
$$;

create or replace function public.service_review_candidate_conversion(
  target_actor_id uuid,
  target_request_id uuid,
  target_decision text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  conversion private.hr_candidate_conversion_requests%rowtype;
  applicant private.hr_applicants%rowtype;
  created_employee_id uuid;
  created_person_id uuid;
  created_worker_id uuid;
  created_employee_number text;
  duplicate_matches jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_recruiting_assert_enabled();
  perform private.hr_recruiting_require_actor_permission(target_actor_id, 'hr.recruiting.approve');
  if target_decision not in ('approve','reject','cancel') or btrim(coalesce(target_reason,'')) = '' then
    raise check_violation using message = 'A supported decision and audit reason are required.';
  end if;

  select * into conversion
  from private.hr_candidate_conversion_requests
  where id = target_request_id
  for update;

  if not found or conversion.status <> 'requested' then
    raise check_violation using message = 'Only a pending conversion request can be reviewed.';
  end if;
  if conversion.requested_by = target_actor_id then
    raise insufficient_privilege using message = 'Candidate conversion requires a second authorized reviewer.';
  end if;

  if target_decision <> 'approve' then
    update private.hr_candidate_conversion_requests
    set status = case target_decision when 'reject' then 'rejected' else 'canceled' end,
        reviewed_by = target_actor_id,
        reviewed_at = clock_timestamp(),
        review_reason = btrim(target_reason)
    where id = target_request_id;
    insert into private.hr_candidate_conversion_events (
      conversion_request_id, event_type, actor_id, reason
    ) values (
      target_request_id,
      case target_decision when 'reject' then 'rejected' else 'canceled' end,
      target_actor_id,
      btrim(target_reason)
    );
    return jsonb_build_object(
      'conversionRequestId', target_request_id,
      'status', case target_decision when 'reject' then 'rejected' else 'canceled' end
    );
  end if;

  if conversion.proposed_time_zone not in ('America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles')
  then
    raise check_violation using message = 'Confirm the employee time zone before approving this conversion.';
  end if;

  duplicate_matches := private.hr_candidate_duplicate_matches(conversion.application_id);
  if jsonb_array_length(duplicate_matches) > 0 then
    raise unique_violation
      using message = 'Possible duplicate employee found. Resolve the identity match before conversion.',
            detail = duplicate_matches::text;
  end if;

  select source_applicant.* into applicant
  from private.hr_applications application
  join private.hr_applicants source_applicant on source_applicant.id = application.applicant_id
  where application.id = conversion.application_id
  for update of source_applicant;

  insert into public.employees (
    first_name, middle_name, last_name, preferred_name, role, employment_type,
    status, job_title, hired_on, time_zone
  ) values (
    applicant.legal_first_name, applicant.legal_middle_name, applicant.legal_last_name,
    applicant.preferred_name, conversion.proposed_role, conversion.proposed_employment_type,
    'onboarding', conversion.proposed_job_title, conversion.proposed_start_date,
    conversion.proposed_time_zone
  ) returning id, employee_number into created_employee_id, created_employee_number;

  insert into private.employee_contacts (employee_id,personal_email,mobile_phone,city,region)
  values (created_employee_id,applicant.personal_email,applicant.mobile_phone,applicant.city,applicant.region);
  insert into private.hr_person_identifiers (employee_id,source_system,created_by)
  values (created_employee_id,'hr_recruiting',target_actor_id)
  returning id into created_person_id;
  insert into private.hr_worker_identifiers (person_id,worker_reference,created_by)
  values (created_person_id,created_employee_number,target_actor_id)
  returning id into created_worker_id;

  update private.hr_applicants
  set converted_employee_id = created_employee_id,
      converted_at = clock_timestamp()
  where id = applicant.id;
  update private.hr_applications
  set status = 'hired', updated_at = clock_timestamp()
  where id = conversion.application_id;
  update private.hr_candidate_conversion_requests
  set status = 'converted',
      reviewed_by = target_actor_id,
      reviewed_at = clock_timestamp(),
      review_reason = btrim(target_reason),
      converted_employee_id = created_employee_id,
      converted_at = clock_timestamp(),
      identity_snapshot = jsonb_build_object(
        'employeeId',created_employee_id,
        'personId',created_person_id,
        'workerId',created_worker_id,
        'timeZone',conversion.proposed_time_zone
      )
  where id = target_request_id;
  insert into private.hr_candidate_conversion_events (
    conversion_request_id,event_type,actor_id,reason,details
  ) values (
    target_request_id,'converted',target_actor_id,btrim(target_reason),
    jsonb_build_object('employeeId',created_employee_id,'timeZone',conversion.proposed_time_zone)
  );

  return jsonb_build_object(
    'conversionRequestId',target_request_id,
    'status','converted',
    'employeeId',created_employee_id,
    'timeZone',conversion.proposed_time_zone,
    'loginCreated',false,
    'accessGranted',false
  );
end
$$;

-- The old request signature omitted time zone and may not remain a callable
-- service boundary.
revoke all on function public.service_request_candidate_conversion(
  uuid,uuid,public.app_role,public.employment_type,text,date,text
) from public,anon,authenticated,service_role;
revoke all on function public.service_request_candidate_conversion(
  uuid,uuid,public.app_role,public.employment_type,text,date,text,text
) from public,anon,authenticated;
revoke all on function public.service_review_candidate_conversion(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_request_candidate_conversion(
  uuid,uuid,public.app_role,public.employment_type,text,date,text,text
) to service_role;
grant execute on function public.service_review_candidate_conversion(uuid,uuid,text,text) to service_role;

create or replace function public.get_weekly_schedule_payload(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  viewer_employee_id uuid := private.current_employee_id();
  can_view_own_schedule boolean := public.has_effective_permission('schedule.self.view');
  can_view_all_schedule boolean := public.has_any_effective_permission(array[
    'schedule.view',
    'scheduler.view',
    'scheduler.manage',
    'schedule.manage',
    'schedule.publish',
    'schedule.delete_shift',
    'schedule.override_warnings'
  ]);
  target_schedule public.schedules%rowtype;
  payload jsonb;
begin
  if viewer_employee_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view the schedule.';
  end if;

  if not can_view_own_schedule and not can_view_all_schedule then
    raise insufficient_privilege using message = 'Schedule access is required.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and (
      schedule.status = 'published'
      or (schedule.status = 'draft' and can_view_all_schedule)
    )
  order by schedule.revision desc
  limit 1;

  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'id', target_schedule.id,
    'week_starts_on', target_schedule.week_starts_on,
    'revision', target_schedule.revision,
    'status', target_schedule.status,
    'published_at', target_schedule.published_at,
    'shifts', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', shift.id,
        'starts_at', shift.starts_at,
        'ends_at', shift.ends_at,
        'time_zone', shift.time_zone,
        'time_zone_source', shift.time_zone_source,
        'time_zone_employee_id', case when can_view_all_schedule then shift.time_zone_employee_id else null end,
        'headcount_required', shift.headcount_required,
        'requires_armed', shift.requires_armed,
        'is_open', assignment_count.active_assignments < shift.headcount_required,
        'is_overtime', shift.is_overtime,
        'notes', shift.notes,
        'post', case when post.id is null then null else jsonb_build_object(
          'id', post.id,
          'name', post.name,
          'site', jsonb_build_object('id', site.id, 'code', site.code, 'name', site.name)
        ) end,
        'event', case when event.id is null then null else jsonb_build_object(
          'id', event.id,
          'name', event.name,
          'location_name', event.location_name,
          'site', case when event_site.id is null then null else jsonb_build_object(
            'id', event_site.id,
            'code', event_site.code,
            'name', event_site.name
          ) end
        ) end,
        'assignments', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'id', assignment.id,
              'status', assignment.status,
              'employee', jsonb_build_object(
                'id', employee.id,
                'first_name', employee.first_name,
                'last_name', employee.last_name,
                'preferred_name', employee.preferred_name,
                'employee_number', employee.employee_number
              ),
              'overrides', coalesce(assignment_overrides.records, '[]'::jsonb)
            )
            order by employee.last_name, employee.first_name, assignment.id
          ), '[]'::jsonb)
          from public.shift_assignments assignment
          join public.employees employee on employee.id = assignment.employee_id
          left join lateral (
            select jsonb_agg(jsonb_build_object(
              'kind', override_record.override_kind,
              'note', override_record.note,
              'createdAt', to_char(override_record.created_at at time zone 'America/Denver', 'MM/DD/YYYY HH12:MI AM')
            ) order by override_record.created_at desc) as records
            from public.schedule_assignment_overrides override_record
            where override_record.shift_id = assignment.shift_id
              and override_record.employee_id = assignment.employee_id
          ) assignment_overrides on true
          where assignment.shift_id = shift.id
            and assignment.status <> 'canceled'
        )
      )
      order by shift.starts_at, shift.created_at, shift.id
    ) filter (where shift.id is not null), '[]'::jsonb)
  )
  into payload
  from public.shifts shift
  left join lateral (
    select count(*)::integer as active_assignments
    from public.shift_assignments assignment
    where assignment.shift_id = shift.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) assignment_count on true
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  where shift.schedule_id = target_schedule.id
    and shift.canceled_at is null
    and (
      can_view_all_schedule
      or exists (
        select 1
        from public.shift_assignments viewer_assignment
        where viewer_assignment.shift_id = shift.id
          and viewer_assignment.employee_id = viewer_employee_id
          and viewer_assignment.status <> 'canceled'
      )
    );

  return payload;
end;
$function$;

revoke all on function public.get_weekly_schedule_payload(date) from public, anon;
grant execute on function public.get_weekly_schedule_payload(date) to authenticated;

create or replace function public.get_timekeeping_dashboard(target_operational_date date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  target_date date;
  server_now timestamptz := clock_timestamp();
  employee_record record;
  last_event jsonb;
  eligible_shifts jsonb;
  recent_events jsonb;
  pending_correction_count integer;
begin
  if viewer_employee_id is null then raise insufficient_privilege using message = 'An active employee account is required for timekeeping.'; end if;
  if not (public.has_effective_permission('time.self.view') or public.has_effective_permission('time.punch') or public.has_effective_permission('time.view') or public.has_effective_permission('time.manage') or public.has_effective_permission('time.export_payroll')) then
    raise insufficient_privilege using message = 'Time clock access is required for timekeeping.';
  end if;

  select employee.id, employee.username, employee.first_name, employee.last_name, employee.preferred_name,
         employee.role, employee.employment_type, employee.time_zone
  into employee_record from public.employees employee where employee.id = viewer_employee_id;

  target_date := coalesce(target_operational_date, (server_now at time zone employee_record.time_zone)::date);

  select jsonb_build_object(
    'id', event.id, 'kind', event.kind, 'shiftId', event.shift_id, 'recordedAt', event.recorded_at,
    'effectiveAt', coalesce((select correction.replacement_time from public.time_event_corrections correction where correction.time_event_id = event.id and correction.approved_at is not null and not correction.voided and correction.replacement_time is not null order by correction.approved_at desc limit 1), event.recorded_at),
    'source', event.source
  ) into last_event
  from public.time_events event
  where event.employee_id = viewer_employee_id
    and not exists (select 1 from public.time_event_corrections correction where correction.time_event_id = event.id and correction.approved_at is not null and correction.voided)
  order by coalesce((select correction.replacement_time from public.time_event_corrections correction where correction.time_event_id = event.id and correction.approved_at is not null and not correction.voided and correction.replacement_time is not null order by correction.approved_at desc limit 1), event.recorded_at) desc, event.created_at desc
  limit 1;

  with ranked_eligible_shifts as (
    select assignment.id assignment_id, assignment.status, shift.id shift_id, shift.starts_at, shift.ends_at,
      shift.time_zone, shift.requires_armed, shift.is_overtime, shift.work_type, shift.assignment_type,
      post.name post_name, site.name site_name, site.code site_code, event.name event_name,
      coalesce(event.location_name, site.name, post.name, event.name) location_name,
      row_number() over (partition by coalesce(shift.post_id, shift.event_id), shift.starts_at, shift.ends_at, shift.time_zone, shift.requires_armed, shift.is_overtime order by case assignment.status when 'confirmed' then 0 else 1 end, assignment.assigned_at, assignment.id) duplicate_rank
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where assignment.employee_id = viewer_employee_id
      and assignment.status in ('assigned', 'confirmed')
      and schedule.status = 'published'
      and shift.canceled_at is null
      and private.shift_assignment_type(shift.id) = 'standard'
      and shift.starts_at <= server_now + interval '12 hours'
      and shift.ends_at >= server_now - interval '6 hours'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'assignmentId', shift.assignment_id, 'shiftId', shift.shift_id, 'status', shift.status,
    'startsAt', shift.starts_at, 'endsAt', shift.ends_at, 'timeZone', shift.time_zone,
    'requiresArmed', shift.requires_armed, 'isOvertime', shift.is_overtime, 'workType', shift.work_type,
    'assignmentType', shift.assignment_type, 'postName', shift.post_name, 'siteName', shift.site_name,
    'siteCode', shift.site_code, 'eventName', shift.event_name, 'locationName', shift.location_name
  ) order by shift.starts_at), '[]'::jsonb) into eligible_shifts
  from ranked_eligible_shifts shift where shift.duplicate_rank = 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', event.id, 'kind', event.kind, 'shiftId', event.shift_id, 'recordedAt', event.recorded_at,
    'effectiveAt', coalesce((select correction.replacement_time from public.time_event_corrections correction where correction.time_event_id = event.id and correction.approved_at is not null and not correction.voided and correction.replacement_time is not null order by correction.approved_at desc limit 1), event.recorded_at),
    'clientRecordedAt', event.client_recorded_at, 'source', event.source,
    'voided', exists (select 1 from public.time_event_corrections correction where correction.time_event_id = event.id and correction.approved_at is not null and correction.voided)
  ) order by event.recorded_at desc), '[]'::jsonb) into recent_events
  from public.time_events event
  where event.employee_id = viewer_employee_id
    and (event.recorded_at at time zone employee_record.time_zone)::date = target_date;

  select count(*)::integer into pending_correction_count
  from public.time_event_corrections correction join public.time_events event on event.id = correction.time_event_id
  where event.employee_id = viewer_employee_id and correction.approved_at is null;

  return jsonb_build_object(
    'serverTimestamp', server_now, 'operationalDate', target_date, 'operationalTimeZone', employee_record.time_zone,
    'employee', jsonb_build_object('id', employee_record.id, 'username', employee_record.username,
      'displayName', btrim(coalesce(employee_record.preferred_name, employee_record.first_name) || ' ' || employee_record.last_name),
      'role', employee_record.role, 'employmentType', employee_record.employment_type, 'timeZone', employee_record.time_zone),
    'lastEvent', last_event, 'eligibleShifts', eligible_shifts, 'recentEvents', recent_events,
    'pendingCorrectionCount', pending_correction_count
  );
end
$$;

revoke all on function public.get_timekeeping_dashboard(date) from public, anon;
grant execute on function public.get_timekeeping_dashboard(date) to authenticated;

-- Exact, reviewed production repair for Misty Kimbal. These are the only
-- active published/draft employee-sourced occurrences observed at review time.
-- The UTC instants are immutable inputs to the guard and are never converted.
create temporary table employee_time_zone_repair_targets (
  shift_id uuid primary key,
  expected_starts_at timestamptz not null,
  expected_ends_at timestamptz not null
) on commit drop;

insert into employee_time_zone_repair_targets (shift_id, expected_starts_at, expected_ends_at) values
  ('eeefd9ad-24a3-4b2f-9eb0-024c2ad11b72','2026-09-25 14:00:00+00','2026-09-25 22:00:00+00'),
  ('3cbaedd1-b0bc-49ce-bf6c-e072bbfbdd59','2026-09-28 13:00:00+00','2026-09-28 21:00:00+00'),
  ('1bb70e30-75ca-47ff-a7e6-74e9e680c063','2026-09-28 13:00:00+00','2026-09-28 21:00:00+00'),
  ('ac5a2a95-3927-4a22-96c3-b7ff249c076c','2026-09-29 13:00:00+00','2026-09-29 21:00:00+00'),
  ('30018cf0-518e-441b-b09a-e932a066575e','2026-09-29 13:00:00+00','2026-09-29 21:00:00+00'),
  ('f71580b0-2f25-409e-9788-d41473068584','2026-09-30 13:00:00+00','2026-09-30 21:00:00+00'),
  ('ca5b3620-a985-4a05-9453-e04005657637','2026-09-30 13:00:00+00','2026-09-30 21:00:00+00'),
  ('de438f72-e755-4a94-8582-c3301428e221','2026-10-01 13:00:00+00','2026-10-01 21:00:00+00'),
  ('8791d986-ac7a-4851-8a09-2c9554d96a9f','2026-10-01 13:00:00+00','2026-10-01 21:00:00+00'),
  ('86b74b86-7975-43f7-9db9-7d6691282ab7','2026-10-02 13:00:00+00','2026-10-02 21:00:00+00'),
  ('592930df-6dbd-486e-8525-50ede68e4644','2026-10-02 13:00:00+00','2026-10-02 21:00:00+00');

lock table public.employees in row exclusive mode;
lock table public.shifts in share row exclusive mode;
alter table public.shifts disable trigger shifts_published_immutable;

do $$
declare
  target_employee_id constant uuid := 'd4893a26-1a0b-483d-bbe3-00373c3caaac';
  target_employee public.employees%rowtype;
  matched_target_count integer;
begin
  select * into target_employee
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  -- Fresh/local databases may not contain the production employee. Production
  -- must match every identity and shift guard or the migration stops safely.
  if found then
    if target_employee.employee_number <> 'SYG-1131'
      or target_employee.username <> 'mkimbal'
      or target_employee.first_name <> 'Misty'
      or target_employee.last_name <> 'Kimbal'
      or target_employee.time_zone not in ('America/Denver','America/New_York')
    then
      raise check_violation using message = 'Misty Kimbal time-zone repair identity guard did not match.';
    end if;

    select count(*)::integer into matched_target_count
    from employee_time_zone_repair_targets repair
    join public.shifts shift on shift.id = repair.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id
    where schedule.status in ('draft','published')
      and shift.canceled_at is null
      and shift.time_zone_source = 'employee'
      and shift.time_zone_employee_id = target_employee_id
      and shift.starts_at = repair.expected_starts_at
      and shift.ends_at = repair.expected_ends_at
      and shift.time_zone in ('America/Denver','America/New_York')
      and exists (
        select 1
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.employee_id = target_employee_id
          and assignment.status in ('assigned','confirmed','completed')
          and assignment.canceled_at is null
      );

    if matched_target_count <> 11 then
      raise check_violation using message = 'Misty Kimbal shift repair guard did not match all 11 reviewed active assigned occurrences.';
    end if;

    if not exists (
      select 1
      from public.shifts shift
      join public.schedules schedule on schedule.id = shift.schedule_id
      where shift.id = 'eeefd9ad-24a3-4b2f-9eb0-024c2ad11b72'::uuid
        and shift.starts_at = '2026-09-25 14:00:00+00'::timestamptz
        and shift.ends_at = '2026-09-25 22:00:00+00'::timestamptz
        and shift.time_zone = 'America/Denver'
        and shift.time_zone_source = 'employee'
        and shift.time_zone_employee_id = target_employee_id
        and schedule.status = 'published'
        and exists (
          select 1 from public.shift_assignments assignment
          where assignment.shift_id = shift.id
            and assignment.employee_id = target_employee_id
            and assignment.status in ('assigned','confirmed','completed')
            and assignment.canceled_at is null
        )
    ) then
      raise check_violation using message = 'Misty Kimbal published 09/25 14:00Z occurrence changed after review.';
    end if;

    if not exists (
      select 1
      from public.shifts shift
      join public.schedules schedule on schedule.id = shift.schedule_id
      where shift.id = '6b80d59a-8d5e-43be-8131-23100d19c1a9'::uuid
        and shift.starts_at = '2026-09-25 13:00:00+00'::timestamptz
        and shift.ends_at = '2026-09-25 21:00:00+00'::timestamptz
        and shift.time_zone = 'America/Denver'
        and shift.time_zone_source = 'employee'
        and shift.time_zone_employee_id = target_employee_id
        and schedule.status = 'superseded'
    ) then
      raise check_violation using message = 'Misty Kimbal superseded 09/25 history changed after review.';
    end if;

    if exists (
      select 1
      from public.shifts shift
      join public.schedules schedule on schedule.id = shift.schedule_id
      where schedule.status in ('draft','published')
        and shift.canceled_at is null
        and shift.time_zone_source = 'employee'
        and shift.time_zone_employee_id = target_employee_id
        and shift.starts_at >= '2026-09-25 00:00:00+00'::timestamptz
        and exists (
          select 1
          from public.shift_assignments assignment
          where assignment.shift_id = shift.id
            and assignment.employee_id = target_employee_id
            and assignment.status in ('assigned','confirmed','completed')
            and assignment.canceled_at is null
        )
        and not exists (
          select 1 from employee_time_zone_repair_targets repair where repair.shift_id = shift.id
        )
    ) then
      raise check_violation using message = 'Misty Kimbal has an unreviewed active current/future assigned employee-sourced occurrence.';
    end if;

    update public.employees employee
    set time_zone = 'America/New_York',
        updated_at = clock_timestamp()
    where employee.id = target_employee_id;

    update public.shifts shift
    set time_zone = 'America/New_York',
        updated_at = clock_timestamp()
    from employee_time_zone_repair_targets repair
    where shift.id = repair.shift_id;

    if exists (
      select 1
      from employee_time_zone_repair_targets repair
      join public.shifts shift on shift.id = repair.shift_id
      join public.schedules schedule on schedule.id = shift.schedule_id
      where shift.starts_at <> repair.expected_starts_at
        or shift.ends_at <> repair.expected_ends_at
        or shift.time_zone <> 'America/New_York'
        or shift.time_zone_source <> 'employee'
        or shift.time_zone_employee_id <> target_employee_id
        or shift.canceled_at is not null
        or schedule.status not in ('draft','published')
    ) then
      raise check_violation using message = 'Misty Kimbal repair changed protected shift instants/source metadata or missed a reviewed occurrence.';
    end if;

    insert into private.audit_events (
      auth_user_id, employee_id, request_id, schema_name, table_name,
      operation, row_id, old_record, new_record
    ) values (
      null, null, 'migration:20260925175035', 'public', 'employees',
      'TIME_ZONE_CONTRACT_REPAIR', target_employee_id::text,
      jsonb_build_object(
        'employeeNumber','SYG-1131',
        'username','mkimbal',
        'timeZone',target_employee.time_zone,
        'reviewedShiftCount',11
      ),
      jsonb_build_object(
        'employeeNumber','SYG-1131',
        'username','mkimbal',
        'timeZone','America/New_York',
        'reviewedShiftCount',11,
        'startsAtAndEndsAtPreserved',true,
        'timeZoneSourcePreserved','employee',
        'published1400UtcCurrentRowGuarded',true,
        'superseded1300UtcHistoryPreserved',true,
        'published1400UtcAnomalyPreservedForManualReview',true,
        'shiftIds',(select jsonb_agg(repair.shift_id order by repair.shift_id) from employee_time_zone_repair_targets repair)
      )
    );
  end if;
end
$$;

set constraints all immediate;
alter table public.shifts enable trigger shifts_published_immutable;

notify pgrst, 'reload schema';

commit;
