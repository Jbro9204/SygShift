begin;

create or replace function public.get_patrol_makeup_work()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  can_operate boolean;
  payload jsonb;
begin
  if actor_id is null or not (
    public.has_effective_permission('patrol.self.view')
    or public.has_effective_permission('patrol.view')
    or public.has_effective_permission('patrol.manage')
  ) then
    raise insufficient_privilege using message = 'Patrol access is required.';
  end if;
  can_operate := public.has_effective_permission('patrol.manage')
    or public.has_effective_permission('patrol.operations.view')
    or public.has_effective_permission('patrol.exceptions.manage');

  select coalesce(jsonb_agg(jsonb_build_object(
    'makeupAssignmentId', makeup.id,
    'obligationId', obligation.id,
    'assignmentId', assigned_assignment.id,
    'stopId', stop.id,
    'locationLabel', stop.location_label,
    'requirementId', requirement.id,
    'requirementLabel', requirement.requirement_label,
    'hitNumber', obligation.hit_number,
    'dueStartAt', obligation.due_start_at,
    'dueEndAt', obligation.due_end_at,
    'status', makeup.status,
    'allowPhotos', stop.allow_photos,
    'allowVideos', stop.allow_videos,
    'requireEvidence', stop.require_evidence,
    'evidenceInstructions', stop.evidence_instructions,
    'locationConfigured', stop.latitude is not null,
    'reason', makeup.reason,
    'originalServiceDate', original_assignment.service_date,
    'originalEmployeeName', concat_ws(' ', original_employee.first_name, original_employee.last_name)
  ) order by assigned_shift.starts_at, stop.sequence_number, obligation.hit_number), '[]'::jsonb)
  into payload
  from public.patrol_makeup_assignments makeup
  join public.patrol_hit_obligations obligation on obligation.id = makeup.obligation_id
  join public.patrol_assignments original_assignment on original_assignment.id = obligation.assignment_id
  join public.employees original_employee on original_employee.id = original_assignment.employee_id
  join public.patrol_assignments assigned_assignment on assigned_assignment.id = makeup.assigned_patrol_assignment_id
  join public.shifts assigned_shift on assigned_shift.id = assigned_assignment.shift_id
  join public.patrol_route_stops stop on stop.id = obligation.stop_id
  join public.patrol_stop_requirements requirement on requirement.id = obligation.requirement_id
  where makeup.status = 'assigned'
    and assigned_assignment.status = 'active'
    and (can_operate or makeup.assigned_to = actor_id);

  return payload;
end
$$;

create or replace function public.assign_patrol_makeup(target_obligation_id uuid, target_assignment_id uuid, target_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  makeup_id uuid;
  employee_id uuid;
  original_route_version_id uuid;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.exceptions.manage')) then
    raise insufficient_privilege using message = 'Patrol Exception Management permission is required.';
  end if;
  select original_assignment.route_version_id into original_route_version_id
  from public.patrol_hit_obligations obligation
  join public.patrol_assignments original_assignment on original_assignment.id = obligation.assignment_id
  where obligation.id = target_obligation_id and obligation.status = 'missed';
  if original_route_version_id is null then
    raise exception using errcode = '22023', message = 'Only a missed patrol hit can be assigned for makeup.';
  end if;
  select assignment.employee_id into employee_id
  from public.patrol_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  where assignment.id = target_assignment_id
    and assignment.status = 'active'
    and assignment.route_version_id = original_route_version_id
    and shift.ends_at >= now();
  if employee_id is null then
    raise exception using errcode = '22023', message = 'Choose a current or upcoming assignment on the same route version.';
  end if;
  insert into public.patrol_makeup_assignments(obligation_id, assigned_patrol_assignment_id, assigned_to, reason, assigned_by)
  values (target_obligation_id, target_assignment_id, employee_id, btrim(target_reason), actor_id)
  returning id into makeup_id;
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'patrol_makeup_assignments', 'assign', makeup_id::text,
    jsonb_build_object('obligationId', target_obligation_id, 'assignmentId', target_assignment_id, 'assignedTo', employee_id, 'reason', btrim(target_reason)));
  return makeup_id;
end
$$;

create or replace function public.get_patrol_report_supplement(target_from date, target_through date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); payload jsonb;
begin
  if actor_id is null or not (
    private.patrol_can_manage() or public.has_effective_permission('patrol.reports.view') or public.has_effective_permission('reports.view')
  ) then raise insufficient_privilege using message = 'Patrol Report access is required.'; end if;
  if target_from is null or target_through is null or target_through < target_from or target_through - target_from > 366 then
    raise exception using errcode = '22023', message = 'Choose a valid report range of 366 days or fewer.';
  end if;

  with activity as (
    select
      makeup.id as record_id,
      'makeup'::text as classification,
      obligation.id as obligation_id,
      assigned_assignment.service_date,
      assigned_route.name as route_name,
      assigned_route.requires_armed as armed,
      concat_ws(' ', assigned_employee.first_name, assigned_employee.last_name) as employee_name,
      assigned_employee.employee_number,
      stop.location_label,
      requirement.requirement_label,
      obligation.hit_number,
      obligation.due_start_at,
      obligation.due_end_at,
      makeup.status,
      hit.submitted_at as completed_at,
      hit.outcome,
      hit.note,
      hit.location_status,
      (select count(*) from public.patrol_hit_evidence evidence where evidence.hit_id = hit.id and evidence.status = 'stored')::integer as evidence_count
    from public.patrol_makeup_assignments makeup
    join public.patrol_hit_obligations obligation on obligation.id = makeup.obligation_id
    join public.patrol_assignments assigned_assignment on assigned_assignment.id = makeup.assigned_patrol_assignment_id
    join public.patrol_routes assigned_route on assigned_route.id = assigned_assignment.route_id
    join public.employees assigned_employee on assigned_employee.id = makeup.assigned_to
    join public.patrol_route_stops stop on stop.id = obligation.stop_id
    join public.patrol_stop_requirements requirement on requirement.id = obligation.requirement_id
    left join public.patrol_hits hit on hit.id = makeup.completed_hit_id and hit.status = 'submitted'
    where assigned_assignment.service_date between target_from and target_through

    union all

    select
      hit.id as record_id,
      'extra'::text as classification,
      null::uuid as obligation_id,
      assignment.service_date,
      route.name as route_name,
      route.requires_armed as armed,
      concat_ws(' ', employee.first_name, employee.last_name) as employee_name,
      employee.employee_number,
      stop.location_label,
      'Extra hit'::text as requirement_label,
      null::integer as hit_number,
      hit.submitted_at as due_start_at,
      hit.submitted_at as due_end_at,
      'completed'::text as status,
      hit.submitted_at as completed_at,
      hit.outcome,
      hit.note,
      hit.location_status,
      (select count(*) from public.patrol_hit_evidence evidence where evidence.hit_id = hit.id and evidence.status = 'stored')::integer as evidence_count
    from public.patrol_hits hit
    join public.patrol_assignments assignment on assignment.id = hit.assignment_id
    join public.patrol_routes route on route.id = assignment.route_id
    join public.employees employee on employee.id = assignment.employee_id
    join public.patrol_route_stops stop on stop.id = hit.stop_id
    where hit.classification = 'extra'
      and hit.status = 'submitted'
      and assignment.service_date between target_from and target_through
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'makeupAssigned', count(*) filter (where classification = 'makeup' and status = 'assigned'),
      'makeupCompleted', count(*) filter (where classification = 'makeup' and status = 'completed')
    ),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'recordId', record_id,
      'classification', classification,
      'obligationId', obligation_id,
      'serviceDate', service_date,
      'routeName', route_name,
      'armed', armed,
      'employeeName', employee_name,
      'employeeNumber', employee_number,
      'locationLabel', location_label,
      'requirementLabel', requirement_label,
      'hitNumber', hit_number,
      'dueStartAt', due_start_at,
      'dueEndAt', due_end_at,
      'status', status,
      'completedAt', completed_at,
      'outcome', outcome,
      'note', note,
      'locationStatus', location_status,
      'evidenceCount', evidence_count
    ) order by service_date desc, route_name, location_label, classification), '[]'::jsonb)
  ) into payload
  from activity;
  return payload;
end
$$;

revoke all on function public.get_patrol_makeup_work() from public, anon;
revoke all on function public.get_patrol_report_supplement(date, date) from public, anon;
revoke all on function public.assign_patrol_makeup(uuid, uuid, text) from public, anon;
grant execute on function public.get_patrol_makeup_work() to authenticated;
grant execute on function public.get_patrol_report_supplement(date, date) to authenticated;
grant execute on function public.assign_patrol_makeup(uuid, uuid, text) to authenticated;

commit;
