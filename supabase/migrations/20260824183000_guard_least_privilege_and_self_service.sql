begin;

-- Guard access is intentionally self-service. Team-wide schedule, workforce,
-- accountability, and timekeeping access remains permission-gated.
update public.permission_catalog
set
  name = 'View own requests',
  description = 'View the signed-in employee''s time-off, coverage, and call-off requests.',
  requires_mfa = false,
  active = true,
  updated_at = now()
where code = 'requests.view';

update public.permission_catalog
set
  name = 'View own availability',
  description = 'View the signed-in employee''s availability and availability requests.',
  requires_mfa = false,
  active = true,
  updated_at = now()
where code = 'availability.view';

update public.permission_catalog
set
  name = 'View employee announcements',
  description = 'View active announcements addressed to the signed-in employee''s role and qualifications.',
  requires_mfa = false,
  active = true,
  updated_at = now()
where code = 'announcements.view';

delete from public.access_role_permissions permission
using public.access_roles role
where permission.role_id = role.id
  and role.code = 'system_guard'
  and permission.permission_code in ('accountability.create', 'time.view');

create or replace function private.current_employee_visible_shift_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct assignment.shift_id), array[]::uuid[])
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  where assignment.employee_id = private.current_employee_id()
    and assignment.status <> 'canceled'
    and shift.canceled_at is null
    and schedule.status = 'published'
$$;

create or replace function private.current_employee_visible_schedule_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct schedule.id), array[]::uuid[])
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  where assignment.employee_id = private.current_employee_id()
    and assignment.status <> 'canceled'
    and shift.canceled_at is null
    and schedule.status = 'published'
$$;

revoke all on function private.current_employee_visible_shift_ids() from public, anon;
revoke all on function private.current_employee_visible_schedule_ids() from public, anon;
grant execute on function private.current_employee_visible_shift_ids() to authenticated;
grant execute on function private.current_employee_visible_schedule_ids() to authenticated;

-- The announcement helper is referenced by an authenticated RLS policy. The
-- role can execute it only through its resolved policy OID; authenticated does
-- not receive USAGE on the private schema.
revoke all on function private.announcement_visible_to_current_user(public.announcements) from public, anon;
grant execute on function private.announcement_visible_to_current_user(public.announcements) to authenticated;

drop policy if exists employees_read on public.employees;
create policy employees_read on public.employees
for select to authenticated
using (
  id = (select public.current_employee_id())
  or (select public.has_any_effective_permission(array[
    'directory.view',
    'directory.edit_basic',
    'directory.edit_credentials',
    'licensing.view',
    'licensing.manage',
    'admin.users.view',
    'admin.users.basic',
    'admin.users.manage'
  ]))
);

drop policy if exists schedules_read on public.schedules;
create policy schedules_read on public.schedules
for select to authenticated
using (
  (select public.has_any_effective_permission(array[
    'schedule.view',
    'scheduler.view',
    'scheduler.manage',
    'schedule.manage',
    'schedule.publish',
    'schedule.delete_shift',
    'schedule.override_warnings'
  ]))
  or id in (select unnest(private.current_employee_visible_schedule_ids()))
);

drop policy if exists shifts_read on public.shifts;
create policy shifts_read on public.shifts
for select to authenticated
using (
  (select public.has_any_effective_permission(array[
    'schedule.view',
    'scheduler.view',
    'scheduler.manage',
    'schedule.manage',
    'schedule.publish',
    'schedule.delete_shift',
    'schedule.override_warnings'
  ]))
  or id in (select unnest(private.current_employee_visible_shift_ids()))
);

drop policy if exists assignments_read on public.shift_assignments;
create policy assignments_read on public.shift_assignments
for select to authenticated
using (
  (select public.has_any_effective_permission(array[
    'schedule.view',
    'scheduler.view',
    'scheduler.manage',
    'schedule.manage',
    'schedule.publish',
    'schedule.delete_shift',
    'schedule.override_warnings'
  ]))
  or (
    employee_id = (select public.current_employee_id())
    and shift_id in (select unnest(private.current_employee_visible_shift_ids()))
  )
);

-- ALL policies also participate in SELECT evaluation. Keep their permission
-- checks as init plans so a Guard reading a large schedule does not re-run the
-- full effective-permission calculation for every row.
drop policy if exists schedules_supervisor_write on public.schedules;
create policy schedules_supervisor_write on public.schedules
for all to authenticated
using ((select public.has_any_effective_permission(array[
  'schedule.manage',
  'schedule.publish',
  'schedule.delete_shift'
])))
with check ((select public.has_any_effective_permission(array[
  'schedule.manage',
  'schedule.publish',
  'schedule.delete_shift'
])));

drop policy if exists shifts_supervisor_write on public.shifts;
create policy shifts_supervisor_write on public.shifts
for all to authenticated
using ((select public.has_effective_permission('schedule.manage')))
with check ((select public.has_effective_permission('schedule.manage')));

drop policy if exists assignments_supervisor_write on public.shift_assignments;
create policy assignments_supervisor_write on public.shift_assignments
for all to authenticated
using ((select public.has_effective_permission('schedule.manage')))
with check ((select public.has_effective_permission('schedule.manage')));

drop policy if exists employee_availability_read on public.employee_availability;
create policy employee_availability_read on public.employee_availability
for select to authenticated
using (
  employee_id = (select public.current_employee_id())
  or (select public.has_effective_permission('availability.manage'))
);

drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements
for select to authenticated
using (
  private.announcement_visible_to_current_user(announcements)
  or (select public.has_any_effective_permission(array['announcements.send', 'announcements.banner.manage']))
);

drop policy if exists sites_read on public.sites;
create policy sites_read on public.sites
for select to authenticated
using ((select public.has_any_effective_permission(array['sites.view', 'sites.manage'])));

drop policy if exists posts_read on public.posts;
create policy posts_read on public.posts
for select to authenticated
using ((select public.has_any_effective_permission(array['sites.view', 'sites.manage'])));

drop policy if exists events_read on public.events;
create policy events_read on public.events
for select to authenticated
using (
  (select public.has_any_effective_permission(array[
    'events.view',
    'events.manage',
    'shift_pool.view',
    'shift_pool.manage'
  ]))
);

drop function if exists private.current_employee_has_shift_assignment(uuid);
drop function if exists private.current_employee_has_schedule_assignment(uuid);

do $$
declare
  guard_role_id uuid;
  actual_permissions text[];
  expected_permissions constant text[] := array[
    'actions.self.view',
    'announcements.view',
    'availability.view',
    'events.view',
    'operations.view',
    'requests.view',
    'schedule.self.view',
    'shift_pool.view',
    'time.punch',
    'time.self.view',
    'training.view'
  ]::text[];
begin
  select id into guard_role_id
  from public.access_roles
  where code = 'system_guard'
    and system_role
    and active;

  if guard_role_id is null then
    raise exception 'The active system Guard role was not found.';
  end if;

  select coalesce(array_agg(permission_code order by permission_code), array[]::text[])
  into actual_permissions
  from public.access_role_permissions
  where role_id = guard_role_id
    and enabled;

  if actual_permissions is distinct from expected_permissions then
    raise exception 'Guard permission baseline is not the approved least-privilege set: %', actual_permissions;
  end if;

  if exists (
    select 1
    from public.permission_catalog
    where code in ('requests.view', 'availability.view', 'announcements.view')
      and (not active or requires_mfa)
  ) then
    raise exception 'A Guard self-service permission is inactive or incorrectly requires MFA.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
