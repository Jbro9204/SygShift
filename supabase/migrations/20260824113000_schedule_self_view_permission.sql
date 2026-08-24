begin;

-- Personal schedule access is a baseline capability. Company-wide schedule
-- visibility remains a separate elevated permission.
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
  'schedule.self.view',
  'Schedule',
  'View own schedule',
  'View only the signed-in employee''s published schedule assignments.',
  'standard',
  false,
  true,
  true
)
on conflict (code) do update
set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  locked = excluded.locked,
  active = excluded.active,
  updated_at = now();

update public.permission_catalog
set
  name = 'View all schedules',
  description = 'View company-wide published schedules and authorized draft coverage.',
  risk_level = 'sensitive',
  requires_mfa = true,
  active = true,
  updated_at = now()
where code = 'schedule.view';

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, 'schedule.self.view', true
from public.access_roles role
where role.system_role
  and role.base_app_role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
on conflict (role_id, permission_code) do update
set
  enabled = true,
  updated_at = now();

-- Guards and Recruiting & Licensing staff retain personal schedule access but
-- no longer inherit company-wide schedule visibility. Any intentional direct
-- employee grant remains intact.
delete from public.access_role_permissions permission
using public.access_roles role
where permission.role_id = role.id
  and permission.permission_code = 'schedule.view'
  and role.code in ('system_guard', 'system_recruiting_licensing');

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

comment on function public.get_weekly_schedule_payload(date) is
  'Returns company-wide schedule detail for elevated viewers or only the signed-in employee''s published assignments for personal viewers.';

notify pgrst, 'reload schema';

commit;
