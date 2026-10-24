begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Report rows must expose the immutable source record that owns them. Without
-- that identity, two employees whose automatic clock-outs share a scheduled
-- start can exchange React keys after a refetch and make an already-open detail
-- view appear to belong to the wrong employee.
create or replace function public.get_timekeeping_operations_reports(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  review_payload jsonb;
begin
  perform private.timekeeping_require_permission('time.reports.view');
  if target_from_date is null or target_through_date is null or target_through_date < target_from_date or target_through_date - target_from_date > 366 then
    raise check_violation using message = 'Choose a valid report range of 366 days or fewer.';
  end if;
  review_payload := public.get_timekeeping_review(target_from_date, target_through_date);

  return jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'timekeepingExceptions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', exception.id,
        'employeeId', exception.employee_id,
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'sitePost', coalesce(concat_ws(' / ', site.code, site.name, post.name), event.name, 'Scheduled shift'),
        'scheduledStartAt', exception.scheduled_start_at,
        'scheduledEndAt', exception.scheduled_end_at,
        'exceptionCode', exception.exception_code,
        'status', exception.status,
        'resolutionMethod', exception.resolution_method,
        'resolutionNote', exception.resolution_note,
        'resolvedBy', case when resolver.id is null then null else concat_ws(' ', coalesce(nullif(resolver.preferred_name, ''), resolver.first_name), resolver.last_name) end,
        'resolvedAt', exception.resolved_at,
        'detectedAt', exception.detected_at
      ) order by exception.detected_at desc), '[]'::jsonb)
      from public.timekeeping_operational_exceptions exception
      join public.employees employee on employee.id = exception.employee_id
      join public.shifts shift on shift.id = exception.shift_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      left join public.employees resolver on resolver.id = exception.resolved_by
      where (exception.scheduled_start_at at time zone shift.time_zone)::date between target_from_date and target_through_date
    ),
    'automaticClockOuts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', exception.id,
        'exceptionId', exception.id,
        'employeeId', exception.employee_id,
        'shiftId', exception.shift_id,
        'timeEventId', time_event.id,
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'sitePost', coalesce(concat_ws(' / ', site.code, site.name, post.name), event.name, 'Scheduled shift'),
        'scheduledStartAt', exception.scheduled_start_at,
        'scheduledEndAt', exception.scheduled_end_at,
        'automaticClockOutAt', time_event.recorded_at,
        'status', exception.status,
        'adjustmentStatus', adjustment.status
      ) order by exception.scheduled_end_at desc, exception.id), '[]'::jsonb)
      from public.timekeeping_operational_exceptions exception
      join public.employees employee on employee.id = exception.employee_id
      join public.shifts shift on shift.id = exception.shift_id
      join public.time_events time_event on time_event.id = exception.source_time_event_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      left join lateral (
        select request.status from public.time_adjustment_requests request
        where request.employee_id = exception.employee_id and request.shift_id = exception.shift_id
        order by request.submitted_at desc limit 1
      ) adjustment on true
      where exception.exception_code = 'automatic_clock_out'
        and (exception.scheduled_end_at at time zone shift.time_zone)::date between target_from_date and target_through_date
    ),
    'manualTimeEntryAudit', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', history.id,
        'historyId', history.id,
        'manualEntryId', entry.id,
        'employeeId', entry.employee_id,
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'workDate', entry.work_date,
        'clockInAt', entry.clock_in_at,
        'clockOutAt', entry.clock_out_at,
        'reason', history.reason,
        'action', history.action,
        'beforeValues', history.before_values,
        'afterValues', history.after_values,
        'actor', concat_ws(' ', coalesce(nullif(actor.preferred_name, ''), actor.first_name), actor.last_name),
        'approvalStatus', entry.approval_status,
        'createdAt', history.created_at
      ) order by history.created_at desc, history.id), '[]'::jsonb)
      from public.manual_time_entry_history history
      join public.manual_time_entries entry on entry.id = history.manual_entry_id
      join public.employees employee on employee.id = entry.employee_id
      join public.employees actor on actor.id = history.actor_id
      where entry.work_date between target_from_date and target_through_date
    ),
    'timeAdjustmentRequests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', request.id,
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'workDate', request.work_date,
        'issueType', request.issue_type,
        'requestedClockInAt', request.requested_clock_in_at,
        'requestedClockOutAt', request.requested_clock_out_at,
        'reason', request.reason,
        'status', request.status,
        'reviewer', case when reviewer.id is null then null else concat_ws(' ', coalesce(nullif(reviewer.preferred_name, ''), reviewer.first_name), reviewer.last_name) end,
        'decisionNote', request.decision_note,
        'submittedAt', request.submitted_at,
        'reviewedAt', request.reviewed_at,
        'processingMinutes', case when request.reviewed_at is null then null else round(extract(epoch from (request.reviewed_at - request.submitted_at)) / 60) end
      ) order by request.submitted_at desc), '[]'::jsonb)
      from public.time_adjustment_requests request
      join public.employees employee on employee.id = request.employee_id
      left join public.employees reviewer on reviewer.id = request.reviewer_id
      where request.work_date between target_from_date and target_through_date
    ),
    'attendanceCallOffs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', report.id,
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'sitePost', coalesce(concat_ws(' / ', site.code, site.name, post.name), event.name, 'Scheduled shift'),
        'scheduledStartAt', shift.starts_at,
        'callOffType', report.call_off_type,
        'reason', report.reason,
        'replacementNeeded', report.replacement_needed,
        'reportedAt', report.reported_at,
        'canceledAt', report.canceled_at
      ) order by report.reported_at desc), '[]'::jsonb)
      from public.call_off_reports report
      join public.employees employee on employee.id = report.employee_id
      join public.shifts shift on shift.id = report.shift_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      where (shift.starts_at at time zone shift.time_zone)::date between target_from_date and target_through_date
    ),
    'scheduledVsActual', coalesce(review_payload -> 'rows', '[]'::jsonb),
    'coverageUnfilled', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'shiftId', shift.id,
        'sitePost', coalesce(concat_ws(' / ', site.code, site.name, post.name), event.name, 'Scheduled shift'),
        'startsAt', shift.starts_at,
        'endsAt', shift.ends_at,
        'headcountRequired', shift.headcount_required,
        'assignedCount', assigned.assigned_count,
        'openCount', greatest(shift.headcount_required - assigned.assigned_count, 0),
        'callOffCount', call_off.call_off_count,
        'timeOpenMinutes', case when greatest(shift.headcount_required - assigned.assigned_count, 0) > 0 then greatest(0, round(extract(epoch from (least(clock_timestamp(), shift.starts_at) - shift.created_at)) / 60)) else 0 end
      ) order by shift.starts_at), '[]'::jsonb)
      from public.shifts shift
      join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      left join lateral (
        select count(*)::integer as assigned_count from public.shift_assignments assignment
        where assignment.shift_id = shift.id and assignment.status in ('assigned', 'confirmed')
      ) assigned on true
      left join lateral (
        select count(*)::integer as call_off_count from public.call_off_reports report
        where report.shift_id = shift.id and report.canceled_at is null
      ) call_off on true
      where shift.canceled_at is null
        and (shift.starts_at at time zone shift.time_zone)::date between target_from_date and target_through_date
    ),
    'overtimePayrollRisk', (
      select coalesce(jsonb_agg(row_value order by (row_value ->> 'employeeName'), (row_value ->> 'operationalDate')), '[]'::jsonb)
      from jsonb_array_elements(coalesce(review_payload -> 'rows', '[]'::jsonb)) rows(row_value)
      where coalesce((row_value ->> 'overtimeMinutes')::integer, 0) > 0
        or not coalesce((row_value ->> 'payrollReady')::boolean, false)
        or jsonb_array_length(coalesce(row_value -> 'exceptionCodes', '[]'::jsonb)) > 0
    )
  );
end
$$;

revoke all on function public.get_timekeeping_operations_reports(date, date)
  from public, anon;
grant execute on function public.get_timekeeping_operations_reports(date, date)
  to authenticated;

notify pgrst, 'reload schema';

commit;
