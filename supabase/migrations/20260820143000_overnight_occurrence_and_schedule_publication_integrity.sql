begin;

-- A work occurrence must remain stable when an authorized user corrects its
-- Site/Post. Use the original clocking relationship (or the manual/session
-- relationship for originally unlinked punches) as the occurrence identity.
-- The latest Site/Post override can still supply the displayed/payroll location.
create or replace function private.get_timekeeping_occurrence_key(
  target_event_id uuid,
  target_employee_id uuid,
  target_shift_id uuid,
  target_effective_at timestamptz,
  target_time_zone text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
select case
  when manual.id is not null then 'manual:' || manual.id::text || ':employee:' || target_employee_id::text
  when source_event.shift_id is not null then 'shift:' || source_event.shift_id::text || ':employee:' || target_employee_id::text
  when session.session_event_id is not null then 'unscheduled-session:' || session.session_event_id::text || ':employee:' || target_employee_id::text
  when target_effective_at is not null
    then 'unscheduled:' || target_employee_id::text || ':' || (target_effective_at at time zone target_time_zone)::date::text
  else 'unresolved-event:' || target_event_id::text || ':employee:' || target_employee_id::text
end
from (select 1) seed
left join lateral (
  select event.shift_id
  from public.time_events event
  where event.id = target_event_id
) source_event on true
left join lateral (
  select entry.id
  from public.manual_time_entries entry
  where target_event_id in (entry.clock_in_event_id, entry.clock_out_event_id)
  order by entry.created_at desc, entry.id desc
  limit 1
) manual on true
left join lateral (
  select occurrence.session_event_id
  from private.get_unscheduled_time_session_start(
    target_event_id,
    target_employee_id,
    target_effective_at
  ) occurrence
  where source_event.shift_id is null
    and manual.id is null
) session on true
$$;

-- Payroll-week assignment follows the same immutable occurrence identity. A
-- later Site/Post correction must not move one half of an overnight session to
-- another day or payroll week.
create or replace function private.get_payroll_assignment_anchor(
  target_shift_id uuid,
  target_event_id uuid,
  fallback_clock_in timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
select coalesce(
  manual.clock_in_at,
  case when source_event.shift_id is not null then source_shift.starts_at end,
  session.session_started_at,
  fallback_clock_in
)
from (select 1) seed
left join lateral (
  select event.employee_id, event.shift_id
  from public.time_events event
  where event.id = target_event_id
) source_event on true
left join public.shifts source_shift on source_shift.id = source_event.shift_id
left join lateral (
  select entry.id, entry.clock_in_at
  from public.manual_time_entries entry
  where target_event_id in (entry.clock_in_event_id, entry.clock_out_event_id)
  order by entry.created_at desc, entry.id desc
  limit 1
) manual on true
left join lateral (
  select occurrence.session_started_at
  from private.get_unscheduled_time_session_start(
    target_event_id,
    source_event.employee_id,
    fallback_clock_in
  ) occurrence
  where source_event.shift_id is null
    and manual.id is null
) session on true
$$;

-- The base review previously grouped by both occurrence key and the mutable
-- corrected shift id. That could split one session after Site/Post maintenance.
-- Keep one group and use the latest non-null corrected shift for presentation.
do $patch_timekeeping_grouping$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef('private.get_timekeeping_review_base(date,date)'::regprocedure)
  into function_sql;

  updated_sql := replace(
    function_sql,
    E'      event.shift_id,\n      event.group_key,',
    E'      (array_remove(array_agg(event.shift_id order by event.effective_at, event.recorded_at, event.id), null))[1] as shift_id,\n      event.group_key,'
  );
  updated_sql := replace(
    updated_sql,
    'group by event.employee_id, event.shift_id, event.group_key',
    'group by event.employee_id, event.group_key'
  );

  if updated_sql = function_sql
    or position('array_remove(array_agg(event.shift_id order by event.effective_at' in updated_sql) = 0
    or position('group by event.employee_id, event.shift_id, event.group_key' in updated_sql) > 0
  then
    raise check_violation using message = 'The authoritative timekeeping occurrence grouping could not be updated safely.';
  end if;

  execute updated_sql;
end
$patch_timekeeping_grouping$;

-- Exception detail must load the same full occurrence as the payroll row. The
-- first clock-in identifies the occurrence; calendar midnight does not split it.
do $patch_timekeeping_occurrence_context$
declare
  function_sql text;
  updated_sql text;
  scoped_events_start integer;
  ordered_events_start integer;
  new_scope text := $scope$scoped_events as (
  select event.*
  from effective_events event
where not event.voided
    and (
      (
        target_first_clock_in is not null
        and private.get_timekeeping_occurrence_key(
          event.id,
          event.employee_id,
          event.shift_id,
          event.effective_at,
          'America/Denver'
        ) = (
          select private.get_timekeeping_occurrence_key(
            anchor.id,
            anchor.employee_id,
            anchor.shift_id,
            anchor.effective_at,
            'America/Denver'
          )
          from effective_events anchor
          where anchor.kind = 'clock_in'
            and anchor.effective_at = target_first_clock_in
          order by anchor.recorded_at, anchor.id
          limit 1
        )
      )
      or (
        target_first_clock_in is null
        and (
          (target_shift_id is not null and event.shift_id = target_shift_id)
          or (
            target_shift_id is null
            and event.shift_id is null
            and (event.effective_at at time zone 'America/Denver')::date = target_operational_date
          )
        )
      )
    )
),
$scope$;
begin
  select pg_get_functiondef(
    'private.get_timekeeping_occurrence_context(uuid,uuid,date,timestamptz)'::regprocedure
  ) into function_sql;

  scoped_events_start := position('scoped_events as (' in function_sql);
  ordered_events_start := position('ordered_events as (' in function_sql);

  if scoped_events_start = 0 or ordered_events_start <= scoped_events_start then
    raise check_violation using message = 'The overnight exception occurrence context boundaries could not be found safely.';
  end if;

  updated_sql := substring(function_sql from 1 for scoped_events_start - 1)
    || new_scope
    || substring(function_sql from ordered_events_start);

  if updated_sql = function_sql
    or position('target_first_clock_in is not null' in updated_sql) = 0
    or position('private.get_timekeeping_occurrence_key(' in updated_sql) = 0
  then
    raise check_violation using message = 'The overnight exception occurrence context could not be updated safely.';
  end if;

  execute updated_sql;
end
$patch_timekeeping_occurrence_context$;

-- Retain every revision, but allow only the newest published revision for each
-- week to remain operationally active. Older revisions become audit history.
with ranked_published as (
  select
    schedule.id,
    row_number() over (
      partition by schedule.week_starts_on
      order by schedule.revision desc, schedule.published_at desc nulls last, schedule.updated_at desc, schedule.id desc
    ) as publication_rank
  from public.schedules schedule
  where schedule.status = 'published'
)
update public.schedules schedule
set
  status = 'superseded',
  updated_at = clock_timestamp()
from ranked_published ranked
where ranked.id = schedule.id
  and ranked.publication_rank > 1;

create unique index if not exists schedules_one_published_week_unique
  on public.schedules (week_starts_on)
  where status = 'published';

-- Future full-week publishes supersede every older published revision, even if
-- historical data already contains more than one.
do $patch_full_schedule_publish$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef('public.publish_schedule_draft(uuid)'::regprocedure)
  into function_sql;
  updated_sql := replace(
    function_sql,
    'where schedule.id = latest_published.id;',
    E'where schedule.week_starts_on = draft_schedule.week_starts_on\n      and schedule.status = ''published''\n      and schedule.id <> target_schedule_id;'
  );

  if updated_sql = function_sql
    or position('schedule.id <> target_schedule_id' in updated_sql) = 0
  then
    raise check_violation using message = 'The full schedule publication integrity rule could not be installed.';
  end if;

  execute updated_sql;
end
$patch_full_schedule_publish$;

-- Employee-scoped publishes also supersede every prior publication after the
-- new full snapshot has been assembled.
do $patch_employee_schedule_publish$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef('public.publish_employee_schedule_slice(uuid,uuid)'::regprocedure)
  into function_sql;
  updated_sql := replace(
    function_sql,
    'where schedule.id = latest_published.id;',
    E'where schedule.week_starts_on = draft_schedule.week_starts_on\n      and schedule.status = ''published''\n      and schedule.id <> scoped_published_schedule_id;'
  );

  if updated_sql = function_sql
    or position('schedule.id <> scoped_published_schedule_id' in updated_sql) = 0
  then
    raise check_violation using message = 'The employee schedule publication integrity rule could not be installed.';
  end if;

  execute updated_sql;
end
$patch_employee_schedule_publish$;

-- Defense in depth: Attendance Review always reads only the newest published
-- revision for a week, even before or during a future repair operation.
do $patch_attendance_review_publication_scope$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef('public.get_daily_attendance_review(date,date,boolean)'::regprocedure)
  into function_sql;

  if position('newer_schedule.week_starts_on = schedule.week_starts_on' in function_sql) = 0 then
    updated_sql := replace(
      function_sql,
      E'    where schedule.status = ''published''\n      and shift.canceled_at is null',
      E'    where schedule.status = ''published''\n      and not exists (\n        select 1\n        from public.schedules newer_schedule\n        where newer_schedule.week_starts_on = schedule.week_starts_on\n          and newer_schedule.status = ''published''\n          and newer_schedule.revision > schedule.revision\n      )\n      and shift.canceled_at is null'
    );
  else
    updated_sql := function_sql;
  end if;

  if position('newer_schedule.week_starts_on = schedule.week_starts_on' in updated_sql) = 0 then
    raise check_violation using message = 'Attendance Review could not be restricted to the authoritative published revision.';
  end if;

  execute updated_sql;
end
$patch_attendance_review_publication_scope$;

-- Add scheduled minutes to the existing team summary so Time Maintenance can
-- show a simple, authoritative Scheduled vs Worked total for one employee.
do $patch_team_attendance_scheduled_minutes$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef('public.get_team_attendance_summary(date,date)'::regprocedure)
  into function_sql;

  updated_sql := replace(
    function_sql,
    'count(distinct scheduled_rows.shift_id)::integer as scheduled_shift_count',
    E'count(distinct scheduled_rows.shift_id)::integer as scheduled_shift_count,\n      coalesce(sum(greatest(0, extract(epoch from (scheduled_rows.ends_at - scheduled_rows.starts_at)) / 60)), 0)::integer as scheduled_minutes'
  );
  updated_sql := replace(
    updated_sql,
    E'''scheduledShiftCount'', coalesce(scheduled_count.scheduled_shift_count, 0),\n    ''scheduledStartsAt''',
    E'''scheduledShiftCount'', coalesce(scheduled_count.scheduled_shift_count, 0),\n    ''scheduledMinutes'', coalesce(scheduled_count.scheduled_minutes, 0),\n    ''scheduledStartsAt'''
  );

  if updated_sql = function_sql
    or position('as scheduled_minutes' in updated_sql) = 0
    or position('''scheduledMinutes''' in updated_sql) = 0
  then
    raise check_violation using message = 'Scheduled minutes could not be added to the Time Maintenance summary safely.';
  end if;

  execute updated_sql;
end
$patch_team_attendance_scheduled_minutes$;

revoke all on function private.get_timekeeping_occurrence_key(uuid,uuid,uuid,timestamptz,text) from public, anon, authenticated;
revoke all on function private.get_payroll_assignment_anchor(uuid,uuid,timestamptz) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
