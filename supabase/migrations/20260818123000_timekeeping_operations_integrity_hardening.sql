begin;

-- Preserve the existing workspace contract while exposing the independently
-- assignable manual-entry edit capability to the interface.
alter function public.get_timekeeping_operations_workspace(date, date) set schema private;
alter function private.get_timekeeping_operations_workspace(date, date) rename to get_timekeeping_operations_workspace_edit_base;
revoke all on function private.get_timekeeping_operations_workspace_edit_base(date, date) from public, anon, authenticated;

create function public.get_timekeeping_operations_workspace(
  target_from_date date default current_date - 14,
  target_through_date date default current_date + 14
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_timekeeping_operations_workspace_edit_base(target_from_date, target_through_date)
    || jsonb_build_object(
      'canEditManualEntry', public.has_mfa() and public.has_effective_permission('time.manual_entry.edit'),
      'posts', case when private.timekeeping_can_view_operations() then (
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
      'callOffReports', case when private.timekeeping_can_view_operations() then (
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
      ) else '[]'::jsonb end
    )
$$;

-- Apply a requested punch by adding an append-only correction to an existing
-- event, or by creating the genuinely missing event. The original event is
-- never deleted or overwritten.
create or replace function private.apply_adjustment_request_event(
  target_request_id uuid,
  target_employee_id uuid,
  target_shift_id uuid,
  target_kind public.time_event_kind,
  target_recorded_at timestamptz,
  target_reason text,
  target_actor_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing_event public.time_events;
  inserted_event public.time_events;
begin
  if target_kind not in ('clock_in', 'clock_out') then
    raise check_violation using message = 'Only clock-in and clock-out adjustments are supported.';
  end if;

  select event.* into existing_event
  from public.time_events event
  cross join lateral private.current_effective_time_event(event.id) effective
  where event.employee_id = target_employee_id
    and event.shift_id is not distinct from target_shift_id
    and event.kind = target_kind
    and not effective.voided
    and (
      target_shift_id is not null
      or (effective.effective_at at time zone 'America/Denver')::date = (
        select request.work_date from public.time_adjustment_requests request where request.id = target_request_id
      )
    )
  order by effective.effective_at desc, event.recorded_at desc, event.id desc
  limit 1
  for update of event;

  if existing_event.id is not null then
    insert into public.time_event_corrections (
      time_event_id, replacement_time, voided, reason, requested_by, approved_by, approved_at
    ) values (
      existing_event.id, target_recorded_at, false, target_reason, target_employee_id, target_actor_id, clock_timestamp()
    );
    insert into public.time_event_maintenance_notes (time_event_id, action, note, created_by)
    values (existing_event.id, 'time_adjust', target_reason, target_actor_id);
    return existing_event.id;
  end if;

  insert into public.time_events (
    employee_id, shift_id, kind, recorded_at, client_recorded_at, source, idempotency_key, created_by
  ) values (
    target_employee_id,
    target_shift_id,
    target_kind,
    target_recorded_at,
    null,
    'supervisor',
    concat('approved-adjustment:', target_request_id, ':', target_kind::text),
    target_actor_id
  )
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into inserted_event;

  insert into public.time_event_maintenance_notes (time_event_id, action, note, created_by)
  values (inserted_event.id, 'manual_add', target_reason, target_actor_id);
  return inserted_event.id;
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
  selected_shift public.shifts;
  current_clock_in_at timestamptz;
  current_clock_out_at timestamptz;
  effective_clock_in_at timestamptz;
  effective_clock_out_at timestamptz;
  clock_in_event_id uuid;
  clock_out_event_id uuid;
  warning_codes text[] := '{}'::text[];
  long_minutes integer := private.timekeeping_setting_integer('timekeeping.long_shift_warning_minutes', 840);
  resolution_reason text;
begin
  if target_decision not in ('under_review', 'approved', 'partially_approved', 'rejected') then
    raise check_violation using message = 'Choose a valid review decision.';
  end if;
  if btrim(coalesce(target_decision_note, '')) = '' then
    raise check_violation using message = 'A decision note is required.';
  end if;

  select * into request from public.time_adjustment_requests where id = target_request_id for update;
  if request.id is null or request.status not in ('submitted', 'under_review') then
    raise check_violation using message = 'This request is no longer awaiting review.';
  end if;

  if request.shift_id is not null then
    select * into selected_shift from public.shifts where id = request.shift_id;
  end if;

  if target_decision in ('approved', 'partially_approved') then
    if request.requested_clock_in_at is null and request.requested_clock_out_at is null then
      raise check_violation using message = 'An approved request must include at least one requested punch time.';
    end if;

    select effective.effective_at into current_clock_in_at
    from public.time_events event
    cross join lateral private.current_effective_time_event(event.id) effective
    where event.employee_id = request.employee_id
      and event.shift_id is not distinct from request.shift_id
      and event.kind = 'clock_in'
      and not effective.voided
      and (
        request.shift_id is not null
        or (effective.effective_at at time zone 'America/Denver')::date = request.work_date
      )
    order by effective.effective_at desc, event.id desc limit 1;

    select effective.effective_at into current_clock_out_at
    from public.time_events event
    cross join lateral private.current_effective_time_event(event.id) effective
    where event.employee_id = request.employee_id
      and event.shift_id is not distinct from request.shift_id
      and event.kind = 'clock_out'
      and not effective.voided
      and (
        request.shift_id is not null
        or (effective.effective_at at time zone 'America/Denver')::date = request.work_date
      )
    order by effective.effective_at desc, event.id desc limit 1;

    effective_clock_in_at := coalesce(request.requested_clock_in_at, current_clock_in_at);
    effective_clock_out_at := coalesce(request.requested_clock_out_at, current_clock_out_at);

    if target_decision = 'approved' and (effective_clock_in_at is null or effective_clock_out_at is null) then
      raise check_violation using message = 'Full approval requires a complete clock-in and clock-out pair. Choose Partial Approval or add the missing time.';
    end if;
    if effective_clock_in_at is not null and effective_clock_out_at is not null and effective_clock_out_at <= effective_clock_in_at then
      raise check_violation using message = 'The resulting clock-out must be after the resulting clock-in.';
    end if;
    if effective_clock_in_at is not null and effective_clock_out_at is not null
      and extract(epoch from (effective_clock_out_at - effective_clock_in_at)) / 60 > long_minutes then
      warning_codes := array_append(warning_codes, 'unusually_long_shift');
    end if;
    if selected_shift.id is not null and (
      (request.requested_clock_in_at is not null and request.requested_clock_in_at < selected_shift.starts_at - interval '30 minutes')
      or (request.requested_clock_out_at is not null and request.requested_clock_out_at > selected_shift.ends_at + interval '30 minutes')
    ) then
      warning_codes := array_append(warning_codes, 'outside_scheduled_shift');
    end if;
    if cardinality(warning_codes) > 0 and not target_confirm_warnings then
      raise check_violation using message = concat('Confirmation required: ', array_to_string(warning_codes, ', '));
    end if;

    resolution_reason := concat('Approved time-adjustment request: ', request.reason, '. Decision: ', btrim(target_decision_note));
    if request.requested_clock_in_at is not null then
      clock_in_event_id := private.apply_adjustment_request_event(request.id, request.employee_id, request.shift_id, 'clock_in', request.requested_clock_in_at, resolution_reason, actor_id);
    end if;
    if request.requested_clock_out_at is not null then
      clock_out_event_id := private.apply_adjustment_request_event(request.id, request.employee_id, request.shift_id, 'clock_out', request.requested_clock_out_at, resolution_reason, actor_id);
    end if;

    with resolved as (
      update public.timekeeping_operational_exceptions exception
      set status = 'resolved', resolution_method = 'resolved_adjustment', resolution_note = resolution_reason,
          resolved_by = actor_id, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
      where exception.employee_id = request.employee_id
        and exception.shift_id is not distinct from request.shift_id
        and exception.status = 'unresolved'
        and (
          (exception.exception_code = 'missing_clock_in' and request.requested_clock_in_at is not null)
          or (exception.exception_code = 'automatic_clock_out' and request.requested_clock_out_at is not null)
        )
      returning exception.*
    )
    insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
    select resolved.id, 'resolved_adjustment', resolution_reason, actor_id, to_jsonb(resolved) from resolved;

    update public.operational_alerts alert
    set active = false, cleared_at = clock_timestamp(), cleared_by = actor_id
    where alert.related_record_type = 'timekeeping_operational_exception'
      and alert.related_record_id in (
        select exception.id from public.timekeeping_operational_exceptions exception
        where exception.employee_id = request.employee_id and exception.shift_id is not distinct from request.shift_id and exception.status = 'resolved'
      );
  end if;

  update public.time_adjustment_requests
  set status = target_decision, reviewer_id = actor_id, reviewed_at = clock_timestamp(), decision_note = btrim(target_decision_note)
  where id = request.id returning * into request;
  insert into public.time_adjustment_request_actions (request_id, action, note, actor_id, snapshot)
  values (request.id, target_decision, btrim(target_decision_note), actor_id, to_jsonb(request));

  return jsonb_build_object(
    'id', request.id,
    'status', request.status,
    'manualEntry', null,
    'clockInEventId', clock_in_event_id,
    'clockOutEventId', clock_out_event_id,
    'warningCodes', warning_codes
  );
end
$$;

-- Return every eligible employee address. The Worker applies the centralized
-- blocked-domain policy before contacting the provider, while still allowing a
-- personal address when a blocked company address is also present.
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
    select outbox.* from private.notification_outbox outbox
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
    'id', outbox.id, 'messageType', outbox.message_type, 'aggregateType', outbox.aggregate_type,
    'aggregateId', outbox.aggregate_id, 'attemptCount', outbox.attempt_count,
    'recipients', coalesce((
      select jsonb_agg(distinct lower(address.email))
      from public.timekeeping_operational_exceptions exception
      join private.employee_contacts contact on contact.employee_id = exception.employee_id
      cross join lateral (values (contact.company_email), (contact.personal_email)) address(email)
      where exception.id = outbox.aggregate_id and nullif(btrim(address.email), '') is not null
    ), '[]'::jsonb),
    'message', (
      select jsonb_build_object(
        'subject', 'SygShift automatic clock-out — review your time',
        'text', concat('Hello ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), ',', E'\n\n',
          'Your shift was automatically clocked out at ', to_char(exception.scheduled_end_at at time zone shift.time_zone, 'MM/DD/YYYY HH12:MI AM'),
          ' because SygShift did not receive a clock-out punch.', E'\n\n',
          'Please review your time record and submit a time-adjustment request if a correction is needed.', E'\n\n',
          'Open SygShift: https://app.sygilant.us/time/my-time'),
        'html', concat('<p>Hello ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), ',</p>',
          '<p>Your shift was <strong>automatically clocked out at ', to_char(exception.scheduled_end_at at time zone shift.time_zone, 'MM/DD/YYYY HH12:MI AM'),
          '</strong> because SygShift did not receive a clock-out punch.</p>',
          '<p>Please review your time record and submit a time-adjustment request if a correction is needed.</p>',
          '<p><a href="https://app.sygilant.us/time/my-time">Open My Time in SygShift</a></p>')
      )
      from public.timekeeping_operational_exceptions exception
      join public.employees employee on employee.id = exception.employee_id
      join public.shifts shift on shift.id = exception.shift_id
      where exception.id = outbox.aggregate_id
    )
  ) order by outbox.id), '[]'::jsonb) into claimed from touched outbox;
  return claimed;
end
$$;

revoke all on function private.apply_adjustment_request_event(uuid, uuid, uuid, public.time_event_kind, timestamptz, text, uuid) from public, anon, authenticated;
revoke all on function public.get_timekeeping_operations_workspace(date, date) from public, anon;
revoke all on function public.review_time_adjustment_request(uuid, text, text, boolean) from public, anon;
revoke all on function public.service_claim_timekeeping_notification_batch(integer) from public, anon, authenticated;
grant execute on function public.get_timekeeping_operations_workspace(date, date) to authenticated;
grant execute on function public.review_time_adjustment_request(uuid, text, text, boolean) to authenticated;
grant execute on function public.service_claim_timekeeping_notification_batch(integer) to service_role;

notify pgrst, 'reload schema';
commit;
