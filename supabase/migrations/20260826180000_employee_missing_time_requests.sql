begin;

alter table public.time_adjustment_requests
  add column if not exists requested_post_id uuid references public.posts(id) on delete restrict,
  add column if not exists requested_unpaid_break_minutes integer not null default 0,
  add column if not exists applied_time_event_ids uuid[] not null default '{}'::uuid[];

alter table public.time_adjustment_requests
  drop constraint if exists time_adjustment_requested_break_range;

alter table public.time_adjustment_requests
  add constraint time_adjustment_requested_break_range
  check (requested_unpaid_break_minutes between 0 and 240);

create index if not exists time_adjustment_missing_time_review_idx
  on public.time_adjustment_requests (status, work_date, submitted_at desc)
  where issue_type = 'missing_shift';

create or replace function public.get_missing_time_request_workspace(
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
  can_review boolean;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if target_from_date is null or target_through_date is null
    or target_through_date < target_from_date
    or target_through_date - target_from_date > 366 then
    raise check_violation using message = 'Choose a valid date range of 366 days or fewer.';
  end if;

  can_review := public.has_mfa() and public.has_effective_permission('time.adjustments.review');

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'canReviewAdjustments', can_review,
    'posts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', post.id,
        'siteId', site.id,
        'siteCode', site.code,
        'siteName', site.name,
        'postName', post.name,
        'timeZone', site.time_zone
      ) order by site.name, post.name), '[]'::jsonb)
      from public.posts post
      join public.sites site on site.id = post.site_id
      where post.active and site.active
    ),
    'requests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', request.id,
        'employeeId', request.employee_id,
        'employeeName', concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name),
        'shiftId', request.shift_id,
        'workDate', request.work_date,
        'issueType', request.issue_type,
        'requestedClockInAt', request.requested_clock_in_at,
        'requestedClockOutAt', request.requested_clock_out_at,
        'requestedPostId', request.requested_post_id,
        'requestedLocation', concat_ws(' · ', nullif(site.code, ''), site.name, post.name),
        'requestedTimeZone', site.time_zone,
        'requestedUnpaidBreakMinutes', request.requested_unpaid_break_minutes,
        'appliedTimeEventIds', request.applied_time_event_ids,
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
      left join public.posts post on post.id = request.requested_post_id
      left join public.sites site on site.id = post.site_id
      left join public.employees reviewer on reviewer.id = request.reviewer_id
      where request.issue_type = 'missing_shift'
        and request.work_date between target_from_date and target_through_date
        and (can_review or request.employee_id = actor_id)
    )
  );
end
$$;

create or replace function public.submit_missing_time_request(
  target_work_date date,
  target_requested_clock_in_at timestamptz,
  target_requested_clock_out_at timestamptz,
  target_post_id uuid,
  target_unpaid_break_minutes integer,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_reason text := btrim(coalesce(target_reason, ''));
  requested_duration_minutes integer;
  selected_post record;
  matched_shift_id uuid;
  inserted public.time_adjustment_requests;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if target_work_date is null or target_requested_clock_in_at is null or target_requested_clock_out_at is null then
    raise check_violation using message = 'Date, clock-in time, and clock-out time are required.';
  end if;
  if target_requested_clock_out_at <= target_requested_clock_in_at then
    raise check_violation using message = 'Clock-out must be after clock-in.';
  end if;
  requested_duration_minutes := floor(extract(epoch from (target_requested_clock_out_at - target_requested_clock_in_at)) / 60)::integer;
  if requested_duration_minutes > 1440 then
    raise check_violation using message = 'A missing-time request cannot exceed 24 hours.';
  end if;
  if coalesce(target_unpaid_break_minutes, 0) < 0 or coalesce(target_unpaid_break_minutes, 0) > 240
    or coalesce(target_unpaid_break_minutes, 0) >= requested_duration_minutes then
    raise check_violation using message = 'Enter an unpaid break shorter than the requested work period.';
  end if;
  if length(clean_reason) < 10 then
    raise check_violation using message = 'Explain what happened using at least 10 characters.';
  end if;
  if length(clean_reason) > 1000 then
    raise check_violation using message = 'The explanation must be 1,000 characters or fewer.';
  end if;

  select post.id, site.time_zone into selected_post
  from public.posts post
  join public.sites site on site.id = post.site_id
  where post.id = target_post_id and post.active and site.active;

  if selected_post.id is null then
    raise check_violation using message = 'Choose an active Site/Post.';
  end if;
  if (target_requested_clock_in_at at time zone selected_post.time_zone)::date <> target_work_date then
    raise check_violation using message = 'The work date must match the clock-in date at the selected Site/Post.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(concat('missing-time:', actor_id, ':', target_work_date), 0));

  if exists (
    select 1 from public.time_adjustment_requests request
    where request.employee_id = actor_id
      and request.issue_type = 'missing_shift'
      and request.status in ('submitted', 'under_review')
      and request.requested_clock_in_at = target_requested_clock_in_at
      and request.requested_clock_out_at = target_requested_clock_out_at
      and request.requested_post_id = target_post_id
  ) then
    raise check_violation using message = 'This missing-time request is already awaiting review.';
  end if;

  select shift.id into matched_shift_id
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
  join public.shift_assignments assignment on assignment.shift_id = shift.id
  where assignment.employee_id = actor_id
    and assignment.status <> 'canceled'
    and shift.post_id = target_post_id
    and shift.starts_at < target_requested_clock_out_at
    and shift.ends_at > target_requested_clock_in_at
  order by abs(extract(epoch from (shift.starts_at - target_requested_clock_in_at)))
  limit 1;

  insert into public.time_adjustment_requests (
    employee_id, shift_id, work_date, issue_type, requested_clock_in_at, requested_clock_out_at,
    requested_post_id, requested_unpaid_break_minutes, reason, submitted_by
  ) values (
    actor_id, matched_shift_id, target_work_date, 'missing_shift', target_requested_clock_in_at,
    target_requested_clock_out_at, target_post_id, coalesce(target_unpaid_break_minutes, 0), clean_reason, actor_id
  ) returning * into inserted;

  insert into public.time_adjustment_request_actions (request_id, action, note, actor_id, snapshot)
  values (inserted.id, 'submitted', clean_reason, actor_id, to_jsonb(inserted));

  return jsonb_build_object('id', inserted.id, 'status', inserted.status, 'submittedAt', inserted.submitted_at);
end
$$;

create or replace function public.review_missing_time_request(
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
  selected_post record;
  warning_codes text[] := '{}'::text[];
  event_ids uuid[] := '{}'::uuid[];
  inserted_event public.time_events;
  event_kind public.time_event_kind;
  event_at timestamptz;
  break_start_at timestamptz;
  break_end_at timestamptz;
  event_index integer := 0;
  location_name text;
  clean_note text := btrim(coalesce(target_decision_note, ''));
begin
  if target_decision not in ('under_review', 'approved', 'rejected') then
    raise check_violation using message = 'Choose a valid review decision.';
  end if;
  if length(clean_note) < 3 then
    raise check_violation using message = 'A documented decision note is required.';
  end if;

  select * into request
  from public.time_adjustment_requests
  where id = target_request_id
  for update;

  if request.id is null or request.issue_type <> 'missing_shift' or request.status not in ('submitted', 'under_review') then
    raise check_violation using message = 'This missing-time request is no longer awaiting review.';
  end if;

  if target_decision = 'approved' then
    select post.id, post.name as post_name, site.code as site_code, site.name as site_name, site.time_zone
      into selected_post
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = request.requested_post_id;

    if selected_post.id is null or request.requested_clock_in_at is null or request.requested_clock_out_at is null then
      raise check_violation using message = 'This request is missing required time or Site/Post information and cannot be approved.';
    end if;

    if extract(epoch from (request.requested_clock_out_at - request.requested_clock_in_at)) / 60 > private.timekeeping_setting_integer('long_shift_minutes', 840) then
      warning_codes := array_append(warning_codes, 'long_shift');
    end if;
    if exists (
      select 1
      from public.time_events event
      cross join lateral private.current_effective_time_event(event.id) effective
      where event.employee_id = request.employee_id
        and not effective.voided
        and effective.effective_at between request.requested_clock_in_at and request.requested_clock_out_at
    ) then
      warning_codes := array_append(warning_codes, 'existing_punches_in_range');
    end if;
    if cardinality(warning_codes) > 0 and not target_confirm_warnings then
      raise check_violation using message = concat('Review and confirm these warnings before approval: ', array_to_string(warning_codes, ', '), '.');
    end if;

    location_name := concat_ws(' · ', nullif(selected_post.site_code, ''), selected_post.site_name, selected_post.post_name);
    if request.requested_unpaid_break_minutes > 0 then
      break_start_at := request.requested_clock_in_at + ((request.requested_clock_out_at - request.requested_clock_in_at - make_interval(mins => request.requested_unpaid_break_minutes)) / 2);
      break_end_at := break_start_at + make_interval(mins => request.requested_unpaid_break_minutes);
    end if;

    for event_kind, event_at in
      select item.kind, item.event_at
      from (values
        ('clock_in'::public.time_event_kind, request.requested_clock_in_at),
        ('break_start'::public.time_event_kind, break_start_at),
        ('break_end'::public.time_event_kind, break_end_at),
        ('clock_out'::public.time_event_kind, request.requested_clock_out_at)
      ) item(kind, event_at)
      where item.event_at is not null
      order by item.event_at
    loop
      event_index := event_index + 1;
      insert into public.time_events (
        employee_id, shift_id, kind, recorded_at, client_recorded_at, source, idempotency_key, created_by
      ) values (
        request.employee_id, request.shift_id, event_kind, event_at, null, 'supervisor',
        concat('approved-missing-time:', request.id, ':', event_index), actor_id
      )
      on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
      returning * into inserted_event;

      event_ids := array_append(event_ids, inserted_event.id);
      insert into public.time_event_maintenance_notes (time_event_id, action, note, created_by)
      values (inserted_event.id, 'manual_add', concat('Approved missing-time request: ', request.reason, ' Review: ', clean_note), actor_id)
      on conflict do nothing;

      if request.shift_id is null then
        insert into public.time_event_location_overrides (time_event_id, location_name, time_zone, reason, created_by)
        select inserted_event.id, location_name, selected_post.time_zone, clean_note, actor_id
        where not exists (
          select 1 from public.time_event_location_overrides existing where existing.time_event_id = inserted_event.id
        );
      end if;
    end loop;
  end if;

  update public.time_adjustment_requests
  set status = target_decision,
      reviewer_id = actor_id,
      reviewed_at = case when target_decision in ('approved', 'rejected') then clock_timestamp() else reviewed_at end,
      decision_note = clean_note,
      applied_time_event_ids = case when target_decision = 'approved' then event_ids else applied_time_event_ids end
  where id = request.id
  returning * into request;

  insert into public.time_adjustment_request_actions (request_id, action, note, actor_id, snapshot)
  values (request.id, target_decision, clean_note, actor_id, to_jsonb(request));

  return jsonb_build_object(
    'id', request.id,
    'status', request.status,
    'timeEventIds', request.applied_time_event_ids,
    'warningCodes', warning_codes
  );
end
$$;

revoke all on function public.get_missing_time_request_workspace(date, date) from public, anon;
revoke all on function public.submit_missing_time_request(date, timestamptz, timestamptz, uuid, integer, text) from public, anon;
revoke all on function public.review_missing_time_request(uuid, text, text, boolean) from public, anon;

grant execute on function public.get_missing_time_request_workspace(date, date) to authenticated;
grant execute on function public.submit_missing_time_request(date, timestamptz, timestamptz, uuid, integer, text) to authenticated;
grant execute on function public.review_missing_time_request(uuid, text, text, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
