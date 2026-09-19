begin;
set local lock_timeout = '5s';

-- Stage B establishes the SygShift-owned communications scope only. It does
-- not create media sessions, browser capabilities, Worker routes, or grants.
create table if not exists private.sygsphere_tenants (
  singleton boolean primary key default true,
  id uuid not null unique default gen_random_uuid(),
  tenant_key text not null unique,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygsphere_tenants_singleton check (singleton),
  constraint sygsphere_tenants_primary_key check (tenant_key = 'sygshift-primary'),
  constraint sygsphere_tenants_display_name_length check (char_length(btrim(display_name)) between 2 and 160)
);

insert into private.sygsphere_tenants (singleton, tenant_key, display_name, active)
values (true, 'sygshift-primary', 'SygShift primary organization', true)
on conflict (singleton) do update
set display_name = excluded.display_name,
    active = true,
    updated_at = clock_timestamp();

alter table private.sygsphere_tenants enable row level security;
alter table private.sygsphere_tenants force row level security;
revoke all on table private.sygsphere_tenants from public, anon, authenticated;

create or replace function private.current_sygsphere_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tenant.id
  from private.sygsphere_tenants tenant
  where tenant.tenant_key = 'sygshift-primary'
    and tenant.active
  limit 1
$$;

-- Permission vocabulary is canonical in shared/sygsphere-communications/v1.
-- Cataloguing it here does not grant access; role assignments remain explicit.
insert into public.permission_catalog (
  code, category, name, description, risk_level, requires_mfa, locked, active
)
values
  ('sygsphere.comms.use', 'SygSphere Communications', 'Use communications', 'Enter an authorized SygSphere communications experience.', 'high', false, true, true),
  ('sygsphere.comms.ptt.listen', 'SygSphere Communications', 'Listen to push-to-talk', 'Receive authorized push-to-talk audio.', 'high', false, true, true),
  ('sygsphere.comms.ptt.transmit', 'SygSphere Communications', 'Transmit push-to-talk', 'Transmit authorized push-to-talk audio.', 'critical', false, true, true),
  ('sygsphere.comms.ptt.priority', 'SygSphere Communications', 'Use priority push-to-talk', 'Transmit on priority push-to-talk channels.', 'critical', true, true, true),
  ('sygsphere.comms.ptt.monitor', 'SygSphere Communications', 'Monitor push-to-talk', 'Monitor authorized push-to-talk activity.', 'critical', true, true, true),
  ('sygsphere.comms.call.start', 'SygSphere Communications', 'Start calls', 'Start authorized direct calls.', 'high', false, true, true),
  ('sygsphere.comms.call.receive', 'SygSphere Communications', 'Receive calls', 'Receive authorized direct calls.', 'high', false, true, true),
  ('sygsphere.comms.meeting.create', 'SygSphere Communications', 'Create meetings', 'Create authorized meetings.', 'high', true, true, true),
  ('sygsphere.comms.video.publish', 'SygSphere Communications', 'Publish video', 'Publish authorized camera video.', 'critical', true, true, true),
  ('sygsphere.comms.screen.publish', 'SygSphere Communications', 'Publish screen share', 'Publish authorized screen sharing.', 'critical', true, true, true),
  ('sygsphere.comms.moderate', 'SygSphere Communications', 'Moderate communications', 'Moderate authorized communications sessions.', 'critical', true, true, true),
  ('sygsphere.comms.history.read', 'SygSphere Communications', 'Read communications history', 'Read authorized communications history.', 'high', true, true, true),
  ('sygsphere.comms.usage.read', 'SygSphere Communications', 'Read communications usage', 'Read authorized communications usage.', 'high', true, true, true),
  ('sygsphere.comms.configure', 'SygSphere Communications', 'Configure communications', 'Configure authorized communications settings.', 'critical', true, true, true)
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = excluded.active,
    updated_at = clock_timestamp();

create or replace function private.sygsphere_comms_permissions(target_employee_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(granted.permission_code order by granted.permission_code), array[]::text[])
  from unnest(private.employee_effective_permissions(target_employee_id)) as granted(permission_code)
  join public.permission_catalog catalog on catalog.code = granted.permission_code
  where catalog.active
    and granted.permission_code like 'sygsphere.comms.%'
$$;

-- This is the only Stage B identity bridge for a future server coordinator.
-- It is service-role-only and never accepts a browser-supplied employee or tenant.
create or replace function public.service_get_sygsphere_communications_context(target_auth_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  tenant_id_value uuid;
  permission_codes text[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  if target_auth_user_id is null then
    raise check_violation using message = 'A communications subject is required.';
  end if;

  select employee.*
  into employee_record
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.auth_user_id = target_auth_user_id
    and account.disabled_at is null
    and employee.status = 'active'
  limit 1;

  if not found then
    raise insufficient_privilege using message = 'The communications subject is not active.';
  end if;

  tenant_id_value := private.current_sygsphere_tenant_id();
  if tenant_id_value is null then
    raise insufficient_privilege using message = 'The communications tenant is unavailable.';
  end if;

  permission_codes := private.sygsphere_comms_permissions(employee_record.id);

  return jsonb_build_object(
    'tenantId', tenant_id_value,
    'employeeId', employee_record.id,
    'authUserId', target_auth_user_id,
    'permissions', permission_codes,
    'canUseCommunications', 'sygsphere.comms.use' = any(permission_codes)
  );
end
$$;

revoke all on function private.current_sygsphere_tenant_id() from public, anon, authenticated;
revoke all on function private.sygsphere_comms_permissions(uuid) from public, anon, authenticated;
revoke all on function public.service_get_sygsphere_communications_context(uuid) from public, anon, authenticated;
grant execute on function private.current_sygsphere_tenant_id() to service_role;
grant execute on function private.sygsphere_comms_permissions(uuid) to service_role;
grant execute on function public.service_get_sygsphere_communications_context(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
