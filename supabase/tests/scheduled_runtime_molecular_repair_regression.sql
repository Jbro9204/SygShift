begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $scheduled_runtime_structure_guard$
declare
  automation_function pg_catalog.pg_proc%rowtype;
  attendance_function pg_catalog.pg_proc%rowtype;
  automation_sql text;
  attendance_sql text;
  due_index text;
  event_index text;
begin
  select * into strict automation_function
  from pg_catalog.pg_proc
  where oid = 'public.service_run_timekeeping_automation(uuid)'::regprocedure;

  select * into strict attendance_function
  from pg_catalog.pg_proc
  where oid = 'private.refresh_attendance_alert_schedule_state(date,uuid,boolean)'::regprocedure;

  automation_sql := pg_get_functiondef(automation_function.oid);
  attendance_sql := pg_get_functiondef(attendance_function.oid);
  due_index := pg_get_indexdef('public.shifts_timekeeping_due_end_idx'::regclass);
  event_index := pg_get_indexdef('public.time_events_employee_shift_recorded_idx'::regclass);

  if due_index not like '%(ends_at, id)%'
     or due_index not like '%WHERE (canceled_at IS NULL)%' then
    raise exception 'Due-shift range index differs from the reviewed boundary: %', due_index;
  end if;

  if event_index not like '%(employee_id, shift_id, recorded_at DESC, id)%'
     or event_index not like '%WHERE (shift_id IS NOT NULL)%' then
    raise exception 'Employee-occurrence event index differs from the reviewed boundary: %', event_index;
  end if;

  if position('with due_shifts as materialized' in automation_sql) = 0
     or position('with due_missing_shifts as materialized' in automation_sql) = 0
     or position($marker$shift.ends_at >= statement_timestamp() - interval '7 days'$marker$ in automation_sql) = 0
     or position($marker$shift.starts_at >= statement_timestamp() - interval '7 days'$marker$ in automation_sql) = 0
     or position('occurrence_schedule.week_starts_on = schedule.week_starts_on' in automation_sql) = 0
     or position('occurrence_schedule.week_starts_on = target_schedule.week_starts_on' in automation_sql) = 0
     or pg_get_userbyid(automation_function.proowner) <> 'postgres'
     or not automation_function.prosecdef
     or automation_function.proconfig is distinct from array['search_path=""']::text[]
     or automation_function.proacl::text
       is distinct from '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception 'Bounded timekeeping automation security or behavior boundary is incorrect.';
  end if;

  if position($marker$set_config('plan_cache_mode', 'force_custom_plan', true)$marker$ in attendance_sql) = 0
     or pg_get_userbyid(attendance_function.proowner) <> 'postgres'
     or not attendance_function.prosecdef
     or attendance_function.proconfig is distinct from array['search_path=""']::text[]
     or attendance_function.proacl::text is distinct from '{postgres=X/postgres}' then
    raise exception 'Attendance custom-plan security or behavior boundary is incorrect.';
  end if;
end
$scheduled_runtime_structure_guard$;

-- Exercise the occurrence identity rules with deterministic fixtures instead
-- of relying on whichever revisions happen to exist in the preview dataset.
-- The corrected fixture intentionally has an original non-clock-in kind and
-- an effective clock-in kind: missing detection follows the effective kind,
-- while the existing resolver deliberately preserves its original-kind rule.
create temporary table scheduled_runtime_fixture_schedules (
  id uuid primary key,
  week_starts_on date not null
) on commit drop;

create temporary table scheduled_runtime_fixture_shifts (
  id uuid primary key,
  schedule_id uuid not null,
  post_id uuid,
  event_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null
) on commit drop;

create temporary table scheduled_runtime_fixture_events (
  id uuid primary key,
  employee_id uuid not null,
  shift_id uuid not null,
  kind text not null,
  effective_kind text not null,
  voided boolean not null
) on commit drop;

create temporary table scheduled_runtime_fixture_expectations (
  case_name text primary key,
  employee_id uuid not null,
  target_shift_id uuid not null,
  expected_missing_evidence boolean not null,
  expected_resolution_evidence boolean not null
) on commit drop;

insert into scheduled_runtime_fixture_schedules (id, week_starts_on)
values
  ('10000000-0000-0000-0000-000000000001', date '2026-10-25'),
  ('10000000-0000-0000-0000-000000000002', date '2026-10-25');

insert into scheduled_runtime_fixture_shifts (
  id,
  schedule_id,
  post_id,
  event_id,
  starts_at,
  ends_at
)
values
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    null,
    timestamptz '2026-10-26 08:00:00+00',
    timestamptz '2026-10-26 16:00:00+00'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002',
    null,
    timestamptz '2026-10-26 10:00:00+00',
    timestamptz '2026-10-26 18:00:00+00'
  ),
  (
    '20000000-0000-0000-0000-000000000102',
    '10000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000002',
    null,
    timestamptz '2026-10-26 10:00:00+00',
    timestamptz '2026-10-26 18:00:00+00'
  ),
  (
    '20000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000003',
    null,
    timestamptz '2026-10-26 12:00:00+00',
    timestamptz '2026-10-26 20:00:00+00'
  ),
  (
    '20000000-0000-0000-0000-000000000004',
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000004',
    null,
    timestamptz '2026-10-26 14:00:00+00',
    timestamptz '2026-10-26 22:00:00+00'
  );

insert into scheduled_runtime_fixture_events (
  id,
  employee_id,
  shift_id,
  kind,
  effective_kind,
  voided
)
values
  (
    '40000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'clock_in',
    'clock_in',
    false
  ),
  (
    '40000000-0000-0000-0000-000000000002',
    '50000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000102',
    'clock_in',
    'clock_in',
    false
  ),
  (
    '40000000-0000-0000-0000-000000000003',
    '50000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000003',
    'break_start',
    'clock_in',
    false
  ),
  (
    '40000000-0000-0000-0000-000000000004',
    '50000000-0000-0000-0000-000000000004',
    '20000000-0000-0000-0000-000000000004',
    'clock_in',
    'clock_in',
    true
  );

insert into scheduled_runtime_fixture_expectations (
  case_name,
  employee_id,
  target_shift_id,
  expected_missing_evidence,
  expected_resolution_evidence
)
values
  (
    'exact',
    '50000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    true,
    true
  ),
  (
    'revision_equivalent',
    '50000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000002',
    true,
    true
  ),
  (
    'corrected',
    '50000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000003',
    true,
    false
  ),
  (
    'voided',
    '50000000-0000-0000-0000-000000000004',
    '20000000-0000-0000-0000-000000000004',
    false,
    false
  );

do $synthetic_occurrence_parity$
begin
  if exists (
    with evaluated as (
      select
        expectation.*,
        exists (
          select 1
          from scheduled_runtime_fixture_events fixture_event
          where fixture_event.employee_id = expectation.employee_id
            and (
              fixture_event.shift_id = expectation.target_shift_id
              or exists (
                select 1
                from scheduled_runtime_fixture_shifts occurrence_shift
                join scheduled_runtime_fixture_shifts target_shift
                  on target_shift.id = expectation.target_shift_id
                join scheduled_runtime_fixture_schedules occurrence_schedule
                  on occurrence_schedule.id = occurrence_shift.schedule_id
                join scheduled_runtime_fixture_schedules target_schedule
                  on target_schedule.id = target_shift.schedule_id
                where occurrence_shift.id = fixture_event.shift_id
                  and occurrence_shift.schedule_id <> target_shift.schedule_id
                  and occurrence_schedule.week_starts_on = target_schedule.week_starts_on
                  and occurrence_shift.post_id is not distinct from target_shift.post_id
                  and occurrence_shift.event_id is not distinct from target_shift.event_id
                  and occurrence_shift.starts_at = target_shift.starts_at
                  and occurrence_shift.ends_at = target_shift.ends_at
              )
            )
            and fixture_event.effective_kind = 'clock_in'
            and not fixture_event.voided
        ) as baseline_missing_evidence,
        exists (
          select 1
          from scheduled_runtime_fixture_shifts target_shift
          join scheduled_runtime_fixture_schedules target_schedule
            on target_schedule.id = target_shift.schedule_id
          join scheduled_runtime_fixture_shifts occurrence_shift on true
          join scheduled_runtime_fixture_schedules occurrence_schedule
            on occurrence_schedule.id = occurrence_shift.schedule_id
          join scheduled_runtime_fixture_events fixture_event
            on fixture_event.employee_id = expectation.employee_id
           and fixture_event.shift_id = occurrence_shift.id
          where target_shift.id = expectation.target_shift_id
            and (
              occurrence_shift.id = target_shift.id
              or (
                occurrence_shift.schedule_id <> target_shift.schedule_id
                and occurrence_schedule.week_starts_on = target_schedule.week_starts_on
                and occurrence_shift.post_id is not distinct from target_shift.post_id
                and occurrence_shift.event_id is not distinct from target_shift.event_id
                and occurrence_shift.starts_at = target_shift.starts_at
                and occurrence_shift.ends_at = target_shift.ends_at
              )
            )
            and fixture_event.effective_kind = 'clock_in'
            and not fixture_event.voided
        ) as repaired_missing_evidence,
        exists (
          select 1
          from scheduled_runtime_fixture_events fixture_event
          where fixture_event.employee_id = expectation.employee_id
            and (
              fixture_event.shift_id = expectation.target_shift_id
              or exists (
                select 1
                from scheduled_runtime_fixture_shifts occurrence_shift
                join scheduled_runtime_fixture_shifts target_shift
                  on target_shift.id = expectation.target_shift_id
                join scheduled_runtime_fixture_schedules occurrence_schedule
                  on occurrence_schedule.id = occurrence_shift.schedule_id
                join scheduled_runtime_fixture_schedules target_schedule
                  on target_schedule.id = target_shift.schedule_id
                where occurrence_shift.id = fixture_event.shift_id
                  and occurrence_shift.schedule_id <> target_shift.schedule_id
                  and occurrence_schedule.week_starts_on = target_schedule.week_starts_on
                  and occurrence_shift.post_id is not distinct from target_shift.post_id
                  and occurrence_shift.event_id is not distinct from target_shift.event_id
                  and occurrence_shift.starts_at = target_shift.starts_at
                  and occurrence_shift.ends_at = target_shift.ends_at
              )
            )
            and fixture_event.kind = 'clock_in'
            and not fixture_event.voided
        ) as baseline_resolution_evidence,
        exists (
          select 1
          from scheduled_runtime_fixture_shifts target_shift
          join scheduled_runtime_fixture_schedules target_schedule
            on target_schedule.id = target_shift.schedule_id
          join scheduled_runtime_fixture_shifts occurrence_shift on true
          join scheduled_runtime_fixture_schedules occurrence_schedule
            on occurrence_schedule.id = occurrence_shift.schedule_id
          join scheduled_runtime_fixture_events fixture_event
            on fixture_event.employee_id = expectation.employee_id
           and fixture_event.shift_id = occurrence_shift.id
          where target_shift.id = expectation.target_shift_id
            and (
              occurrence_shift.id = target_shift.id
              or (
                occurrence_shift.schedule_id <> target_shift.schedule_id
                and occurrence_schedule.week_starts_on = target_schedule.week_starts_on
                and occurrence_shift.post_id is not distinct from target_shift.post_id
                and occurrence_shift.event_id is not distinct from target_shift.event_id
                and occurrence_shift.starts_at = target_shift.starts_at
                and occurrence_shift.ends_at = target_shift.ends_at
              )
            )
            and fixture_event.kind = 'clock_in'
            and not fixture_event.voided
        ) as repaired_resolution_evidence
      from scheduled_runtime_fixture_expectations expectation
    )
    select 1
    from evaluated
    where baseline_missing_evidence is distinct from repaired_missing_evidence
       or repaired_missing_evidence is distinct from expected_missing_evidence
       or baseline_resolution_evidence is distinct from repaired_resolution_evidence
       or repaired_resolution_evidence is distinct from expected_resolution_evidence
  ) then
    raise exception 'Synthetic exact/revision/corrected/voided occurrence parity failed.';
  end if;
end
$synthetic_occurrence_parity$;

-- Prove that range-first materialization selects the same automatic-clock-out
-- assignment set as the verified pre-repair query. This is read-only and does
-- not substitute scheduled time for effective punches.
do $automatic_candidate_parity$
declare
  automatic_grace integer :=
    private.timekeeping_setting_integer('timekeeping.automatic_clock_out_grace_minutes', 3);
begin
  if exists (
    with baseline as (
      select assignment.id
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      join public.schedules schedule
        on schedule.id = shift.schedule_id
       and schedule.status in ('published', 'superseded')
      join public.employees employee
        on employee.id = assignment.employee_id
       and employee.status = 'active'
      left join lateral (
        select event.id, event.kind, effective.effective_at
        from public.time_events event
        cross join lateral private.current_effective_time_event(event.id) effective
        where event.employee_id = assignment.employee_id
          and event.shift_id = shift.id
          and not effective.voided
        order by effective.effective_at desc, event.recorded_at desc, event.id desc
        limit 1
      ) latest on true
      where assignment.status in ('assigned', 'confirmed')
        and shift.canceled_at is null
        and shift.ends_at + make_interval(mins => automatic_grace) <= statement_timestamp()
        and shift.ends_at >= statement_timestamp() - interval '7 days'
        and latest.kind in ('clock_in', 'break_start', 'break_end')
        and latest.effective_at <= shift.ends_at
    ), due_shifts as materialized (
      select shift.id, shift.schedule_id, shift.ends_at
      from public.shifts shift
      where shift.canceled_at is null
        and shift.ends_at >= statement_timestamp() - interval '7 days'
        and shift.ends_at <= statement_timestamp() - make_interval(mins => automatic_grace)
    ), repaired as (
      select assignment.id
      from due_shifts shift
      join public.shift_assignments assignment on assignment.shift_id = shift.id
      join public.schedules schedule
        on schedule.id = shift.schedule_id
       and schedule.status in ('published', 'superseded')
      join public.employees employee
        on employee.id = assignment.employee_id
       and employee.status = 'active'
      left join lateral (
        select event.id, event.kind, effective.effective_at
        from public.time_events event
        cross join lateral private.current_effective_time_event(event.id) effective
        where event.employee_id = assignment.employee_id
          and event.shift_id = shift.id
          and not effective.voided
        order by effective.effective_at desc, event.recorded_at desc, event.id desc
        limit 1
      ) latest on true
      where assignment.status in ('assigned', 'confirmed')
        and latest.kind in ('clock_in', 'break_start', 'break_end')
        and latest.effective_at <= shift.ends_at
    ), difference as (
      (select id from baseline except select id from repaired)
      union all
      (select id from repaired except select id from baseline)
    )
    select 1 from difference
  ) then
    raise exception 'Range-first automatic-clock-out candidates differ from the verified baseline.';
  end if;
end
$automatic_candidate_parity$;

-- Prove the same set parity for missing-clock-in detection, including the
-- revision-aware effective-punch rule introduced for historical schedules.
do $missing_candidate_parity$
declare
  clock_in_grace integer :=
    private.timekeeping_setting_integer('timekeeping.missing_clock_in_grace_minutes', 15);
begin
  if exists (
    with baseline as (
      select assignment.employee_id, shift.id as shift_id
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      join public.schedules schedule
        on schedule.id = shift.schedule_id
       and schedule.status = 'published'
      join public.employees employee
        on employee.id = assignment.employee_id
       and employee.status = 'active'
      where assignment.status in ('assigned', 'confirmed')
        and shift.canceled_at is null
        and shift.starts_at + make_interval(mins => clock_in_grace) <= statement_timestamp()
        and shift.starts_at >= statement_timestamp() - interval '7 days'
        and not exists (
          select 1
          from public.time_events event
          cross join lateral private.current_effective_time_event(event.id) effective
          where event.employee_id = assignment.employee_id
            and private.same_scheduled_occurrence(event.shift_id, shift.id)
            and private.current_effective_time_event_kind(event.id) = 'clock_in'
            and not effective.voided
        )
        and not exists (
          select 1
          from public.call_off_reports report
          where report.employee_id = assignment.employee_id
            and report.shift_id = shift.id
            and report.canceled_at is null
        )
    ), due_missing_shifts as materialized (
      select
        shift.id,
        shift.schedule_id,
        shift.starts_at,
        shift.ends_at,
        shift.post_id,
        shift.event_id
      from public.shifts shift
      where shift.canceled_at is null
        and shift.starts_at >= statement_timestamp() - interval '7 days'
        and shift.starts_at <= statement_timestamp() - make_interval(mins => clock_in_grace)
    ), repaired as (
      select assignment.employee_id, shift.id as shift_id
      from due_missing_shifts shift
      join public.shift_assignments assignment on assignment.shift_id = shift.id
      join public.schedules schedule
        on schedule.id = shift.schedule_id
       and schedule.status = 'published'
      join public.employees employee
        on employee.id = assignment.employee_id
       and employee.status = 'active'
      where assignment.status in ('assigned', 'confirmed')
        and not exists (
          select 1
          from public.shifts occurrence_shift
          join public.schedules occurrence_schedule
            on occurrence_schedule.id = occurrence_shift.schedule_id
          join public.time_events event
            on event.employee_id = assignment.employee_id
           and event.shift_id = occurrence_shift.id
          cross join lateral private.current_effective_time_event(event.id) effective
          where (
            occurrence_shift.id = shift.id
            or (
              occurrence_shift.schedule_id <> shift.schedule_id
              and occurrence_schedule.week_starts_on = schedule.week_starts_on
              and occurrence_shift.post_id is not distinct from shift.post_id
              and occurrence_shift.event_id is not distinct from shift.event_id
              and occurrence_shift.starts_at = shift.starts_at
              and occurrence_shift.ends_at = shift.ends_at
            )
          )
            and private.current_effective_time_event_kind(event.id) = 'clock_in'
            and not effective.voided
        )
        and not exists (
          select 1
          from public.call_off_reports report
          where report.employee_id = assignment.employee_id
            and report.shift_id = shift.id
            and report.canceled_at is null
        )
    ), difference as (
      (select employee_id, shift_id from baseline except select employee_id, shift_id from repaired)
      union all
      (select employee_id, shift_id from repaired except select employee_id, shift_id from baseline)
    )
    select 1 from difference
  ) then
    raise exception 'Range-first missing-clock-in candidates differ from the verified baseline.';
  end if;
end
$missing_candidate_parity$;

-- The resolver uses the same revision identity but intentionally preserves its
-- existing original-kind rule. Compare the inline join with the installed
-- helper for every unresolved missing-clock occurrence before exercising any
-- mutating service boundary.
do $resolution_evidence_parity$
begin
  if exists (
    select 1
    from public.timekeeping_operational_exceptions exception
    join public.shifts shift on shift.id = exception.shift_id
    where exception.exception_code = 'missing_clock_in'
      and exception.status = 'unresolved'
      and exists (
        select 1
        from public.time_events event
        cross join lateral private.current_effective_time_event(event.id) effective
        where private.same_scheduled_occurrence(event.shift_id, exception.shift_id)
          and event.employee_id = exception.employee_id
          and event.kind = 'clock_in'
          and not effective.voided
      ) is distinct from exists (
        select 1
        from public.schedules target_schedule
        join public.shifts occurrence_shift on true
        join public.schedules occurrence_schedule
          on occurrence_schedule.id = occurrence_shift.schedule_id
        join public.time_events event
          on event.employee_id = exception.employee_id
         and event.shift_id = occurrence_shift.id
        cross join lateral private.current_effective_time_event(event.id) effective
        where target_schedule.id = shift.schedule_id
          and (
            occurrence_shift.id = shift.id
            or (
              occurrence_shift.schedule_id <> shift.schedule_id
              and occurrence_schedule.week_starts_on = target_schedule.week_starts_on
              and occurrence_shift.post_id is not distinct from shift.post_id
              and occurrence_shift.event_id is not distinct from shift.event_id
              and occurrence_shift.starts_at = shift.starts_at
              and occurrence_shift.ends_at = shift.ends_at
            )
          )
          and event.kind = 'clock_in'
          and not effective.voided
      )
  ) then
    raise exception 'Inline resolver occurrence evidence differs from the verified helper.';
  end if;
end
$resolution_evidence_parity$;

-- Exercise the public idempotency boundary inside this rollback-only
-- transaction. A retry of the same job identifier must be reported as a
-- duplicate and may not run the candidate mutations twice.
do $automation_idempotency$
declare
  job_id uuid := gen_random_uuid();
  first_result jsonb;
  retry_result jsonb;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  first_result := public.service_run_timekeeping_automation(job_id);
  retry_result := public.service_run_timekeeping_automation(job_id);

  if first_result ->> 'status' not in ('completed', 'skipped')
     or retry_result ->> 'status' <> 'duplicate'
     or (select count(*) from private.timekeeping_job_runs where id = job_id) <> 1 then
    raise exception 'Scheduled automation idempotency boundary failed: first %, retry %',
      first_result, retry_result;
  end if;
end
$automation_idempotency$;

rollback;
