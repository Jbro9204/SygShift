begin;

-- Freeze the current access assignments inside this transaction. This migration
-- may change enforcement logic, but it must never alter who has which role or
-- permission.
create temporary table access_integrity_before on commit drop as
select md5(jsonb_build_object(
  'rolePermissions', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'roleId', permission.role_id,
        'permissionCode', permission.permission_code,
        'enabled', permission.enabled
      ) order by permission.role_id, permission.permission_code
    )
    from public.access_role_permissions permission
  ), '[]'::jsonb),
  'employeeRoles', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'employeeId', assignment.employee_id,
        'roleId', assignment.role_id
      ) order by assignment.employee_id, assignment.role_id
    )
    from public.employee_access_roles assignment
  ), '[]'::jsonb),
  'overrides', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'employeeId', override.employee_id,
        'permissionCode', override.permission_code,
        'effect', override.effect,
        'active', override.active,
        'reason', override.reason
      ) order by override.employee_id, override.permission_code
    )
    from public.employee_permission_overrides override
  ), '[]'::jsonb),
  'primaryRoles', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'employeeId', employee.id,
        'role', employee.role,
        'status', employee.status
      ) order by employee.id
    )
    from public.employees employee
  ), '[]'::jsonb)
)::text) as fingerprint;

create or replace function public.has_any_effective_permission(required_permissions text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from unnest(coalesce(required_permissions, array[]::text[])) required_permission(code)
    where public.has_effective_permission(required_permission.code)
  ), false)
$$;

comment on function public.has_any_effective_permission(text[]) is
  'Returns true when the signed-in employee has at least one requested effective permission after direct denies and MFA requirements are applied.';

revoke all on function public.has_any_effective_permission(text[]) from public, anon;
grant execute on function public.has_any_effective_permission(text[]) to authenticated, service_role;

create or replace function private.require_admin_mfa()
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

  if not public.has_effective_permission('admin.users.manage') then
    raise insufficient_privilege using message = 'User administration permission with MFA is required.';
  end if;

  return actor_id;
end
$$;

create or replace function private.require_import_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_effective_permission('admin.security.manage') then
    raise insufficient_privilege
      using message = 'Security administration permission with MFA is required for source-data review.';
  end if;
end
$$;

create or replace function private.require_licensing_mfa(required_permission text default 'licensing.view')
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

  if not public.has_effective_permission(required_permission) then
    raise insufficient_privilege using message = 'The required Licensing Center permission with MFA is required.';
  end if;

  return actor_id;
end
$$;

create or replace function private.require_credential_editor_mfa()
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

  if not public.has_any_effective_permission(array['licensing.manage', 'directory.edit_credentials']) then
    raise insufficient_privilege using message = 'Credential editor permission with MFA is required.';
  end if;

  return actor_id;
end
$$;

create or replace function private.can_manage_schedule_drafts()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_any_effective_permission(array['schedule.manage', 'scheduler.manage'])
$$;

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
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if admin_role_required and not public.has_effective_permission('admin.roles.manage') then
    raise insufficient_privilege using message = 'Role administration permission with MFA is required for this protected action.';
  end if;

  if not public.has_any_effective_permission(required_permissions) then
    raise insufficient_privilege using message = 'The required user administration permission with MFA is required.';
  end if;

  return actor_id;
end
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

  if not public.has_effective_permission('sites.manage') then
    raise insufficient_privilege using message = 'Sites and posts management permission with MFA is required.';
  end if;

  return actor_id;
end
$$;

create or replace function public.can_manage_licensing()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_effective_permission('licensing.manage')
$$;

-- Replace only known authorization fragments in the current production
-- definitions. Each replacement is asserted so schema drift fails closed.
create or replace function pg_temp.replace_function_authorization(
  target_signature text,
  expected_fragment text,
  replacement_fragment text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  target_oid regprocedure := to_regprocedure(target_signature);
  definition text;
begin
  if target_oid is null then
    raise exception 'Required function % was not found.', target_signature;
  end if;

  definition := pg_get_functiondef(target_oid::oid);
  if strpos(definition, expected_fragment) = 0 then
    raise exception 'Authorization boundary in % did not match the reviewed definition.', target_signature;
  end if;

  execute replace(definition, expected_fragment, replacement_fragment);
end
$$;

select pg_temp.replace_function_authorization(
  'private.ensure_schedule_draft_unmerged(date)',
  'actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa()',
  'actor_id is null or not public.has_effective_permission(''schedule.manage'')'
);
select pg_temp.replace_function_authorization(
  'private.publish_schedule_draft_unmerged(uuid)',
  'actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa()',
  'actor_id is null or not public.has_effective_permission(''schedule.publish'')'
);
select pg_temp.replace_function_authorization(
  'private.remove_schedule_draft_shift_unmerged(uuid,text)',
  'actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa()',
  'actor_id is null or not public.has_effective_permission(''schedule.delete_shift'')'
);
select pg_temp.replace_function_authorization(
  'public.cancel_schedule_draft(uuid)',
  'actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa()',
  'actor_id is null or not public.has_effective_permission(''schedule.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.cancel_employee_availability(uuid,text)',
  'actor_id is null or public.current_app_role() not in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'') or not public.has_mfa()',
  'actor_id is null or not public.has_effective_permission(''availability.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_payroll_rules()',
  'not public.is_supervisor_or_admin() or not public.has_mfa()',
  'not public.has_any_effective_permission(array[''time.manage'', ''time.export_payroll''])'
);
select pg_temp.replace_function_authorization(
  'public.request_time_event_correction(uuid,timestamp with time zone,boolean,text)',
  'public.is_supervisor_or_admin() and public.has_mfa()',
  'public.has_any_effective_permission(array[''time.manage'', ''time.adjustments.review'', ''time.manual_entry.edit''])'
);
select pg_temp.replace_function_authorization(
  'public.supervisor_correct_time_event_details(uuid,timestamp with time zone,public.time_event_kind,boolean,text)',
  'not public.is_supervisor_or_admin() or not public.has_mfa()',
  'not public.has_any_effective_permission(array[''time.manage'', ''time.manual_entry.edit''])'
);
select pg_temp.replace_function_authorization(
  'public.supervisor_update_time_event_location(uuid,text,text,text)',
  'not public.is_supervisor_or_admin() or not public.has_mfa()',
  'not public.has_any_effective_permission(array[''time.manage'', ''time.manual_entry.edit''])'
);
select pg_temp.replace_function_authorization(
  'public.admin_create_employee(text,text,text,text,public.app_role,public.employment_type,public.employee_status,text,text,text,text,text)',
  'target_role = ''admin'' and not public.is_admin()',
  'target_role = ''admin'' and not public.has_effective_permission(''admin.roles.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.admin_separate_employee(uuid,text,date)',
  '(before_record ->> ''role'') = ''admin'' and not public.is_admin()',
  '(before_record ->> ''role'') = ''admin'' and not public.has_effective_permission(''admin.roles.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.admin_update_employee(uuid,text,text,text,text,public.app_role,public.employment_type,public.employee_status,text,text,text,text,text)',
  'if not public.is_admin() then',
  'if not public.has_effective_permission(''admin.roles.manage'') then'
);
select pg_temp.replace_function_authorization(
  'public.get_licensing_center()',
  'public.has_role_permission(''licensing.manage'') or public.current_app_role() = ''admin''',
  'public.has_effective_permission(''licensing.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_licensing_center()',
  'public.has_role_permission(''licensing.configure'') or public.current_app_role() = ''admin''',
  'public.has_effective_permission(''licensing.configure'')'
);
select pg_temp.replace_function_authorization(
  'public.get_licensing_center()',
  'public.has_role_permission(''licensing.communicate'') or public.current_app_role() = ''admin''',
  'public.has_effective_permission(''licensing.communicate'')'
);
select pg_temp.replace_function_authorization(
  'public.get_session_context()',
  'employee.role in (''dispatcher'', ''scheduler'', ''recruiting_licensing'', ''supervisor'', ''admin'')',
  'exists (select 1 from public.access_roles base_role where base_role.base_app_role = employee.role and base_role.system_role and base_role.active and base_role.mfa_required)'
);
select pg_temp.replace_function_authorization(
  'public.upsert_licensing_employee(uuid,text,text,text,text,text,public.employment_type,public.employee_status,text,text,text,public.app_role)',
  'actor_role public.app_role := public.current_app_role();',
  'can_manage_roles boolean := public.has_effective_permission(''admin.roles.manage'');'
);
select pg_temp.replace_function_authorization(
  'public.upsert_licensing_employee(uuid,text,text,text,text,text,public.employment_type,public.employee_status,text,text,text,public.app_role)',
  'actor_role <> ''admin''',
  'not can_manage_roles'
);
select pg_temp.replace_function_authorization(
  'public.admin_upsert_employee_credential(uuid,public.credential_kind,public.credential_status,text,date,date,text)',
  'actor_id := private.require_admin_mfa();',
  'actor_id := private.require_credential_editor_mfa();'
);
select pg_temp.replace_function_authorization(
  'private.can_override_schedule_warnings()',
  'public.has_effective_permission(''schedule.override_warnings'')
      or public.is_supervisor_or_admin()',
  'public.has_effective_permission(''schedule.override_warnings'')'
);
select pg_temp.replace_function_authorization(
  'private.get_timekeeping_review_base(date,date)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''time.manage'')',
  'public.has_effective_permission(''time.view'')
      or public.has_effective_permission(''time.manage'')'
);
select pg_temp.replace_function_authorization(
  'private.get_timekeeping_review_operations_base(date,date)',
  'public.is_supervisor_or_admin()
    or public.has_effective_permission(''time.manage'')',
  'public.has_effective_permission(''time.view'')
    or public.has_effective_permission(''time.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.create_payroll_export_batch(date,date,text)',
  'public.is_supervisor_or_admin()
    or public.has_effective_permission(''time.export_payroll'')',
  'public.has_effective_permission(''time.export_payroll'')'
);
select pg_temp.replace_function_authorization(
  'public.decide_availability_request(uuid,public.request_status,text)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''availability.manage'')',
  'public.has_effective_permission(''availability.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.decide_shift_request(uuid,public.request_status,text)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''requests.manage'')',
  'public.has_effective_permission(''requests.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.decide_time_off_request(uuid,public.request_status,text)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''requests.manage'')',
  'public.has_effective_permission(''requests.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_availability_workspace(date,date)',
  'viewer_role in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'')
    or public.has_effective_permission(''availability.manage'')',
  'public.has_effective_permission(''availability.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_employee_directory()',
  'public.current_app_role() in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'', ''recruiting_licensing'')
    or public.has_effective_permission(''directory.view'')',
  'public.has_effective_permission(''directory.view'')'
);
select pg_temp.replace_function_authorization(
  'public.get_notification_center()',
  'public.is_supervisor_or_admin()
    or public.has_effective_permission(''notifications.view'')',
  'public.has_effective_permission(''notifications.view'')'
);
select pg_temp.replace_function_authorization(
  'public.get_notification_center()',
  'public.current_app_role() in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'')
      or public.has_effective_permission(''notifications.manage'')',
  'public.has_effective_permission(''notifications.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_open_opportunities_payload()',
  'viewer_role in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'')
    or public.has_effective_permission(''events.manage'')',
  'public.has_effective_permission(''events.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_operations_report()',
  'public.is_supervisor_or_admin()
    or public.has_effective_permission(''reports.view'')',
  'public.has_effective_permission(''reports.view'')'
);
select pg_temp.replace_function_authorization(
  'public.get_overview_metrics_payload()',
  'public.has_effective_permission(''operations.view'')
    or public.current_app_role() in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'')',
  'public.has_effective_permission(''operations.view'')'
);
select pg_temp.replace_function_authorization(
  'public.get_patrol_coverage()',
  'viewer_role in (''dispatcher'', ''supervisor'', ''admin'')
        or public.has_effective_permission(''patrol.manage'')',
  'public.has_effective_permission(''patrol.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_payroll_accountability_events(date,date)',
  'actor_role in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'')
    or public.has_effective_permission(''time.view'')',
  'public.has_effective_permission(''time.view'')'
);
select pg_temp.replace_function_authorization(
  'public.get_payroll_export_batch_detail(uuid)',
  'public.is_supervisor_or_admin()
    or public.has_effective_permission(''time.export_payroll'')',
  'public.has_effective_permission(''time.export_payroll'')'
);
select pg_temp.replace_function_authorization(
  'public.get_payroll_export_history(integer)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''time.view'')',
  'public.has_effective_permission(''time.view'')'
);
select pg_temp.replace_function_authorization(
  'public.get_removed_employee_ids()',
  'public.has_effective_permission(''admin.users.view'')
    or public.is_admin()',
  'public.has_effective_permission(''admin.users.view'')'
);
select pg_temp.replace_function_authorization(
  'public.get_request_center_payload()',
  'viewer_role in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'')
    or public.has_effective_permission(''requests.manage'')',
  'public.has_effective_permission(''requests.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_shift_work_type_map(date)',
  'public.has_effective_permission(''schedule.manage'')
    or actor_role in (''admin'', ''supervisor'', ''scheduler'', ''dispatcher'')',
  'public.has_effective_permission(''schedule.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_sites_payload()',
  'public.has_effective_permission(''sites.manage'')
    or public.current_app_role() in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'')',
  'public.has_effective_permission(''sites.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_team_attendance_summary(date,date)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''time.view'')',
  'public.has_effective_permission(''time.view'')'
);
select pg_temp.replace_function_authorization(
  'public.get_team_attendance_totals(date,date)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''time.view'')',
  'public.has_effective_permission(''time.view'')'
);
select pg_temp.replace_function_authorization(
  'public.get_time_maintenance(date,date,uuid)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''time.manage'')',
  'public.has_effective_permission(''time.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_time_maintenance_shift_options(date,date,uuid)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''time.manage'')',
  'public.has_effective_permission(''time.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.get_weekly_schedule_payload(date)',
  'public.has_effective_permission(''schedule.view'')
    or viewer_role in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'')',
  'public.has_effective_permission(''schedule.view'')'
);
select pg_temp.replace_function_authorization(
  'public.publish_call_off_opening(uuid,text,text)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''requests.manage'')',
  'public.has_effective_permission(''requests.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.review_time_event_correction(uuid,boolean,text)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''time.manage'')',
  'public.has_effective_permission(''time.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.submit_availability_request(uuid,date,date,integer,time without time zone,time without time zone,text,text)',
  'actor_role in (''dispatcher'', ''scheduler'', ''supervisor'', ''admin'')
      or public.has_effective_permission(''availability.manage'')',
  'public.has_effective_permission(''availability.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.supervisor_correct_time_event(uuid,timestamp with time zone,boolean,text)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''time.manage'')',
  'public.has_effective_permission(''time.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.supervisor_record_time_event(uuid,public.time_event_kind,timestamp with time zone,uuid,text,text)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''time.manage'')',
  'public.has_effective_permission(''time.manage'')'
);
select pg_temp.replace_function_authorization(
  'public.supervisor_update_time_event_site_post(uuid,uuid,text)',
  'public.is_supervisor_or_admin()
      or public.has_effective_permission(''time.manage'')',
  'public.has_effective_permission(''time.manage'')'
);

-- RLS now consumes the same effective-permission model as the application and
-- RPC boundary. Direct permission denies therefore take effect everywhere.
drop policy if exists announcement_templates_admin_write on public.announcement_templates;
create policy announcement_templates_admin_write on public.announcement_templates
for all to authenticated
using (public.has_any_effective_permission(array['announcements.send', 'announcements.banner.manage']))
with check (public.has_any_effective_permission(array['announcements.send', 'announcements.banner.manage']));

drop policy if exists announcement_templates_read on public.announcement_templates;
create policy announcement_templates_read on public.announcement_templates
for select to authenticated
using (is_active and public.has_any_effective_permission(array['announcements.send', 'announcements.banner.manage']));

drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements
for select to authenticated
using (
  (published_at is not null and (expires_at is null or expires_at > now()))
  or public.has_any_effective_permission(array['announcements.send', 'announcements.banner.manage'])
);

drop policy if exists announcements_supervisor_write on public.announcements;
create policy announcements_supervisor_write on public.announcements
for all to authenticated
using (public.has_any_effective_permission(array['announcements.send', 'announcements.banner.manage']))
with check (public.has_any_effective_permission(array['announcements.send', 'announcements.banner.manage']));

drop policy if exists call_off_read on public.call_off_reports;
create policy call_off_read on public.call_off_reports
for select to authenticated
using (
  employee_id = public.current_employee_id()
  or public.has_any_effective_permission(array['accountability.view', 'accountability.manage'])
);

drop policy if exists attendance_accountability_self_select on public.attendance_accountability_events;
create policy attendance_accountability_self_select on public.attendance_accountability_events
for select to authenticated
using (
  employee_id = public.current_employee_id()
  or public.has_any_effective_permission(array[
    'accountability.view',
    'accountability.manage',
    'time.view',
    'time.manage',
    'time.export_payroll'
  ])
);

drop policy if exists call_off_supervisor_update on public.call_off_reports;
create policy call_off_supervisor_update on public.call_off_reports
for update to authenticated
using (public.has_effective_permission('accountability.manage'))
with check (public.has_effective_permission('accountability.manage'));

drop policy if exists employee_availability_ops_write on public.employee_availability;
create policy employee_availability_ops_write on public.employee_availability
for all to authenticated
using (public.has_effective_permission('availability.manage'))
with check (public.has_effective_permission('availability.manage'));

drop policy if exists employee_availability_read on public.employee_availability;
create policy employee_availability_read on public.employee_availability
for select to authenticated
using (
  employee_id = public.current_employee_id()
  or public.has_any_effective_permission(array['availability.view', 'availability.manage'])
);

drop policy if exists credentials_admin_write on public.employee_credentials;
create policy credentials_admin_write on public.employee_credentials
for all to authenticated
using (public.has_any_effective_permission(array['licensing.manage', 'directory.edit_credentials']))
with check (public.has_any_effective_permission(array['licensing.manage', 'directory.edit_credentials']));

drop policy if exists credentials_read on public.employee_credentials;
create policy credentials_read on public.employee_credentials
for select to authenticated
using (
  employee_id = public.current_employee_id()
  or public.has_any_effective_permission(array['licensing.view', 'licensing.manage', 'directory.edit_credentials'])
);

drop policy if exists employees_admin_insert on public.employees;
create policy employees_admin_insert on public.employees
for insert to authenticated
with check (public.has_any_effective_permission(array['admin.users.basic', 'admin.users.manage']));

drop policy if exists employees_admin_update on public.employees;
create policy employees_admin_update on public.employees
for update to authenticated
using (public.has_any_effective_permission(array['admin.users.basic', 'admin.users.manage']))
with check (public.has_any_effective_permission(array['admin.users.basic', 'admin.users.manage']));

drop policy if exists employees_read on public.employees;
create policy employees_read on public.employees
for select to authenticated
using (
  status = 'active'
  or id = public.current_employee_id()
  or public.has_any_effective_permission(array['directory.view', 'licensing.view', 'admin.users.view', 'admin.users.basic', 'admin.users.manage'])
);

drop policy if exists events_read on public.events;
create policy events_read on public.events
for select to authenticated
using (active or public.has_any_effective_permission(array['events.manage', 'shift_pool.manage']));

drop policy if exists events_supervisor_write on public.events;
create policy events_supervisor_write on public.events
for all to authenticated
using (public.has_any_effective_permission(array['events.manage', 'shift_pool.manage']))
with check (public.has_any_effective_permission(array['events.manage', 'shift_pool.manage']));

drop policy if exists posts_read on public.posts;
create policy posts_read on public.posts
for select to authenticated
using (active or public.has_effective_permission('sites.manage'));

drop policy if exists posts_supervisor_write on public.posts;
create policy posts_supervisor_write on public.posts
for all to authenticated
using (public.has_effective_permission('sites.manage'))
with check (public.has_effective_permission('sites.manage'));

drop policy if exists "Operations can create schedule assignment overrides" on public.schedule_assignment_overrides;
create policy "Operations can create schedule assignment overrides" on public.schedule_assignment_overrides
for insert to authenticated
with check (public.has_effective_permission('schedule.override_warnings'));

drop policy if exists "Operations can read schedule assignment overrides" on public.schedule_assignment_overrides;
create policy "Operations can read schedule assignment overrides" on public.schedule_assignment_overrides
for select to authenticated
using (
  employee_id = public.current_employee_id()
  or public.has_any_effective_permission(array['schedule.manage', 'schedule.override_warnings'])
);

drop policy if exists schedules_read on public.schedules;
create policy schedules_read on public.schedules
for select to authenticated
using (
  status = 'published'
  or public.has_any_effective_permission(array['schedule.manage', 'scheduler.manage'])
);

drop policy if exists schedules_supervisor_write on public.schedules;
create policy schedules_supervisor_write on public.schedules
for all to authenticated
using (public.has_any_effective_permission(array['schedule.manage', 'schedule.publish', 'schedule.delete_shift']))
with check (public.has_any_effective_permission(array['schedule.manage', 'schedule.publish', 'schedule.delete_shift']));

drop policy if exists assignments_read on public.shift_assignments;
create policy assignments_read on public.shift_assignments
for select to authenticated
using (
  public.has_any_effective_permission(array['schedule.manage', 'scheduler.manage'])
  or exists (
    select 1
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    where shift.id = shift_assignments.shift_id
      and schedule.status = 'published'
  )
);

drop policy if exists assignments_supervisor_write on public.shift_assignments;
create policy assignments_supervisor_write on public.shift_assignments
for all to authenticated
using (public.has_effective_permission('schedule.manage'))
with check (public.has_effective_permission('schedule.manage'));

drop policy if exists shift_requests_read on public.shift_requests;
create policy shift_requests_read on public.shift_requests
for select to authenticated
using (
  employee_id = public.current_employee_id()
  or public.has_any_effective_permission(array['requests.manage', 'shift_pool.manage'])
);

drop policy if exists shift_requests_supervisor_update on public.shift_requests;
create policy shift_requests_supervisor_update on public.shift_requests
for update to authenticated
using (public.has_any_effective_permission(array['requests.manage', 'shift_pool.manage']))
with check (public.has_any_effective_permission(array['requests.manage', 'shift_pool.manage']));

drop policy if exists shifts_read on public.shifts;
create policy shifts_read on public.shifts
for select to authenticated
using (
  public.has_any_effective_permission(array['schedule.manage', 'scheduler.manage'])
  or (
    exists (
      select 1 from public.schedules schedule
      where schedule.id = shifts.schedule_id and schedule.status = 'published'
    )
    and (
      not requires_armed
      or public.has_valid_credential(
        public.current_employee_id(),
        'armed_guard',
        (starts_at at time zone time_zone)::date
      )
    )
  )
);

drop policy if exists shifts_supervisor_write on public.shifts;
create policy shifts_supervisor_write on public.shifts
for all to authenticated
using (public.has_effective_permission('schedule.manage'))
with check (public.has_effective_permission('schedule.manage'));

drop policy if exists sites_admin_write on public.sites;
create policy sites_admin_write on public.sites
for all to authenticated
using (public.has_effective_permission('sites.manage'))
with check (public.has_effective_permission('sites.manage'));

drop policy if exists sites_read on public.sites;
create policy sites_read on public.sites
for select to authenticated
using (active or public.has_effective_permission('sites.manage'));

drop policy if exists time_event_corrections_read on public.time_event_corrections;
create policy time_event_corrections_read on public.time_event_corrections
for select to authenticated
using (
  public.has_any_effective_permission(array['time.view', 'time.manage', 'time.resolve_exceptions', 'time.export_payroll'])
  or exists (
    select 1 from public.time_events event
    where event.id = time_event_corrections.time_event_id
      and event.employee_id = public.current_employee_id()
  )
);

drop policy if exists time_event_maintenance_notes_read on public.time_event_maintenance_notes;
create policy time_event_maintenance_notes_read on public.time_event_maintenance_notes
for select to authenticated
using (
  public.has_any_effective_permission(array['time.view', 'time.manage', 'time.resolve_exceptions', 'time.export_payroll'])
  or exists (
    select 1 from public.time_events event
    where event.id = time_event_maintenance_notes.time_event_id
      and event.employee_id = public.current_employee_id()
  )
);

drop policy if exists time_event_location_overrides_read on public.time_event_location_overrides;
create policy time_event_location_overrides_read on public.time_event_location_overrides
for select to authenticated
using (
  public.has_any_effective_permission(array['time.view', 'time.manage', 'time.resolve_exceptions', 'time.export_payroll'])
  or exists (
    select 1 from public.time_events event
    where event.id = time_event_location_overrides.time_event_id
      and event.employee_id = public.current_employee_id()
  )
);

drop policy if exists time_event_shift_overrides_read on public.time_event_shift_overrides;
create policy time_event_shift_overrides_read on public.time_event_shift_overrides
for select to authenticated
using (
  public.has_any_effective_permission(array['time.view', 'time.manage', 'time.resolve_exceptions', 'time.export_payroll'])
  or exists (
    select 1 from public.time_events event
    where event.id = time_event_shift_overrides.time_event_id
      and event.employee_id = public.current_employee_id()
  )
);

drop policy if exists time_events_read on public.time_events;
create policy time_events_read on public.time_events
for select to authenticated
using (
  employee_id = public.current_employee_id()
  or public.has_any_effective_permission(array['time.view', 'time.manage', 'time.resolve_exceptions', 'time.export_payroll'])
);

drop policy if exists time_off_read on public.time_off_requests;
create policy time_off_read on public.time_off_requests
for select to authenticated
using (
  employee_id = public.current_employee_id()
  or public.has_effective_permission('requests.manage')
);

drop policy if exists time_off_supervisor_update on public.time_off_requests;
create policy time_off_supervisor_update on public.time_off_requests
for update to authenticated
using (public.has_effective_permission('requests.manage'))
with check (public.has_effective_permission('requests.manage'));

drop policy if exists sygshift_credential_documents_privileged_access on storage.objects;
create policy sygshift_credential_documents_privileged_access on storage.objects
for all to authenticated
using (
  bucket_id = 'credential-documents'
  and public.has_any_effective_permission(array['licensing.view', 'licensing.manage', 'directory.edit_credentials'])
)
with check (
  bucket_id = 'credential-documents'
  and public.has_any_effective_permission(array['licensing.manage', 'directory.edit_credentials'])
);

drop policy if exists sygshift_employee_photos_privileged_read on storage.objects;
create policy sygshift_employee_photos_privileged_read on storage.objects
for select to authenticated
using (bucket_id = 'employee-photos' and public.has_effective_permission('directory.view'));

drop policy if exists sygshift_employee_photos_privileged_write on storage.objects;
create policy sygshift_employee_photos_privileged_write on storage.objects
for all to authenticated
using (bucket_id = 'employee-photos' and public.has_effective_permission('directory.edit_basic'))
with check (bucket_id = 'employee-photos' and public.has_effective_permission('directory.edit_basic'));

drop policy if exists sygshift_payroll_exports_admin_access on storage.objects;
create policy sygshift_payroll_exports_admin_access on storage.objects
for all to authenticated
using (bucket_id = 'payroll-exports' and public.has_effective_permission('time.export_payroll'))
with check (bucket_id = 'payroll-exports' and public.has_effective_permission('time.export_payroll'));

drop policy if exists sygshift_source_imports_admin_access on storage.objects;
create policy sygshift_source_imports_admin_access on storage.objects
for all to authenticated
using (bucket_id = 'source-imports' and public.has_effective_permission('admin.security.manage'))
with check (bucket_id = 'source-imports' and public.has_effective_permission('admin.security.manage'));

-- Private helpers are internal implementation details, never client RPCs.
revoke execute on all functions in schema private from public, anon, authenticated;

-- Public RPCs require authentication unless explicitly implemented as an
-- unauthenticated endpoint. These four administration/session functions are
-- not public entry points.
revoke execute on function public.admin_remove_separated_employee(uuid,text,text) from anon;
revoke execute on function public.get_employee_removal_preview(uuid) from anon;
revoke execute on function public.get_removed_employee_ids() from anon;
revoke execute on function public.get_session_context() from anon;

do $$
declare
  before_fingerprint text;
  after_fingerprint text;
begin
  select fingerprint into before_fingerprint from access_integrity_before;

  select md5(jsonb_build_object(
    'rolePermissions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'roleId', permission.role_id,
          'permissionCode', permission.permission_code,
          'enabled', permission.enabled
        ) order by permission.role_id, permission.permission_code
      )
      from public.access_role_permissions permission
    ), '[]'::jsonb),
    'employeeRoles', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'employeeId', assignment.employee_id,
          'roleId', assignment.role_id
        ) order by assignment.employee_id, assignment.role_id
      )
      from public.employee_access_roles assignment
    ), '[]'::jsonb),
    'overrides', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'employeeId', override.employee_id,
          'permissionCode', override.permission_code,
          'effect', override.effect,
          'active', override.active,
          'reason', override.reason
        ) order by override.employee_id, override.permission_code
      )
      from public.employee_permission_overrides override
    ), '[]'::jsonb),
    'primaryRoles', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'employeeId', employee.id,
          'role', employee.role,
          'status', employee.status
        ) order by employee.id
      )
      from public.employees employee
    ), '[]'::jsonb)
  )::text) into after_fingerprint;

  if before_fingerprint is distinct from after_fingerprint then
    raise exception 'Access assignment integrity check failed; the migration was rolled back.';
  end if;
end
$$;

commit;
