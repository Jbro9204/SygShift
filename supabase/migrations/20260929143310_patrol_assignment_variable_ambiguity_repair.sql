begin;

-- Route-to-shift assignment failed while inserting obligations because
-- the local assignment_id variable had the same name as the obligation column
-- referenced by ON CONFLICT. Keep the public contract and authorization boundary
-- intact while giving the local identifier an unambiguous name.
create or replace function public.link_patrol_route_shift(target_route_id uuid, target_shift_id uuid, target_employee_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  route_record public.patrol_routes%rowtype;
  shift_record public.shifts%rowtype;
  patrol_assignment_id uuid;
  local_day smallint;
  local_date date;
  requirement_record record;
  counter integer;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.assignments.manage')) then
    raise insufficient_privilege using message = 'Patrol Assignment Management permission is required.';
  end if;
  select * into route_record from public.patrol_routes where id = target_route_id and status = 'active' and current_version_id is not null;
  if not found then raise exception using errcode = '22023', message = 'Activate the patrol route before assigning it.'; end if;
  select shift.* into shift_record
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
  join public.shift_assignments assigned on assigned.shift_id = shift.id and assigned.employee_id = target_employee_id and assigned.status in ('assigned', 'confirmed')
  where shift.id = target_shift_id;
  if not found then raise exception using errcode = '22023', message = 'Choose a published shift assigned to this employee.'; end if;
  if route_record.requires_armed and not shift_record.requires_armed then
    raise exception using errcode = '22023', message = 'An armed patrol route must be linked to an armed shift.';
  end if;

  local_day := extract(dow from shift_record.starts_at at time zone route_record.time_zone)::smallint;
  local_date := (shift_record.starts_at at time zone route_record.time_zone)::date;
  insert into public.patrol_assignments as patrol_assignment(
    route_id, route_version_id, shift_id, employee_id, service_date, assigned_by
  )
  values (route_record.id, route_record.current_version_id, target_shift_id, target_employee_id, local_date, actor_id)
  on conflict (route_version_id, shift_id, employee_id) do update
  set status = 'active', canceled_at = null, cancellation_reason = null
  returning patrol_assignment.id into patrol_assignment_id;

  for requirement_record in
    select requirement.*, stop.sequence_number
    from public.patrol_stop_requirements requirement
    join public.patrol_route_stops stop on stop.id = requirement.stop_id
    where stop.route_version_id = route_record.current_version_id
      and requirement.day_of_week = local_day
      and requirement.status = 'active'
    order by stop.sequence_number, requirement.requirement_label
  loop
    for counter in 1..requirement_record.required_hits loop
      insert into public.patrol_hit_obligations(
        assignment_id, stop_id, requirement_id, hit_number, due_start_at, due_end_at
      ) values (
        patrol_assignment_id,
        requirement_record.stop_id,
        requirement_record.id,
        counter,
        case when requirement_record.window_start is null then shift_record.starts_at
             else (local_date + requirement_record.window_start) at time zone route_record.time_zone end,
        case when requirement_record.window_end is null then shift_record.ends_at
             when requirement_record.window_end > requirement_record.window_start then (local_date + requirement_record.window_end) at time zone route_record.time_zone
             else (local_date + 1 + requirement_record.window_end) at time zone route_record.time_zone end
      ) on conflict on constraint patrol_hit_obligations_unique do nothing;
    end loop;
  end loop;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'patrol_assignments', 'link_shift', patrol_assignment_id::text,
    jsonb_build_object('routeId', route_record.id, 'routeVersionId', route_record.current_version_id, 'shiftId', target_shift_id, 'employeeId', target_employee_id));
  return patrol_assignment_id;
end
$$;

revoke all on function public.link_patrol_route_shift(uuid, uuid, uuid) from public, anon;
grant execute on function public.link_patrol_route_shift(uuid, uuid, uuid) to authenticated;

comment on function public.link_patrol_route_shift(uuid, uuid, uuid) is
  'Links the active version of a Patrol route to an assigned published shift and creates that service day''s immutable hit obligations without PL/pgSQL name ambiguity.';

commit;
