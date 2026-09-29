begin;

set local lock_timeout = '5s';

-- Salaried shift presence is deliberately separate from timekeeping. It records
-- only an affirmative manager-reviewed Worked marker for one scheduled shift.
-- It does not create punches, calculate duration, affect payroll, or mutate the
-- schedule assignment that anchors the record.
insert into public.permission_catalog (
  code, category, name, description, risk_level, requires_mfa, locked, active
)
values (
  'schedule.salary_shifts.manage',
  'Schedule',
  'Manage salaried shift presence',
  'Review scheduled salaried shifts and record or remove an audited Worked marker without creating timekeeping or payroll data.',
  'sensitive',
  true,
  true,
  true
)
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = excluded.active,
    updated_at = clock_timestamp();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, 'schedule.salary_shifts.manage', true
from public.access_roles access_role
where access_role.code in (
  'system_scheduler',
  'system_supervisor',
  'operations_manager',
  'human_resources',
  'system_admin'
)
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

-- Every accepted mutation, including a semantic no-op, receives an immutable
-- receipt. A delayed network retry can therefore never become a new mutation
-- after some later manager action changes the marker state.
create table private.salaried_shift_presence_requests (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  -- Keep the exact caller-supplied ID for replay matching without pinning a
  -- disposable draft assignment that normal scheduler cleanup may remove.
  requested_assignment_id uuid not null,
  canonical_assignment_id uuid not null references public.shift_assignments(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  requested_outcome text not null check (requested_outcome in ('worked', 'unconfirmed')),
  normalized_note text,
  result_presence_status text not null check (result_presence_status in ('worked', 'unconfirmed')),
  result_worked_at timestamptz,
  result_updated_at timestamptz not null,
  result_action text not null check (result_action in ('recorded', 'corrected', 'voided', 'unchanged')),
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint salaried_shift_presence_request_note_length check (
    normalized_note is null or char_length(normalized_note) between 1 and 2000
  ),
  constraint salaried_shift_presence_request_worked_time check (
    (result_presence_status = 'worked' and result_worked_at is not null)
    or (result_presence_status = 'unconfirmed' and result_worked_at is null)
  )
);

create index salaried_shift_presence_requests_assignment_idx
  on private.salaried_shift_presence_requests(canonical_assignment_id, created_at desc);

alter table private.salaried_shift_presence_requests enable row level security;
alter table private.salaried_shift_presence_requests force row level security;

revoke all on table private.salaried_shift_presence_requests from public, anon, authenticated;

create table private.salaried_shift_presence_events (
  id uuid primary key default gen_random_uuid(),
  shift_assignment_id uuid not null references public.shift_assignments(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  action text not null check (action in ('worked', 'voided')),
  note text,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  request_id uuid not null unique,
  result_action text not null check (result_action in ('recorded', 'corrected', 'voided')),
  created_at timestamptz not null default clock_timestamp(),
  constraint salaried_shift_presence_note_length check (
    note is null or char_length(btrim(note)) between 1 and 2000
  ),
  constraint salaried_shift_presence_void_reason check (
    action <> 'voided' or char_length(btrim(coalesce(note, ''))) between 8 and 2000
  ),
  constraint salaried_shift_presence_result_action check (
    (action = 'voided' and result_action = 'voided')
    or (action = 'worked' and result_action in ('recorded', 'corrected'))
  )
);

create index salaried_shift_presence_assignment_history_idx
  on private.salaried_shift_presence_events(shift_assignment_id, created_at desc, id desc);

create index salaried_shift_presence_employee_history_idx
  on private.salaried_shift_presence_events(employee_id, created_at desc, id desc);

alter table private.salaried_shift_presence_events enable row level security;
alter table private.salaried_shift_presence_events force row level security;

revoke all on table private.salaried_shift_presence_events from public, anon, authenticated;

create or replace function private.validate_salaried_shift_presence_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  assigned_employee_id uuid;
begin
  select assignment.employee_id
    into assigned_employee_id
  from public.shift_assignments assignment
  where assignment.id = new.shift_assignment_id;

  if assigned_employee_id is null then
    raise foreign_key_violation using message = 'The selected shift assignment does not exist.';
  end if;

  if assigned_employee_id is distinct from new.employee_id then
    raise check_violation using message = 'The salaried shift marker employee must match the selected assignment.';
  end if;

  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end
$$;

create trigger salaried_shift_presence_events_validate
before insert on private.salaried_shift_presence_events
for each row execute function private.validate_salaried_shift_presence_event();

create trigger salaried_shift_presence_requests_append_only
before update or delete on private.salaried_shift_presence_requests
for each row execute function private.prevent_append_only_change();

create trigger salaried_shift_presence_requests_audit
after insert on private.salaried_shift_presence_requests
for each row execute function private.write_audit_event();

create trigger salaried_shift_presence_events_append_only
before update or delete on private.salaried_shift_presence_events
for each row execute function private.prevent_append_only_change();

create trigger salaried_shift_presence_events_audit
after insert on private.salaried_shift_presence_events
for each row execute function private.write_audit_event();

revoke all on function private.validate_salaried_shift_presence_event()
  from public, anon, authenticated;

-- Revision IDs change when a schedule is republished. Presence follows only an
-- exact occurrence for the same employee in the same schedule week. Exact UTC
-- bounds plus the same post/event prevent a copied week from inheriting a mark.
create or replace function private.salaried_shift_equivalent_assignments(
  target_assignment_id uuid
)
returns table(assignment_id uuid, shift_id uuid, schedule_status public.schedule_status)
language sql
stable
security definer
set search_path = ''
as $$
  select candidate_assignment.id, candidate_shift.id, candidate_schedule.status
  from public.shift_assignments target_assignment
  join public.shifts target_shift on target_shift.id = target_assignment.shift_id
  join public.schedules target_schedule on target_schedule.id = target_shift.schedule_id
  join public.shift_assignments candidate_assignment
    on candidate_assignment.employee_id = target_assignment.employee_id
   and candidate_assignment.status in ('assigned', 'confirmed', 'completed')
   and candidate_assignment.canceled_at is null
  join public.shifts candidate_shift on candidate_shift.id = candidate_assignment.shift_id
  join public.schedules candidate_schedule on candidate_schedule.id = candidate_shift.schedule_id
  where target_assignment.id = target_assignment_id
    and candidate_schedule.week_starts_on = target_schedule.week_starts_on
    and candidate_shift.canceled_at is null
    and candidate_shift.starts_at = target_shift.starts_at
    and candidate_shift.ends_at = target_shift.ends_at
    and candidate_shift.post_id is not distinct from target_shift.post_id
    and candidate_shift.event_id is not distinct from target_shift.event_id
    and private.shift_assignment_type(target_shift.id) <> 'dispatch_phone_duty'
    and private.shift_assignment_type(candidate_shift.id) <> 'dispatch_phone_duty'
$$;

revoke all on function private.salaried_shift_equivalent_assignments(uuid)
  from public, anon, authenticated;

create or replace function private.salaried_shift_assignment_is_absent(
  target_assignment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.shift_assignments target_assignment
    where target_assignment.id = target_assignment_id
      and (
        exists (
          select 1
          from public.call_off_reports report
          where report.employee_id = target_assignment.employee_id
            and report.canceled_at is null
            and private.same_scheduled_occurrence(report.shift_id, target_assignment.shift_id)
        )
        or exists (
          select 1
          from public.shift_coverage_cases coverage
          where coverage.absent_employee_id = target_assignment.employee_id
            and coverage.status <> 'canceled'
            and private.same_scheduled_occurrence(coverage.source_shift_id, target_assignment.shift_id)
        )
      )
  ), false)
$$;

revoke all on function private.salaried_shift_assignment_is_absent(uuid)
  from public, anon, authenticated;

create or replace function private.salaried_shift_assignment_has_approved_time_off(
  target_assignment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.employees employee on employee.id = assignment.employee_id
    join public.time_off_requests request
      on request.employee_id = assignment.employee_id
     and request.status = 'approved'
    where assignment.id = target_assignment_id
      and private.time_off_window(
        request.starts_on,
        request.ends_on,
        request.partial_day_start,
        request.partial_day_end,
        employee.time_zone
      ) && tstzrange(shift.starts_at, shift.ends_at, '[)')
  ), false)
$$;

revoke all on function private.salaried_shift_assignment_has_approved_time_off(uuid)
  from public, anon, authenticated;

create or replace function public.get_salaried_shift_workspace(
  range_starts_on date default null,
  range_ends_on date default null,
  requested_employee_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_record public.employees%rowtype;
  local_today date;
  target_starts_on date;
  target_ends_on date;
begin
  if actor_id is null
    or not public.has_effective_permission('schedule.salary_shifts.manage')
  then
    raise insufficient_privilege using message = 'MFA-verified salaried shift access is required.';
  end if;

  select employee.* into actor_record
  from public.employees employee
  where employee.id = actor_id;

  if actor_record.id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  local_today := (clock_timestamp() at time zone actor_record.time_zone)::date;
  target_starts_on := coalesce(range_starts_on, local_today - 30);
  target_ends_on := coalesce(range_ends_on, local_today);

  if target_ends_on < target_starts_on then
    raise check_violation using message = 'The end date must be on or after the start date.';
  end if;
  if target_ends_on - target_starts_on > 92 then
    raise check_violation using message = 'Choose a date range of 93 days or fewer.';
  end if;
  if requested_employee_id is not null and not exists (
    select 1
    from public.employees employee
    where employee.id = requested_employee_id
      and employee.employment_type = 'salary'
  ) then
    raise check_violation using message = 'Choose a salaried employee.';
  end if;

  return (
    with current_assignments as (
      select distinct on (
        assignment.employee_id,
        schedule.week_starts_on,
        shift.post_id,
        shift.event_id,
        shift.starts_at,
        shift.ends_at
      )
        assignment.id as assignment_id,
        assignment.employee_id,
        assignment.status as assignment_status,
        assignment.updated_at as assignment_updated_at,
        shift.id as shift_id,
        shift.starts_at,
        shift.ends_at,
        shift.time_zone as shift_time_zone,
        schedule.week_starts_on,
        schedule.status as schedule_status,
        employee.employee_number,
        btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name) as employee_name,
        employee.time_zone as employee_time_zone,
        post_site.code as site_code,
        coalesce(post_site.name, event_site.name) as site_name,
        post.name as post_name,
        event.name as event_name,
        coalesce(post_site.name, event_site.name, event.location_name, 'Location pending') as location,
        case
          when coalesce(post_site.supports_dispatch_phone_duty, event_site.supports_dispatch_phone_duty, false)
            then 'dispatch_primary'
          else 'standard'
        end as assignment_type
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      join public.schedules schedule on schedule.id = shift.schedule_id
      join public.employees employee on employee.id = assignment.employee_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites post_site on post_site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      left join public.sites event_site on event_site.id = event.site_id
      where schedule.status = 'published'
        and assignment.status in ('assigned', 'confirmed', 'completed')
        and assignment.canceled_at is null
        and shift.canceled_at is null
        and employee.employment_type = 'salary'
        and private.shift_assignment_type(shift.id) <> 'dispatch_phone_duty'
        and (shift.starts_at at time zone shift.time_zone)::date
          between target_starts_on and target_ends_on
        and (requested_employee_id is null or assignment.employee_id = requested_employee_id)
        and not private.salaried_shift_assignment_is_absent(assignment.id)
        and not private.salaried_shift_assignment_has_approved_time_off(assignment.id)
      order by
        assignment.employee_id,
        schedule.week_starts_on,
        shift.post_id,
        shift.event_id,
        shift.starts_at,
        shift.ends_at,
        schedule.revision desc,
        assignment.id
    ), assignment_rows as (
      select
        current_assignment.*,
        latest_event.id as latest_event_id,
        latest_event.action as latest_action,
        latest_event.note as latest_note,
        latest_event.created_at as latest_created_at,
        latest_event.actor_employee_id,
        latest_event.actor_name,
        coalesce(history.events, '[]'::jsonb) as history
      from current_assignments current_assignment
      left join lateral (
        select
          event.id,
          event.action,
          event.note,
          event.actor_employee_id,
          event.created_at,
          btrim(coalesce(nullif(actor.preferred_name, ''), actor.first_name) || ' ' || actor.last_name) as actor_name
        from private.salaried_shift_presence_events event
        join private.salaried_shift_equivalent_assignments(current_assignment.assignment_id) equivalent
          on equivalent.assignment_id = event.shift_assignment_id
        join public.employees actor on actor.id = event.actor_employee_id
        order by event.created_at desc, event.id desc
        limit 1
      ) latest_event on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
          'id', event.id,
          'action', event.action,
          'note', event.note,
          'actor', jsonb_build_object(
            'id', actor.id,
            'displayName', btrim(coalesce(nullif(actor.preferred_name, ''), actor.first_name) || ' ' || actor.last_name)
          ),
          'recordedAt', event.created_at
        ) order by event.created_at, event.id) as events
        from private.salaried_shift_presence_events event
        join private.salaried_shift_equivalent_assignments(current_assignment.assignment_id) equivalent
          on equivalent.assignment_id = event.shift_assignment_id
        join public.employees actor on actor.id = event.actor_employee_id
      ) history on true
    )
    select jsonb_build_object(
      'generatedAt', clock_timestamp(),
      'range', jsonb_build_object(
        'startsOn', target_starts_on,
        'endsOn', target_ends_on
      ),
      'viewer', jsonb_build_object(
        'employeeId', actor_record.id,
        'timeZone', actor_record.time_zone,
        'employmentType', actor_record.employment_type::text,
        'canManage', true
      ),
      'filters', jsonb_build_object('employeeId', requested_employee_id),
      'summary', jsonb_build_object(
        'total', (select count(*) from assignment_rows row where row.ends_at <= clock_timestamp()),
        'worked', (select count(*) from assignment_rows row where row.latest_action = 'worked'),
        'unconfirmed', (
          select count(*)
          from assignment_rows row
          where row.ends_at <= clock_timestamp()
            and row.latest_action is distinct from 'worked'
        )
      ),
      'employees', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', employee.id,
          'employeeNumber', employee.employee_number,
          'displayName', btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name),
          'timeZone', employee.time_zone
        ) order by employee.last_name, employee.first_name, employee.id)
        from public.employees employee
        where employee.employment_type = 'salary'
          and employee.status in ('active', 'leave')
      ), '[]'::jsonb),
      'assignments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'assignmentId', row.assignment_id,
          'shiftId', row.shift_id,
          'employee', jsonb_build_object(
            'id', row.employee_id,
            'employeeNumber', row.employee_number,
            'displayName', row.employee_name,
            'timeZone', row.employee_time_zone
          ),
          'startsAt', row.starts_at,
          'endsAt', row.ends_at,
          'shiftTimeZone', row.shift_time_zone,
          'employeeTimeZone', row.employee_time_zone,
          'workday', (row.starts_at at time zone row.shift_time_zone)::date,
          'scheduleStatus', row.schedule_status::text,
          'assignmentStatus', row.assignment_status::text,
          'assignmentType', row.assignment_type,
          'siteCode', row.site_code,
          'siteName', row.site_name,
          'postName', row.post_name,
          'eventName', row.event_name,
          'location', row.location,
          'presenceStatus', case when row.latest_action = 'worked' then 'worked' else 'unconfirmed' end,
          'workedAt', case when row.latest_action = 'worked' then row.latest_created_at end,
          'recordedNote', case when row.latest_action = 'worked' then row.latest_note end,
          'recordedBy', case when row.latest_action = 'worked' then jsonb_build_object(
            'id', row.actor_employee_id,
            'displayName', row.actor_name
          ) end,
          'updatedAt', row.latest_created_at,
          'canMarkWorked', row.ends_at <= clock_timestamp() and row.latest_action is distinct from 'worked',
          'canVoid', row.latest_action = 'worked',
          'blockingReason', case
            when row.latest_action = 'worked' then 'already_worked'
            when row.ends_at > clock_timestamp() then 'shift_not_ended'
            else null
          end,
          'history', row.history
        ) order by row.starts_at desc, row.employee_name, row.assignment_id)
        from assignment_rows row
      ), '[]'::jsonb)
    )
  );
end
$$;

revoke all on function public.get_salaried_shift_workspace(date, date, uuid)
  from public, anon;
grant execute on function public.get_salaried_shift_workspace(date, date, uuid)
  to authenticated;

create or replace function public.record_salaried_shift_outcome(
  target_assignment_id uuid,
  requested_outcome text,
  request_id uuid,
  outcome_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_record record;
  canonical_record record;
  latest_event private.salaried_shift_presence_events%rowtype;
  replay_request private.salaried_shift_presence_requests%rowtype;
  inserted_event private.salaried_shift_presence_events%rowtype;
  normalized_outcome text := lower(btrim(coalesce(requested_outcome, '')));
  normalized_note text := nullif(btrim(coalesce(outcome_note, '')), '');
  request_key uuid := request_id;
  response_action text;
begin
  if actor_id is null
    or not public.has_effective_permission('schedule.salary_shifts.manage')
  then
    raise insufficient_privilege using message = 'MFA-verified salaried shift access is required.';
  end if;

  if target_assignment_id is null then
    raise null_value_not_allowed using message = 'A shift assignment is required.';
  end if;
  if request_id is null then
    raise null_value_not_allowed using message = 'A request identifier is required.';
  end if;
  if normalized_outcome not in ('worked', 'unconfirmed') then
    raise check_violation using message = 'Choose Worked or remove the existing Worked marker.';
  end if;
  if normalized_note is not null and char_length(normalized_note) > 2000 then
    raise check_violation using message = 'Keep the shift confirmation note to 2,000 characters or fewer.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'salary-shift-presence-request:' || request_key::text,
    0
  ));

  select receipt.* into replay_request
  from private.salaried_shift_presence_requests receipt
  where receipt.request_id = request_key;

  if replay_request.request_id is not null then
    if replay_request.requested_assignment_id <> target_assignment_id
      or replay_request.requested_outcome <> normalized_outcome
      or replay_request.normalized_note is distinct from normalized_note
    then
      raise check_violation using message = 'This request identifier was already used for a different shift change.';
    end if;

    select event.* into latest_event
    from private.salaried_shift_presence_events event
    join private.salaried_shift_equivalent_assignments(replay_request.canonical_assignment_id) equivalent
      on equivalent.assignment_id = event.shift_assignment_id
    order by event.created_at desc, event.id desc
    limit 1;

    return jsonb_build_object(
      'assignmentId', replay_request.canonical_assignment_id,
      'presenceStatus', case when latest_event.action = 'worked' then 'worked' else 'unconfirmed' end,
      'workedAt', case when latest_event.action = 'worked' then latest_event.created_at end,
      'updatedAt', coalesce(latest_event.created_at, replay_request.result_updated_at),
      'action', 'unchanged'
    );
  end if;

  select
    assignment.employee_id,
    shift.id as shift_id,
    shift.starts_at,
    shift.ends_at,
    shift.time_zone,
    schedule.week_starts_on
  into target_record
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  where assignment.id = target_assignment_id;

  if target_record.employee_id is null then
    raise check_violation using message = 'The selected shift assignment was not found.';
  end if;

  perform private.lock_employee_schedule_time_off(target_record.employee_id);
  perform pg_advisory_xact_lock(hashtext('schedule-draft:' || target_record.week_starts_on::text));
  perform pg_advisory_xact_lock(hashtextextended(
    concat_ws(':',
      'salary-shift-presence',
      target_record.employee_id::text,
      target_record.week_starts_on::text,
      target_record.shift_id::text
    ),
    0
  ));

  select
    assignment.id as assignment_id,
    assignment.employee_id,
    assignment.status as assignment_status,
    assignment.updated_at as assignment_updated_at,
    shift.id as shift_id,
    shift.schedule_id,
    shift.starts_at,
    shift.ends_at,
    shift.time_zone,
    schedule.week_starts_on,
    schedule.status as schedule_status,
    schedule.revision,
    employee.employment_type
  into canonical_record
  from private.salaried_shift_equivalent_assignments(target_assignment_id) equivalent
  join public.shift_assignments assignment on assignment.id = equivalent.assignment_id
  join public.shifts shift on shift.id = assignment.shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  join public.employees employee on employee.id = assignment.employee_id
  where schedule.status = 'published'
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and assignment.canceled_at is null
    and shift.canceled_at is null
    and private.shift_assignment_type(shift.id) <> 'dispatch_phone_duty'
  order by schedule.revision desc, assignment.id
  limit 1;

  if canonical_record.assignment_id is null then
    raise check_violation using message = 'Only an active assignment on the published schedule can be marked Worked.';
  end if;
  if canonical_record.employment_type <> 'salary' then
    raise check_violation using message = 'Only salaried employee shifts can be marked Worked here.';
  end if;

  perform 1
  from public.schedules schedule
  where schedule.id = canonical_record.schedule_id
  for share;
  perform 1
  from public.shift_assignments assignment
  where assignment.id = canonical_record.assignment_id
  for update;

  if canonical_record.ends_at > clock_timestamp() then
    raise check_violation using message = 'Wait until the scheduled shift has ended before marking it Worked.';
  end if;

  select event.* into latest_event
  from private.salaried_shift_presence_events event
  join private.salaried_shift_equivalent_assignments(canonical_record.assignment_id) equivalent
    on equivalent.assignment_id = event.shift_assignment_id
  order by event.created_at desc, event.id desc
  limit 1;

  if normalized_outcome = 'worked'
    and private.salaried_shift_assignment_is_absent(canonical_record.assignment_id)
  then
    raise check_violation using message = 'This employee is recorded as absent for the selected shift and cannot be marked Worked.';
  end if;
  if normalized_outcome = 'worked'
    and private.salaried_shift_assignment_has_approved_time_off(canonical_record.assignment_id)
  then
    raise check_violation using message = 'Approved time off overlaps this shift, so it cannot be marked Worked.';
  end if;

  if normalized_outcome = 'worked' then
    if latest_event.action = 'worked' then
      insert into private.salaried_shift_presence_requests (
        request_id,
        requested_assignment_id,
        canonical_assignment_id,
        employee_id,
        requested_outcome,
        normalized_note,
        result_presence_status,
        result_worked_at,
        result_updated_at,
        result_action,
        actor_employee_id
      ) values (
        request_key,
        target_assignment_id,
        canonical_record.assignment_id,
        canonical_record.employee_id,
        normalized_outcome,
        normalized_note,
        'worked',
        latest_event.created_at,
        latest_event.created_at,
        'unchanged',
        actor_id
      );

      return jsonb_build_object(
        'assignmentId', canonical_record.assignment_id,
        'presenceStatus', 'worked',
        'workedAt', latest_event.created_at,
        'updatedAt', latest_event.created_at,
        'action', 'unchanged'
      );
    end if;

    response_action := case when latest_event.action = 'voided' then 'corrected' else 'recorded' end;
    if response_action = 'corrected'
      and char_length(coalesce(normalized_note, '')) < 8
    then
      raise check_violation using message = 'Enter at least 8 characters explaining why the Worked marker is being restored.';
    end if;

    insert into private.salaried_shift_presence_events (
      shift_assignment_id,
      employee_id,
      action,
      note,
      actor_employee_id,
      request_id,
      result_action
    ) values (
      canonical_record.assignment_id,
      canonical_record.employee_id,
      'worked',
      normalized_note,
      actor_id,
      request_key,
      response_action
    )
    returning * into inserted_event;

    insert into private.salaried_shift_presence_requests (
      request_id,
      requested_assignment_id,
      canonical_assignment_id,
      employee_id,
      requested_outcome,
      normalized_note,
      result_presence_status,
      result_worked_at,
      result_updated_at,
      result_action,
      actor_employee_id
    ) values (
      request_key,
      target_assignment_id,
      canonical_record.assignment_id,
      canonical_record.employee_id,
      normalized_outcome,
      normalized_note,
      'worked',
      inserted_event.created_at,
      inserted_event.created_at,
      response_action,
      actor_id
    );

    return jsonb_build_object(
      'assignmentId', canonical_record.assignment_id,
      'presenceStatus', 'worked',
      'workedAt', inserted_event.created_at,
      'updatedAt', inserted_event.created_at,
      'action', response_action
    );
  end if;

  if latest_event.id is null or latest_event.action = 'voided' then
    insert into private.salaried_shift_presence_requests (
      request_id,
      requested_assignment_id,
      canonical_assignment_id,
      employee_id,
      requested_outcome,
      normalized_note,
      result_presence_status,
      result_worked_at,
      result_updated_at,
      result_action,
      actor_employee_id
    ) values (
      request_key,
      target_assignment_id,
      canonical_record.assignment_id,
      canonical_record.employee_id,
      normalized_outcome,
      normalized_note,
      'unconfirmed',
      null,
      coalesce(latest_event.created_at, canonical_record.assignment_updated_at),
      'unchanged',
      actor_id
    );

    return jsonb_build_object(
      'assignmentId', canonical_record.assignment_id,
      'presenceStatus', 'unconfirmed',
      'workedAt', null,
      'updatedAt', coalesce(latest_event.created_at, canonical_record.assignment_updated_at),
      'action', 'unchanged'
    );
  end if;

  if char_length(coalesce(normalized_note, '')) < 8 then
    raise check_violation using message = 'Enter at least 8 characters explaining why the Worked marker is being removed.';
  end if;

  insert into private.salaried_shift_presence_events (
    shift_assignment_id,
    employee_id,
    action,
    note,
    actor_employee_id,
    request_id,
    result_action
  ) values (
    canonical_record.assignment_id,
    canonical_record.employee_id,
    'voided',
    normalized_note,
    actor_id,
    request_key,
    'voided'
  )
  returning * into inserted_event;

  insert into private.salaried_shift_presence_requests (
    request_id,
    requested_assignment_id,
    canonical_assignment_id,
    employee_id,
    requested_outcome,
    normalized_note,
    result_presence_status,
    result_worked_at,
    result_updated_at,
    result_action,
    actor_employee_id
  ) values (
    request_key,
    target_assignment_id,
    canonical_record.assignment_id,
    canonical_record.employee_id,
    normalized_outcome,
    normalized_note,
    'unconfirmed',
    null,
    inserted_event.created_at,
    'voided',
    actor_id
  );

  return jsonb_build_object(
    'assignmentId', canonical_record.assignment_id,
    'presenceStatus', 'unconfirmed',
    'workedAt', null,
    'updatedAt', inserted_event.created_at,
    'action', 'voided'
  );
end
$$;

revoke all on function public.record_salaried_shift_outcome(uuid, text, uuid, text)
  from public, anon;
grant execute on function public.record_salaried_shift_outcome(uuid, text, uuid, text)
  to authenticated;

comment on table private.salaried_shift_presence_events is
  'Append-only manager audit trail for affirmative salaried Worked markers. This domain never stores worked time, minutes, punches, overtime, or payroll values.';

comment on table private.salaried_shift_presence_requests is
  'Append-only replay receipts for every accepted salaried shift presence mutation, including semantic no-ops.';

comment on function public.get_salaried_shift_workspace(date, date, uuid) is
  'Manager-only salaried scheduled-shift presence workspace. Dates use each shift authoritative time zone and the payload contains no worked-duration calculation.';

comment on function public.record_salaried_shift_outcome(uuid, text, uuid, text) is
  'Records or voids an affirmative Worked marker for a completed, published, non-absent salaried assignment. It never mutates schedule or timekeeping rows.';

notify pgrst, 'reload schema';

commit;
