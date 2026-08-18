begin;

create or replace function private.timekeeping_can_view_operations()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.has_effective_permission('time.view')
    or public.has_effective_permission('time.manage')
    or public.has_effective_permission('time.resolve_exceptions')
    or public.has_effective_permission('time.reports.view')
    or public.has_effective_permission('time.export_payroll')
$$;

create or replace function private.timekeeping_require_permission(target_permission text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if not public.has_mfa() or not public.has_effective_permission(target_permission) then
    raise insufficient_privilege using message = 'Verified access with the required permission is required.';
  end if;
  return actor_id;
end
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
  can_view_operations boolean := private.timekeeping_can_view_operations();
begin
  if workspace_actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if target_from_date is null or target_through_date is null or target_through_date < target_from_date or target_through_date - target_from_date > 366 then
    raise check_violation using message = 'Choose a valid date range of 366 days or fewer.';
  end if;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'canViewOperations', can_view_operations,
    'canCreateManualEntry', public.has_effective_permission('time.manual_entry.create') and public.has_mfa(),
    'canReviewAdjustments', public.has_effective_permission('time.adjustments.review') and public.has_mfa(),
    'canResolveExceptions', public.has_effective_permission('time.resolve_exceptions') and public.has_mfa(),
    'canReportCallOff', public.has_effective_permission('accountability.report_call_off') and public.has_mfa(),
    'employees', case when can_view_operations then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'name', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'username', employee.username,
        'employmentType', employee.employment_type
      ) order by coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name), '[]'::jsonb)
      from public.employees employee
      where employee.status = 'active'
    ) else '[]'::jsonb end,
    'shifts', case when can_view_operations then (
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
        and (shift.starts_at at time zone shift.time_zone)::date <= target_through_date
        and (shift.ends_at at time zone shift.time_zone)::date >= target_from_date
    ) else '[]'::jsonb end,
    'exceptions', case when can_view_operations then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', exception.id,
        'employeeId', exception.employee_id,
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'shiftId', exception.shift_id,
        'exceptionCode', exception.exception_code,
        'status', exception.status,
        'severity', exception.severity,
        'scheduledStartAt', exception.scheduled_start_at,
        'scheduledEndAt', exception.scheduled_end_at,
        'location', coalesce(concat_ws(' - ', site.code, site.name, post.name), event.name, 'Scheduled shift'),
        'sourceTimeEventId', exception.source_time_event_id,
        'detectedAt', exception.detected_at,
        'resolutionMethod', exception.resolution_method,
        'resolutionNote', exception.resolution_note,
        'resolvedAt', exception.resolved_at,
        'resolvedBy', case when resolver.id is null then null else concat_ws(' ', coalesce(nullif(resolver.preferred_name, ''), resolver.first_name), resolver.last_name) end
      ) order by (exception.status = 'unresolved') desc, exception.detected_at desc), '[]'::jsonb)
      from public.timekeeping_operational_exceptions exception
      join public.employees employee on employee.id = exception.employee_id
      join public.shifts shift on shift.id = exception.shift_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      left join public.employees resolver on resolver.id = exception.resolved_by
      where (exception.scheduled_start_at at time zone shift.time_zone)::date between target_from_date and target_through_date
    ) else '[]'::jsonb end,
    'adjustmentRequests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', request.id,
        'employeeId', request.employee_id,
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'shiftId', request.shift_id,
        'workDate', request.work_date,
        'issueType', request.issue_type,
        'requestedClockInAt', request.requested_clock_in_at,
        'requestedClockOutAt', request.requested_clock_out_at,
        'reason', request.reason,
        'notes', request.notes,
        'status', request.status,
        'submittedAt', request.submitted_at,
        'reviewedAt', request.reviewed_at,
        'decisionNote', request.decision_note,
        'reviewer', case when reviewer.id is null then null else concat_ws(' ', coalesce(nullif(reviewer.preferred_name, ''), reviewer.first_name), reviewer.last_name) end
      ) order by request.submitted_at desc), '[]'::jsonb)
      from public.time_adjustment_requests request
      join public.employees employee on employee.id = request.employee_id
      left join public.employees reviewer on reviewer.id = request.reviewer_id
      where request.work_date between target_from_date and target_through_date
        and (can_view_operations or request.employee_id = workspace_actor_id)
    ),
    'alerts', case when can_view_operations then (
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

create or replace function public.submit_time_adjustment_request(
  target_shift_id uuid,
  target_work_date date,
  target_issue_type text,
  target_requested_clock_in_at timestamptz,
  target_requested_clock_out_at timestamptz,
  target_reason text,
  target_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  inserted public.time_adjustment_requests;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if target_work_date is null then raise check_violation using message = 'A work date is required.'; end if;
  if target_issue_type not in ('clock_in', 'clock_out', 'both_punches', 'missing_shift', 'other') then
    raise check_violation using message = 'Choose a valid time issue.';
  end if;
  if btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'A reason is required.'; end if;
  if target_requested_clock_in_at is not null and target_requested_clock_out_at is not null and target_requested_clock_out_at <= target_requested_clock_in_at then
    raise check_violation using message = 'The requested clock-out must be after the requested clock-in.';
  end if;
  if target_shift_id is not null and not exists (
    select 1 from public.shift_assignments assignment
    where assignment.shift_id = target_shift_id and assignment.employee_id = actor_id and assignment.status <> 'canceled'
  ) then
    raise insufficient_privilege using message = 'The selected shift is not assigned to this employee.';
  end if;

  insert into public.time_adjustment_requests (
    employee_id, shift_id, work_date, issue_type, requested_clock_in_at, requested_clock_out_at,
    reason, notes, submitted_by
  ) values (
    actor_id, target_shift_id, target_work_date, target_issue_type, target_requested_clock_in_at,
    target_requested_clock_out_at, btrim(target_reason), nullif(btrim(coalesce(target_notes, '')), ''), actor_id
  ) returning * into inserted;

  insert into public.time_adjustment_request_actions (request_id, action, note, actor_id, snapshot)
  values (inserted.id, 'submitted', btrim(target_reason), actor_id, to_jsonb(inserted));

  return jsonb_build_object('id', inserted.id, 'status', inserted.status, 'submittedAt', inserted.submitted_at);
end
$$;

create or replace function public.cancel_time_adjustment_request(target_request_id uuid, target_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  changed public.time_adjustment_requests;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if btrim(coalesce(target_note, '')) = '' then raise check_violation using message = 'A cancellation note is required.'; end if;
  update public.time_adjustment_requests
  set status = 'canceled', canceled_at = clock_timestamp(), decision_note = btrim(target_note)
  where id = target_request_id and employee_id = actor_id and status in ('submitted', 'under_review')
  returning * into changed;
  if changed.id is null then raise check_violation using message = 'This request can no longer be canceled.'; end if;
  insert into public.time_adjustment_request_actions (request_id, action, note, actor_id, snapshot)
  values (changed.id, 'canceled', btrim(target_note), actor_id, to_jsonb(changed));
end
$$;

create or replace function public.create_manual_time_entry(
  target_employee_id uuid,
  target_work_date date,
  target_clock_in_at timestamptz,
  target_clock_out_at timestamptz,
  target_post_id uuid,
  target_shift_id uuid,
  target_reason text,
  target_notes text default null,
  target_exception_id uuid default null,
  target_confirm_warnings boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('time.manual_entry.create');
  in_event public.time_events;
  out_event public.time_events;
  inserted public.manual_time_entries;
  warning_codes text[] := '{}'::text[];
  long_minutes integer := private.timekeeping_setting_integer('timekeeping.long_shift_warning_minutes', 840);
  has_overlap boolean := false;
  selected_shift public.shifts;
begin
  if target_employee_id is null or not exists (select 1 from public.employees where id = target_employee_id and status = 'active') then
    raise check_violation using message = 'Choose an active employee.';
  end if;
  if target_work_date is null or target_clock_in_at is null or target_clock_out_at is null then
    raise check_violation using message = 'Work date, clock-in, and clock-out are required.';
  end if;
  if target_clock_out_at <= target_clock_in_at then raise check_violation using message = 'Clock-out must be after clock-in.'; end if;
  if btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'An entry reason is required.'; end if;
  if extract(epoch from (target_clock_out_at - target_clock_in_at)) / 60 > long_minutes then warning_codes := array_append(warning_codes, 'unusually_long_shift'); end if;

  perform pg_advisory_xact_lock(hashtext('manual-time-entry:' || target_employee_id::text));
  if target_shift_id is not null then
    select * into selected_shift from public.shifts where id = target_shift_id and canceled_at is null;
    if selected_shift.id is null then raise check_violation using message = 'The selected shift is not available.'; end if;
    if target_clock_in_at < selected_shift.starts_at - interval '30 minutes' or target_clock_out_at > selected_shift.ends_at + interval '30 minutes' then
      warning_codes := array_append(warning_codes, 'outside_scheduled_shift');
    end if;
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

  select exists (
    select 1 from public.manual_time_entries entry
    where entry.employee_id = target_employee_id
      and entry.approval_status <> 'rejected'
      and tstzrange(entry.clock_in_at, entry.clock_out_at, '[)') && tstzrange(target_clock_in_at, target_clock_out_at, '[)')
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
    where event.employee_id = target_employee_id
      and not coalesce(latest_correction.voided, false)
      and coalesce(latest_correction.replacement_time, event.recorded_at) >= target_clock_in_at
      and coalesce(latest_correction.replacement_time, event.recorded_at) < target_clock_out_at
    limit 1
  ) into has_overlap;
  if has_overlap then warning_codes := array_append(warning_codes, 'overlapping_time_record'); end if;
  if cardinality(warning_codes) > 0 and not target_confirm_warnings then
    raise check_violation using message = concat('Confirmation required: ', array_to_string(warning_codes, ', '));
  end if;

  insert into public.time_events (employee_id, shift_id, kind, recorded_at, source, idempotency_key, created_by)
  values (target_employee_id, target_shift_id, 'clock_in', target_clock_in_at, 'supervisor', concat('manual-pair-in:', gen_random_uuid()), actor_id)
  returning * into in_event;
  insert into public.time_events (employee_id, shift_id, kind, recorded_at, source, idempotency_key, created_by)
  values (target_employee_id, target_shift_id, 'clock_out', target_clock_out_at, 'supervisor', concat('manual-pair-out:', gen_random_uuid()), actor_id)
  returning * into out_event;

  insert into public.manual_time_entries (
    employee_id, shift_id, post_id, clock_in_event_id, clock_out_event_id, work_date,
    clock_in_at, clock_out_at, reason, notes, warning_codes, warning_confirmation, created_by
  ) values (
    target_employee_id, target_shift_id, target_post_id, in_event.id, out_event.id, target_work_date,
    target_clock_in_at, target_clock_out_at, btrim(target_reason), nullif(btrim(coalesce(target_notes, '')), ''),
    warning_codes, case when cardinality(warning_codes) > 0 then 'Confirmed by authorized user.' end, actor_id
  ) returning * into inserted;

  insert into public.time_event_maintenance_notes (time_event_id, action, note, created_by)
  values
    (in_event.id, 'manual_add', concat('Manual clock-in pair: ', btrim(target_reason)), actor_id),
    (out_event.id, 'manual_add', concat('Manual clock-out pair: ', btrim(target_reason)), actor_id);
  insert into public.manual_time_entry_history (manual_entry_id, action, after_values, reason, actor_id)
  values (inserted.id, 'created', to_jsonb(inserted), btrim(target_reason), actor_id);

  if target_exception_id is not null then
    update public.timekeeping_operational_exceptions
    set status = 'resolved', resolution_method = 'manual_entry', resolution_note = btrim(target_reason), resolved_by = actor_id, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = target_exception_id and employee_id = target_employee_id and status = 'unresolved';
    if found then
      insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
      select id, 'resolved_manual_entry', btrim(target_reason), actor_id, to_jsonb(exception)
      from public.timekeeping_operational_exceptions exception where id = target_exception_id;
    end if;
  end if;

  return jsonb_build_object('id', inserted.id, 'clockInEventId', in_event.id, 'clockOutEventId', out_event.id, 'warningCodes', warning_codes);
end
$$;

create or replace function public.review_time_adjustment_request(
  target_request_id uuid,
  target_decision text,
  target_decision_note text,
  target_confirm_warnings boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('time.adjustments.review');
  request public.time_adjustment_requests;
  manual_result jsonb;
begin
  if target_decision not in ('under_review', 'approved', 'partially_approved', 'rejected') then raise check_violation using message = 'Choose a valid review decision.'; end if;
  if btrim(coalesce(target_decision_note, '')) = '' then raise check_violation using message = 'A decision note is required.'; end if;
  select * into request from public.time_adjustment_requests where id = target_request_id for update;
  if request.id is null or request.status not in ('submitted', 'under_review') then raise check_violation using message = 'This request is no longer awaiting review.'; end if;
  if target_decision in ('approved', 'partially_approved') then
    if request.requested_clock_in_at is null or request.requested_clock_out_at is null then
      raise check_violation using message = 'Approved requests require both a corrected clock-in and clock-out time.';
    end if;
    manual_result := public.create_manual_time_entry(request.employee_id, request.work_date, request.requested_clock_in_at, request.requested_clock_out_at, null, request.shift_id, concat('Approved time-adjustment request: ', request.reason), request.notes, null, target_confirm_warnings);
  end if;
  update public.time_adjustment_requests
  set status = target_decision, reviewer_id = actor_id, reviewed_at = clock_timestamp(), decision_note = btrim(target_decision_note),
      related_manual_entry_id = case when manual_result is null then related_manual_entry_id else (manual_result->>'id')::uuid end
  where id = request.id returning * into request;
  insert into public.time_adjustment_request_actions (request_id, action, note, actor_id, snapshot)
  values (request.id, target_decision, btrim(target_decision_note), actor_id, to_jsonb(request));
  return jsonb_build_object('id', request.id, 'status', request.status, 'manualEntry', manual_result);
end
$$;

create or replace function public.resolve_timekeeping_operational_exception(
  target_exception_id uuid,
  target_action text,
  target_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('time.resolve_exceptions');
  changed public.timekeeping_operational_exceptions;
begin
  if target_action not in ('dismissed', 'resolved_manual_entry', 'resolved_adjustment', 'resolved_call_off', 'resolved_shift_canceled') then raise check_violation using message = 'Choose a valid resolution.'; end if;
  if btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'A documented reason is required.'; end if;
  update public.timekeeping_operational_exceptions
  set status = case when target_action = 'dismissed' then 'dismissed' else 'resolved' end,
      resolution_method = target_action,
      resolution_note = btrim(target_reason), resolved_by = actor_id, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = target_exception_id and status = 'unresolved'
  returning * into changed;
  if changed.id is null then raise check_violation using message = 'This exception is no longer unresolved.'; end if;
  insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
  values (changed.id, target_action, btrim(target_reason), actor_id, to_jsonb(changed));
  update public.operational_alerts set active = false, cleared_at = clock_timestamp(), cleared_by = actor_id
  where related_record_type = 'timekeeping_operational_exception' and related_record_id = changed.id and active;
end
$$;

create or replace function public.acknowledge_operational_alert(target_alert_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id();
begin
  if actor_id is null or not private.timekeeping_can_view_operations() then raise insufficient_privilege using message = 'Timekeeping operations access is required.'; end if;
  insert into public.operational_alert_acknowledgments (alert_id, employee_id)
  select alert.id, actor_id from public.operational_alerts alert where alert.id = target_alert_id and alert.active
  on conflict (alert_id, employee_id) do nothing;
end
$$;

create or replace function public.report_employee_call_off(
  target_employee_id uuid,
  target_shift_id uuid,
  target_call_off_type text,
  target_call_received_at timestamptz,
  target_reason text,
  target_notes text,
  target_replacement_needed boolean,
  target_operational_details text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('accountability.report_call_off');
  report public.call_off_reports;
  employee public.employees;
  shift public.shifts;
  alert_id uuid;
begin
  if target_call_off_type not in ('sick', 'other') then raise check_violation using message = 'Choose Sick or Other call-off.'; end if;
  if btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'A call-off reason is required.'; end if;
  select * into employee from public.employees where id = target_employee_id and status = 'active';
  select * into shift from public.shifts where id = target_shift_id and canceled_at is null;
  if employee.id is null or shift.id is null then raise check_violation using message = 'Choose an active employee and scheduled shift.'; end if;
  if not exists (select 1 from public.shift_assignments assignment where assignment.shift_id = shift.id and assignment.employee_id = employee.id and assignment.status <> 'canceled') then
    raise check_violation using message = 'The employee is not assigned to the selected shift.';
  end if;
  insert into public.call_off_reports (
    shift_id, employee_id, reason, call_received_at, received_by, reported_by, call_off_type,
    replacement_needed, operational_details
  ) values (
    shift.id, employee.id, concat(btrim(target_reason), case when btrim(coalesce(target_notes, '')) = '' then '' else E'\n\n' || btrim(target_notes) end),
    coalesce(target_call_received_at, clock_timestamp()), actor_id, actor_id, target_call_off_type,
    coalesce(target_replacement_needed, true), nullif(btrim(coalesce(target_operational_details, '')), '')
  ) on conflict (shift_id, employee_id) do nothing returning * into report;
  if report.id is null then raise unique_violation using message = 'A call-off already exists for this employee and shift.'; end if;
  insert into public.call_off_report_actions (call_off_report_id, action, reason, actor_id, snapshot)
  values (report.id, 'created', btrim(target_reason), actor_id, to_jsonb(report));
  insert into public.operational_alerts (
    alert_type, priority, title, summary, employee_id, shift_id, related_record_type, related_record_id,
    audience_roles, direct_path, deduplication_key
  ) values (
    'employee_call_off', 'urgent', 'Employee call-off — coverage review required',
    concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name, ' reported ', case when target_call_off_type = 'sick' then 'sick' else 'a call-off' end, '.'),
    employee.id, shift.id, 'call_off_report', report.id,
    array['dispatcher', 'scheduler', 'supervisor', 'admin']::public.app_role[], concat('/scheduler?shift=', shift.id), concat('call-off:', report.id)
  ) returning id into alert_id;
  return jsonb_build_object('id', report.id, 'alertId', alert_id, 'status', 'recorded');
end
$$;

create or replace function public.service_claim_timekeeping_notification_batch(target_limit integer default 25)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  with pending as (
    select outbox.*
    from private.notification_outbox outbox
    where outbox.message_type = 'automatic_clock_out_employee'
      and outbox.delivered_at is null and outbox.failed_at is null
      and outbox.available_at <= clock_timestamp() and outbox.attempt_count < 5
    order by outbox.available_at, outbox.created_at
    limit least(greatest(coalesce(target_limit, 25), 1), 50)
    for update skip locked
  ), touched as (
    update private.notification_outbox outbox
    set attempted_at = clock_timestamp(), attempt_count = outbox.attempt_count + 1, last_error = null
    from pending where outbox.id = pending.id returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', outbox.id,
    'messageType', outbox.message_type,
    'aggregateType', outbox.aggregate_type,
    'aggregateId', outbox.aggregate_id,
    'attemptCount', outbox.attempt_count,
    'recipients', coalesce((
      select jsonb_agg(distinct coalesce(contact.company_email, contact.personal_email))
      from public.timekeeping_operational_exceptions exception
      join private.employee_contacts contact on contact.employee_id = exception.employee_id
      where exception.id = outbox.aggregate_id and coalesce(contact.company_email, contact.personal_email) is not null
    ), '[]'::jsonb),
    'message', (
      select jsonb_build_object(
        'subject', 'SygShift automatic clock-out — review your time',
        'text', concat(
          'Hello ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), ',', E'\n\n',
          'Your shift was automatically clocked out at ', to_char(exception.scheduled_end_at at time zone shift.time_zone, 'MM/DD/YYYY HH12:MI AM'),
          ' because SygShift did not receive a clock-out punch.', E'\n\n',
          'Please review your time record and submit a time-adjustment request if a correction is needed.', E'\n\n',
          'Open SygShift: https://app.sygilant.us/time/my-time'
        ),
        'html', concat(
          '<p>Hello ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), ',</p>',
          '<p>Your shift was <strong>automatically clocked out at ', to_char(exception.scheduled_end_at at time zone shift.time_zone, 'MM/DD/YYYY HH12:MI AM'),
          '</strong> because SygShift did not receive a clock-out punch.</p>',
          '<p>Please review your time record and submit a time-adjustment request if a correction is needed.</p>',
          '<p><a href="https://app.sygilant.us/time/my-time">Open My Time in SygShift</a></p>'
        )
      )
      from public.timekeeping_operational_exceptions exception
      join public.employees employee on employee.id = exception.employee_id
      join public.shifts shift on shift.id = exception.shift_id
      where exception.id = outbox.aggregate_id
    )
  ) order by outbox.id), '[]'::jsonb) into claimed
  from touched outbox;
  return claimed;
end
$$;

revoke all on function private.timekeeping_can_view_operations() from public, anon, authenticated;
revoke all on function private.timekeeping_require_permission(text) from public, anon, authenticated;
revoke all on function public.get_timekeeping_operations_workspace(date, date) from public, anon;
revoke all on function public.submit_time_adjustment_request(uuid, date, text, timestamptz, timestamptz, text, text) from public, anon;
revoke all on function public.cancel_time_adjustment_request(uuid, text) from public, anon;
revoke all on function public.create_manual_time_entry(uuid, date, timestamptz, timestamptz, uuid, uuid, text, text, uuid, boolean) from public, anon;
revoke all on function public.review_time_adjustment_request(uuid, text, text, boolean) from public, anon;
revoke all on function public.resolve_timekeeping_operational_exception(uuid, text, text) from public, anon;
revoke all on function public.acknowledge_operational_alert(uuid) from public, anon;
revoke all on function public.report_employee_call_off(uuid, uuid, text, timestamptz, text, text, boolean, text) from public, anon;
revoke all on function public.service_claim_timekeeping_notification_batch(integer) from public, anon, authenticated;
grant execute on function public.get_timekeeping_operations_workspace(date, date) to authenticated;
grant execute on function public.submit_time_adjustment_request(uuid, date, text, timestamptz, timestamptz, text, text) to authenticated;
grant execute on function public.cancel_time_adjustment_request(uuid, text) to authenticated;
grant execute on function public.create_manual_time_entry(uuid, date, timestamptz, timestamptz, uuid, uuid, text, text, uuid, boolean) to authenticated;
grant execute on function public.review_time_adjustment_request(uuid, text, text, boolean) to authenticated;
grant execute on function public.resolve_timekeeping_operational_exception(uuid, text, text) to authenticated;
grant execute on function public.acknowledge_operational_alert(uuid) to authenticated;
grant execute on function public.report_employee_call_off(uuid, uuid, text, timestamptz, text, text, boolean, text) to authenticated;
grant execute on function public.service_claim_timekeeping_notification_batch(integer) to service_role;

notify pgrst, 'reload schema';
commit;
