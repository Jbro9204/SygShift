-- Rollback-only parity and trigger-lifecycle proof for the indexed effective
-- punch projection. Run after 20261026142700_bound_payroll_effective_event_source.sql.
begin isolation level repeatable read;

set local statement_timeout = '90s';
set local lock_timeout = '250ms';

do $bounded_projection_regression$
declare
  actor_auth_user_id uuid;
  actor_employee_id uuid;
  long_session_employee_id constant uuid := 'be000000-0000-4000-8000-000000000001';
  corrected_employee_id constant uuid := 'be000000-0000-4000-8000-000000000002';
  shifted_employee_id constant uuid := 'be000000-0000-4000-8000-000000000003';
  dst_employee_id constant uuid := 'be000000-0000-4000-8000-000000000004';
  site_id constant uuid := 'be100000-0000-4000-8000-000000000001';
  post_id constant uuid := 'be200000-0000-4000-8000-000000000001';
  schedule_id constant uuid := 'be300000-0000-4000-8000-000000000001';
  shifted_occurrence_id constant uuid := 'be400000-0000-4000-8000-000000000001';
  prior_close_id constant uuid := 'be500000-0000-4000-8000-000000000001';
  long_clock_in_id constant uuid := 'be500000-0000-4000-8000-000000000002';
  long_break_id constant uuid := 'be500000-0000-4000-8000-000000000003';
  corrected_clock_in_id constant uuid := 'be500000-0000-4000-8000-000000000004';
  corrected_clock_out_id constant uuid := 'be500000-0000-4000-8000-000000000005';
  shifted_clock_in_id constant uuid := 'be500000-0000-4000-8000-000000000006';
  shifted_clock_out_id constant uuid := 'be500000-0000-4000-8000-000000000007';
  dst_clock_in_id constant uuid := 'be500000-0000-4000-8000-000000000008';
  dst_clock_out_id constant uuid := 'be500000-0000-4000-8000-000000000009';
  correction_clock_in_id constant uuid := 'be600000-0000-4000-8000-000000000001';
  correction_clock_out_id constant uuid := 'be600000-0000-4000-8000-000000000002';
  fingerprint_before text;
  fingerprint_after text;
  bounded_count integer;
  target record;
begin
  select account.auth_user_id, employee.id
  into actor_auth_user_id, actor_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and 'time.view' = any(private.employee_effective_permissions(employee.id))
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  if actor_auth_user_id is null then
    raise insufficient_privilege using message =
      'An active MFA time viewer is required for the projection regression.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_user_id,
    'role', 'authenticated',
    'aal', 'aal2'
  )::text, true);

  if has_table_privilege('authenticated',
      'private.timekeeping_effective_event_projection', 'select')
    or has_function_privilege('authenticated',
      'private.refresh_timekeeping_effective_event_projection(uuid)', 'execute')
    or has_function_privilege('authenticated',
      'private.refresh_timekeeping_effective_event_projection_trigger()', 'execute')
    or has_function_privilege('authenticated',
      'private.get_effective_time_events_bounded(uuid,timestamptz,timestamptz)',
      'execute') then
    raise exception 'Private effective-event projection privileges leaked.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc function_row
    where function_row.oid in (
      'private.refresh_timekeeping_effective_event_projection(uuid)'::regprocedure,
      'private.refresh_timekeeping_effective_event_projection_trigger()'::regprocedure,
      'private.get_effective_time_events_bounded(uuid,timestamptz,timestamptz)'::regprocedure
    )
      and (
        not function_row.prosecdef
        or position('search_path=' in array_to_string(function_row.proconfig, ',')) = 0
      )
  ) then
    raise exception 'Projection functions lost SECURITY DEFINER or empty search-path controls.';
  end if;

  -- Existing production-shaped history must keep the exact effective fields
  -- and every event whose mature assignment anchor belongs to the range. This
  -- catches adjacent overnight sessions before any synthetic fixture exists.
  for target in
    select * from (values
      ('prior_period', date '2026-10-04', date '2026-10-17'),
      ('current_period', date '2026-10-18', date '2026-10-31'),
      ('maximum_range', date '2026-09-04', date '2026-10-19')
    ) cases(case_name, from_date, through_date)
  loop
    if exists (
      with rules as (
        select rule.time_zone
        from private.payroll_rules rule
        where rule.id = true
      ), bounded as materialized (
        select event.*
        from rules
        cross join lateral private.get_effective_time_events_bounded(
          null,
          target.from_date::timestamp at time zone rules.time_zone,
          (target.through_date + 1)::timestamp at time zone rules.time_zone
        ) event
      )
      select 1
      from bounded
      left join private.get_effective_time_events() legacy
        on legacy.id = bounded.id
      where legacy.id is null or to_jsonb(legacy) is distinct from to_jsonb(bounded)
    ) then
      raise exception 'Existing % bounded events differ from the mature resolver.',
        target.case_name;
    end if;

    if exists (
      with rules as (
        select rule.time_zone
        from private.payroll_rules rule
        where rule.id = true
      ), effective_events as materialized (
        select event.*
        from private.get_effective_time_events() event
      ), session_membership as materialized (
        select
          event.id,
          event.employee_id,
          coalesce(sum(case when event.kind = 'clock_out' then 1 else 0 end) over (
            partition by event.employee_id
            order by event.effective_at, event.recorded_at, event.id
            rows between unbounded preceding and 1 preceding
          ), 0)::bigint as session_number
        from effective_events event
        where not event.voided
      ), session_candidates as materialized (
        select
          membership.id,
          min(candidate.effective_at) filter (where candidate.kind = 'clock_in')
            as session_started_at
        from session_membership membership
        join effective_events selected on selected.id = membership.id
        left join session_membership candidate_membership
          on candidate_membership.employee_id = membership.employee_id
         and candidate_membership.session_number = membership.session_number
        left join effective_events candidate
          on candidate.id = candidate_membership.id
         and candidate.kind = 'clock_in'
         and candidate.effective_at <= selected.effective_at
         and candidate.effective_at >= selected.effective_at - interval '24 hours'
        group by membership.id
      ), expected as materialized (
        select event.id
        from effective_events event
        cross join rules
        left join session_candidates session on session.id = event.id
        where not event.voided
          and (coalesce(
            event.manual_clock_in_at,
            event.original_shift_starts_at,
            session.session_started_at,
            event.effective_at
          ) at time zone rules.time_zone)::date
            between target.from_date and target.through_date
      ), bounded as materialized (
        select event.id
        from rules
        cross join lateral private.get_effective_time_events_bounded(
          null,
          target.from_date::timestamp at time zone rules.time_zone,
          (target.through_date + 1)::timestamp at time zone rules.time_zone
        ) event
      )
      select 1
      from expected
      left join bounded on bounded.id = expected.id
      where bounded.id is null
    ) then
      raise exception 'Existing % review anchors were clipped by the bounded source.',
        target.case_name;
    end if;
  end loop;

  insert into public.employees (
    id, username, first_name, last_name, role, employment_type, status, time_zone
  ) values
    (long_session_employee_id, 'projectionlong2077', 'Long', 'Session', 'guard',
      'hourly', 'active', 'America/Denver'),
    (corrected_employee_id, 'projectioncorrected2077', 'Far', 'Correction', 'guard',
      'hourly', 'active', 'America/Denver'),
    (shifted_employee_id, 'projectionshift2077', 'Far', 'Shift', 'guard',
      'hourly', 'active', 'America/Denver'),
    (dst_employee_id, 'projectiondst2026', 'DST', 'Boundary', 'guard',
      'hourly', 'active', 'America/Denver');

  insert into public.sites (id, code, name, time_zone, active)
  values (site_id, 'BOUND-PROJ', 'Bounded Projection', 'America/Denver', true);
  insert into public.posts (id, site_id, name, requires_armed, active)
  values (post_id, site_id, 'Projection Post', false, true);
  insert into public.schedules (id, week_starts_on, revision, status, created_by)
  values (schedule_id, date '2077-10-31', 1, 'draft', actor_employee_id);
  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, created_by
  ) values (
    shifted_occurrence_id, schedule_id, post_id,
    timestamptz '2077-11-02 02:00:00+00',
    timestamptz '2077-11-02 10:00:00+00',
    'America/Denver', 1, actor_employee_id
  );

  -- A malformed unscheduled session exceeds 24 hours and never closes. The
  -- bounded source must retain the earlier clock-in so it remains incomplete;
  -- it must not invent a boundary or convert the break into worked time.
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (prior_close_id, long_session_employee_id, null, 'clock_out',
      timestamptz '2077-10-31 05:00:00+00', 'system',
      'projection-prior-close', actor_employee_id),
    (long_clock_in_id, long_session_employee_id, null, 'clock_in',
      timestamptz '2077-11-01 05:00:00+00', 'system',
      'projection-long-clock-in', actor_employee_id),
    (long_break_id, long_session_employee_id, null, 'break_start',
      timestamptz '2077-11-02 08:30:00+00', 'system',
      'projection-long-break', actor_employee_id);

  -- These source punches are years away. Approval moves their effective times
  -- into the requested range; only an effective-time projection can find them
  -- without scanning the immutable event history.
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (corrected_clock_in_id, corrected_employee_id, null, 'clock_in',
      timestamptz '2060-01-01 15:00:00+00', 'system',
      'projection-corrected-clock-in', actor_employee_id),
    (corrected_clock_out_id, corrected_employee_id, null, 'clock_out',
      timestamptz '2060-01-01 23:00:00+00', 'system',
      'projection-corrected-clock-out', actor_employee_id);

  insert into public.time_event_corrections (
    id, time_event_id, replacement_time, voided, reason, requested_by
  ) values
    (correction_clock_in_id, corrected_clock_in_id,
      timestamptz '2077-11-02 15:00:00+00', false,
      'Projection regression far-time correction.', actor_employee_id),
    (correction_clock_out_id, corrected_clock_out_id,
      timestamptz '2077-11-02 23:00:00+00', false,
      'Projection regression far-time correction.', actor_employee_id);

  update public.time_event_corrections
  set approved_by = actor_employee_id, approved_at = clock_timestamp()
  where id in (correction_clock_in_id, correction_clock_out_id);

  -- Explicit occurrence ownership can also move old punches into a current
  -- workday without changing their timestamps.
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (shifted_clock_in_id, shifted_employee_id, null, 'clock_in',
      timestamptz '2070-05-01 02:00:00+00', 'system',
      'projection-shifted-clock-in', actor_employee_id),
    (shifted_clock_out_id, shifted_employee_id, null, 'clock_out',
      timestamptz '2070-05-01 10:00:00+00', 'system',
      'projection-shifted-clock-out', actor_employee_id);

  insert into public.time_event_occurrence_overrides (
    time_event_id, original_shift_id, replacement_shift_id,
    reason, source, created_by
  ) values
    (shifted_clock_in_id, null, shifted_occurrence_id,
      'Projection regression far occurrence.', 'authorized_correction',
      actor_employee_id),
    (shifted_clock_out_id, null, shifted_occurrence_id,
      'Projection regression far occurrence.', 'authorized_correction',
      actor_employee_id);

  -- Repeated wall time during the Denver fall-back remains two distinct UTC
  -- instants. The resolver must preserve their sixty elapsed minutes.
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (dst_clock_in_id, dst_employee_id, null, 'clock_in',
      timestamptz '2026-11-01 01:30:00-06', 'system',
      'projection-dst-clock-in', actor_employee_id),
    (dst_clock_out_id, dst_employee_id, null, 'clock_out',
      timestamptz '2026-11-01 01:30:00-07', 'system',
      'projection-dst-clock-out', actor_employee_id);

  if (select projection.effective_at
      from private.timekeeping_effective_event_projection projection
      where projection.event_id = corrected_clock_in_id)
      is distinct from timestamptz '2077-11-02 15:00:00+00' then
    raise exception 'Correction approval did not refresh the indexed projection.';
  end if;

  select projection.source_fingerprint into strict fingerprint_before
  from private.timekeeping_effective_event_projection projection
  where projection.event_id = corrected_clock_in_id;
  perform private.refresh_timekeeping_effective_event_projection(corrected_clock_in_id);
  perform private.refresh_timekeeping_effective_event_projection(corrected_clock_in_id);
  select projection.source_fingerprint into strict fingerprint_after
  from private.timekeeping_effective_event_projection projection
  where projection.event_id = corrected_clock_in_id;
  if fingerprint_after is distinct from fingerprint_before then
    raise exception 'Projection refresh is not idempotent.';
  end if;

  -- Every bounded row must be byte-for-byte equivalent to the mature resolver
  -- for the same event ID. This checks corrections, occurrence inheritance,
  -- timestamps, flags, overrides, and assignment anchors together.
  if exists (
    select 1
    from private.get_effective_time_events_bounded(
      long_session_employee_id,
      timestamptz '2077-11-02 07:00:00+00',
      timestamptz '2077-11-03 07:00:00+00'
    ) bounded
    left join private.get_effective_time_events(long_session_employee_id) legacy
      on legacy.id = bounded.id
    where legacy.id is null or to_jsonb(legacy) is distinct from to_jsonb(bounded)
  ) then
    raise exception 'Long or incomplete session projection differs from the mature resolver.';
  end if;

  select count(*) into bounded_count
  from private.get_effective_time_events_bounded(
    long_session_employee_id,
    timestamptz '2077-11-02 07:00:00+00',
    timestamptz '2077-11-03 07:00:00+00'
  ) bounded
  where bounded.id in (long_clock_in_id, long_break_id);
  if bounded_count <> 2 then
    raise exception 'The >24-hour incomplete session lost its earlier boundary.';
  end if;

  if not exists (
    select 1
    from private.get_effective_time_events_bounded(
      corrected_employee_id,
      timestamptz '2077-11-02 07:00:00+00',
      timestamptz '2077-11-03 07:00:00+00'
    ) bounded
    where bounded.id = corrected_clock_in_id
      and bounded.effective_at = timestamptz '2077-11-02 15:00:00+00'
  ) then
    raise exception 'A far recorded-at correction was not selected by effective time.';
  end if;

  if exists (
    select 1
    from private.get_effective_time_events_bounded(
      shifted_employee_id,
      timestamptz '2077-11-01 06:00:00+00',
      timestamptz '2077-11-08 07:00:00+00'
    ) bounded
    left join private.get_effective_time_events(shifted_employee_id) legacy
      on legacy.id = bounded.id
    where legacy.id is null or to_jsonb(legacy) is distinct from to_jsonb(bounded)
  ) or not exists (
    select 1
    from private.get_effective_time_events_bounded(
      shifted_employee_id,
      timestamptz '2077-11-01 06:00:00+00',
      timestamptz '2077-11-08 07:00:00+00'
    ) bounded
    where bounded.id = shifted_clock_out_id
      and bounded.original_shift_id = shifted_occurrence_id
  ) then
    raise exception 'Far explicit occurrence ownership was clipped or changed.';
  end if;

  if exists (
    select 1
    from private.get_effective_time_events_bounded(
      dst_employee_id,
      timestamptz '2026-11-01 06:00:00+00',
      timestamptz '2026-11-02 07:00:00+00'
    ) bounded
    left join private.get_effective_time_events(dst_employee_id) legacy
      on legacy.id = bounded.id
    where legacy.id is null or to_jsonb(legacy) is distinct from to_jsonb(bounded)
  ) or (
    select extract(epoch from max(bounded.effective_at) - min(bounded.effective_at))
    from private.get_effective_time_events_bounded(
      dst_employee_id,
      timestamptz '2026-11-01 06:00:00+00',
      timestamptz '2026-11-02 07:00:00+00'
    ) bounded
  ) <> 3600 then
    raise exception 'DST fall-back elapsed-time identity changed.';
  end if;

  if (select count(*) from private.timekeeping_effective_event_projection projection
      where projection.event_id in (
        prior_close_id, long_clock_in_id, long_break_id,
        corrected_clock_in_id, corrected_clock_out_id,
        shifted_clock_in_id, shifted_clock_out_id,
        dst_clock_in_id, dst_clock_out_id
      )) <> 9 then
    raise exception 'Projection does not preserve one row per immutable punch.';
  end if;
end
$bounded_projection_regression$;

select jsonb_build_object(
  'status', 'passed',
  'projectionRows', (select count(*)
    from private.timekeeping_effective_event_projection),
  'sourceRows', (select count(*) from public.time_events)
) as bounded_effective_event_projection_regression;

rollback;
