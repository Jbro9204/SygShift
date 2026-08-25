begin;

insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
)
values (
  'admin.maintenance.manage',
  'Administration',
  'Manage maintenance and releases',
  'Schedule maintenance notices, place affected features into a controlled read-only state, and close maintenance windows.',
  'critical',
  true,
  true,
  true
)
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = excluded.active,
    updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, 'admin.maintenance.manage', true
from public.access_roles access_role
where access_role.code = 'system_admin'
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

create table if not exists public.maintenance_windows (
  id uuid primary key default gen_random_uuid(),
  release_kind text not null,
  access_mode text not null,
  title text not null,
  message text not null,
  completion_message text,
  release_version text,
  feature_codes text[] not null default array[]::text[],
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled',
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.employees(id) on delete restrict,
  updated_at timestamptz not null default now(),
  closed_by uuid references public.employees(id) on delete restrict,
  closed_at timestamptz,
  constraint maintenance_windows_release_kind_check
    check (release_kind in ('routine', 'planned', 'major', 'emergency')),
  constraint maintenance_windows_access_mode_check
    check (access_mode in ('notice', 'read_only', 'unavailable')),
  constraint maintenance_windows_status_check
    check (status in ('scheduled', 'completed', 'canceled')),
  constraint maintenance_windows_title_present check (btrim(title) <> ''),
  constraint maintenance_windows_message_present check (btrim(message) <> ''),
  constraint maintenance_windows_duration_check check (ends_at > starts_at),
  constraint maintenance_windows_features_present check (cardinality(feature_codes) > 0),
  constraint maintenance_windows_features_known check (
    feature_codes <@ array[
      'schedule',
      'events_openings',
      'time_clock',
      'time_attendance',
      'payroll',
      'directory',
      'licensing',
      'availability',
      'sites_posts',
      'patrol',
      'requests',
      'communications',
      'user_accounts',
      'roles_permissions',
      'training'
    ]::text[]
  )
);

create index if not exists maintenance_windows_active_range_idx
  on public.maintenance_windows(status, starts_at, ends_at);

alter table public.maintenance_windows enable row level security;
revoke all on table public.maintenance_windows from public, anon, authenticated;

create or replace function private.require_maintenance_admin()
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

  if not public.has_effective_permission('admin.maintenance.manage') then
    raise insufficient_privilege using message = 'Maintenance administration permission with MFA is required.';
  end if;

  return actor_id;
end
$$;

create or replace function public.get_maintenance_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'serverTime', now(),
    'active', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mw.id,
        'releaseKind', mw.release_kind,
        'accessMode', mw.access_mode,
        'title', mw.title,
        'message', mw.message,
        'completionMessage', mw.completion_message,
        'releaseVersion', mw.release_version,
        'featureCodes', mw.feature_codes,
        'startsAt', mw.starts_at,
        'endsAt', mw.ends_at,
        'status', mw.status
      ) order by mw.starts_at, mw.created_at)
      from public.maintenance_windows mw
      where mw.status = 'scheduled'
        and mw.starts_at <= now()
        and mw.ends_at > now()
    ), '[]'::jsonb),
    'upcoming', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', upcoming.id,
        'releaseKind', upcoming.release_kind,
        'accessMode', upcoming.access_mode,
        'title', upcoming.title,
        'message', upcoming.message,
        'completionMessage', upcoming.completion_message,
        'releaseVersion', upcoming.release_version,
        'featureCodes', upcoming.feature_codes,
        'startsAt', upcoming.starts_at,
        'endsAt', upcoming.ends_at,
        'status', upcoming.status
      ) order by upcoming.starts_at, upcoming.created_at)
      from (
        select mw.*
        from public.maintenance_windows mw
        where mw.status = 'scheduled'
          and mw.starts_at > now()
          and mw.starts_at <= now() + interval '48 hours'
        order by mw.starts_at, mw.created_at
        limit 3
      ) upcoming
    ), '[]'::jsonb),
    'recentlyCompleted', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', completed.id,
        'releaseKind', completed.release_kind,
        'accessMode', completed.access_mode,
        'title', completed.title,
        'message', completed.message,
        'completionMessage', completed.completion_message,
        'releaseVersion', completed.release_version,
        'featureCodes', completed.feature_codes,
        'startsAt', completed.starts_at,
        'endsAt', completed.ends_at,
        'status', completed.status
      ) order by completed.closed_at desc)
      from (
        select mw.*
        from public.maintenance_windows mw
        where mw.status = 'completed'
          and mw.closed_at > now() - interval '2 hours'
          and mw.completion_message is not null
        order by mw.closed_at desc
        limit 1
      ) completed
    ), '[]'::jsonb)
  )
$$;

create or replace function public.get_maintenance_admin_workspace()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_maintenance_admin();

  return jsonb_build_object(
    'generatedAt', now(),
    'windows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mw.id,
        'releaseKind', mw.release_kind,
        'accessMode', mw.access_mode,
        'title', mw.title,
        'message', mw.message,
        'completionMessage', mw.completion_message,
        'releaseVersion', mw.release_version,
        'featureCodes', mw.feature_codes,
        'startsAt', mw.starts_at,
        'endsAt', mw.ends_at,
        'status', case
          when mw.status = 'scheduled' and mw.ends_at <= now() then 'expired'
          when mw.status = 'scheduled' and mw.starts_at <= now() then 'active'
          else mw.status
        end,
        'createdAt', mw.created_at,
        'updatedAt', mw.updated_at,
        'closedAt', mw.closed_at
      ) order by mw.created_at desc)
      from (
        select item.*
        from public.maintenance_windows item
        order by item.created_at desc
        limit 50
      ) mw
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.save_maintenance_window(
  target_id uuid,
  target_release_kind text,
  target_access_mode text,
  target_title text,
  target_message text,
  target_completion_message text,
  target_release_version text,
  target_feature_codes text[],
  target_starts_at timestamptz,
  target_ends_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_maintenance_admin();
  saved_id uuid;
  clean_features text[];
  old_record jsonb;
  new_record jsonb;
begin
  clean_features := array(
    select distinct btrim(feature)
    from unnest(coalesce(target_feature_codes, array[]::text[])) feature
    where btrim(feature) <> ''
    order by btrim(feature)
  );

  if target_release_kind not in ('routine', 'planned', 'major', 'emergency') then
    raise check_violation using message = 'Choose a valid release type.';
  end if;
  if target_access_mode not in ('notice', 'read_only', 'unavailable') then
    raise check_violation using message = 'Choose a valid access mode.';
  end if;
  if btrim(coalesce(target_title, '')) = '' or btrim(coalesce(target_message, '')) = '' then
    raise check_violation using message = 'A title and employee-facing message are required.';
  end if;
  if target_starts_at is null or target_ends_at is null or target_ends_at <= target_starts_at then
    raise check_violation using message = 'The maintenance end must be after its start.';
  end if;
  if target_ends_at <= now() then
    raise check_violation using message = 'The maintenance window must end in the future.';
  end if;
  if target_ends_at > target_starts_at + interval '24 hours' then
    raise check_violation using message = 'A maintenance window cannot remain active for more than 24 hours.';
  end if;
  if cardinality(clean_features) = 0 then
    raise check_violation using message = 'Choose at least one affected feature.';
  end if;

  if exists (
    select 1
    from public.maintenance_windows existing
    where existing.status = 'scheduled'
      and existing.id is distinct from target_id
      and existing.starts_at < target_ends_at
      and existing.ends_at > target_starts_at
  ) then
    raise check_violation using message = 'Another maintenance window is already scheduled during this time.';
  end if;

  if target_id is null then
    insert into public.maintenance_windows (
      release_kind,
      access_mode,
      title,
      message,
      completion_message,
      release_version,
      feature_codes,
      starts_at,
      ends_at,
      created_by,
      updated_by
    ) values (
      target_release_kind,
      target_access_mode,
      btrim(target_title),
      btrim(target_message),
      nullif(btrim(coalesce(target_completion_message, '')), ''),
      nullif(btrim(coalesce(target_release_version, '')), ''),
      clean_features,
      target_starts_at,
      target_ends_at,
      actor_id,
      actor_id
    ) returning id into saved_id;

    select to_jsonb(mw.*)
      into new_record
    from public.maintenance_windows mw
    where mw.id = saved_id;
  else
    select to_jsonb(mw.*)
      into old_record
    from public.maintenance_windows mw
    where mw.id = target_id
    for update;

    if old_record is null then
      raise no_data_found using message = 'The maintenance window no longer exists.';
    end if;
    if old_record ->> 'status' <> 'scheduled' then
      raise check_violation using message = 'Completed or canceled maintenance history cannot be edited.';
    end if;

    update public.maintenance_windows mw
    set release_kind = target_release_kind,
        access_mode = target_access_mode,
        title = btrim(target_title),
        message = btrim(target_message),
        completion_message = nullif(btrim(coalesce(target_completion_message, '')), ''),
        release_version = nullif(btrim(coalesce(target_release_version, '')), ''),
        feature_codes = clean_features,
        starts_at = target_starts_at,
        ends_at = target_ends_at,
        updated_by = actor_id,
        updated_at = now()
    where mw.id = target_id
    returning mw.id into saved_id;

    select to_jsonb(mw.*)
      into new_record
    from public.maintenance_windows mw
    where mw.id = saved_id;
  end if;

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
    auth.uid(),
    actor_id,
    'public',
    'maintenance_windows',
    case when target_id is null then 'INSERT' else 'UPDATE' end,
    saved_id::text,
    old_record,
    new_record
  );

  return public.get_maintenance_admin_workspace();
end
$$;

create or replace function public.close_maintenance_window(
  target_id uuid,
  target_action text,
  target_completion_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_maintenance_admin();
  old_record jsonb;
  new_record jsonb;
begin
  if target_action not in ('complete', 'cancel') then
    raise check_violation using message = 'Choose complete or cancel.';
  end if;

  select to_jsonb(mw.*)
    into old_record
  from public.maintenance_windows mw
  where mw.id = target_id
  for update;

  if old_record is null then
    raise no_data_found using message = 'The maintenance window no longer exists.';
  end if;
  if old_record ->> 'status' <> 'scheduled' then
    raise check_violation using message = 'This maintenance window is already closed.';
  end if;

  update public.maintenance_windows mw
  set status = case when target_action = 'complete' then 'completed' else 'canceled' end,
      completion_message = coalesce(
        nullif(btrim(coalesce(target_completion_message, '')), ''),
        mw.completion_message
      ),
      closed_by = actor_id,
      closed_at = now(),
      updated_by = actor_id,
      updated_at = now()
  where mw.id = target_id;

  select to_jsonb(mw.*)
    into new_record
  from public.maintenance_windows mw
  where mw.id = target_id;

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
    auth.uid(),
    actor_id,
    'public',
    'maintenance_windows',
    upper(target_action),
    target_id::text,
    old_record,
    new_record
  );

  return public.get_maintenance_admin_workspace();
end
$$;

create or replace function private.enforce_maintenance_feature_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  feature_code text := tg_argv[0];
  active_window record;
begin
  select mw.title, mw.access_mode, mw.ends_at
    into active_window
  from public.maintenance_windows mw
  where mw.status = 'scheduled'
    and mw.starts_at <= now()
    and mw.ends_at > now()
    and feature_code = any(mw.feature_codes)
    and mw.access_mode in ('read_only', 'unavailable')
  order by
    case mw.access_mode when 'unavailable' then 2 else 1 end desc,
    mw.starts_at desc
  limit 1;

  if found then
    raise insufficient_privilege using
      message = format('%s is temporarily read-only for scheduled maintenance. Your change was not saved.', active_window.title),
      detail = format('Feature %s is protected until %s.', feature_code, active_window.ends_at);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

do $$
declare
  mapping record;
begin
  for mapping in
    select * from (values
      ('schedule', 'schedules'),
      ('schedule', 'shifts'),
      ('schedule', 'shift_assignments'),
      ('schedule', 'schedule_acknowledgments'),
      ('schedule', 'schedule_assignment_overrides'),
      ('events_openings', 'events'),
      ('events_openings', 'shift_requests'),
      ('time_clock', 'time_events'),
      ('time_attendance', 'manual_time_entries'),
      ('time_attendance', 'manual_time_entry_history'),
      ('time_attendance', 'time_adjustment_requests'),
      ('time_attendance', 'time_adjustment_request_actions'),
      ('time_attendance', 'time_event_corrections'),
      ('time_attendance', 'time_event_work_type_corrections'),
      ('time_attendance', 'time_event_location_overrides'),
      ('time_attendance', 'time_event_shift_overrides'),
      ('time_attendance', 'time_event_occurrence_overrides'),
      ('time_attendance', 'time_event_maintenance_notes'),
      ('time_attendance', 'timekeeping_exception_resolutions'),
      ('time_attendance', 'timekeeping_operational_exceptions'),
      ('time_attendance', 'timekeeping_operational_exception_actions'),
      ('time_attendance', 'attendance_reconciliation_decisions'),
      ('time_attendance', 'attendance_accountability_events'),
      ('time_attendance', 'attendance_accountability_event_actions'),
      ('time_attendance', 'call_off_reports'),
      ('time_attendance', 'call_off_report_actions'),
      ('payroll', 'payroll_batch_assignment_history'),
      ('directory', 'employees'),
      ('licensing', 'employee_credentials'),
      ('licensing', 'employee_credential_documents'),
      ('licensing', 'credential_types'),
      ('licensing', 'credential_requirements'),
      ('licensing', 'employee_work_eligibility_overrides'),
      ('licensing', 'licensing_communications'),
      ('licensing', 'licensing_email_templates'),
      ('availability', 'employee_availability'),
      ('sites_posts', 'sites'),
      ('sites_posts', 'posts'),
      ('requests', 'time_off_requests'),
      ('communications', 'announcements'),
      ('communications', 'announcement_acknowledgments'),
      ('communications', 'announcement_banners'),
      ('communications', 'announcement_templates'),
      ('roles_permissions', 'access_roles'),
      ('roles_permissions', 'access_role_permissions'),
      ('roles_permissions', 'employee_access_roles'),
      ('roles_permissions', 'employee_permission_overrides'),
      ('training', 'training_courses'),
      ('training', 'training_course_versions'),
      ('training', 'training_assignments')
    ) as feature_map(feature_code, table_name)
  loop
    if to_regclass(format('public.%I', mapping.table_name)) is not null then
      execute format('drop trigger if exists maintenance_write_guard on public.%I', mapping.table_name);
      execute format(
        'create trigger maintenance_write_guard before insert or update or delete on public.%I for each row execute function private.enforce_maintenance_feature_write(%L)',
        mapping.table_name,
        mapping.feature_code
      );
    end if;
  end loop;
end
$$;

revoke all on function public.get_maintenance_status() from public, anon;
revoke all on function public.get_maintenance_admin_workspace() from public, anon;
revoke all on function public.save_maintenance_window(uuid, text, text, text, text, text, text, text[], timestamptz, timestamptz) from public, anon;
revoke all on function public.close_maintenance_window(uuid, text, text) from public, anon;

grant execute on function public.get_maintenance_status() to authenticated, service_role;
grant execute on function public.get_maintenance_admin_workspace() to authenticated, service_role;
grant execute on function public.save_maintenance_window(uuid, text, text, text, text, text, text, text[], timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.close_maintenance_window(uuid, text, text) to authenticated, service_role;

comment on table public.maintenance_windows is
  'Audited, automatically expiring maintenance and release communication windows. Empty by default; deployment does not activate maintenance.';
comment on function private.enforce_maintenance_feature_write() is
  'Database-boundary write guard for active feature-specific read-only or unavailable maintenance windows.';

commit;
