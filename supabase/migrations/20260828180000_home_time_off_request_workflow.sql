begin;

alter table public.time_off_requests
  add column if not exists request_type text,
  add column if not exists employment_type_snapshot text,
  add column if not exists pay_treatment text,
  add column if not exists requested_minutes integer,
  add column if not exists return_on date,
  add column if not exists submission_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists affected_shifts_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists decision_snapshot jsonb;

alter table public.time_off_requests
  drop constraint if exists time_off_request_type_check,
  add constraint time_off_request_type_check check (
    request_type is null or request_type in ('paid_vacation', 'sick_time', 'unpaid_time_off')
  ),
  drop constraint if exists time_off_employment_snapshot_check,
  add constraint time_off_employment_snapshot_check check (
    employment_type_snapshot is null or employment_type_snapshot in ('hourly', 'salary', 'flex')
  ),
  drop constraint if exists time_off_pay_treatment_check,
  add constraint time_off_pay_treatment_check check (
    pay_treatment is null or pay_treatment in ('salary_paid_leave', 'sick_policy', 'unpaid')
  ),
  drop constraint if exists time_off_requested_minutes_check,
  add constraint time_off_requested_minutes_check check (requested_minutes is null or requested_minutes >= 0),
  drop constraint if exists time_off_return_date_check,
  add constraint time_off_return_date_check check (return_on is null or return_on >= ends_on);

create index if not exists time_off_pending_review_idx
  on public.time_off_requests(status, created_at desc)
  where status = 'pending';

create or replace function private.time_off_affected_shifts(
  target_employee_id uuid,
  target_starts_on date,
  target_ends_on date
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'shiftId', shift.id,
    'assignmentId', assignment.id,
    'workday', (shift.starts_at at time zone shift.time_zone)::date,
    'startsAt', shift.starts_at,
    'endsAt', shift.ends_at,
    'timeZone', shift.time_zone,
    'siteCode', site.code,
    'siteName', coalesce(site.name, event_site.name),
    'postName', post.name,
    'eventName', event.name,
    'location', coalesce(site.name, event_site.name, event.location_name, 'Location pending'),
    'estimatedMinutes', greatest(0, floor(extract(epoch from (shift.ends_at - shift.starts_at)) / 60)::integer)
  ) order by shift.starts_at), '[]'::jsonb)
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  where assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and schedule.status = 'published'
    and (shift.starts_at at time zone shift.time_zone)::date between target_starts_on and target_ends_on
$$;

create or replace function public.get_time_off_request_context(
  request_starts_on date default null,
  request_ends_on date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := public.current_employee_id();
  employee_record public.employees%rowtype;
  affected jsonb := '[]'::jsonb;
begin
  if viewer_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into employee_record
  from public.employees employee
  where employee.id = viewer_id and employee.status = 'active';

  if not found then
    raise insufficient_privilege using message = 'Only active employees can request time off.';
  end if;
  if employee_record.employment_type::text not in ('hourly', 'salary', 'flex') then
    raise check_violation using message = 'This employment classification cannot request time off yet. Contact an administrator.';
  end if;

  if request_starts_on is not null and request_ends_on is not null and request_ends_on >= request_starts_on then
    affected := private.time_off_affected_shifts(viewer_id, request_starts_on, request_ends_on);
  end if;

  return jsonb_build_object(
    'employee', jsonb_build_object(
      'id', employee_record.id,
      'employeeNumber', employee_record.employee_number,
      'name', employee_record.first_name || ' ' || employee_record.last_name,
      'employmentType', employee_record.employment_type,
      'status', employee_record.status
    ),
    'allowedTypes', case employee_record.employment_type::text
      when 'salary' then jsonb_build_array('paid_vacation', 'sick_time', 'unpaid_time_off')
      else jsonb_build_array('sick_time', 'unpaid_time_off')
    end,
    'affectedShifts', affected,
    'recentRequests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', request.id,
        'requestType', request.request_type,
        'startsOn', request.starts_on,
        'endsOn', request.ends_on,
        'status', request.status,
        'createdAt', request.created_at
      ) order by request.created_at desc), '[]'::jsonb)
      from (
        select item.*
        from public.time_off_requests item
        where item.employee_id = viewer_id
        order by item.created_at desc
        limit 8
      ) request
    )
  );
end
$$;

create or replace function public.submit_time_off_request_v2(
  request_kind text,
  request_starts_on date,
  request_ends_on date,
  request_partial_start time default null,
  request_partial_end time default null,
  request_return_on date default null,
  request_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  requesting_employee_id uuid := public.current_employee_id();
  employee_record public.employees%rowtype;
  request_id uuid;
  operational_today date := (clock_timestamp() at time zone 'America/Denver')::date;
  affected jsonb;
  estimated_minutes integer;
  treatment text;
begin
  if requesting_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into employee_record
  from public.employees employee
  where employee.id = requesting_employee_id and employee.status = 'active'
  for update;

  if not found then
    raise insufficient_privilege using message = 'Only active employees can request time off.';
  end if;

  if request_kind not in ('paid_vacation', 'sick_time', 'unpaid_time_off') then
    raise check_violation using message = 'Choose an available time-off type.';
  end if;
  if request_kind = 'paid_vacation' and employee_record.employment_type::text <> 'salary' then
    raise insufficient_privilege using message = 'Paid Vacation is available only to salary employees. Contact an administrator if the employment classification is incorrect.';
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
  if request_return_on is not null and request_return_on < request_ends_on then
    raise check_violation using message = 'The return date cannot be before the final requested date.';
  end if;
  if num_nonnulls(request_partial_start, request_partial_end) = 1
    or (request_partial_start is not null and (
      request_starts_on <> request_ends_on or request_partial_end <= request_partial_start
    ))
  then
    raise check_violation using message = 'Partial-day times require one date and a valid start and end time.';
  end if;
  if char_length(coalesce(request_reason, '')) > 2000 then
    raise check_violation using message = 'The request note exceeds 2,000 characters.';
  end if;
  if exists (
    select 1 from public.time_off_requests existing
    where existing.employee_id = requesting_employee_id
      and existing.status in ('pending', 'approved')
      and daterange(existing.starts_on, existing.ends_on, '[]')
        && daterange(request_starts_on, request_ends_on, '[]')
  ) then
    raise unique_violation using message = 'An active time-off request already overlaps these dates.';
  end if;
  if request_kind = 'sick_time'
    and request_starts_on <= operational_today and request_ends_on >= operational_today
    and exists (
      select 1
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      join public.schedules schedule on schedule.id = shift.schedule_id
      where assignment.employee_id = requesting_employee_id
        and assignment.status in ('assigned', 'confirmed')
        and schedule.status = 'published'
        and (shift.starts_at at time zone shift.time_zone)::date between operational_today and operational_today + 1
        and shift.starts_at <= clock_timestamp() + interval '4 hours'
        and shift.ends_at > clock_timestamp()
    )
  then
    raise check_violation using message = 'For a current or imminent shift, use Report Sick / Call-Off so Dispatch is notified immediately.';
  end if;

  affected := private.time_off_affected_shifts(requesting_employee_id, request_starts_on, request_ends_on);
  if request_partial_start is not null then
    estimated_minutes := greatest(0, floor(extract(epoch from (request_partial_end - request_partial_start)) / 60)::integer);
  else
    select sum((item ->> 'estimatedMinutes')::integer)::integer
      into estimated_minutes
    from jsonb_array_elements(affected) item;
  end if;

  treatment := case request_kind
    when 'paid_vacation' then 'salary_paid_leave'
    when 'sick_time' then 'sick_policy'
    else 'unpaid'
  end;

  insert into public.time_off_requests (
    employee_id, starts_on, ends_on, partial_day_start, partial_day_end, return_on,
    reason, request_type, employment_type_snapshot, pay_treatment, requested_minutes,
    submission_snapshot, affected_shifts_snapshot
  ) values (
    requesting_employee_id, request_starts_on, request_ends_on, request_partial_start,
    request_partial_end, request_return_on, nullif(btrim(request_reason), ''), request_kind,
    employee_record.employment_type::text, treatment, estimated_minutes,
    jsonb_build_object(
      'employeeId', employee_record.id,
      'employeeNumber', employee_record.employee_number,
      'employeeName', employee_record.first_name || ' ' || employee_record.last_name,
      'employmentType', employee_record.employment_type,
      'requestType', request_kind,
      'payTreatment', treatment,
      'startsOn', request_starts_on,
      'endsOn', request_ends_on,
      'partialStart', request_partial_start,
      'partialEnd', request_partial_end,
      'returnOn', request_return_on,
      'requestedMinutes', estimated_minutes,
      'submittedAt', clock_timestamp()
    ),
    affected
  ) returning id into request_id;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    (select auth.uid()), requesting_employee_id, 'public', 'time_off_requests',
    'EMPLOYEE_SUBMIT', request_id::text,
    jsonb_build_object('requestType', request_kind, 'startsOn', request_starts_on, 'endsOn', request_ends_on)
  );

  return request_id;
end
$$;

create or replace function public.get_time_off_review_context(target_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  request_record public.time_off_requests%rowtype;
  employee_record public.employees%rowtype;
begin
  if not public.has_effective_permission('requests.manage') then
    raise insufficient_privilege using message = 'Time-off review permission is required.';
  end if;
  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to review time-off requests.';
  end if;

  select * into request_record from public.time_off_requests request where request.id = target_request_id;
  if not found then raise no_data_found using message = 'The time-off request could not be found.'; end if;
  select * into employee_record from public.employees employee where employee.id = request_record.employee_id;

  return jsonb_build_object(
    'id', request_record.id,
    'employee', jsonb_build_object(
      'id', employee_record.id,
      'employeeNumber', employee_record.employee_number,
      'name', employee_record.first_name || ' ' || employee_record.last_name
    ),
    'requestType', request_record.request_type,
    'employmentType', request_record.employment_type_snapshot,
    'payTreatment', request_record.pay_treatment,
    'startsOn', request_record.starts_on,
    'endsOn', request_record.ends_on,
    'partialStart', request_record.partial_day_start,
    'partialEnd', request_record.partial_day_end,
    'returnOn', request_record.return_on,
    'requestedMinutes', request_record.requested_minutes,
    'reason', request_record.reason,
    'status', request_record.status,
    'createdAt', request_record.created_at,
    'affectedShifts', request_record.affected_shifts_snapshot,
    'decisionNote', request_record.decision_note,
    'decisionSnapshot', request_record.decision_snapshot
  );
end
$$;

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
  request_record public.time_off_requests%rowtype;
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

  select * into request_record
  from public.time_off_requests request
  where request.id = target_request_id and request.status = 'pending'
  for update;
  if not found then
    raise check_violation using message = 'The time-off request is no longer pending.';
  end if;

  update public.time_off_requests
  set status = target_decision,
      decided_by = reviewer_id,
      decided_at = clock_timestamp(),
      decision_note = btrim(target_note),
      decision_snapshot = jsonb_build_object(
        'action', target_decision,
        'reviewerId', reviewer_id,
        'decidedAt', clock_timestamp(),
        'note', btrim(target_note)
      )
  where id = target_request_id;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    (select auth.uid()), reviewer_id, 'public', 'time_off_requests',
    case target_decision when 'approved' then 'APPROVE' else 'DECLINE' end,
    target_request_id::text,
    jsonb_build_object('status', request_record.status),
    jsonb_build_object('status', target_decision, 'note', btrim(target_note), 'subjectEmployeeId', request_record.employee_id)
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
      'requestType', request_record.request_type
    ),
    concat('time_off_decision:', target_request_id::text, ':', target_decision::text)
  )
  on conflict (idempotency_key) do nothing;

  return true;
end
$$;

create or replace function public.decide_time_off_request(
  target_request_id uuid,
  target_decision public.request_status,
  target_note text default null
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select public.decide_time_off_request_v2(target_request_id, target_decision, target_note)
$$;

create or replace function public.service_claim_time_off_notification_batch(target_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_limit integer := least(greatest(coalesce(target_limit, 10), 1), 25);
  claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Only the service role can claim time-off notification deliveries.';
  end if;

  with pending as (
    select outbox.*
    from private.notification_outbox outbox
    where outbox.message_type = 'time_off_decision'
      and outbox.delivered_at is null
      and outbox.failed_at is null
      and outbox.available_at <= clock_timestamp()
      and outbox.attempt_count < 5
    order by outbox.available_at, outbox.created_at
    limit clean_limit
    for update skip locked
  ), touched as (
    update private.notification_outbox outbox
    set attempted_at = clock_timestamp(),
        attempt_count = outbox.attempt_count + 1,
        last_error = null
    from pending
    where outbox.id = pending.id
    returning outbox.*
  ), expanded as (
    select
      outbox.id,
      outbox.message_type,
      outbox.aggregate_type,
      outbox.aggregate_id,
      outbox.attempt_count,
      jsonb_build_object(
        'subject', concat(
          'Time-off request ',
          case request.status when 'approved' then 'approved' else 'declined' end
        ),
        'text', concat(
          'Your ',
          case request.request_type
            when 'paid_vacation' then 'Paid Vacation'
            when 'sick_time' then 'Sick Time'
            else 'Unpaid Time Off'
          end,
          ' request for ', to_char(request.starts_on, 'MM/DD/YYYY'),
          case when request.ends_on <> request.starts_on
            then concat(' through ', to_char(request.ends_on, 'MM/DD/YYYY')) else '' end,
          ' was ', request.status, '. Open SygShift to review the decision.'
        ),
        'html', concat(
          '<p>Your <strong>',
          case request.request_type
            when 'paid_vacation' then 'Paid Vacation'
            when 'sick_time' then 'Sick Time'
            else 'Unpaid Time Off'
          end,
          '</strong> request for <strong>', to_char(request.starts_on, 'MM/DD/YYYY'),
          case when request.ends_on <> request.starts_on
            then concat(' through ', to_char(request.ends_on, 'MM/DD/YYYY')) else '' end,
          '</strong> was <strong>', request.status, '</strong>.</p>',
          '<p>Open SygShift to review the decision.</p>'
        )
      ) as message,
      case when private.preferred_delivery_email(contact.personal_email, contact.company_email) is null
        then '[]'::jsonb
        else jsonb_build_array(private.preferred_delivery_email(contact.personal_email, contact.company_email))
      end as recipients
    from touched outbox
    join public.time_off_requests request on request.id = outbox.aggregate_id
    left join private.employee_contacts contact on contact.employee_id = outbox.recipient_employee_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'messageType', message_type,
    'aggregateType', aggregate_type,
    'aggregateId', aggregate_id,
    'attemptCount', attempt_count,
    'recipients', recipients,
    'message', message
  ) order by id), '[]'::jsonb)
  into claimed
  from expanded;

  return claimed;
end
$$;

create or replace function private.protect_time_off_submission_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(
    new.employee_id, new.starts_on, new.ends_on, new.partial_day_start, new.partial_day_end,
    new.return_on, new.request_type, new.employment_type_snapshot, new.pay_treatment,
    new.requested_minutes, new.submission_snapshot, new.affected_shifts_snapshot, new.created_at
  ) is distinct from row(
    old.employee_id, old.starts_on, old.ends_on, old.partial_day_start, old.partial_day_end,
    old.return_on, old.request_type, old.employment_type_snapshot, old.pay_treatment,
    old.requested_minutes, old.submission_snapshot, old.affected_shifts_snapshot, old.created_at
  ) then
    raise check_violation using message = 'Submitted time-off details are immutable. Withdraw the pending request and create a new one.';
  end if;
  return new;
end
$$;

drop trigger if exists time_off_submission_snapshot_immutable on public.time_off_requests;
create trigger time_off_submission_snapshot_immutable
before update on public.time_off_requests
for each row execute function private.protect_time_off_submission_snapshot();

revoke all on function private.time_off_affected_shifts(uuid, date, date) from public, anon, authenticated;
revoke all on function private.protect_time_off_submission_snapshot() from public, anon, authenticated;
revoke all on function public.get_time_off_request_context(date, date) from public, anon;
revoke all on function public.submit_time_off_request_v2(text, date, date, time, time, date, text) from public, anon;
revoke all on function public.get_time_off_review_context(uuid) from public, anon;
revoke all on function public.decide_time_off_request_v2(uuid, public.request_status, text) from public, anon;
revoke all on function public.decide_time_off_request(uuid, public.request_status, text) from public, anon;
revoke all on function public.service_claim_time_off_notification_batch(integer) from public, anon, authenticated;

grant execute on function public.get_time_off_request_context(date, date) to authenticated;
grant execute on function public.submit_time_off_request_v2(text, date, date, time, time, date, text) to authenticated;
grant execute on function public.get_time_off_review_context(uuid) to authenticated;
grant execute on function public.decide_time_off_request_v2(uuid, public.request_status, text) to authenticated;
grant execute on function public.decide_time_off_request(uuid, public.request_status, text) to authenticated;
grant execute on function public.service_claim_time_off_notification_batch(integer) to service_role;

commit;
