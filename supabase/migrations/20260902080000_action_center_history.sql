-- Separate active Action Center work from immutable, permission-scoped history.
-- This migration changes functions only; it does not copy or mutate action records.

create temporary table action_center_history_preservation_baseline on commit drop as
select
  (select count(*) from public.announcement_acknowledgments) as announcement_count,
  (select count(*) from public.training_assignments) as training_count,
  (select count(*) from public.schedule_acknowledgments) as schedule_count,
  (select count(*) from private.hr_workflow_tasks) as hr_task_count,
  (select count(*) from public.employee_access_roles) as role_assignment_count,
  (select count(*) from public.employee_permission_overrides) as permission_override_count;

create or replace function public.get_employee_action_center()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  announcement_items jsonb;
  training_items jsonb;
  schedule_items jsonb;
begin
  if actor_id is null or not public.has_effective_permission('actions.self.view') then
    raise insufficient_privilege using message = 'Employee Action Center access is required.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', acknowledgment.id,
    'announcementId', acknowledgment.announcement_id,
    'version', acknowledgment.announcement_version,
    'title', acknowledgment.title_snapshot,
    'body', acknowledgment.body_snapshot,
    'assignedAt', acknowledgment.assigned_at,
    'dueAt', acknowledgment.due_at,
    'viewedAt', acknowledgment.viewed_at,
    'acknowledgedAt', acknowledgment.acknowledged_at,
    'status', acknowledgment.status
  ) order by acknowledgment.due_at nulls last, acknowledgment.assigned_at desc), '[]'::jsonb)
  into announcement_items
  from public.announcement_acknowledgments acknowledgment
  where acknowledgment.employee_id = actor_id
    and acknowledgment.status in ('pending', 'viewed');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', assignment.id,
    'courseId', course.id,
    'versionId', version.id,
    'version', version.version_number,
    'title', version.title,
    'description', version.description,
    'contentType', version.content_type,
    'contentUrl', version.content_url,
    'instructions', version.instructions,
    'effectiveOn', version.effective_on,
    'assignedAt', assignment.assigned_at,
    'dueAt', assignment.due_at,
    'viewedAt', assignment.viewed_at,
    'completedAt', assignment.completed_at,
    'status', case
      when assignment.due_at < clock_timestamp() then 'overdue'
      else assignment.status
    end
  ) order by assignment.due_at nulls last, assignment.assigned_at desc), '[]'::jsonb)
  into training_items
  from public.training_assignments assignment
  join public.training_courses course on course.id = assignment.course_id
  join public.training_course_versions version on version.id = assignment.version_id
  where assignment.employee_id = actor_id
    and assignment.status in ('assigned', 'in_progress');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', acknowledgment.id,
    'scheduleId', acknowledgment.schedule_id,
    'weekStartsOn', acknowledgment.week_starts_on,
    'scheduleRevision', acknowledgment.schedule_revision,
    'shifts', acknowledgment.shifts_snapshot,
    'publishedAt', acknowledgment.published_at,
    'viewedAt', acknowledgment.viewed_at,
    'acknowledgedAt', acknowledgment.acknowledged_at,
    'status', acknowledgment.status
  ) order by acknowledgment.week_starts_on desc, acknowledgment.schedule_revision desc), '[]'::jsonb)
  into schedule_items
  from public.schedule_acknowledgments acknowledgment
  where acknowledgment.employee_id = actor_id
    and acknowledgment.status in ('pending', 'viewed');

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'summary', jsonb_build_object(
      'announcementCount', jsonb_array_length(announcement_items),
      'trainingCount', jsonb_array_length(training_items),
      'scheduleCount', jsonb_array_length(schedule_items)
    ),
    'announcements', announcement_items,
    'training', training_items,
    'schedules', schedule_items
  );
end;
$$;

create or replace function public.get_employee_action_history(
  target_page integer default 1,
  target_page_size integer default 10,
  target_search text default null,
  target_action_type text default 'all',
  target_status text default 'all',
  target_from_date date default null,
  target_through_date date default null,
  target_scope text default 'self'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  page_number integer := greatest(coalesce(target_page, 1), 1);
  page_size integer := case when target_page_size in (5, 10, 20) then target_page_size else 10 end;
  row_offset integer;
  clean_search text := nullif(btrim(coalesce(target_search, '')), '');
  can_manage_announcements boolean := public.has_effective_permission('announcements.acknowledgments.manage');
  can_manage_training boolean := public.has_effective_permission('training.manage');
  can_manage_schedules boolean := public.has_effective_permission('schedule.acknowledgments.manage');
  can_manage_hr boolean := public.has_effective_permission('hr.automation.manage');
  can_view_team boolean;
  result jsonb;
begin
  if actor_id is null or not public.has_effective_permission('actions.self.view') then
    raise insufficient_privilege using message = 'Employee Action Center access is required.';
  end if;

  if target_scope not in ('self', 'team') then
    raise check_violation using message = 'Choose My history or Team history.';
  end if;
  if target_action_type not in ('all', 'announcement', 'training', 'schedule', 'hr_task') then
    raise check_violation using message = 'Choose a supported Action Center record type.';
  end if;
  if target_status not in ('all', 'acknowledged', 'completed', 'superseded', 'cancelled', 'expired') then
    raise check_violation using message = 'Choose a supported Action Center outcome.';
  end if;
  if target_from_date is not null and target_through_date is not null and target_from_date > target_through_date then
    raise check_violation using message = 'The history start date must be on or before the end date.';
  end if;

  can_view_team := (can_manage_announcements or can_manage_training or can_manage_schedules or can_manage_hr) and public.has_mfa();
  if target_scope = 'team' and not can_view_team then
    raise insufficient_privilege using message = 'MFA-verified team Action Center reporting permission is required.';
  end if;
  row_offset := (page_number - 1) * page_size;

  with history_rows as (
    select
      acknowledgment.id,
      'announcement'::text as action_type,
      acknowledgment.employee_id,
      btrim(concat_ws(' ', employee.first_name, employee.last_name)) as employee_name,
      acknowledgment.title_snapshot as title,
      acknowledgment.body_snapshot as description,
      acknowledgment.status,
      acknowledgment.assigned_at,
      acknowledgment.due_at,
      acknowledgment.viewed_at,
      coalesce(acknowledgment.acknowledged_at, acknowledgment.superseded_at, acknowledgment.updated_at) as resolved_at,
      case when acknowledgment.status = 'acknowledged' then acknowledgment.employee_id else null end as resolved_by_id,
      case when acknowledgment.status = 'acknowledged' then btrim(concat_ws(' ', employee.first_name, employee.last_name)) else null end as resolved_by_name,
      case when acknowledgment.status = 'acknowledged' then 'employee' else 'system' end::text as resolution_source,
      case when acknowledgment.status = 'acknowledged' then 'Employee acknowledged the required announcement.' else 'Superseded by a newer announcement version.' end::text as resolution_note,
      concat('Announcement version ', acknowledgment.announcement_version) as context_label,
      jsonb_build_object('announcementId', acknowledgment.announcement_id, 'version', acknowledgment.announcement_version) as metadata
    from public.announcement_acknowledgments acknowledgment
    join public.employees employee on employee.id = acknowledgment.employee_id
    where acknowledgment.status in ('acknowledged', 'superseded')
      and ((target_scope = 'self' and acknowledgment.employee_id = actor_id) or (target_scope = 'team' and can_manage_announcements))

    union all

    select
      assignment.id,
      'training'::text,
      assignment.employee_id,
      btrim(concat_ws(' ', employee.first_name, employee.last_name)),
      version.title,
      coalesce(version.description, version.instructions),
      assignment.status,
      assignment.assigned_at,
      assignment.due_at,
      assignment.viewed_at,
      coalesce(assignment.completed_at, assignment.superseded_at, assignment.updated_at),
      assignment.completed_by,
      case when resolver.id is null then null else btrim(concat_ws(' ', resolver.first_name, resolver.last_name)) end,
      case
        when assignment.status = 'superseded' then 'system'
        when assignment.completed_by = assignment.employee_id then 'employee'
        else 'manager'
      end::text,
      case when assignment.status = 'completed' then assignment.completion_attestation else 'Superseded by a newer training version.' end,
      concat('Training version ', version.version_number),
      jsonb_build_object('courseId', assignment.course_id, 'versionId', assignment.version_id, 'version', version.version_number, 'contentType', version.content_type)
    from public.training_assignments assignment
    join public.training_course_versions version on version.id = assignment.version_id
    join public.employees employee on employee.id = assignment.employee_id
    left join public.employees resolver on resolver.id = assignment.completed_by
    where assignment.status in ('completed', 'superseded')
      and ((target_scope = 'self' and assignment.employee_id = actor_id) or (target_scope = 'team' and can_manage_training))

    union all

    select
      acknowledgment.id,
      'schedule'::text,
      acknowledgment.employee_id,
      btrim(concat_ws(' ', employee.first_name, employee.last_name)),
      concat('Schedule for week of ', to_char(acknowledgment.week_starts_on, 'MM/DD/YYYY')),
      'Published schedule review and acknowledgment.'::text,
      acknowledgment.status,
      acknowledgment.assigned_at,
      null::timestamptz,
      acknowledgment.viewed_at,
      coalesce(acknowledgment.acknowledged_at, acknowledgment.superseded_at, acknowledgment.updated_at),
      case when acknowledgment.status = 'acknowledged' then acknowledgment.employee_id else null end,
      case when acknowledgment.status = 'acknowledged' then btrim(concat_ws(' ', employee.first_name, employee.last_name)) else null end,
      case when acknowledgment.status = 'acknowledged' then 'employee' else 'system' end::text,
      case when acknowledgment.status = 'acknowledged' then 'Employee acknowledged the published schedule.' else 'Superseded by a changed schedule revision.' end::text,
      concat('Revision ', acknowledgment.schedule_revision, ' · ', jsonb_array_length(acknowledgment.shifts_snapshot), ' shift', case when jsonb_array_length(acknowledgment.shifts_snapshot) = 1 then '' else 's' end),
      jsonb_build_object('scheduleId', acknowledgment.schedule_id, 'weekStartsOn', acknowledgment.week_starts_on, 'scheduleRevision', acknowledgment.schedule_revision, 'shifts', acknowledgment.shifts_snapshot)
    from public.schedule_acknowledgments acknowledgment
    join public.employees employee on employee.id = acknowledgment.employee_id
    where acknowledgment.status in ('acknowledged', 'superseded')
      and ((target_scope = 'self' and acknowledgment.employee_id = actor_id) or (target_scope = 'team' and can_manage_schedules))

    union all

    select
      task.id,
      'hr_task'::text,
      coalesce(task.assigned_employee_id, task.completed_by),
      coalesce(
        nullif(btrim(concat_ws(' ', assigned_employee.first_name, assigned_employee.last_name)), ''),
        nullif(btrim(concat_ws(' ', resolver.first_name, resolver.last_name)), ''),
        'Permission-assigned HR task'
      ),
      task.title,
      task.instructions,
      task.status,
      task.created_at,
      task.due_at,
      task.viewed_at,
      coalesce(task.completed_at, task.updated_at),
      task.completed_by,
      case when resolver.id is null then null else btrim(concat_ws(' ', resolver.first_name, resolver.last_name)) end,
      case
        when task.status in ('cancelled', 'expired') then 'system'
        when task.completed_by = task.assigned_employee_id then 'employee'
        else 'manager'
      end::text,
      coalesce(task.completion_note, case when task.status = 'expired' then 'The workflow task expired.' else 'The workflow task was cancelled.' end),
      'HR workflow task'::text,
      jsonb_build_object('instanceId', task.instance_id, 'requiredPermission', task.required_permission)
    from private.hr_workflow_tasks task
    left join public.employees assigned_employee on assigned_employee.id = task.assigned_employee_id
    left join public.employees resolver on resolver.id = task.completed_by
    where task.action_center_visible
      and task.status in ('completed', 'cancelled', 'expired')
      and (
        (target_scope = 'self' and (task.assigned_employee_id = actor_id or task.completed_by = actor_id))
        or (target_scope = 'team' and can_manage_hr)
      )
  ), filtered_history as (
    select history.*
    from history_rows history
    where (target_action_type = 'all' or history.action_type = target_action_type)
      and (target_status = 'all' or history.status = target_status)
      and (target_from_date is null or history.resolved_at::date >= target_from_date)
      and (target_through_date is null or history.resolved_at::date <= target_through_date)
      and (
        clean_search is null
        or history.title ilike '%' || clean_search || '%'
        or coalesce(history.description, '') ilike '%' || clean_search || '%'
        or history.employee_name ilike '%' || clean_search || '%'
        or coalesce(history.resolved_by_name, '') ilike '%' || clean_search || '%'
        or coalesce(history.resolution_note, '') ilike '%' || clean_search || '%'
        or coalesce(history.context_label, '') ilike '%' || clean_search || '%'
      )
  ), page_rows as (
    select history.*
    from filtered_history history
    order by history.resolved_at desc, history.id
    limit page_size offset row_offset
  )
  select jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'scope', target_scope,
    'canViewTeam', can_view_team,
    'page', jsonb_build_object(
      'number', page_number,
      'size', page_size,
      'total', (select count(*) from filtered_history),
      'totalPages', case when (select count(*) from filtered_history) = 0 then 0 else ceil((select count(*) from filtered_history)::numeric / page_size)::integer end
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', history.id,
        'actionType', history.action_type,
        'employeeId', history.employee_id,
        'employeeName', history.employee_name,
        'title', history.title,
        'description', history.description,
        'status', history.status,
        'assignedAt', history.assigned_at,
        'dueAt', history.due_at,
        'viewedAt', history.viewed_at,
        'resolvedAt', history.resolved_at,
        'resolvedById', history.resolved_by_id,
        'resolvedByName', history.resolved_by_name,
        'resolutionSource', history.resolution_source,
        'resolutionNote', history.resolution_note,
        'contextLabel', history.context_label,
        'metadata', history.metadata
      ) order by history.resolved_at desc, history.id)
      from page_rows history
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_employee_action_history(integer, integer, text, text, text, date, date, text) from public, anon;
grant execute on function public.get_employee_action_history(integer, integer, text, text, text, date, date, text) to authenticated;

comment on function public.get_employee_action_history(integer, integer, text, text, text, date, date, text) is
  'Returns immutable Action Center outcomes from authoritative records. Self history requires actions.self.view; team records are source-permission scoped and require current MFA.';

do $$
declare
  baseline action_center_history_preservation_baseline%rowtype;
begin
  select * into strict baseline from action_center_history_preservation_baseline;
  if baseline.announcement_count <> (select count(*) from public.announcement_acknowledgments)
    or baseline.training_count <> (select count(*) from public.training_assignments)
    or baseline.schedule_count <> (select count(*) from public.schedule_acknowledgments)
    or baseline.hr_task_count <> (select count(*) from private.hr_workflow_tasks)
  then
    raise exception 'Action Center history changed an authoritative action record.';
  end if;
  if baseline.role_assignment_count <> (select count(*) from public.employee_access_roles)
    or baseline.permission_override_count <> (select count(*) from public.employee_permission_overrides)
  then
    raise exception 'Action Center history changed an access-control assignment.';
  end if;
end;
$$;
