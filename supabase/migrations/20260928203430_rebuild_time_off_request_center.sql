begin;

set local lock_timeout = '5s';

-- Keep the manager history slice predictable without allowing the request-center
-- payload to grow forever. Pending work and each employee's own history remain
-- complete; only other employees' completed history is capped.
create index if not exists time_off_requests_recent_history_idx
  on public.time_off_requests(updated_at desc, created_at desc, id)
  where status <> 'pending';

-- A single employee-scoped transaction lock serializes request submission,
-- approval, and assignment changes. It closes the approve-vs-assign race
-- without retaining a session lock or depending on a table-row lock order.
create or replace function private.lock_employee_schedule_time_off(
  target_employee_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_employee_id is null then
    raise null_value_not_allowed using message = 'An employee is required for schedule and time-off locking.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('sygshift:employee-schedule-time-off:' || target_employee_id::text, 0)
  );
end
$$;

-- PostgreSQL otherwise silently normalizes nonexistent local times and chooses
-- one side of an ambiguous fall-back hour. A partial-day request cannot express
-- that intent safely, so require an unambiguous employee-local wall time.
create or replace function private.time_off_local_instant(
  target_date date,
  target_time time without time zone,
  target_time_zone text
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  local_value timestamp without time zone;
  resolved_value timestamptz;
begin
  if target_date is null or target_time is null or nullif(target_time_zone, '') is null then
    raise null_value_not_allowed using message = 'A date, time, and employee time zone are required.';
  end if;

  local_value := target_date + target_time;
  resolved_value := local_value at time zone target_time_zone;

  if resolved_value at time zone target_time_zone <> local_value
    or (resolved_value - interval '1 hour') at time zone target_time_zone = local_value
    or (resolved_value + interval '1 hour') at time zone target_time_zone = local_value
  then
    raise check_violation using
      message = 'Choose a partial-day time outside the daylight-saving clock change.',
      detail = concat('The local time ', local_value, ' is not unique in ', target_time_zone, '.');
  end if;

  return resolved_value;
exception
  when invalid_parameter_value then
    raise check_violation using message = 'The employee time zone is not supported.';
end
$$;

-- Canonical half-open request interval. Full days are midnight-to-midnight in
-- the employee profile zone; partial days are employee-local wall times. Shift
-- instants remain timestamptz and are never reinterpreted in a browser zone.
create or replace function private.time_off_window(
  target_starts_on date,
  target_ends_on date,
  target_partial_start time without time zone,
  target_partial_end time without time zone,
  target_time_zone text
)
returns tstzrange
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  starts_at timestamptz;
  ends_at timestamptz;
begin
  if target_starts_on is null or target_ends_on is null or target_ends_on < target_starts_on then
    raise check_violation using message = 'Enter a valid time-off date range.';
  end if;
  if nullif(target_time_zone, '') is null then
    raise check_violation using message = 'An employee time zone is required for time off.';
  end if;
  if num_nonnulls(target_partial_start, target_partial_end) = 1
    or (target_partial_start is not null and (
      target_starts_on <> target_ends_on or target_partial_end <= target_partial_start
    ))
  then
    raise check_violation using message = 'Partial-day times require one date and a valid start and end time.';
  end if;

  if target_partial_start is null then
    starts_at := target_starts_on::timestamp without time zone at time zone target_time_zone;
    ends_at := (target_ends_on + 1)::timestamp without time zone at time zone target_time_zone;
  else
    starts_at := private.time_off_local_instant(
      target_starts_on,
      target_partial_start,
      target_time_zone
    );
    ends_at := private.time_off_local_instant(
      target_ends_on,
      target_partial_end,
      target_time_zone
    );
  end if;

  return tstzrange(starts_at, ends_at, '[)');
exception
  when invalid_parameter_value then
    raise check_violation using message = 'The employee time zone is not supported.';
end
$$;

create or replace function private.time_off_affected_shifts(
  target_employee_id uuid,
  target_starts_on date,
  target_ends_on date,
  target_partial_start time without time zone,
  target_partial_end time without time zone,
  target_time_zone text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with boundary as (
    select private.time_off_window(
      target_starts_on,
      target_ends_on,
      target_partial_start,
      target_partial_end,
      target_time_zone
    ) as request_span
  )
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
    'estimatedMinutes', greatest(
      0,
      floor(extract(epoch from (
        least(shift.ends_at, upper(boundary.request_span))
        - greatest(shift.starts_at, lower(boundary.request_span))
      )) / 60)::integer
    )
  ) order by shift.starts_at, assignment.id), '[]'::jsonb)
  from boundary
  join public.shift_assignments assignment
    on assignment.employee_id = target_employee_id
   and assignment.status in ('assigned', 'confirmed', 'completed')
  join public.shifts shift
    on shift.id = assignment.shift_id
   and shift.canceled_at is null
   and tstzrange(shift.starts_at, shift.ends_at, '[)') && boundary.request_span
  join public.schedules schedule
    on schedule.id = shift.schedule_id
   and schedule.status = 'published'
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
$$;

-- Preserve the original private signature for existing callers while routing
-- it through the same interval implementation.
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
  select private.time_off_affected_shifts(
    target_employee_id,
    target_starts_on,
    target_ends_on,
    null,
    null,
    coalesce(
      (select employee.time_zone from public.employees employee where employee.id = target_employee_id),
      'America/Denver'
    )
  )
$$;

create or replace function public.get_time_off_request_context_v2(
  request_starts_on date,
  request_ends_on date,
  request_partial_start time without time zone,
  request_partial_end time without time zone
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
  request_span tstzrange;
  estimated_minutes integer := 0;
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
    request_span := private.time_off_window(
      request_starts_on,
      request_ends_on,
      request_partial_start,
      request_partial_end,
      employee_record.time_zone
    );
    affected := private.time_off_affected_shifts(
      viewer_id,
      request_starts_on,
      request_ends_on,
      request_partial_start,
      request_partial_end,
      employee_record.time_zone
    );

    if request_partial_start is not null then
      estimated_minutes := greatest(
        0,
        floor(extract(epoch from (upper(request_span) - lower(request_span))) / 60)::integer
      );
    else
      select coalesce(sum((item ->> 'estimatedMinutes')::integer), 0)::integer
      into estimated_minutes
      from jsonb_array_elements(affected) item;
    end if;
  end if;

  return jsonb_build_object(
    'employee', jsonb_build_object(
      'id', employee_record.id,
      'employeeNumber', employee_record.employee_number,
      'name', employee_record.first_name || ' ' || employee_record.last_name,
      'employmentType', employee_record.employment_type,
      'status', employee_record.status,
      'timeZone', employee_record.time_zone
    ),
    'allowedTypes', case employee_record.employment_type::text
      when 'salary' then jsonb_build_array('paid_vacation', 'sick_time', 'unpaid_time_off')
      else jsonb_build_array('sick_time', 'unpaid_time_off')
    end,
    'affectedShifts', affected,
    'requestedMinutes', estimated_minutes,
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

-- Preserve the established two-date RPC for older clients. New clients use v2
-- so partial-day previews and the final submission share the exact interval.
create or replace function public.get_time_off_request_context(
  request_starts_on date default null,
  request_ends_on date default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.get_time_off_request_context_v2(
    request_starts_on,
    request_ends_on,
    null,
    null
  )
$$;

create or replace function public.submit_time_off_request_v2(
  request_kind text,
  request_starts_on date,
  request_ends_on date,
  request_partial_start time without time zone default null,
  request_partial_end time without time zone default null,
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
  operational_today date;
  request_span tstzrange;
  affected jsonb;
  estimated_minutes integer;
  treatment text;
begin
  if requesting_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  perform private.lock_employee_schedule_time_off(requesting_employee_id);

  select * into employee_record
  from public.employees employee
  where employee.id = requesting_employee_id and employee.status = 'active'
  for update;

  if not found then
    raise insufficient_privilege using message = 'Only active employees can request time off.';
  end if;

  operational_today := (clock_timestamp() at time zone employee_record.time_zone)::date;

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

  request_span := private.time_off_window(
    request_starts_on,
    request_ends_on,
    request_partial_start,
    request_partial_end,
    employee_record.time_zone
  );

  if exists (
    select 1
    from public.time_off_requests existing
    where existing.employee_id = requesting_employee_id
      and existing.status in ('pending', 'approved')
      and private.time_off_window(
        existing.starts_on,
        existing.ends_on,
        existing.partial_day_start,
        existing.partial_day_end,
        coalesce(
          nullif(existing.submission_snapshot ->> 'timeZone', ''),
          employee_record.time_zone
        )
      ) && request_span
  ) then
    raise unique_violation using message = 'An active time-off request already overlaps this time.';
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
        and shift.canceled_at is null
        and tstzrange(shift.starts_at, shift.ends_at, '[)') && request_span
        and shift.starts_at <= clock_timestamp() + interval '4 hours'
        and shift.ends_at > clock_timestamp()
    )
  then
    raise check_violation using message = 'For a current or imminent shift, use Report Sick / Call-Off so Dispatch is notified immediately.';
  end if;

  affected := private.time_off_affected_shifts(
    requesting_employee_id,
    request_starts_on,
    request_ends_on,
    request_partial_start,
    request_partial_end,
    employee_record.time_zone
  );

  if request_partial_start is not null then
    estimated_minutes := greatest(
      0,
      floor(extract(epoch from (upper(request_span) - lower(request_span))) / 60)::integer
    );
  else
    select coalesce(sum((item ->> 'estimatedMinutes')::integer), 0)::integer
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
      'timeZone', employee_record.time_zone,
      'requestWindowStartsAt', lower(request_span),
      'requestWindowEndsAt', upper(request_span),
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
    jsonb_build_object(
      'requestType', request_kind,
      'startsOn', request_starts_on,
      'endsOn', request_ends_on,
      'timeZone', employee_record.time_zone,
      'requestWindowStartsAt', lower(request_span),
      'requestWindowEndsAt', upper(request_span)
    )
  );

  return request_id;
end
$$;

-- Compatibility endpoint for older clients. It retains the prior signature but
-- cannot bypass the authoritative validator or snapshot/audit path.
create or replace function public.submit_time_off_request(
  request_starts_on date,
  request_ends_on date,
  request_partial_start time without time zone default null,
  request_partial_end time without time zone default null,
  request_reason text default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public.submit_time_off_request_v2(
    'unpaid_time_off',
    request_starts_on,
    request_ends_on,
    request_partial_start,
    request_partial_end,
    null,
    request_reason
  )
$$;

create or replace function public.withdraw_time_off_request(target_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  requesting_employee_id uuid := public.current_employee_id();
  request_record public.time_off_requests%rowtype;
  withdrawal_time timestamptz := clock_timestamp();
begin
  if requesting_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  perform private.lock_employee_schedule_time_off(requesting_employee_id);

  select * into request_record
  from public.time_off_requests request
  where request.id = target_request_id
    and request.employee_id = requesting_employee_id
    and request.status = 'pending'
  for update;

  if not found then
    raise check_violation using message = 'Only a pending request owned by this account can be withdrawn.';
  end if;

  update public.time_off_requests
  set
    status = 'withdrawn',
    decision_snapshot = jsonb_build_object(
      'action', 'withdrawn',
      'employeeId', requesting_employee_id,
      'withdrawnAt', withdrawal_time
    )
  where id = target_request_id;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    (select auth.uid()), requesting_employee_id, 'public', 'time_off_requests',
    'EMPLOYEE_WITHDRAW', target_request_id::text,
    jsonb_build_object('status', request_record.status),
    jsonb_build_object('status', 'withdrawn', 'withdrawnAt', withdrawal_time)
  );

  return true;
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

  select * into request_record
  from public.time_off_requests request
  where request.id = target_request_id;
  if not found then
    raise no_data_found using message = 'The time-off request could not be found.';
  end if;

  select * into employee_record
  from public.employees employee
  where employee.id = request_record.employee_id;

  return jsonb_build_object(
    'id', request_record.id,
    'employee', jsonb_build_object(
      'id', employee_record.id,
      'employeeNumber', employee_record.employee_number,
      'name', employee_record.first_name || ' ' || employee_record.last_name,
      'timeZone', coalesce(
        nullif(request_record.submission_snapshot ->> 'timeZone', ''),
        employee_record.time_zone
      )
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
     and schedule.status <> 'superseded'
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

-- Keep assignment capacity and overlap behavior, but use the same employee
-- lock and the same employee-zone time-off interval used by submit/approve.
create or replace function private.enforce_assignment_capacity_and_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  target_employee_time_zone text;
  active_assignment_count integer;
  conflict jsonb;
begin
  if new.status = 'canceled' then
    return new;
  end if;

  perform private.lock_employee_schedule_time_off(new.employee_id);
  perform pg_advisory_xact_lock(hashtext(new.shift_id::text));

  select * into target_shift
  from public.shifts shift
  where shift.id = new.shift_id
    and shift.canceled_at is null;

  if target_shift.id is null then
    raise foreign_key_violation using message = 'The assigned shift does not exist.';
  end if;

  select * into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.id is null then
    raise foreign_key_violation using message = 'The assigned shift is not linked to a schedule.';
  end if;

  select employee.time_zone into target_employee_time_zone
  from public.employees employee
  where employee.id = new.employee_id;

  if target_employee_time_zone is null then
    raise foreign_key_violation using message = 'The assigned employee does not exist.';
  end if;

  if exists (
    select 1
    from public.time_off_requests request
    where request.employee_id = new.employee_id
      and request.status = 'approved'
      and private.time_off_window(
        request.starts_on,
        request.ends_on,
        request.partial_day_start,
        request.partial_day_end,
        coalesce(
          nullif(request.submission_snapshot ->> 'timeZone', ''),
          target_employee_time_zone
        )
      ) && tstzrange(target_shift.starts_at, target_shift.ends_at, '[)')
  ) then
    raise check_violation using message = 'The employee has approved time off during this shift.';
  end if;

  select count(*) into active_assignment_count
  from public.shift_assignments assignment
  where assignment.shift_id = new.shift_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and assignment.id <> new.id;

  if active_assignment_count >= target_shift.headcount_required then
    raise check_violation using message = 'The shift already has its required number of assigned employees.';
  end if;

  conflict := private.assignment_overlap_conflict(new.id, new.shift_id, new.employee_id);

  if conflict is not null then
    raise exception using
      message = private.assignment_overlap_conflict_message(conflict),
      detail = conflict::text,
      hint = 'Open the employee schedule or the listed schedule revision to review the actual conflict.';
  end if;

  return new;
end
$$;

comment on function private.time_off_window(date, date, time without time zone, time without time zone, text) is
  'Maps a full- or partial-day request to one half-open timestamptz range in the employee profile time zone.';
comment on function private.enforce_assignment_capacity_and_overlap() is
  'Serializes employee scheduling against time-off decisions and enforces capacity, approved leave, and active assignment overlap.';

revoke all on function private.lock_employee_schedule_time_off(uuid)
  from public, anon, authenticated;
revoke all on function private.time_off_local_instant(date, time without time zone, text)
  from public, anon, authenticated;
revoke all on function private.time_off_window(date, date, time without time zone, time without time zone, text)
  from public, anon, authenticated;
revoke all on function private.time_off_affected_shifts(uuid, date, date, time without time zone, time without time zone, text)
  from public, anon, authenticated;
revoke all on function private.time_off_affected_shifts(uuid, date, date)
  from public, anon, authenticated;

revoke all on function public.get_time_off_request_context(date, date) from public, anon;
revoke all on function public.get_time_off_request_context_v2(date, date, time without time zone, time without time zone)
  from public, anon;
revoke all on function public.submit_time_off_request_v2(text, date, date, time without time zone, time without time zone, date, text)
  from public, anon;
revoke all on function public.submit_time_off_request(date, date, time without time zone, time without time zone, text)
  from public, anon;
revoke all on function public.withdraw_time_off_request(uuid) from public, anon;
revoke all on function public.get_time_off_review_context(uuid) from public, anon;
revoke all on function public.decide_time_off_request_v2(uuid, public.request_status, text)
  from public, anon;

grant execute on function public.get_time_off_request_context(date, date) to authenticated;
grant execute on function public.get_time_off_request_context_v2(date, date, time without time zone, time without time zone)
  to authenticated;
grant execute on function public.submit_time_off_request_v2(text, date, date, time without time zone, time without time zone, date, text)
  to authenticated;
grant execute on function public.submit_time_off_request(date, date, time without time zone, time without time zone, text)
  to authenticated;
grant execute on function public.withdraw_time_off_request(uuid) to authenticated;
grant execute on function public.get_time_off_review_context(uuid) to authenticated;
grant execute on function public.decide_time_off_request_v2(uuid, public.request_status, text)
  to authenticated;

-- Time-off rows are now RPC-only for authenticated clients. SELECT remains
-- governed by the existing RLS policies; service and migration roles retain
-- their administrative access.
revoke insert, update, delete, truncate on table public.time_off_requests
  from public, anon, authenticated;

-- This is the single authoritative request-center implementation. The prior
-- wrapper delegated row visibility to a preserved private function while
-- calculating canManage separately, which allowed those answers to diverge.
create or replace function public.get_request_center_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  can_manage boolean := public.has_effective_permission('requests.manage');
  viewer_time_zone text;
  manager_history_limit constant integer := 100;
  payload jsonb;
begin
  if viewer_employee_id is null or viewer_role is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view requests.';
  end if;

  select employee.time_zone into viewer_time_zone
  from public.employees employee
  where employee.id = viewer_employee_id;

  if viewer_time_zone is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view requests.';
  end if;

  select jsonb_build_object(
    'employeeId', viewer_employee_id,
    'employeeTimeZone', viewer_time_zone,
    'role', viewer_role,
    'permissions', jsonb_build_object(
      'canManage', can_manage
    ),
    'timeOffHistory', jsonb_build_object(
      'managerHistoryLimit', case when can_manage then manager_history_limit else null end,
      'truncated', can_manage and (
        select count(*) > manager_history_limit
        from public.time_off_requests history
        where history.employee_id <> viewer_employee_id
          and history.status <> 'pending'
      )
    ),
    'timeOff', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', request.id,
        'employeeId', request.employee_id,
        'employeeNumber', employee.employee_number,
        'employeeName', coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
        'requestType', request.request_type,
        'employmentType', request.employment_type_snapshot,
        'payTreatment', request.pay_treatment,
        'startsOn', request.starts_on,
        'endsOn', request.ends_on,
        'partialDayStart', request.partial_day_start,
        'partialDayEnd', request.partial_day_end,
        'returnOn', request.return_on,
        'requestedMinutes', request.requested_minutes,
        'affectedShiftCount', case
          when jsonb_typeof(request.affected_shifts_snapshot) = 'array'
            then jsonb_array_length(request.affected_shifts_snapshot)
          else 0
        end,
        'affectedShifts', case
          when jsonb_typeof(request.affected_shifts_snapshot) = 'array'
            then request.affected_shifts_snapshot
          else '[]'::jsonb
        end,
        'reason', request.reason,
        'status', request.status,
        'decisionNote', request.decision_note,
        'decidedAt', request.decided_at,
        'decidedByName', case when decider.id is null then null else
          coalesce(nullif(decider.preferred_name, ''), decider.first_name) || ' ' || decider.last_name
        end,
        'createdAt', request.created_at,
        'updatedAt', request.updated_at
      ) order by request.created_at desc, request.id), '[]'::jsonb)
      from public.time_off_requests request
      join public.employees employee on employee.id = request.employee_id
      left join public.employees decider on decider.id = request.decided_by
      where request.employee_id = viewer_employee_id
        or (can_manage and request.status = 'pending')
        or (can_manage and request.id in (
          select history.id
          from public.time_off_requests history
          where history.employee_id <> viewer_employee_id
            and history.status <> 'pending'
          order by history.updated_at desc, history.created_at desc, history.id
          limit manager_history_limit
        ))
    ),
    'shiftRequests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', request.id,
        'employeeId', request.employee_id,
        'employeeName', coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
        'status', request.status,
        'employeeNote', request.employee_note,
        'decisionNote', request.decision_note,
        'createdAt', request.created_at,
        'shift', jsonb_build_object(
          'id', shift.id,
          'startsAt', shift.starts_at,
          'endsAt', shift.ends_at,
          'timeZone', shift.time_zone,
          'title', coalesce(event.name, post.name, 'Assigned shift'),
          'location', coalesce(site.name, event.location_name, 'Location pending')
        )
      ) order by request.created_at desc, request.id), '[]'::jsonb)
      from public.shift_requests request
      join public.employees employee on employee.id = request.employee_id
      join public.shifts shift on shift.id = request.shift_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      where (
          (can_manage and request.status = 'pending')
          or request.employee_id = viewer_employee_id
        )
        and shift.ends_at > clock_timestamp()
    ),
    'callOffs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', report.id,
        'employeeId', report.employee_id,
        'employeeName', coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
        'reason', report.reason,
        'reportedAt', report.reported_at,
        'acknowledgedAt', report.acknowledged_at,
        'announcementId', report.announcement_id,
        'resolvedAt', report.resolved_at,
        'shift', jsonb_build_object(
          'id', shift.id,
          'startsAt', shift.starts_at,
          'endsAt', shift.ends_at,
          'timeZone', shift.time_zone,
          'title', coalesce(event.name, post.name, 'Assigned shift'),
          'location', coalesce(site.name, event.location_name, 'Location pending')
        )
      ) order by report.reported_at desc, report.id), '[]'::jsonb)
      from public.call_off_reports report
      join public.employees employee on employee.id = report.employee_id
      join public.shifts shift on shift.id = report.shift_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      where (
          (can_manage and report.announcement_id is null and report.resolved_at is null)
          or report.employee_id = viewer_employee_id
        )
        and report.canceled_at is null
        and shift.ends_at > clock_timestamp()
    ),
    'upcomingAssignments', (
      select case
        when can_manage then '[]'::jsonb
        else coalesce(jsonb_agg(jsonb_build_object(
          'id', assignment.id,
          'status', assignment.status,
          'shift', jsonb_build_object(
            'id', shift.id,
            'startsAt', shift.starts_at,
            'endsAt', shift.ends_at,
            'timeZone', shift.time_zone,
            'title', coalesce(event.name, post.name, 'Assigned shift'),
            'location', coalesce(site.name, event.location_name, 'Location pending')
          )
        ) order by shift.starts_at, assignment.id), '[]'::jsonb)
      end
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      where not can_manage
        and assignment.employee_id = viewer_employee_id
        and assignment.status in ('assigned', 'confirmed')
        and shift.ends_at > clock_timestamp()
    )
  )
  into payload;

  return payload;
end
$$;

revoke all on function public.get_request_center_payload() from public, anon;
grant execute on function public.get_request_center_payload() to authenticated;

comment on function public.get_request_center_payload() is
  'Returns the request center with requests.manage-authorized queues, complete employee self-history, bounded manager time-off history, and future/unresolved operational filtering.';

-- The former implementation is no longer retained as executable source. This
-- prevents a later wrapper from accidentally restoring role-label visibility.
drop function if exists private.get_request_center_payload_pre_absence_completion();

-- Canonicalize request links at the notification boundary so every future
-- workflow/action or status notification lands on the exact record regardless
-- of which producer supplied the original generic Requests path.
create or replace function private.canonicalize_request_notification_action_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source_id is null then
    return new;
  end if;

  case new.source_type
    when 'time_off_request' then
      new.action_path := concat('/time-off?tab=time-off&request=', new.source_id);
      new.action_label := 'Open time-off request';
    when 'shift_request' then
      new.action_path := concat('/time-off?tab=shift-requests&request=', new.source_id);
      new.action_label := 'Open shift request';
    when 'call_off_request' then
      new.action_path := concat('/time-off?tab=call-offs&callOff=', new.source_id);
      new.action_label := 'Open call-off';
    else
      null;
  end case;

  return new;
end
$$;

revoke all on function private.canonicalize_request_notification_action_path()
  from public, anon, authenticated;

drop trigger if exists canonicalize_request_notification_action_path
  on public.employee_notifications;
create trigger canonicalize_request_notification_action_path
before insert or update on public.employee_notifications
for each row execute function private.canonicalize_request_notification_action_path();

-- Repair only still-open reviewer actions backed by a pending request. Read,
-- acknowledgment, dismissal, creation, and completion timestamps are untouched.
do $notification_backfill$
declare
  prior_signal_setting text := current_setting('sygshift.suppress_notification_signal', true);
begin
  perform set_config('sygshift.suppress_notification_signal', 'yes', true);

  update public.employee_notifications notification
  set
    action_path = case notification.source_type
      when 'time_off_request' then concat('/time-off?tab=time-off&request=', notification.source_id)
      when 'shift_request' then concat('/time-off?tab=shift-requests&request=', notification.source_id)
      when 'call_off_request' then concat('/time-off?tab=call-offs&callOff=', notification.source_id)
    end,
    action_label = case notification.source_type
      when 'time_off_request' then 'Open time-off request'
      when 'shift_request' then 'Open shift request'
      when 'call_off_request' then 'Open call-off'
    end
  where notification.action_required
    and notification.resolved_at is null
    and notification.source_id is not null
    and (
      (
        notification.source_type = 'time_off_request'
        and exists (
          select 1
          from public.time_off_requests request
          where request.id = notification.source_id
            and request.status = 'pending'
        )
      )
      or (
        notification.source_type = 'shift_request'
        and exists (
          select 1
          from public.shift_requests request
          where request.id = notification.source_id
            and request.status = 'pending'
        )
      )
      or (
        notification.source_type = 'call_off_request'
        and exists (
          select 1
          from public.call_off_reports report
          where report.id = notification.source_id
            and report.resolved_at is null
            and report.canceled_at is null
        )
      )
    );

  perform set_config(
    'sygshift.suppress_notification_signal',
    coalesce(prior_signal_setting, ''),
    true
  );
exception
  when others then
    perform set_config(
      'sygshift.suppress_notification_signal',
      coalesce(prior_signal_setting, ''),
      true
    );
    raise;
end
$notification_backfill$;

do $contract$
declare
  request_center_function regprocedure := 'public.get_request_center_payload()'::regprocedure;
  canonicalizer_function regprocedure := 'private.canonicalize_request_notification_action_path()'::regprocedure;
begin
  if to_regprocedure('private.get_request_center_payload_pre_absence_completion()') is not null then
    raise exception 'The superseded request-center implementation is still installed.';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_proc procedure
    where procedure.oid in (request_center_function, canonicalizer_function)
      and procedure.prosecdef
      and coalesce(procedure.proconfig, array[]::text[]) @> array['search_path=""']
  ) <> 2 then
    raise exception 'Request-center security-definer functions do not have fixed empty search paths.';
  end if;

  if has_function_privilege('anon', request_center_function, 'execute')
     or not has_function_privilege('authenticated', request_center_function, 'execute') then
    raise exception 'Request-center RPC execution grants are incorrect.';
  end if;

  if has_table_privilege('authenticated', 'public.time_off_requests', 'INSERT')
    or has_table_privilege('authenticated', 'public.time_off_requests', 'UPDATE')
    or has_table_privilege('authenticated', 'public.time_off_requests', 'DELETE')
    or has_table_privilege('authenticated', 'public.time_off_requests', 'TRUNCATE')
    or has_any_column_privilege('authenticated', 'public.time_off_requests', 'INSERT')
    or has_any_column_privilege('authenticated', 'public.time_off_requests', 'UPDATE')
  then
    raise exception 'Authenticated time-off writes must remain RPC-only.';
  end if;
end
$contract$;

notify pgrst, 'reload schema';

commit;
