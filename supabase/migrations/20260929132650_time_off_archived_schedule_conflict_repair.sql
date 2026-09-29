-- Archived schedule revisions are retained history, not current operational
-- conflicts. Keep time-off approval serialized and audited while limiting the
-- final decision recheck to assignments on draft or published schedules.
create or replace function public.decide_time_off_request_v2(
  target_request_id uuid,
  target_decision public.request_status,
  target_note text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  subject_employee_id uuid;
  request_record public.time_off_requests%rowtype;
  request_time_zone text;
  request_span tstzrange;
  decision_time timestamptz;
begin
  if reviewer_id is null or not public.has_effective_permission('requests.manage') then
    raise insufficient_privilege using message = 'Time-off review permission is required.';
  end if;
  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to review time-off requests.';
  end if;
  if target_decision not in ('approved', 'declined') then
    raise check_violation using message = 'Time off can only be approved or declined.';
  end if;
  if btrim(coalesce(target_note, '')) = '' then
    raise check_violation using message = 'A decision note is required.';
  end if;
  if char_length(target_note) > 2000 then
    raise check_violation using message = 'The decision note exceeds 2,000 characters.';
  end if;

  select request.employee_id into subject_employee_id
  from public.time_off_requests request
  where request.id = target_request_id
    and request.status = 'pending';
  if not found then
    raise check_violation using message = 'The time-off request is no longer pending.';
  end if;

  perform private.lock_employee_schedule_time_off(subject_employee_id);

  select * into request_record
  from public.time_off_requests request
  where request.id = target_request_id
    and request.status = 'pending'
  for update;
  if not found then
    raise check_violation using message = 'The time-off request is no longer pending.';
  end if;

  if reviewer_id = request_record.employee_id then
    raise insufficient_privilege using
      message = 'Another authorized reviewer must decide your time-off request.';
  end if;

  select coalesce(
    nullif(request_record.submission_snapshot ->> 'timeZone', ''),
    employee.time_zone
  )
  into request_time_zone
  from public.employees employee
  where employee.id = request_record.employee_id;

  request_span := private.time_off_window(
    request_record.starts_on,
    request_record.ends_on,
    request_record.partial_day_start,
    request_record.partial_day_end,
    request_time_zone
  );

  if target_decision = 'approved' and exists (
    select 1
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule
      on schedule.id = shift.schedule_id
     and schedule.status in ('draft', 'published')
    where assignment.employee_id = request_record.employee_id
      and assignment.status in ('assigned', 'confirmed')
      and shift.canceled_at is null
      and tstzrange(shift.starts_at, shift.ends_at, '[)') && request_span
  ) then
    raise check_violation using message = 'Resolve assigned shifts before approving this time off.';
  end if;

  decision_time := clock_timestamp();

  update public.time_off_requests
  set status = target_decision,
      decided_by = reviewer_id,
      decided_at = decision_time,
      decision_note = btrim(target_note),
      decision_snapshot = jsonb_build_object(
        'action', target_decision,
        'reviewerId', reviewer_id,
        'decidedAt', decision_time,
        'note', btrim(target_note),
        'timeZone', request_time_zone,
        'requestWindowStartsAt', lower(request_span),
        'requestWindowEndsAt', upper(request_span)
      )
  where id = target_request_id;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    (select auth.uid()), reviewer_id, 'public', 'time_off_requests',
    case target_decision when 'approved' then 'APPROVE' else 'DECLINE' end,
    target_request_id::text,
    jsonb_build_object('status', request_record.status),
    jsonb_build_object(
      'status', target_decision,
      'note', btrim(target_note),
      'subjectEmployeeId', request_record.employee_id,
      'timeZone', request_time_zone,
      'requestWindowStartsAt', lower(request_span),
      'requestWindowEndsAt', upper(request_span)
    )
  );

  insert into private.notification_outbox (
    message_type,
    aggregate_type,
    aggregate_id,
    recipient_employee_id,
    payload,
    idempotency_key
  ) values (
    'time_off_decision',
    'time_off_request',
    target_request_id,
    request_record.employee_id,
    jsonb_build_object(
      'decision', target_decision,
      'startsOn', request_record.starts_on,
      'endsOn', request_record.ends_on,
      'requestType', request_record.request_type,
      'timeZone', request_time_zone
    ),
    concat('time_off_decision:', target_request_id::text, ':', target_decision::text)
  )
  on conflict (idempotency_key) do nothing;

  return true;
end
$$;

comment on function public.decide_time_off_request_v2(uuid, public.request_status, text) is
  'Approves or declines time off with independent MFA review, employee locking, audit/notification evidence, and conflicts limited to current draft or published schedules.';

revoke all on function public.decide_time_off_request_v2(uuid, public.request_status, text)
  from public, anon;
grant execute on function public.decide_time_off_request_v2(uuid, public.request_status, text)
  to authenticated;
