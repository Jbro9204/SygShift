begin;
set local lock_timeout = '5s';

-- Communications is a shared operational tool. Every active application role
-- receives the same basic, user-initiated capabilities: enter the secure
-- communications surface, make/receive a direct call, and use authorized
-- push-to-talk. Higher-risk recording-adjacent, meeting, screen, moderation,
-- history, and configuration capabilities remain deliberately role-bound.
with default_permissions(role_code, permission_code) as (
  values
    ('system_guard', 'sygsphere.comms.use'),
    ('system_guard', 'sygsphere.comms.ptt.listen'),
    ('system_guard', 'sygsphere.comms.ptt.transmit'),
    ('system_guard', 'sygsphere.comms.call.start'),
    ('system_guard', 'sygsphere.comms.call.receive'),

    ('human_resources_employee', 'sygsphere.comms.use'),
    ('human_resources_employee', 'sygsphere.comms.ptt.listen'),
    ('human_resources_employee', 'sygsphere.comms.ptt.transmit'),
    ('human_resources_employee', 'sygsphere.comms.call.start'),
    ('human_resources_employee', 'sygsphere.comms.call.receive'),
    ('human_resources_employee', 'sygsphere.comms.meeting.create'),
    ('human_resources_employee', 'sygsphere.comms.video.publish'),

    ('human_resources', 'sygsphere.comms.use'),
    ('human_resources', 'sygsphere.comms.ptt.listen'),
    ('human_resources', 'sygsphere.comms.ptt.transmit'),
    ('human_resources', 'sygsphere.comms.call.start'),
    ('human_resources', 'sygsphere.comms.call.receive'),
    ('human_resources', 'sygsphere.comms.meeting.create'),
    ('human_resources', 'sygsphere.comms.video.publish'),
    ('human_resources', 'sygsphere.comms.screen.publish'),
    ('human_resources', 'sygsphere.comms.moderate'),
    ('human_resources', 'sygsphere.comms.history.read'),

    ('operations_manager', 'sygsphere.comms.use'),
    ('operations_manager', 'sygsphere.comms.ptt.listen'),
    ('operations_manager', 'sygsphere.comms.ptt.transmit'),
    ('operations_manager', 'sygsphere.comms.ptt.priority'),
    ('operations_manager', 'sygsphere.comms.ptt.monitor'),
    ('operations_manager', 'sygsphere.comms.call.start'),
    ('operations_manager', 'sygsphere.comms.call.receive'),
    ('operations_manager', 'sygsphere.comms.meeting.create'),
    ('operations_manager', 'sygsphere.comms.video.publish'),
    ('operations_manager', 'sygsphere.comms.screen.publish'),
    ('operations_manager', 'sygsphere.comms.moderate'),
    ('operations_manager', 'sygsphere.comms.history.read'),
    ('operations_manager', 'sygsphere.comms.usage.read'),

    ('custom_chief', 'sygsphere.comms.use'),
    ('custom_chief', 'sygsphere.comms.ptt.listen'),
    ('custom_chief', 'sygsphere.comms.ptt.transmit'),
    ('custom_chief', 'sygsphere.comms.ptt.priority'),
    ('custom_chief', 'sygsphere.comms.ptt.monitor'),
    ('custom_chief', 'sygsphere.comms.call.start'),
    ('custom_chief', 'sygsphere.comms.call.receive'),
    ('custom_chief', 'sygsphere.comms.meeting.create'),
    ('custom_chief', 'sygsphere.comms.video.publish'),
    ('custom_chief', 'sygsphere.comms.screen.publish'),
    ('custom_chief', 'sygsphere.comms.moderate'),
    ('custom_chief', 'sygsphere.comms.history.read'),
    ('custom_chief', 'sygsphere.comms.usage.read'),

    ('system_dispatcher', 'sygsphere.comms.use'),
    ('system_dispatcher', 'sygsphere.comms.ptt.listen'),
    ('system_dispatcher', 'sygsphere.comms.ptt.transmit'),
    ('system_dispatcher', 'sygsphere.comms.call.start'),
    ('system_dispatcher', 'sygsphere.comms.call.receive'),
    ('system_dispatcher', 'sygsphere.comms.meeting.create'),
    ('system_dispatcher', 'sygsphere.comms.video.publish'),

    ('system_scheduler', 'sygsphere.comms.use'),
    ('system_scheduler', 'sygsphere.comms.ptt.listen'),
    ('system_scheduler', 'sygsphere.comms.ptt.transmit'),
    ('system_scheduler', 'sygsphere.comms.call.start'),
    ('system_scheduler', 'sygsphere.comms.call.receive'),
    ('system_scheduler', 'sygsphere.comms.meeting.create'),
    ('system_scheduler', 'sygsphere.comms.video.publish'),

    ('system_recruiting_licensing', 'sygsphere.comms.use'),
    ('system_recruiting_licensing', 'sygsphere.comms.ptt.listen'),
    ('system_recruiting_licensing', 'sygsphere.comms.ptt.transmit'),
    ('system_recruiting_licensing', 'sygsphere.comms.call.start'),
    ('system_recruiting_licensing', 'sygsphere.comms.call.receive'),
    ('system_recruiting_licensing', 'sygsphere.comms.meeting.create'),
    ('system_recruiting_licensing', 'sygsphere.comms.video.publish'),

    ('system_supervisor', 'sygsphere.comms.use'),
    ('system_supervisor', 'sygsphere.comms.ptt.listen'),
    ('system_supervisor', 'sygsphere.comms.ptt.transmit'),
    ('system_supervisor', 'sygsphere.comms.call.start'),
    ('system_supervisor', 'sygsphere.comms.call.receive'),
    ('system_supervisor', 'sygsphere.comms.meeting.create'),
    ('system_supervisor', 'sygsphere.comms.video.publish'),
    ('system_supervisor', 'sygsphere.comms.screen.publish'),
    ('system_supervisor', 'sygsphere.comms.moderate'),
    ('system_supervisor', 'sygsphere.comms.history.read'),

    ('system_admin', 'sygsphere.comms.use'),
    ('system_admin', 'sygsphere.comms.ptt.listen'),
    ('system_admin', 'sygsphere.comms.ptt.transmit'),
    ('system_admin', 'sygsphere.comms.ptt.priority'),
    ('system_admin', 'sygsphere.comms.ptt.monitor'),
    ('system_admin', 'sygsphere.comms.call.start'),
    ('system_admin', 'sygsphere.comms.call.receive'),
    ('system_admin', 'sygsphere.comms.meeting.create'),
    ('system_admin', 'sygsphere.comms.video.publish'),
    ('system_admin', 'sygsphere.comms.screen.publish'),
    ('system_admin', 'sygsphere.comms.moderate'),
    ('system_admin', 'sygsphere.comms.history.read'),
    ('system_admin', 'sygsphere.comms.usage.read'),
    ('system_admin', 'sygsphere.comms.configure')
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, defaults.permission_code, true
from default_permissions defaults
join public.access_roles role on role.code = defaults.role_code and role.active
join public.permission_catalog permission on permission.code = defaults.permission_code and permission.active
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

-- Fail the migration rather than silently leaving an approved role without
-- the baseline. This is intentionally a deployment gate, not a dashboard
-- warning that someone could miss after release.
do $$
begin
  if exists (
    with canonical_roles(role_code) as (
      values
        ('system_guard'), ('system_admin'), ('custom_chief'), ('system_dispatcher'),
        ('human_resources_employee'), ('human_resources'), ('operations_manager'),
        ('system_recruiting_licensing'), ('system_scheduler'), ('system_supervisor')
    ), baseline_permissions(permission_code) as (
      values
        ('sygsphere.comms.use'), ('sygsphere.comms.ptt.listen'), ('sygsphere.comms.ptt.transmit'),
        ('sygsphere.comms.call.start'), ('sygsphere.comms.call.receive')
    )
    select 1
    from canonical_roles canonical
    cross join baseline_permissions baseline
    left join public.access_roles role on role.code = canonical.role_code and role.active
    left join public.access_role_permissions assignment
      on assignment.role_id = role.id and assignment.permission_code = baseline.permission_code and assignment.enabled
    where role.id is null or assignment.role_id is null
  ) then
    raise exception 'SygSphere Communications baseline is incomplete for one or more canonical roles.';
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
