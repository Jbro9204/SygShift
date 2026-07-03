begin;

alter table public.time_off_requests
  add constraint time_off_reason_length
  check (reason is null or char_length(reason) <= 2000);

alter table public.call_off_reports
  add constraint call_off_reason_present
  check (btrim(coalesce(reason, '')) <> ''),
  add constraint call_off_reason_length
  check (char_length(reason) <= 2000);

create or replace function private.protect_published_schedule_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_schedule_id uuid;
  parent_status public.schedule_status;
begin
  if tg_table_name = 'shifts' then
    parent_schedule_id := case when tg_op = 'DELETE' then old.schedule_id else new.schedule_id end;
  else
    select shift.schedule_id into parent_schedule_id
    from public.shifts shift
    where shift.id = case when tg_op = 'DELETE' then old.shift_id else new.shift_id end;
  end if;

  select schedule.status into parent_status
  from public.schedules schedule
  where schedule.id = parent_schedule_id;

  if parent_status = 'published' then
    if tg_table_name = 'shifts'
      and tg_op = 'UPDATE'
      and (to_jsonb(new) - array['is_open', 'updated_at'])
        = (to_jsonb(old) - array['is_open', 'updated_at'])
    then
      return new;
    end if;
    raise exception 'Published schedule records are immutable; create a new revision.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create or replace function private.enforce_assignment_capacity_and_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  active_assignment_count integer;
  target_start_date date;
  target_end_date date;
begin
  if new.status = 'canceled' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.shift_id::text));

  select * into target_shift
  from public.shifts shift
  where shift.id = new.shift_id;

  target_start_date := (target_shift.starts_at at time zone target_shift.time_zone)::date;
  target_end_date := (target_shift.ends_at at time zone target_shift.time_zone)::date;

  if exists (
    select 1
    from public.time_off_requests request
    where request.employee_id = new.employee_id
      and request.status = 'approved'
      and daterange(request.starts_on, request.ends_on, '[]')
        && daterange(target_start_date, target_end_date, '[]')
  ) then
    raise exception 'The employee has approved time off during this shift.';
  end if;

  select count(*) into active_assignment_count
  from public.shift_assignments assignment
  where assignment.shift_id = new.shift_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and assignment.id <> new.id;

  if active_assignment_count >= target_shift.headcount_required then
    raise exception 'The shift already has its required number of assigned employees.';
  end if;

  if exists (
    select 1
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    where assignment.employee_id = new.employee_id
      and assignment.id <> new.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
      and tstzrange(shift.starts_at, shift.ends_at, '[)')
        && tstzrange(target_shift.starts_at, target_shift.ends_at, '[)')
  ) then
    raise exception 'The employee is already assigned to an overlapping shift.';
  end if;

  return new;
end
$$;

create function public.submit_time_off_request(
  request_starts_on date,
  request_ends_on date,
  request_partial_start time default null,
  request_partial_end time default null,
  request_reason text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  requesting_employee_id uuid := public.current_employee_id();
  request_id uuid;
  operational_today date := (clock_timestamp() at time zone 'America/Denver')::date;
begin
  if requesting_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if request_starts_on is null or request_ends_on is null or request_ends_on < request_starts_on then
    raise check_violation using message = 'Enter a valid time-off date range.';
  end if;
  if request_starts_on < operational_today then
    raise check_violation using message = 'Time off cannot begin in the past.';
  end if;
  if request_ends_on - request_starts_on > 366 then
    raise check_violation using message = 'A time-off request cannot exceed 367 calendar days.';
  end if;
  if num_nonnulls(request_partial_start, request_partial_end) = 1
    or (
      request_partial_start is not null
      and (
        request_starts_on <> request_ends_on
        or request_partial_end <= request_partial_start
      )
    )
  then
    raise check_violation using message = 'Partial-day times require one date and a valid time range.';
  end if;
  if char_length(coalesce(request_reason, '')) > 2000 then
    raise check_violation using message = 'The request reason exceeds 2,000 characters.';
  end if;
  if exists (
    select 1
    from public.time_off_requests existing
    where existing.employee_id = requesting_employee_id
      and existing.status in ('pending', 'approved')
      and daterange(existing.starts_on, existing.ends_on, '[]')
        && daterange(request_starts_on, request_ends_on, '[]')
  ) then
    raise unique_violation using message = 'An active time-off request already overlaps these dates.';
  end if;

  insert into public.time_off_requests (
    employee_id,
    starts_on,
    ends_on,
    partial_day_start,
    partial_day_end,
    reason
  ) values (
    requesting_employee_id,
    request_starts_on,
    request_ends_on,
    request_partial_start,
    request_partial_end,
    nullif(btrim(request_reason), '')
  )
  returning id into request_id;

  return request_id;
end
$$;

create function public.withdraw_time_off_request(target_request_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.time_off_requests
  set status = 'withdrawn'
  where id = target_request_id
    and employee_id = public.current_employee_id()
    and status = 'pending';

  if not found then
    raise check_violation using message = 'Only a pending request owned by this account can be withdrawn.';
  end if;
  return true;
end
$$;

create function public.report_call_off(target_shift_id uuid, call_off_reason text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reporting_employee_id uuid := public.current_employee_id();
  report_id uuid;
begin
  if reporting_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if btrim(coalesce(call_off_reason, '')) = '' then
    raise check_violation using message = 'A call-off reason is required.';
  end if;
  if char_length(call_off_reason) > 2000 then
    raise check_violation using message = 'The call-off reason exceeds 2,000 characters.';
  end if;
  if not exists (
    select 1
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    where assignment.shift_id = target_shift_id
      and assignment.employee_id = reporting_employee_id
      and assignment.status in ('assigned', 'confirmed')
      and shift.ends_at > clock_timestamp()
  ) then
    raise check_violation using message = 'Only a current or upcoming assigned shift can be called off.';
  end if;

  insert into public.call_off_reports (shift_id, employee_id, reason)
  values (target_shift_id, reporting_employee_id, btrim(call_off_reason))
  returning id into report_id;

  return report_id;
end
$$;

create function private.enqueue_call_off_supervisor_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.notification_outbox (
    message_type,
    aggregate_type,
    aggregate_id,
    payload,
    idempotency_key
  ) values (
    'call_off_supervisor_alert',
    'call_off_report',
    new.id,
    jsonb_build_object(
      'callOffId', new.id,
      'shiftId', new.shift_id,
      'employeeId', new.employee_id,
      'reportedAt', new.reported_at
    ),
    'call-off:' || new.id::text || ':supervisor-alert'
  );
  return new;
end
$$;

create trigger call_off_reports_enqueue_supervisor_alert
after insert on public.call_off_reports
for each row execute function private.enqueue_call_off_supervisor_alert();

create function public.decide_time_off_request(
  target_request_id uuid,
  target_decision public.request_status,
  target_note text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  request_record public.time_off_requests%rowtype;
begin
  if target_decision not in ('approved', 'declined') then
    raise check_violation using message = 'Time off can only be approved or declined.';
  end if;
  if target_decision = 'declined' and btrim(coalesce(target_note, '')) = '' then
    raise check_violation using message = 'A decline note is required.';
  end if;
  if char_length(coalesce(target_note, '')) > 2000 then
    raise check_violation using message = 'The decision note exceeds 2,000 characters.';
  end if;

  select * into request_record
  from public.time_off_requests request
  where request.id = target_request_id and request.status = 'pending'
  for update;

  if not found then
    raise check_violation using message = 'The time-off request is no longer pending.';
  end if;

  if target_decision = 'approved' and exists (
    select 1
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    where assignment.employee_id = request_record.employee_id
      and assignment.status in ('assigned', 'confirmed')
      and daterange(
        (shift.starts_at at time zone shift.time_zone)::date,
        (shift.ends_at at time zone shift.time_zone)::date,
        '[]'
      ) && daterange(request_record.starts_on, request_record.ends_on, '[]')
  ) then
    raise check_violation using message = 'Resolve assigned shifts before approving this time off.';
  end if;

  update public.time_off_requests
  set
    status = target_decision,
    decided_by = reviewer_id,
    decided_at = clock_timestamp(),
    decision_note = nullif(btrim(target_note), '')
  where id = target_request_id;

  return true;
end
$$;

create function public.decide_shift_request(
  target_request_id uuid,
  target_decision public.request_status,
  target_note text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  request_record public.shift_requests%rowtype;
  required_headcount integer;
  assigned_headcount integer;
begin
  if target_decision not in ('approved', 'declined') then
    raise check_violation using message = 'A shift request can only be approved or declined.';
  end if;
  if target_decision = 'declined' and btrim(coalesce(target_note, '')) = '' then
    raise check_violation using message = 'A decline note is required.';
  end if;
  if char_length(coalesce(target_note, '')) > 2000 then
    raise check_violation using message = 'The decision note exceeds 2,000 characters.';
  end if;

  select * into request_record
  from public.shift_requests request
  where request.id = target_request_id and request.status = 'pending'
  for update;

  if not found then
    raise check_violation using message = 'The shift request is no longer pending.';
  end if;

  if target_decision = 'approved' then
    insert into public.shift_assignments (shift_id, employee_id, assigned_by)
    values (request_record.shift_id, request_record.employee_id, reviewer_id);
  end if;

  update public.shift_requests
  set
    status = target_decision,
    decided_by = reviewer_id,
    decided_at = clock_timestamp(),
    decision_note = nullif(btrim(target_note), '')
  where id = target_request_id;

  if target_decision = 'approved' then
    select shift.headcount_required into required_headcount
    from public.shifts shift where shift.id = request_record.shift_id;

    select count(*) into assigned_headcount
    from public.shift_assignments assignment
    where assignment.shift_id = request_record.shift_id
      and assignment.status in ('assigned', 'confirmed', 'completed');

    if assigned_headcount >= required_headcount then
      update public.shifts set is_open = false where id = request_record.shift_id;
      update public.shift_requests
      set
        status = 'declined',
        decided_by = reviewer_id,
        decided_at = clock_timestamp(),
        decision_note = 'The opening was filled by another approved request.'
      where shift_id = request_record.shift_id
        and id <> request_record.id
        and status = 'pending';
    end if;
  end if;

  return true;
end
$$;

create function public.publish_call_off_opening(
  target_call_off_id uuid,
  announcement_title text,
  announcement_body text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  report_record public.call_off_reports%rowtype;
  shift_end timestamptz;
  created_announcement_id uuid;
begin
  if btrim(coalesce(announcement_title, '')) = '' or char_length(announcement_title) > 160 then
    raise check_violation using message = 'Enter an announcement title of 160 characters or fewer.';
  end if;
  if btrim(coalesce(announcement_body, '')) = '' or char_length(announcement_body) > 4000 then
    raise check_violation using message = 'Enter announcement text of 4,000 characters or fewer.';
  end if;

  select * into report_record
  from public.call_off_reports report
  where report.id = target_call_off_id
    and report.announcement_id is null
    and report.resolved_at is null
  for update;

  if not found then
    raise check_violation using message = 'This call-off no longer needs an announcement.';
  end if;

  select shift.ends_at into shift_end
  from public.shifts shift where shift.id = report_record.shift_id;

  if shift_end <= clock_timestamp() then
    raise check_violation using message = 'The called-off shift has already ended.';
  end if;

  update public.shift_assignments
  set
    status = 'canceled',
    canceled_at = clock_timestamp(),
    cancellation_reason = 'Employee call-off reported.'
  where shift_id = report_record.shift_id
    and employee_id = report_record.employee_id
    and status in ('assigned', 'confirmed');

  if not found then
    raise check_violation using message = 'The original assignment is no longer active.';
  end if;

  update public.shifts set is_open = true where id = report_record.shift_id;

  insert into public.announcements (
    kind,
    title,
    body,
    shift_id,
    published_at,
    expires_at,
    created_by
  ) values (
    'open_shift',
    btrim(announcement_title),
    btrim(announcement_body),
    report_record.shift_id,
    clock_timestamp(),
    shift_end,
    reviewer_id
  )
  returning id into created_announcement_id;

  update public.call_off_reports
  set
    acknowledged_by = reviewer_id,
    acknowledged_at = clock_timestamp(),
    announcement_id = created_announcement_id
  where id = target_call_off_id;

  return created_announcement_id;
end
$$;

create function private.enqueue_published_announcement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.published_at is not null
    and (tg_op = 'INSERT' or old.published_at is null)
  then
    insert into private.notification_outbox (
      message_type,
      aggregate_type,
      aggregate_id,
      payload,
      idempotency_key
    ) values (
      'announcement_published',
      'announcement',
      new.id,
      jsonb_build_object(
        'announcementId', new.id,
        'kind', new.kind,
        'shiftId', new.shift_id,
        'eventId', new.event_id
      ),
      'announcement:' || new.id::text || ':published'
    );
  end if;
  return new;
end
$$;

create trigger announcements_enqueue_published
after insert or update of published_at on public.announcements
for each row execute function private.enqueue_published_announcement();

create or replace function public.submit_shift_request(target_shift_id uuid, request_note text default null)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  employee_id uuid := public.current_employee_id();
  request_id uuid;
begin
  if employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if char_length(coalesce(request_note, '')) > 2000 then
    raise check_violation using message = 'The request note exceeds 2,000 characters.';
  end if;
  if not exists (
    select 1
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    where shift.id = target_shift_id
      and shift.is_open
      and shift.starts_at > clock_timestamp()
      and schedule.status = 'published'
      and (
        select count(*)
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.status in ('assigned', 'confirmed', 'completed')
      ) < shift.headcount_required
  ) then
    raise check_violation using message = 'The shift is not available to request.';
  end if;

  insert into public.shift_requests (shift_id, employee_id, employee_note)
  values (target_shift_id, employee_id, nullif(btrim(request_note), ''))
  returning id into request_id;
  return request_id;
end
$$;

revoke all on function public.submit_time_off_request(date, date, time, time, text) from public, anon;
revoke all on function public.withdraw_time_off_request(uuid) from public, anon;
revoke all on function public.report_call_off(uuid, text) from public, anon;
revoke all on function public.decide_time_off_request(uuid, public.request_status, text) from public, anon;
revoke all on function public.decide_shift_request(uuid, public.request_status, text) from public, anon;
revoke all on function public.publish_call_off_opening(uuid, text, text) from public, anon;

grant execute on function public.submit_time_off_request(date, date, time, time, text) to authenticated;
grant execute on function public.withdraw_time_off_request(uuid) to authenticated;
grant execute on function public.report_call_off(uuid, text) to authenticated;
grant execute on function public.decide_time_off_request(uuid, public.request_status, text) to authenticated;
grant execute on function public.decide_shift_request(uuid, public.request_status, text) to authenticated;
grant execute on function public.publish_call_off_opening(uuid, text, text) to authenticated;

commit;
