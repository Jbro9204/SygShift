begin;

-- `time.view` is an employee self-service permission. It must never grant
-- access to team-wide timekeeping, attendance, call-off, or employee data.
create or replace function private.timekeeping_can_view_operations()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.has_effective_permission('time.manage')
    or public.has_effective_permission('time.resolve_exceptions')
    or public.has_effective_permission('time.reports.view')
    or public.has_effective_permission('time.manual_entry.create')
    or public.has_effective_permission('time.manual_entry.edit')
    or public.has_effective_permission('time.adjustments.review')
$$;

create or replace function public.get_timekeeping_operations_workspace(
  target_from_date date default current_date - 14,
  target_through_date date default current_date + 14
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  workspace_actor_id uuid := private.current_employee_id();
  payload jsonb;
  can_view_operations boolean := private.timekeeping_can_view_operations();
  can_report_call_off boolean := public.has_mfa() and public.has_effective_permission('accountability.report_call_off');
  can_create_manual_entry boolean := public.has_mfa() and public.has_effective_permission('time.manual_entry.create');
  can_edit_manual_entry boolean := public.has_mfa() and public.has_effective_permission('time.manual_entry.edit');
  can_view_staffing_context boolean;
begin
  if workspace_actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  can_view_staffing_context := can_view_operations or can_report_call_off or can_create_manual_entry or can_edit_manual_entry;
  payload := private.get_timekeeping_operations_workspace_edit_base(target_from_date, target_through_date);

  return payload || jsonb_build_object(
    'canViewOperations', can_view_operations,
    'canEditManualEntry', can_edit_manual_entry,
    'employees', case when can_view_staffing_context then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'name', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'username', employee.username,
        'employmentType', employee.employment_type
      ) order by coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name), '[]'::jsonb)
      from public.employees employee
      where employee.status = 'active'
    ) else '[]'::jsonb end,
    'shifts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'shiftId', shift.id,
        'employeeId', assignment.employee_id,
        'startsAt', shift.starts_at,
        'endsAt', shift.ends_at,
        'timeZone', shift.time_zone,
        'location', coalesce(concat_ws(' - ', site.code, site.name, post.name), event.name, 'Scheduled shift'),
        'postId', shift.post_id
      ) order by shift.starts_at), '[]'::jsonb)
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      where assignment.status in ('assigned', 'confirmed')
        and shift.canceled_at is null
        and (can_view_staffing_context or assignment.employee_id = workspace_actor_id)
        and (shift.starts_at at time zone shift.time_zone)::date <= target_through_date
        and (shift.ends_at at time zone shift.time_zone)::date >= target_from_date
    ),
    'posts', case when can_create_manual_entry or can_edit_manual_entry then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', post.id,
        'siteId', site.id,
        'siteName', site.name,
        'postName', post.name,
        'timeZone', site.time_zone
      ) order by site.name, post.name), '[]'::jsonb)
      from public.posts post
      join public.sites site on site.id = post.site_id
      where post.active and site.active
    ) else '[]'::jsonb end,
    'callOffReports', case when can_view_operations or can_report_call_off then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', report.id,
        'employeeId', report.employee_id,
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'shiftId', report.shift_id,
        'startsAt', shift.starts_at,
        'endsAt', shift.ends_at,
        'timeZone', shift.time_zone,
        'location', coalesce(concat_ws(' - ', site.code, site.name, post.name), event.name, 'Scheduled shift'),
        'callOffType', coalesce(report.call_off_type, 'other'),
        'reason', coalesce(report.reason, 'Call-off recorded'),
        'callReceivedAt', coalesce(report.call_received_at, report.reported_at),
        'receivedBy', concat_ws(' ', coalesce(nullif(receiver.preferred_name, ''), receiver.first_name), receiver.last_name),
        'replacementNeeded', report.replacement_needed,
        'operationalDetails', report.operational_details,
        'reportedAt', report.reported_at
      ) order by report.reported_at desc), '[]'::jsonb)
      from public.call_off_reports report
      join public.employees employee on employee.id = report.employee_id
      join public.shifts shift on shift.id = report.shift_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      left join public.employees receiver on receiver.id = report.received_by
      where report.canceled_at is null
        and (shift.starts_at at time zone shift.time_zone)::date <= target_through_date
        and (shift.ends_at at time zone shift.time_zone)::date >= target_from_date
    ) else '[]'::jsonb end,
    'alerts', case when can_view_operations or can_report_call_off then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', alert.id,
        'alertType', alert.alert_type,
        'priority', alert.priority,
        'title', alert.title,
        'summary', alert.summary,
        'employeeId', alert.employee_id,
        'shiftId', alert.shift_id,
        'directPath', alert.direct_path,
        'createdAt', alert.created_at,
        'acknowledgedAt', acknowledgment.acknowledged_at
      ) order by (alert.priority = 'urgent') desc, alert.created_at desc), '[]'::jsonb)
      from public.operational_alerts alert
      left join public.operational_alert_acknowledgments acknowledgment
        on acknowledgment.alert_id = alert.id and acknowledgment.employee_id = workspace_actor_id
      where alert.active
        and (select employee.role from public.employees employee where employee.id = workspace_actor_id) = any(alert.audience_roles)
    ) else '[]'::jsonb end
  );
end
$$;

revoke all on function private.timekeeping_can_view_operations() from public, anon, authenticated;
revoke all on function public.get_timekeeping_operations_workspace(date, date) from public, anon;
grant execute on function public.get_timekeeping_operations_workspace(date, date) to authenticated;

notify pgrst, 'reload schema';
commit;
