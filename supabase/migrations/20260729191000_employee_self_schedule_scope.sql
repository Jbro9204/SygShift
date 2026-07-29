begin;

create or replace function public.get_weekly_schedule_payload(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  can_view_all_schedule boolean := public.has_effective_permission('schedule.view')
    or viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin');
  target_schedule public.schedules%rowtype;
  payload jsonb;
begin
  if viewer_employee_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view the schedule.';
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
        'is_open', shift.is_open,
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
                'preferred_name', employee.preferred_name
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
  'Returns the latest visible schedule revision. Operations roles see team coverage; employee baseline access only returns the signed-in employee''s assigned shifts.';

commit;
