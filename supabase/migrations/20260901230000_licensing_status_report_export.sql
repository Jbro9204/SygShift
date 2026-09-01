begin;

create temporary table licensing_report_release_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, username, first_name, coalesce(middle_name, ''), last_name, role::text, status::text, updated_at::text), '|' order by id)), md5('')) from public.employees) as employee_fingerprint,
  (select count(*) from public.employee_credentials) as credential_count,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, kind::text, status::text, coalesce(credential_number, ''), coalesce(valid_from::text, ''), coalesce(expires_on::text, ''), updated_at::text), '|' order by id)), md5('')) from public.employee_credentials) as credential_fingerprint,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text, coalesce(assigned_by::text, ''), assigned_at::text), '|' order by employee_id, role_id)), md5('')) from public.employee_access_roles) as employee_role_fingerprint,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text, updated_at::text), '|' order by id)), md5('')) from public.employee_permission_overrides) as override_fingerprint;

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, 'reports.export', true
from public.access_roles role
where role.code = 'system_recruiting_licensing'
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

create or replace function public.authorize_licensing_status_report_export(
  target_employee_scope text default 'guards',
  target_employment_status text default 'active',
  target_license_status text default 'all',
  target_credential_type_id uuid default null,
  target_search text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  export_id uuid := gen_random_uuid();
  authorized_at timestamptz := clock_timestamp();
begin
  actor_id := private.require_licensing_mfa('licensing.view');

  if not public.is_admin() and not public.has_effective_permission('licensing.view') then
    raise insufficient_privilege using message = 'Licensing report access is required.';
  end if;
  if not public.is_admin() and not public.has_effective_permission('reports.export') then
    raise insufficient_privilege using message = 'Report export access is required.';
  end if;
  if target_employee_scope not in ('guards', 'all') then
    raise check_violation using message = 'Choose Guards or All employees.';
  end if;
  if target_employment_status not in ('active', 'onboarding', 'leave', 'inactive', 'separated', 'all') then
    raise check_violation using message = 'Choose a supported employment status.';
  end if;
  if target_license_status not in ('all', 'current', 'expiring', 'expired', 'not_licensed', 'pending', 'restricted') then
    raise check_violation using message = 'Choose a supported license status.';
  end if;
  if target_credential_type_id is not null and not exists (
    select 1 from public.credential_types credential_type
    where credential_type.id = target_credential_type_id
      and credential_type.active
  ) then
    raise check_violation using message = 'Choose an active credential type.';
  end if;
  if length(coalesce(target_search, '')) > 200 then
    raise check_violation using message = 'The report search is too long.';
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
    auth.uid(),
    actor_id,
    'public',
    'licensing_status_report',
    'LICENSING_STATUS_REPORT_EXPORT',
    export_id::text,
    jsonb_build_object(
      'employeeScope', target_employee_scope,
      'employmentStatus', target_employment_status,
      'licenseStatus', target_license_status,
      'credentialTypeId', target_credential_type_id,
      'searchApplied', nullif(btrim(coalesce(target_search, '')), '') is not null,
      'authorizedAt', authorized_at
    )
  );

  return jsonb_build_object(
    'authorizedAt', authorized_at,
    'exportId', export_id
  );
end
$$;

revoke all on function public.authorize_licensing_status_report_export(text, text, text, uuid, text) from public, anon;
grant execute on function public.authorize_licensing_status_report_export(text, text, text, uuid, text) to authenticated;

do $$
declare
  baseline licensing_report_release_baseline%rowtype;
begin
  select * into strict baseline from licensing_report_release_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, username, first_name, coalesce(middle_name, ''), last_name, role::text, status::text, updated_at::text), '|' order by id)), md5('')) from public.employees)
    or baseline.credential_count <> (select count(*) from public.employee_credentials)
    or baseline.credential_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, kind::text, status::text, coalesce(credential_number, ''), coalesce(valid_from::text, ''), coalesce(expires_on::text, ''), updated_at::text), '|' order by id)), md5('')) from public.employee_credentials)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.employee_role_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text, coalesce(assigned_by::text, ''), assigned_at::text), '|' order by employee_id, role_id)), md5('')) from public.employee_access_roles)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.override_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text, updated_at::text), '|' order by id)), md5('')) from public.employee_permission_overrides)
  then
    raise exception 'Licensing report release changed protected employee, credential, assignment, or override data.';
  end if;

  if not exists (
    select 1
    from public.access_role_permissions role_permission
    join public.access_roles role on role.id = role_permission.role_id
    where role.code = 'system_recruiting_licensing'
      and role_permission.permission_code = 'reports.export'
      and role_permission.enabled
  ) then
    raise exception 'Recruiting and Licensing did not receive the approved report export permission.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
