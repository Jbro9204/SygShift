begin;

alter function public.get_timekeeping_review(date, date) set schema private;
alter function private.get_timekeeping_review(date, date) rename to get_timekeeping_review_operations_base;
revoke all on function private.get_timekeeping_review_operations_base(date, date) from public, anon, authenticated;

create function public.get_timekeeping_review(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  enriched_rows jsonb;
begin
  payload := private.get_timekeeping_review_operations_base(target_from_date, target_through_date);

  select coalesce(jsonb_agg(
    row_value || jsonb_build_object(
      'shiftNotes', case
        when nullif(row_value ->> 'shiftId', '') is null then null
        else (
          select shift.notes
          from public.shifts shift
          where shift.id = (row_value ->> 'shiftId')::uuid
        )
      end
    )
    order by row_ordinality
  ), '[]'::jsonb)
  into enriched_rows
  from jsonb_array_elements(coalesce(payload -> 'rows', '[]'::jsonb))
    with ordinality rows(row_value, row_ordinality);

  return payload || jsonb_build_object('rows', enriched_rows);
end
$$;

alter function public.get_timekeeping_operations_workspace(date, date) set schema private;
alter function private.get_timekeeping_operations_workspace(date, date) rename to get_timekeeping_operations_workspace_base;
revoke all on function private.get_timekeeping_operations_workspace_base(date, date) from public, anon, authenticated;

create function public.get_timekeeping_operations_workspace(
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
  actor_id uuid := private.current_employee_id();
  payload jsonb;
  can_view_operations boolean := private.timekeeping_can_view_operations();
begin
  payload := private.get_timekeeping_operations_workspace_base(target_from_date, target_through_date);

  return payload || jsonb_build_object(
    'canEditManualEntry', public.has_effective_permission('time.manual_entry.edit') and public.has_mfa(),
    'manualEntries', case when can_view_operations then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', entry.id,
        'employeeId', entry.employee_id,
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'shiftId', entry.shift_id,
        'postId', entry.post_id,
        'workDate', entry.work_date,
        'clockInAt', entry.clock_in_at,
        'clockOutAt', entry.clock_out_at,
        'reason', entry.reason,
        'notes', entry.notes,
        'approvalStatus', entry.approval_status,
        'warningCodes', entry.warning_codes,
        'entrySource', entry.entry_source,
        'createdBy', concat_ws(' ', coalesce(nullif(creator.preferred_name, ''), creator.first_name), creator.last_name),
        'createdAt', entry.created_at,
        'lastEditedBy', case when editor.id is null then null else concat_ws(' ', coalesce(nullif(editor.preferred_name, ''), editor.first_name), editor.last_name) end,
        'lastEditedAt', entry.last_edited_at,
        'history', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', history.id,
            'action', history.action,
            'beforeValues', history.before_values,
            'afterValues', history.after_values,
            'reason', history.reason,
            'actor', concat_ws(' ', coalesce(nullif(history_actor.preferred_name, ''), history_actor.first_name), history_actor.last_name),
            'createdAt', history.created_at
          ) order by history.created_at desc)
          from public.manual_time_entry_history history
          join public.employees history_actor on history_actor.id = history.actor_id
          where history.manual_entry_id = entry.id
        ), '[]'::jsonb)
      ) order by entry.clock_in_at desc), '[]'::jsonb)
      from public.manual_time_entries entry
      join public.employees employee on employee.id = entry.employee_id
      join public.employees creator on creator.id = entry.created_by
      left join public.employees editor on editor.id = entry.last_edited_by
      where entry.work_date between target_from_date and target_through_date
    ) else '[]'::jsonb end,
    'adjustmentRequestActions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', action.id,
        'requestId', action.request_id,
        'action', action.action,
        'note', action.note,
        'actor', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'createdAt', action.created_at
      ) order by action.created_at desc), '[]'::jsonb)
      from public.time_adjustment_request_actions action
      join public.time_adjustment_requests request on request.id = action.request_id
      join public.employees employee on employee.id = action.actor_id
      where request.work_date between target_from_date and target_through_date
        and (can_view_operations or request.employee_id = actor_id)
    )
  );
end
$$;

create or replace function public.edit_manual_time_entry(
  target_manual_entry_id uuid,
  target_clock_in_at timestamptz,
  target_clock_out_at timestamptz,
  target_post_id uuid,
  target_shift_id uuid,
  target_reason text,
  target_notes text default null,
  target_confirm_warnings boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('time.manual_entry.edit');
  entry public.manual_time_entries;
  selected_shift public.shifts;
  before_values jsonb;
  warnings text[] := '{}'::text[];
  long_minutes integer := private.timekeeping_setting_integer('timekeeping.long_shift_warning_minutes', 840);
begin
  if target_manual_entry_id is null or target_clock_in_at is null or target_clock_out_at is null then
    raise check_violation using message = 'Manual entry, clock-in, and clock-out are required.';
  end if;
  if target_clock_out_at <= target_clock_in_at then
    raise check_violation using message = 'Clock-out must be after clock-in.';
  end if;
  if btrim(coalesce(target_reason, '')) = '' then
    raise check_violation using message = 'An edit reason is required.';
  end if;

  select * into entry
  from public.manual_time_entries
  where id = target_manual_entry_id
  for update;
  if entry.id is null then raise no_data_found using message = 'The manual time entry was not found.'; end if;

  before_values := to_jsonb(entry);
  perform pg_advisory_xact_lock(hashtext('manual-time-entry:' || entry.employee_id::text));

  if target_shift_id is not null then
    select * into selected_shift from public.shifts where id = target_shift_id and canceled_at is null;
    if selected_shift.id is null then raise check_violation using message = 'The selected shift is not available.'; end if;
    target_post_id := selected_shift.post_id;
  elsif target_post_id is null then
    raise check_violation using message = 'Choose a Site / Post when the entry is not connected to a scheduled shift.';
  elsif not exists (
    select 1
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active
  ) then
    raise check_violation using message = 'Choose an active Site / Post.';
  end if;

  if extract(epoch from (target_clock_out_at - target_clock_in_at)) / 60 > long_minutes then
    warnings := array_append(warnings, 'unusually_long_shift');
  end if;
  if target_shift_id is not null and not exists (
    select 1 from public.shifts shift
    where shift.id = target_shift_id and shift.canceled_at is null
      and target_clock_in_at >= shift.starts_at - interval '30 minutes'
      and target_clock_out_at <= shift.ends_at + interval '30 minutes'
  ) then
    warnings := array_append(warnings, 'outside_scheduled_shift');
  end if;
  if exists (
    select 1 from public.manual_time_entries other
    where other.employee_id = entry.employee_id
      and other.id <> entry.id
      and other.approval_status <> 'rejected'
      and tstzrange(other.clock_in_at, other.clock_out_at, '[)') && tstzrange(target_clock_in_at, target_clock_out_at, '[)')
    union all
    select 1
    from public.time_events event
    left join lateral (
      select correction.replacement_time, correction.voided
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
      order by correction.approved_at desc, correction.created_at desc, correction.id desc
      limit 1
    ) latest_correction on true
    where event.employee_id = entry.employee_id
      and event.id not in (entry.clock_in_event_id, entry.clock_out_event_id)
      and not coalesce(latest_correction.voided, false)
      and coalesce(latest_correction.replacement_time, event.recorded_at) >= target_clock_in_at
      and coalesce(latest_correction.replacement_time, event.recorded_at) < target_clock_out_at
    limit 1
  ) then
    warnings := array_append(warnings, 'overlapping_time_record');
  end if;
  if cardinality(warnings) > 0 and not target_confirm_warnings then
    raise check_violation using message = concat('Confirmation required: ', array_to_string(warnings, ', '));
  end if;

  insert into public.time_event_corrections (
    time_event_id, replacement_time, voided, reason, requested_by, approved_by, approved_at
  ) values
    (entry.clock_in_event_id, target_clock_in_at, false, btrim(target_reason), actor_id, actor_id, clock_timestamp()),
    (entry.clock_out_event_id, target_clock_out_at, false, btrim(target_reason), actor_id, actor_id, clock_timestamp());

  update public.manual_time_entries
  set
    shift_id = target_shift_id,
    post_id = target_post_id,
    work_date = (target_clock_in_at at time zone coalesce((select shift.time_zone from public.shifts shift where shift.id = target_shift_id), 'America/Denver'))::date,
    clock_in_at = target_clock_in_at,
    clock_out_at = target_clock_out_at,
    notes = nullif(btrim(coalesce(target_notes, '')), ''),
    warning_codes = warnings,
    warning_confirmation = case when cardinality(warnings) > 0 then 'Confirmed by authorized user.' end,
    last_edited_by = actor_id,
    last_edited_at = clock_timestamp()
  where id = entry.id
  returning * into entry;

  insert into public.manual_time_entry_history (manual_entry_id, action, before_values, after_values, reason, actor_id)
  values (entry.id, 'edited', before_values, to_jsonb(entry), btrim(target_reason), actor_id);

  return jsonb_build_object('id', entry.id, 'warningCodes', warnings, 'lastEditedAt', entry.last_edited_at);
end
$$;

create or replace function public.update_employee_call_off(
  target_call_off_report_id uuid,
  target_call_off_type text,
  target_reason text,
  target_notes text,
  target_replacement_needed boolean,
  target_operational_details text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('accountability.report_call_off');
  changed public.call_off_reports;
begin
  if target_call_off_type not in ('sick', 'other') then raise check_violation using message = 'Choose Sick or Other call-off.'; end if;
  if btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'A call-off reason is required.'; end if;

  update public.call_off_reports
  set
    call_off_type = target_call_off_type,
    reason = concat(btrim(target_reason), case when btrim(coalesce(target_notes, '')) = '' then '' else E'\n\n' || btrim(target_notes) end),
    replacement_needed = coalesce(target_replacement_needed, true),
    operational_details = nullif(btrim(coalesce(target_operational_details, '')), ''),
    updated_at = clock_timestamp()
  where id = target_call_off_report_id and canceled_at is null
  returning * into changed;
  if changed.id is null then raise check_violation using message = 'The call-off is no longer active.'; end if;

  insert into public.call_off_report_actions (call_off_report_id, action, reason, actor_id, snapshot)
  values (changed.id, 'updated', btrim(target_reason), actor_id, to_jsonb(changed));
  return jsonb_build_object('id', changed.id, 'status', 'updated');
end
$$;

create or replace function public.cancel_employee_call_off(target_call_off_report_id uuid, target_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('accountability.report_call_off');
  changed public.call_off_reports;
begin
  if btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'A cancellation reason is required.'; end if;
  update public.call_off_reports
  set canceled_at = clock_timestamp(), canceled_by = actor_id, cancellation_note = btrim(target_reason), updated_at = clock_timestamp()
  where id = target_call_off_report_id and canceled_at is null
  returning * into changed;
  if changed.id is null then raise check_violation using message = 'The call-off is no longer active.'; end if;
  insert into public.call_off_report_actions (call_off_report_id, action, reason, actor_id, snapshot)
  values (changed.id, 'canceled', btrim(target_reason), actor_id, to_jsonb(changed));
  update public.operational_alerts
  set active = false, cleared_at = clock_timestamp(), cleared_by = actor_id
  where related_record_type = 'call_off_report' and related_record_id = changed.id and active;
end
$$;

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
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'sitePost', coalesce(concat_ws(' / ', site.code, site.name, post.name), event.name, 'Scheduled shift'),
        'scheduledStartAt', exception.scheduled_start_at,
        'scheduledEndAt', exception.scheduled_end_at,
        'automaticClockOutAt', time_event.recorded_at,
        'status', exception.status,
        'adjustmentStatus', adjustment.status
      ) order by exception.scheduled_end_at desc), '[]'::jsonb)
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
        'manualEntryId', entry.id,
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
      ) order by history.created_at desc), '[]'::jsonb)
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

revoke all on function public.get_timekeeping_review(date, date) from public, anon;
revoke all on function public.get_timekeeping_operations_workspace(date, date) from public, anon;
revoke all on function public.edit_manual_time_entry(uuid, timestamptz, timestamptz, uuid, uuid, text, text, boolean) from public, anon;
revoke all on function public.update_employee_call_off(uuid, text, text, text, boolean, text) from public, anon;
revoke all on function public.cancel_employee_call_off(uuid, text) from public, anon;
revoke all on function public.get_timekeeping_operations_reports(date, date) from public, anon;

grant execute on function public.get_timekeeping_review(date, date) to authenticated;
grant execute on function public.get_timekeeping_operations_workspace(date, date) to authenticated;
grant execute on function public.edit_manual_time_entry(uuid, timestamptz, timestamptz, uuid, uuid, text, text, boolean) to authenticated;
grant execute on function public.update_employee_call_off(uuid, text, text, text, boolean, text) to authenticated;
grant execute on function public.cancel_employee_call_off(uuid, text) to authenticated;
grant execute on function public.get_timekeeping_operations_reports(date, date) to authenticated;

notify pgrst, 'reload schema';

commit;
