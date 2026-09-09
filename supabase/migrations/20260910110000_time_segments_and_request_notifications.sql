begin;

-- Employees may return to the same assigned shift after a personal appointment.
-- The original clock-out remains immutable and the return is a new time segment.
do $migration$
declare
  definition text;
  old_guard text := $old$    if selected_shift.ends_at < server_now then
      raise check_violation using message = 'Clock-in is no longer available because the assigned shift has ended.';
    end if;$old$;
  new_guard text := $new$    if selected_shift.ends_at < server_now
       and not (
         last_kind = 'clock_out'
         and last_shift_id = resolved_shift_id
         and server_now <= selected_shift.ends_at + interval '6 hours'
       ) then
      raise check_violation using message = 'Clock-in is no longer available because the assigned shift has ended.';
    end if;$new$;
begin
  definition := pg_get_functiondef(
    'public.record_time_event(public.time_event_kind,uuid,timestamptz,text)'::regprocedure
  );
  if position(old_guard in definition) = 0 then
    raise exception 'record_time_event end-window guard did not match the reviewed production definition';
  end if;
  definition := replace(definition, old_guard, new_guard);
  execute definition;
end
$migration$;

comment on function public.record_time_event(public.time_event_kind, uuid, timestamptz, text) is
  'Records append-only employee punches using trusted server time. A clocked-out employee may resume the same assigned shift for six hours after its scheduled end; the unpaid gap and every segment remain reviewable.';

alter table public.employee_notifications
  add column action_required boolean not null default false,
  add column resolved_at timestamptz;

alter table public.employee_notifications
  add constraint employee_notifications_workflow_action_check
  check (not action_required or action_path is not null);

create index employee_notifications_open_workflow_action_idx
  on public.employee_notifications(recipient_employee_id, created_at desc)
  where action_required and resolved_at is null and dismissed_at is null;

comment on column public.employee_notifications.action_required is
  'True when the notification represents work that remains open in an authoritative workflow.';
comment on column public.employee_notifications.resolved_at is
  'When the underlying workflow action stopped requiring this recipient''s attention. History is retained.';

create or replace function private.employee_can_receive_notification(target_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_employee_id
      and employee.status = 'active'
      and account.activated_at is not null
      and account.disabled_at is null
  );
$$;

create or replace function private.create_workflow_notification(
  target_recipient_employee_id uuid,
  target_source_type text,
  target_source_id uuid,
  target_title text,
  target_body text,
  target_priority text,
  target_action_path text,
  target_action_label text,
  target_sender_employee_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  notification_id uuid;
  notification_key text := left(concat(
    'workflow-action:', target_source_type, ':', target_source_id, ':', target_recipient_employee_id
  ), 500);
begin
  if not private.employee_can_receive_notification(target_recipient_employee_id) then
    return null;
  end if;
  if target_priority not in ('routine', 'important', 'urgent') then
    raise check_violation using message = 'Choose a valid notification priority.';
  end if;
  if target_action_path is null or target_action_path not like '/%' then
    raise check_violation using message = 'A local action path is required for workflow notifications.';
  end if;

  insert into public.employee_notifications (
    recipient_employee_id,
    sender_employee_id,
    source_type,
    source_id,
    source_key,
    title,
    body,
    priority,
    requires_acknowledgement,
    action_required,
    action_path,
    action_label,
    resolved_at
  ) values (
    target_recipient_employee_id,
    target_sender_employee_id,
    left(btrim(target_source_type), 80),
    target_source_id,
    notification_key,
    left(btrim(target_title), 200),
    left(btrim(target_body), 5000),
    target_priority,
    false,
    true,
    left(btrim(target_action_path), 500),
    left(btrim(target_action_label), 80),
    null
  )
  on conflict (source_key) do update
  set
    sender_employee_id = excluded.sender_employee_id,
    title = excluded.title,
    body = excluded.body,
    priority = excluded.priority,
    action_required = true,
    action_path = excluded.action_path,
    action_label = excluded.action_label,
    expires_at = null,
    resolved_at = null,
    read_at = null,
    dismissed_at = null,
    created_at = clock_timestamp()
  returning id into notification_id;

  return notification_id;
end
$$;

create or replace function private.resolve_workflow_notifications(
  target_source_type text,
  target_source_id uuid,
  target_recipient_employee_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer;
begin
  update public.employee_notifications notification
  set resolved_at = coalesce(notification.resolved_at, clock_timestamp())
  where notification.source_type = target_source_type
    and notification.source_id = target_source_id
    and notification.action_required
    and notification.resolved_at is null
    and (target_recipient_employee_id is null or notification.recipient_employee_id = target_recipient_employee_id);
  get diagnostics affected = row_count;
  return affected;
end
$$;

create or replace function private.notify_workflow_status(
  target_recipient_employee_id uuid,
  target_source_type text,
  target_source_id uuid,
  target_status text,
  target_title text,
  target_body text,
  target_action_path text,
  target_action_label text,
  target_sender_employee_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.employee_can_receive_notification(target_recipient_employee_id) then
    return null;
  end if;
  return private.create_employee_notification(
    target_recipient_employee_id,
    target_source_type,
    target_source_id,
    left(concat('workflow-status:', target_source_type, ':', target_source_id, ':', target_status, ':', target_recipient_employee_id), 500),
    target_title,
    target_body,
    'routine',
    false,
    target_action_path,
    target_action_label,
    target_sender_employee_id
  );
end
$$;

create or replace function private.notify_authorized_workflow_reviewers(
  target_source_type text,
  target_source_id uuid,
  target_subject_employee_id uuid,
  target_permission_codes text[],
  target_excluded_employee_id uuid,
  target_title text,
  target_body text,
  target_priority text,
  target_action_path text,
  target_action_label text,
  target_scope_supervisors boolean default false,
  target_assigned_employee_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient record;
  notified integer := 0;
begin
  for recipient in
    select employee.id
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.status = 'active'
      and account.activated_at is not null
      and account.disabled_at is null
      and employee.id is distinct from target_excluded_employee_id
      and (target_assigned_employee_id is null or employee.id = target_assigned_employee_id)
      and coalesce(private.employee_effective_permissions(employee.id), array[]::text[]) && target_permission_codes
      and (
        not target_scope_supervisors
        or target_subject_employee_id is null
        or employee.role = 'admin'
        or exists (
          select 1
          from public.employee_access_roles role_assignment
          join public.access_roles access_role on access_role.id = role_assignment.role_id
          where role_assignment.employee_id = employee.id
            and access_role.active
            and access_role.code = 'system_admin'
        )
        or not exists (
          select 1 from private.employee_supervisor_assignments scope
          where scope.supervisor_employee_id = employee.id
        )
        or exists (
          select 1 from private.employee_supervisor_assignments scope
          where scope.supervisor_employee_id = employee.id
            and scope.employee_id = target_subject_employee_id
        )
      )
  loop
    if private.create_workflow_notification(
      recipient.id,
      target_source_type,
      target_source_id,
      target_title,
      target_body,
      target_priority,
      target_action_path,
      target_action_label,
      target_excluded_employee_id
    ) is not null then
      notified := notified + 1;
    end if;
  end loop;
  return notified;
end
$$;

create or replace function private.sync_compensation_workflow_queue()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue_id constant uuid := '00000000-0000-4000-8000-00000000c001';
  pending_count integer;
begin
  select count(*)::integer into pending_count
  from private.hr_compensation_proposals proposal
  where proposal.status = 'pending';

  perform private.resolve_workflow_notifications('hr_compensation_request', queue_id);
  if pending_count = 0 then
    return 0;
  end if;

  return private.notify_authorized_workflow_reviewers(
    'hr_compensation_request',
    queue_id,
    null,
    array['hr.compensation.approve'],
    null,
    case when pending_count = 1 then 'Compensation proposal needs approval' else concat(pending_count, ' compensation proposals need approval') end,
    case when pending_count = 1
      then 'A protected compensation proposal requires an independent authorized decision. No pay details are included in this notification.'
      else concat(pending_count, ' protected compensation proposals require independent authorized decisions. No pay details are included in this notification.')
    end,
    'important',
    '/hr/compensation',
    'Review compensation',
    false,
    null
  );
end
$$;

create or replace function private.route_request_workflow_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb := to_jsonb(new);
  prior_payload jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  relation_key text := concat(tg_table_schema, '.', tg_table_name);
  source_id uuid := (payload ->> 'id')::uuid;
  source_type text;
  subject_id uuid;
  requester_id uuid;
  excluded_reviewer_id uuid;
  assigned_id uuid;
  current_status text;
  prior_status text;
  reviewer_permissions text[];
  action_path text;
  action_label text;
  review_title text;
  review_body text;
  priority text := 'important';
  workflow_open boolean := false;
  notify_employee_action boolean := false;
  aggregate_workflow boolean := false;
  scope_supervisors boolean := false;
begin
  case relation_key
    when 'public.time_off_requests' then
      source_type := 'time_off_request';
      subject_id := (payload ->> 'employee_id')::uuid;
      requester_id := subject_id;
      current_status := payload ->> 'status';
      prior_status := prior_payload ->> 'status';
      workflow_open := current_status = 'pending';
      reviewer_permissions := array['requests.manage'];
      action_path := '/requests'; action_label := 'Review request';
      review_title := 'Time-off request needs review';
      review_body := 'A time-off request is waiting for an authorized decision.';
      scope_supervisors := true;
    when 'public.employee_availability' then
      source_type := 'availability_request';
      subject_id := (payload ->> 'employee_id')::uuid;
      requester_id := coalesce((payload ->> 'submitted_by')::uuid, subject_id);
      current_status := payload ->> 'approval_status';
      prior_status := prior_payload ->> 'approval_status';
      workflow_open := current_status = 'pending';
      reviewer_permissions := array['availability.manage'];
      action_path := '/availability'; action_label := 'Review availability';
      review_title := 'Availability request needs review';
      review_body := 'An employee availability request is waiting for an authorized decision.';
      scope_supervisors := true;
    when 'public.shift_requests' then
      source_type := 'shift_request';
      subject_id := (payload ->> 'employee_id')::uuid;
      requester_id := subject_id;
      current_status := payload ->> 'status';
      prior_status := prior_payload ->> 'status';
      workflow_open := current_status = 'pending';
      reviewer_permissions := array['requests.manage'];
      action_path := '/requests'; action_label := 'Review request';
      review_title := 'Shift request needs review';
      review_body := 'A shift request is waiting for an authorized decision.';
      scope_supervisors := true;
    when 'public.call_off_reports' then
      source_type := 'call_off_request';
      subject_id := (payload ->> 'employee_id')::uuid;
      requester_id := coalesce((payload ->> 'reported_by')::uuid, subject_id);
      current_status := case
        when payload ->> 'canceled_at' is not null then 'canceled'
        when payload ->> 'resolved_at' is not null then 'resolved'
        else 'open'
      end;
      prior_status := case
        when prior_payload ->> 'canceled_at' is not null then 'canceled'
        when prior_payload ->> 'resolved_at' is not null then 'resolved'
        else 'open'
      end;
      workflow_open := current_status = 'open';
      reviewer_permissions := array['requests.manage'];
      action_path := '/requests'; action_label := 'Open call-off';
      review_title := 'Urgent call-off needs coverage action';
      review_body := 'A reported call-off is waiting for an authorized coverage response.';
      priority := 'urgent'; scope_supervisors := true;
    when 'public.time_event_corrections' then
      source_type := 'time_correction_request';
      select event.employee_id into subject_id
      from public.time_events event where event.id = (payload ->> 'time_event_id')::uuid;
      requester_id := (payload ->> 'requested_by')::uuid;
      current_status := case
        when payload ->> 'approved_at' is not null then 'approved'
        when payload ->> 'declined_at' is not null then 'declined'
        else 'pending'
      end;
      prior_status := case
        when prior_payload ->> 'approved_at' is not null then 'approved'
        when prior_payload ->> 'declined_at' is not null then 'declined'
        else 'pending'
      end;
      workflow_open := current_status = 'pending';
      reviewer_permissions := array['time.adjustments.review'];
      action_path := '/time/review'; action_label := 'Review correction';
      review_title := 'Time correction needs review';
      review_body := 'An employee time correction is waiting for an authorized decision.';
      scope_supervisors := true;
    when 'public.time_adjustment_requests' then
      source_type := 'time_adjustment_request';
      subject_id := (payload ->> 'employee_id')::uuid;
      requester_id := (payload ->> 'submitted_by')::uuid;
      current_status := payload ->> 'status';
      prior_status := prior_payload ->> 'status';
      workflow_open := current_status in ('submitted', 'under_review');
      reviewer_permissions := array['time.adjustments.review'];
      action_path := '/time/review'; action_label := 'Review time request';
      review_title := 'Time adjustment needs review';
      review_body := 'An employee time adjustment is waiting for an authorized decision.';
      scope_supervisors := true;
    when 'private.hr_document_requests' then
      source_type := 'hr_document_request';
      subject_id := (payload ->> 'employee_id')::uuid;
      requester_id := (payload ->> 'requested_by')::uuid;
      current_status := payload ->> 'status';
      prior_status := prior_payload ->> 'status';
      notify_employee_action := current_status = 'requested';
      workflow_open := current_status = 'submitted';
      reviewer_permissions := array['hr.documents.manage'];
      action_path := '/hr/documents'; action_label := 'Review document';
      review_title := 'HR document response needs review';
      review_body := 'A protected employee document response is waiting for authorized HR review.';
    when 'private.hr_service_requests' then
      source_type := 'hr_service_request';
      subject_id := (payload ->> 'subject_employee_id')::uuid;
      requester_id := (payload ->> 'requester_id')::uuid;
      assigned_id := (payload ->> 'assigned_to')::uuid;
      current_status := payload ->> 'status';
      prior_status := prior_payload ->> 'status';
      workflow_open := current_status in ('submitted', 'under_review');
      reviewer_permissions := array['hr.self_service.manage'];
      action_path := '/hr/self-service'; action_label := 'Review HR request';
      review_title := 'Employee HR request needs review';
      review_body := 'A protected employee HR request is waiting for authorized review.';
    when 'private.hr_lifecycle_cases' then
      source_type := 'hr_lifecycle_request';
      subject_id := (payload ->> 'employee_id')::uuid;
      requester_id := (payload ->> 'requested_by')::uuid;
      current_status := payload ->> 'status';
      prior_status := prior_payload ->> 'status';
      workflow_open := current_status = 'pending_approval';
      reviewer_permissions := array['hr.offboarding.approve'];
      action_path := '/hr/offboarding'; action_label := 'Review lifecycle case';
      review_title := 'Independent HR lifecycle approval required';
      review_body := 'A protected employee lifecycle case requires an independent authorized decision.';
    when 'private.hr_candidate_conversion_requests' then
      source_type := 'hr_candidate_conversion_request';
      requester_id := (payload ->> 'requested_by')::uuid;
      current_status := payload ->> 'status';
      prior_status := prior_payload ->> 'status';
      workflow_open := current_status = 'requested';
      reviewer_permissions := array['hr.recruiting.approve'];
      action_path := '/hr/recruiting'; action_label := 'Review conversion';
      review_title := 'Candidate conversion needs approval';
      review_body := 'A candidate conversion request is waiting for an independent authorized decision.';
    when 'private.hr_compensation_proposals' then
      source_type := 'hr_compensation_request';
      subject_id := (payload ->> 'employee_id')::uuid;
      requester_id := (payload ->> 'proposed_by')::uuid;
      current_status := payload ->> 'status';
      prior_status := prior_payload ->> 'status';
      workflow_open := current_status = 'pending';
      reviewer_permissions := array['hr.compensation.approve'];
      action_path := '/hr/compensation'; action_label := 'Review proposal';
      review_title := 'Independent compensation approval required';
      review_body := 'A protected compensation proposal requires an independent authorized decision. No pay details are included in this notification.';
      aggregate_workflow := true;
    when 'private.hr_payroll_change_proposals' then
      source_type := 'hr_payroll_request';
      subject_id := (payload ->> 'employee_id')::uuid;
      requester_id := (payload ->> 'proposed_by')::uuid;
      current_status := payload ->> 'status';
      prior_status := prior_payload ->> 'status';
      workflow_open := current_status = 'pending_approval';
      reviewer_permissions := array['hr.payroll_integration.approve'];
      action_path := '/hr/payroll-integration'; action_label := 'Review payroll change';
      review_title := 'Independent payroll approval required';
      review_body := 'A protected payroll-impacting proposal requires an independent authorized decision. No payroll details are included in this notification.';
    else
      return new;
  end case;

  if tg_op = 'UPDATE'
     and current_status is not distinct from prior_status
     and not (
       relation_key = 'private.hr_service_requests'
       and payload ->> 'assigned_to' is distinct from prior_payload ->> 'assigned_to'
     ) then
    return new;
  end if;

  -- Most requesters should not receive their own review work. For a document
  -- response, however, the employee is the submitting party and the HR
  -- requester remains an eligible reviewer.
  excluded_reviewer_id := case
    when source_type = 'hr_document_request' then subject_id
    else requester_id
  end;

  perform private.resolve_workflow_notifications(source_type, source_id);

  if notify_employee_action then
    perform private.create_workflow_notification(
      subject_id,
      source_type,
      source_id,
      'HR document requested',
      'Human Resources has requested a protected document from you.',
      'important',
      '/my-documents',
      'Open My Documents',
      requester_id
    );
  elsif aggregate_workflow then
    perform private.sync_compensation_workflow_queue();
  elsif workflow_open then
    perform private.notify_authorized_workflow_reviewers(
      source_type,
      source_id,
      subject_id,
      reviewer_permissions,
      excluded_reviewer_id,
      review_title,
      review_body,
      priority,
      action_path,
      action_label,
      scope_supervisors,
      assigned_id
    );
  end if;

  if current_status is distinct from prior_status
     and not workflow_open
     and not notify_employee_action
     and current_status is not null
     and requester_id is not null then
    perform private.notify_workflow_status(
      requester_id,
      source_type,
      source_id,
      current_status,
      case
        when source_type like 'hr_%' then 'HR request updated'
        when source_type like 'time_%' then 'Time request updated'
        when source_type = 'availability_request' then 'Availability request updated'
        when source_type = 'shift_request' then 'Shift request updated'
        when source_type = 'call_off_request' then 'Call-off updated'
        else 'Request updated'
      end,
      concat('Your request status is now ', replace(current_status, '_', ' '), '.'),
      case when source_type like 'hr_%' then '/notifications' else action_path end,
      case when source_type like 'hr_%' then 'Open notification' else action_label end,
      coalesce((payload ->> 'decided_by')::uuid, (payload ->> 'reviewer_id')::uuid, (payload ->> 'resolved_by')::uuid, (payload ->> 'approved_by')::uuid)
    );

    if source_type = 'hr_document_request' and subject_id is distinct from requester_id then
      perform private.notify_workflow_status(
        subject_id,
        source_type,
        source_id,
        current_status,
        'HR document request updated',
        concat('Your HR document request status is now ', replace(current_status, '_', ' '), '.'),
        '/my-documents',
        'Open My Documents',
        (payload ->> 'reviewed_by')::uuid
      );
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists notify_time_off_request_workflow on public.time_off_requests;
create trigger notify_time_off_request_workflow
after insert or update on public.time_off_requests
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_employee_availability_workflow on public.employee_availability;
create trigger notify_employee_availability_workflow
after insert or update on public.employee_availability
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_shift_request_workflow on public.shift_requests;
create trigger notify_shift_request_workflow
after insert or update on public.shift_requests
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_call_off_request_workflow on public.call_off_reports;
create trigger notify_call_off_request_workflow
after insert or update on public.call_off_reports
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_time_correction_request_workflow on public.time_event_corrections;
create trigger notify_time_correction_request_workflow
after insert or update on public.time_event_corrections
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_time_adjustment_request_workflow on public.time_adjustment_requests;
create trigger notify_time_adjustment_request_workflow
after insert or update on public.time_adjustment_requests
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_hr_document_request_workflow on private.hr_document_requests;
create trigger notify_hr_document_request_workflow
after insert or update on private.hr_document_requests
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_hr_service_request_workflow on private.hr_service_requests;
create trigger notify_hr_service_request_workflow
after insert or update on private.hr_service_requests
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_hr_lifecycle_request_workflow on private.hr_lifecycle_cases;
create trigger notify_hr_lifecycle_request_workflow
after insert or update on private.hr_lifecycle_cases
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_hr_candidate_conversion_workflow on private.hr_candidate_conversion_requests;
create trigger notify_hr_candidate_conversion_workflow
after insert or update on private.hr_candidate_conversion_requests
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_hr_compensation_request_workflow on private.hr_compensation_proposals;
create trigger notify_hr_compensation_request_workflow
after insert or update on private.hr_compensation_proposals
for each row execute function private.route_request_workflow_notification();

drop trigger if exists notify_hr_payroll_request_workflow on private.hr_payroll_change_proposals;
create trigger notify_hr_payroll_request_workflow
after insert or update on private.hr_payroll_change_proposals
for each row execute function private.route_request_workflow_notification();

-- Bring already-open work into the same inbox during release without
-- rewriting the authoritative request rows or their updated timestamps.
do $backfill$
declare item record;
begin
  for item in
    select request.id, request.employee_id, request.employee_id as requester_id, 'time_off_request'::text as source_type,
      array['requests.manage']::text[] as permissions, '/requests'::text as action_path, 'Review request'::text as action_label,
      'Time-off request needs review'::text as title, 'A time-off request is waiting for an authorized decision.'::text as body,
      'important'::text as priority
    from public.time_off_requests request where request.status = 'pending'
    union all
    select request.id, request.employee_id, coalesce(request.submitted_by, request.employee_id), 'availability_request', array['availability.manage']::text[], '/availability', 'Review availability',
      'Availability request needs review', 'An employee availability request is waiting for an authorized decision.', 'important'
    from public.employee_availability request where request.approval_status = 'pending'
    union all
    select request.id, request.employee_id, request.employee_id, 'shift_request', array['requests.manage']::text[], '/requests', 'Review request',
      'Shift request needs review', 'A shift request is waiting for an authorized decision.', 'important'
    from public.shift_requests request where request.status = 'pending'
    union all
    select report.id, report.employee_id, coalesce(report.reported_by, report.employee_id), 'call_off_request', array['requests.manage']::text[], '/requests', 'Open call-off',
      'Urgent call-off needs coverage action', 'A reported call-off is waiting for an authorized coverage response.', 'urgent'
    from public.call_off_reports report where report.resolved_at is null and report.canceled_at is null
    union all
    select request.id, event.employee_id, request.requested_by, 'time_correction_request', array['time.adjustments.review']::text[], '/time/review', 'Review correction',
      'Time correction needs review', 'An employee time correction is waiting for an authorized decision.', 'important'
    from public.time_event_corrections request
    join public.time_events event on event.id = request.time_event_id
    where request.approved_at is null and request.declined_at is null
    union all
    select request.id, request.employee_id, request.submitted_by, 'time_adjustment_request', array['time.adjustments.review']::text[], '/time/review', 'Review time request',
      'Time adjustment needs review', 'An employee time adjustment is waiting for an authorized decision.', 'important'
    from public.time_adjustment_requests request where request.status in ('submitted','under_review')
  loop
    perform private.notify_authorized_workflow_reviewers(
      item.source_type, item.id, item.employee_id, item.permissions, item.requester_id,
      item.title, item.body, item.priority, item.action_path, item.action_label, true, null
    );
  end loop;

  for item in
    select request.* from private.hr_document_requests request where request.status = 'requested'
  loop
    perform private.create_workflow_notification(
      item.employee_id, 'hr_document_request', item.id, 'HR document requested',
      'Human Resources has requested a protected document from you.', 'important',
      '/my-documents', 'Open My Documents', item.requested_by
    );
  end loop;

  for item in
    select request.* from private.hr_document_requests request where request.status = 'submitted'
  loop
    perform private.notify_authorized_workflow_reviewers(
      'hr_document_request', item.id, item.employee_id, array['hr.documents.manage'], item.employee_id,
      'HR document response needs review', 'A protected employee document response is waiting for authorized HR review.',
      'important', '/hr/documents', 'Review document', false, null
    );
  end loop;

  for item in
    select request.* from private.hr_service_requests request where request.status in ('submitted','under_review')
  loop
    perform private.notify_authorized_workflow_reviewers(
      'hr_service_request', item.id, item.subject_employee_id, array['hr.self_service.manage'], item.requester_id,
      'Employee HR request needs review', 'A protected employee HR request is waiting for authorized review.',
      'important', '/hr/self-service', 'Review HR request', false, item.assigned_to
    );
  end loop;

  for item in
    select request.* from private.hr_lifecycle_cases request where request.status = 'pending_approval'
  loop
    perform private.notify_authorized_workflow_reviewers(
      'hr_lifecycle_request', item.id, item.employee_id, array['hr.offboarding.approve'], item.requested_by,
      'Independent HR lifecycle approval required', 'A protected employee lifecycle case requires an independent authorized decision.',
      'important', '/hr/offboarding', 'Review lifecycle case', false, null
    );
  end loop;

  for item in
    select request.* from private.hr_candidate_conversion_requests request where request.status = 'requested'
  loop
    perform private.notify_authorized_workflow_reviewers(
      'hr_candidate_conversion_request', item.id, null, array['hr.recruiting.approve'], item.requested_by,
      'Candidate conversion needs approval', 'A candidate conversion request is waiting for an independent authorized decision.',
      'important', '/hr/recruiting', 'Review conversion', false, null
    );
  end loop;

  perform private.sync_compensation_workflow_queue();

  for item in
    select request.* from private.hr_payroll_change_proposals request where request.status = 'pending_approval'
  loop
    perform private.notify_authorized_workflow_reviewers(
      'hr_payroll_request', item.id, item.employee_id, array['hr.payroll_integration.approve'], item.proposed_by,
      'Independent payroll approval required',
      'A protected payroll-impacting proposal requires an independent authorized decision. No payroll details are included in this notification.',
      'important', '/hr/payroll-integration', 'Review payroll change', false, null
    );
  end loop;
end
$backfill$;

-- Existing signature delivery already creates notification-center records.
-- Classify those records as open actions and resolve them per recipient.
create or replace function private.classify_signature_workflow_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source_type = 'document_signature' then
    new.action_required := true;
    new.resolved_at := null;
  end if;
  return new;
end
$$;

drop trigger if exists classify_signature_workflow_notification on public.employee_notifications;
create trigger classify_signature_workflow_notification
before insert on public.employee_notifications
for each row execute function private.classify_signature_workflow_notification();

create or replace function private.resolve_signature_workflow_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.employee_id is not null
     and new.status in ('completed','declined','correction_requested','expired','voided','reassigned')
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    perform private.resolve_workflow_notifications('document_signature', new.envelope_id, new.employee_id);
  end if;
  return new;
end
$$;

drop trigger if exists resolve_signature_workflow_notification on private.signature_recipients;
create trigger resolve_signature_workflow_notification
after insert or update of status on private.signature_recipients
for each row execute function private.resolve_signature_workflow_notification();

update public.employee_notifications notification
set
  action_required = true,
  resolved_at = case
    when exists (
      select 1
      from private.signature_recipients recipient
      where recipient.envelope_id = notification.source_id
        and recipient.employee_id = notification.recipient_employee_id
        and recipient.status in ('completed','declined','correction_requested','expired','voided','reassigned')
    ) then coalesce(notification.resolved_at, clock_timestamp())
    else null
  end
where notification.source_type = 'document_signature';

create or replace function public.get_my_notification_badge()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  return (
    select jsonb_build_object(
      'unread', count(*) filter (where notification.read_at is null),
      'requiresAction', count(*) filter (where
        (notification.action_required and notification.resolved_at is null)
        or (notification.requires_acknowledgement and notification.acknowledged_at is null)
      ),
      'urgent', count(*) filter (where notification.priority = 'urgent' and notification.read_at is null)
    )
    from public.employee_notifications notification
    where notification.recipient_employee_id = actor_id
      and notification.dismissed_at is null
      and (notification.expires_at is null or notification.expires_at > clock_timestamp())
  );
end
$$;

create or replace function public.get_my_notifications(
  target_filter text default 'all',
  target_category text default 'all',
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_filter text := case when target_filter in ('all', 'unread', 'action') then target_filter else 'all' end;
  clean_category text := coalesce(nullif(btrim(target_category), ''), 'all');
  clean_page integer := greatest(coalesce(target_page, 1), 1);
  clean_size integer := case when coalesce(target_page_size, 10) in (5, 10, 20) then coalesce(target_page_size, 10) else 10 end;
  total_rows bigint;
  can_send boolean;
  can_manage_delivery boolean;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  can_send := public.current_app_role() = 'admin' or public.has_effective_permission('notifications.manage');
  can_manage_delivery := public.has_effective_permission('notifications.manage') and public.has_mfa();

  select count(*) into total_rows
  from public.employee_notifications notification
  where notification.recipient_employee_id = actor_id
    and notification.dismissed_at is null
    and (notification.expires_at is null or notification.expires_at > clock_timestamp())
    and (
      clean_filter = 'all'
      or (clean_filter = 'unread' and notification.read_at is null)
      or (clean_filter = 'action' and (
        (notification.action_required and notification.resolved_at is null)
        or (notification.requires_acknowledgement and notification.acknowledged_at is null)
      ))
    )
    and (clean_category = 'all' or notification.source_type = clean_category);

  return jsonb_build_object(
    'summary', public.get_my_notification_badge(),
    'permissions', jsonb_build_object('canSend', can_send, 'canManageDelivery', can_manage_delivery),
    'page', jsonb_build_object('number', clean_page, 'size', clean_size, 'total', total_rows, 'totalPages', greatest(1, ceil(total_rows::numeric / clean_size)::integer)),
    'notifications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', notification.id,
        'title', notification.title,
        'body', notification.body,
        'priority', notification.priority,
        'sourceType', notification.source_type,
        'sourceId', notification.source_id,
        'requiresAcknowledgement', notification.requires_acknowledgement,
        'actionRequired', notification.action_required,
        'resolvedAt', notification.resolved_at,
        'readAt', notification.read_at,
        'acknowledgedAt', notification.acknowledged_at,
        'createdAt', notification.created_at,
        'expiresAt', notification.expires_at,
        'actionPath', notification.action_path,
        'actionLabel', notification.action_label,
        'senderName', case when sender.id is null then 'SygShift System' else concat(coalesce(nullif(sender.preferred_name, ''), sender.first_name), ' ', sender.last_name) end
      ) order by notification.created_at desc)
      from (
        select item.*
        from public.employee_notifications item
        where item.recipient_employee_id = actor_id
          and item.dismissed_at is null
          and (item.expires_at is null or item.expires_at > clock_timestamp())
          and (
            clean_filter = 'all'
            or (clean_filter = 'unread' and item.read_at is null)
            or (clean_filter = 'action' and (
              (item.action_required and item.resolved_at is null)
              or (item.requires_acknowledgement and item.acknowledged_at is null)
            ))
          )
          and (clean_category = 'all' or item.source_type = clean_category)
        order by item.created_at desc
        limit clean_size offset (clean_page - 1) * clean_size
      ) notification
      left join public.employees sender on sender.id = notification.sender_employee_id
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.dismiss_my_notification(target_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); affected integer;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  update public.employee_notifications notification
  set read_at = coalesce(notification.read_at, clock_timestamp()), dismissed_at = clock_timestamp()
  where notification.id = target_notification_id and notification.recipient_employee_id = actor_id
    and (not notification.requires_acknowledgement or notification.acknowledged_at is not null)
    and (not notification.action_required or notification.resolved_at is not null);
  get diagnostics affected = row_count;
  if affected = 0 then raise check_violation using message = 'Complete or acknowledge this required item before dismissing it.'; end if;
end
$$;

create or replace function public.clear_my_notifications()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clear_time timestamptz := clock_timestamp();
  prior_signal_setting text := current_setting('sygshift.suppress_notification_signal', true);
  marked_read_count integer := 0;
  dismissed_count integer := 0;
  remaining_required_count integer := 0;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(concat('notification-clear:', actor_id), 0));
  perform set_config('sygshift.suppress_notification_signal', 'yes', true);

  with candidates as materialized (
    select
      notification.id,
      notification.read_at is null as was_unread,
      (
        (not notification.requires_acknowledgement or notification.acknowledged_at is not null)
        and (not notification.action_required or notification.resolved_at is not null)
      ) as can_dismiss
    from public.employee_notifications notification
    where notification.recipient_employee_id = actor_id
      and notification.dismissed_at is null
      and (notification.expires_at is null or notification.expires_at > clear_time)
      and (
        notification.read_at is null
        or (
          (not notification.requires_acknowledgement or notification.acknowledged_at is not null)
          and (not notification.action_required or notification.resolved_at is not null)
        )
      )
    for update
  ), changed as (
    update public.employee_notifications notification
    set
      read_at = coalesce(notification.read_at, clear_time),
      dismissed_at = case when candidate.can_dismiss then coalesce(notification.dismissed_at, clear_time) else notification.dismissed_at end
    from candidates candidate
    where notification.id = candidate.id
    returning candidate.was_unread, candidate.can_dismiss
  )
  select
    (count(*) filter (where changed.was_unread))::integer,
    (count(*) filter (where changed.can_dismiss))::integer
  into marked_read_count, dismissed_count
  from changed;

  update public.support_ticket_notifications ticket_notification
  set read_at = coalesce(ticket_notification.read_at, clear_time)
  where ticket_notification.recipient_employee_id = actor_id
    and ticket_notification.read_at is null
    and exists (
      select 1
      from public.employee_notifications notification
      where notification.recipient_employee_id = actor_id
        and notification.source_type = 'support_ticket'
        and notification.source_id = ticket_notification.ticket_id
        and notification.read_at is not null
    );

  select count(*)::integer
  into remaining_required_count
  from public.employee_notifications notification
  where notification.recipient_employee_id = actor_id
    and notification.dismissed_at is null
    and (
      (notification.action_required and notification.resolved_at is null)
      or (notification.requires_acknowledgement and notification.acknowledged_at is null)
    )
    and (notification.expires_at is null or notification.expires_at > clear_time);

  perform set_config('sygshift.suppress_notification_signal', coalesce(prior_signal_setting, ''), true);

  if marked_read_count > 0 or dismissed_count > 0 then
    insert into private.audit_events(
      auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
    ) values (
      (select auth.uid()), actor_id, 'public', 'employee_notifications', 'CLEAR_ALL', actor_id::text,
      jsonb_build_object('markedRead', marked_read_count, 'dismissed', dismissed_count, 'remainingRequired', remaining_required_count)
    );
    perform private.signal_employee_update(
      actor_id,
      jsonb_build_object('kind', 'notification', 'operation', 'clear_all')
    );
  end if;

  return jsonb_build_object(
    'markedRead', marked_read_count,
    'dismissed', dismissed_count,
    'remainingRequired', remaining_required_count
  );
end
$$;

revoke all on function private.employee_can_receive_notification(uuid) from public, anon, authenticated;
revoke all on function private.create_workflow_notification(uuid,text,uuid,text,text,text,text,text,uuid) from public, anon, authenticated;
revoke all on function private.resolve_workflow_notifications(text,uuid,uuid) from public, anon, authenticated;
revoke all on function private.notify_workflow_status(uuid,text,uuid,text,text,text,text,text,uuid) from public, anon, authenticated;
revoke all on function private.notify_authorized_workflow_reviewers(text,uuid,uuid,text[],uuid,text,text,text,text,text,boolean,uuid) from public, anon, authenticated;
revoke all on function private.sync_compensation_workflow_queue() from public, anon, authenticated;
revoke all on function private.route_request_workflow_notification() from public, anon, authenticated;
revoke all on function private.classify_signature_workflow_notification() from public, anon, authenticated;
revoke all on function private.resolve_signature_workflow_notification() from public, anon, authenticated;

revoke all on function public.get_my_notification_badge() from public, anon;
grant execute on function public.get_my_notification_badge() to authenticated;
revoke all on function public.get_my_notifications(text,text,integer,integer) from public, anon;
grant execute on function public.get_my_notifications(text,text,integer,integer) to authenticated;
revoke all on function public.dismiss_my_notification(uuid) from public, anon;
grant execute on function public.dismiss_my_notification(uuid) to authenticated;
revoke all on function public.clear_my_notifications() from public, anon;
grant execute on function public.clear_my_notifications() to authenticated;

commit;
