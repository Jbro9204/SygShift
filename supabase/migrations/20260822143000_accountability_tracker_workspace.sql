begin;

-- Accountability decisions are occurrence-specific. They document operational
-- judgment without changing punches, schedules, or payroll calculations.
alter table public.attendance_accountability_events
  add column if not exists review_outcome text;

alter table public.attendance_accountability_events
  drop constraint if exists attendance_accountability_review_outcome_check;

alter table public.attendance_accountability_events
  add constraint attendance_accountability_review_outcome_check
  check (
    review_outcome is null
    or review_outcome in ('confirmed', 'excused_protected', 'corrected', 'dismissed')
  );

alter table public.attendance_accountability_events
  drop constraint if exists attendance_accountability_source_check;

alter table public.attendance_accountability_events
  add constraint attendance_accountability_source_check
  check (source in ('employee', 'dispatcher', 'scheduler', 'supervisor', 'admin', 'system', 'authorized_user'));

create table if not exists public.attendance_accountability_event_actions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.attendance_accountability_events(id) on delete restrict,
  action text not null,
  reason text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  action_at timestamptz not null default clock_timestamp(),
  before_record jsonb,
  after_record jsonb not null,
  constraint attendance_accountability_action_check
    check (action in ('created', 'confirmed', 'excused_protected', 'corrected', 'dismissed', 'voided', 'reopened')),
  constraint attendance_accountability_action_reason_present check (btrim(reason) <> ''),
  constraint attendance_accountability_action_reason_length check (char_length(reason) <= 2000),
  constraint attendance_accountability_action_before_object check (before_record is null or jsonb_typeof(before_record) = 'object'),
  constraint attendance_accountability_action_after_object check (jsonb_typeof(after_record) = 'object')
);

create index if not exists attendance_accountability_actions_event_idx
  on public.attendance_accountability_event_actions(event_id, action_at desc);

insert into public.attendance_accountability_event_actions (
  event_id,
  action,
  reason,
  actor_id,
  action_at,
  after_record
)
select
  event.id,
  'created',
  event.note,
  coalesce(event.created_by, event.employee_id),
  event.created_at,
  to_jsonb(event)
from public.attendance_accountability_events event
where not exists (
  select 1
  from public.attendance_accountability_event_actions action
  where action.event_id = event.id
);

alter table public.attendance_accountability_event_actions enable row level security;

drop policy if exists attendance_accountability_action_select on public.attendance_accountability_event_actions;
create policy attendance_accountability_action_select
on public.attendance_accountability_event_actions
for select
to authenticated
using (
  exists (
    select 1
    from public.attendance_accountability_events event
    where event.id = attendance_accountability_event_actions.event_id
      and (
        event.employee_id = public.current_employee_id()
        or (
          public.has_mfa()
          and public.has_any_effective_permission(array['accountability.view', 'accountability.manage'])
        )
      )
  )
);

create or replace function private.prevent_accountability_action_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise check_violation using message = 'Accountability decision history is append-only.';
end
$$;

drop trigger if exists attendance_accountability_action_immutable
  on public.attendance_accountability_event_actions;

create trigger attendance_accountability_action_immutable
before update or delete on public.attendance_accountability_event_actions
for each row execute function private.prevent_accountability_action_mutation();

create or replace function private.record_accountability_event_creation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.attendance_accountability_event_actions (
    event_id,
    action,
    reason,
    actor_id,
    action_at,
    after_record
  ) values (
    new.id,
    'created',
    new.note,
    coalesce(new.created_by, new.employee_id),
    new.created_at,
    to_jsonb(new)
  );
  return new;
end
$$;

drop trigger if exists attendance_accountability_record_creation
  on public.attendance_accountability_events;

create trigger attendance_accountability_record_creation
after insert on public.attendance_accountability_events
for each row execute function private.record_accountability_event_creation();

-- Twelve-hour operations require a meaningful missing-clock-in guardrail. The
-- job now waits fourteen hours after scheduled start before opening a blocker.
insert into private.system_settings (
  setting_key,
  setting_value,
  description,
  updated_at
)
values (
  'timekeeping.missing_clock_in_grace_minutes',
  '840'::jsonb,
  'Minutes after scheduled shift start before a missing clock-in exception is created. Fourteen hours supports twelve-hour operations while still flagging an absent punch.',
  clock_timestamp()
)
on conflict (setting_key) do update
set
  setting_value = excluded.setting_value,
  description = excluded.description,
  updated_at = clock_timestamp();

create or replace function public.create_attendance_accountability_event(
  target_employee_id uuid,
  target_shift_id uuid default null,
  target_event_type text default 'other',
  target_operational_date date default null,
  target_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_role text;
  employee_record public.employees%rowtype;
  clean_event_type text := btrim(coalesce(target_event_type, ''));
  clean_note text := btrim(coalesce(target_note, ''));
  shift_id_value uuid;
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  shift_time_zone text := 'America/Denver';
  event_record public.attendance_accountability_events%rowtype;
  source_value text := 'authorized_user';
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() or not public.has_effective_permission('accountability.create') then
    raise insufficient_privilege using message = 'Accountability event creation permission with MFA is required.';
  end if;

  if target_employee_id is null then
    raise check_violation using message = 'Choose an employee.';
  end if;

  select *
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status = 'active';

  if employee_record.id is null then
    raise check_violation using message = 'Choose an active employee.';
  end if;

  if clean_event_type not in ('no_call_no_show', 'late_arrival', 'early_departure', 'other') then
    raise check_violation using message = 'Use Time Operations for sick and call-off reports. Choose a supported operational occurrence.';
  end if;

  if char_length(clean_note) < 4 then
    raise check_violation using message = 'Enter a brief factual note.';
  end if;

  if char_length(clean_note) > 2000 then
    raise check_violation using message = 'The note exceeds 2,000 characters.';
  end if;

  if target_shift_id is not null then
    select
      shift.id,
      shift.starts_at,
      shift.ends_at,
      coalesce(shift.time_zone, 'America/Denver') as time_zone
    into shift_id_value, shift_starts_at, shift_ends_at, shift_time_zone
    from public.shifts shift
    join public.schedules schedule
      on schedule.id = shift.schedule_id
     and schedule.status = 'published'
    join public.shift_assignments assignment
      on assignment.shift_id = shift.id
     and assignment.employee_id = target_employee_id
     and assignment.status in ('assigned', 'confirmed')
    where shift.id = target_shift_id
      and shift.canceled_at is null
    limit 1;

    if shift_id_value is null then
      raise check_violation using message = 'Choose a published shift assigned to this employee.';
    end if;
  elsif clean_event_type <> 'other' then
    raise check_violation using message = 'Late arrival, early departure, and no-call/no-show entries must be tied to a scheduled shift.';
  elsif target_operational_date is null then
    raise check_violation using message = 'Choose an operational date.';
  end if;

  select employee.role::text
  into actor_role
  from public.employees employee
  where employee.id = actor_id;

  if actor_role in ('dispatcher', 'scheduler', 'supervisor', 'admin') then
    source_value := actor_role;
  end if;

  if target_shift_id is not null
     and clean_event_type <> 'other'
     and exists (
       select 1
       from public.attendance_accountability_events existing
       where existing.employee_id = target_employee_id
         and existing.shift_id = target_shift_id
         and existing.event_type = clean_event_type
         and existing.status <> 'voided'
     ) then
    raise unique_violation using message = 'This occurrence is already recorded for the selected employee and shift.';
  end if;

  insert into public.attendance_accountability_events (
    employee_id,
    shift_id,
    event_type,
    status,
    operational_date,
    starts_at,
    ends_at,
    source,
    note,
    created_by
  ) values (
    target_employee_id,
    target_shift_id,
    clean_event_type,
    'reported',
    coalesce(target_operational_date, (shift_starts_at at time zone shift_time_zone)::date),
    shift_starts_at,
    shift_ends_at,
    source_value,
    clean_note,
    actor_id
  )
  returning * into event_record;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    auth.uid(),
    actor_id,
    'public',
    'attendance_accountability_events',
    'INSERT',
    event_record.id::text,
    jsonb_build_object(
      'employeeId', event_record.employee_id,
      'shiftId', event_record.shift_id,
      'eventType', event_record.event_type,
      'operationalDate', event_record.operational_date,
      'source', event_record.source
    )
  );

  return jsonb_build_object(
    'id', event_record.id,
    'employeeId', event_record.employee_id,
    'shiftId', event_record.shift_id,
    'eventType', event_record.event_type,
    'status', event_record.status,
    'operationalDate', event_record.operational_date,
    'createdAt', event_record.created_at
  );
end
$$;

create or replace function public.review_attendance_accountability_event(
  target_event_id uuid,
  target_action text,
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
  clean_action text := btrim(coalesce(target_action, ''));
  clean_reason text := btrim(coalesce(target_reason, ''));
  before_record public.attendance_accountability_events%rowtype;
  after_record public.attendance_accountability_events%rowtype;
  next_status text;
  next_outcome text;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() or not public.has_effective_permission('accountability.manage') then
    raise insufficient_privilege using message = 'Accountability management permission with MFA is required.';
  end if;

  if clean_action not in ('confirmed', 'excused_protected', 'corrected', 'dismissed', 'voided', 'reopened') then
    raise check_violation using message = 'Choose a supported accountability decision.';
  end if;

  if char_length(clean_reason) < 8 then
    raise check_violation using message = 'Enter a clear reason of at least 8 characters.';
  end if;

  if char_length(clean_reason) > 2000 then
    raise check_violation using message = 'The reason exceeds 2,000 characters.';
  end if;

  select *
  into before_record
  from public.attendance_accountability_events event
  where event.id = target_event_id
  for update;

  if before_record.id is null then
    raise check_violation using message = 'The accountability occurrence could not be found.';
  end if;

  if clean_action = 'reopened' then
    next_status := 'reported';
    next_outcome := null;
  elsif clean_action = 'voided' then
    next_status := 'voided';
    next_outcome := null;
  else
    next_status := 'resolved';
    next_outcome := clean_action;
  end if;

  update public.attendance_accountability_events
  set
    status = next_status,
    review_outcome = next_outcome,
    reviewed_by = actor_id,
    reviewed_at = clock_timestamp(),
    decision_note = clean_reason,
    updated_at = clock_timestamp()
  where id = before_record.id
  returning * into after_record;

  insert into public.attendance_accountability_event_actions (
    event_id,
    action,
    reason,
    actor_id,
    before_record,
    after_record
  ) values (
    after_record.id,
    clean_action,
    clean_reason,
    actor_id,
    to_jsonb(before_record),
    to_jsonb(after_record)
  );

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    auth.uid(),
    actor_id,
    'public',
    'attendance_accountability_events',
    'REVIEW',
    after_record.id::text,
    jsonb_build_object(
      'status', before_record.status,
      'reviewOutcome', before_record.review_outcome,
      'decisionNote', before_record.decision_note
    ),
    jsonb_build_object(
      'status', after_record.status,
      'reviewOutcome', after_record.review_outcome,
      'decisionNote', after_record.decision_note,
      'reviewedBy', after_record.reviewed_by,
      'reviewedAt', after_record.reviewed_at
    )
  );

  return jsonb_build_object(
    'id', after_record.id,
    'status', after_record.status,
    'reviewOutcome', after_record.review_outcome,
    'decisionNote', after_record.decision_note,
    'reviewedBy', after_record.reviewed_by,
    'reviewedAt', after_record.reviewed_at
  );
end
$$;

-- The existing payroll accountability reader predates the manage permission.
-- Keep its established query intact while ensuring a custom role that has
-- accountability.manage (but not accountability.view) can use this workspace.
do $accountability_reader_permission$
declare
  function_sql text;
  old_permission text := 'or public.has_effective_permission(''accountability.view'')';
  new_permission text := 'or public.has_effective_permission(''accountability.view'')
    or public.has_effective_permission(''accountability.manage'')';
begin
  select pg_get_functiondef('public.get_payroll_accountability_events(date, date)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise exception 'Required payroll accountability reader was not found.';
  end if;

  if position('accountability.manage' in function_sql) = 0 then
    if position(old_permission in function_sql) = 0 then
      raise exception 'Payroll accountability permission guard could not be updated safely.';
    end if;
    function_sql := replace(function_sql, old_permission, new_permission);
    execute function_sql;
  end if;
end
$accountability_reader_permission$;

create or replace function public.get_accountability_workspace(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  base_events jsonb;
  employee_payload jsonb;
  shift_payload jsonb;
  event_payload jsonb;
  exception_payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa()
     or not public.has_any_effective_permission(array['accountability.view', 'accountability.manage']) then
    raise insufficient_privilege using message = 'Accountability workspace permission with MFA is required.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'Choose a valid accountability date range.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Accountability ranges are limited to 46 days.';
  end if;

  base_events := public.get_payroll_accountability_events(target_from_date, target_through_date);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', employee.id,
    'name', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'username', employee.username,
    'role', employee.role::text,
    'employmentType', employee.employment_type::text
  ) order by lower(coalesce(employee.preferred_name, employee.first_name)), lower(employee.last_name), employee.id), '[]'::jsonb)
  into employee_payload
  from public.employees employee
  where employee.status = 'active';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', shift.id,
    'employeeId', assignment.employee_id,
    'operationalDate', (shift.starts_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date,
    'startsAt', shift.starts_at,
    'endsAt', shift.ends_at,
    'timeZone', coalesce(shift.time_zone, 'America/Denver'),
    'locationName', coalesce(site.name, event.location_name, event.name, post.name, 'Scheduled shift'),
    'siteCode', site.code,
    'postName', post.name,
    'eventName', event.name
  ) order by shift.starts_at, lower(coalesce(site.name, event.name, post.name, ''))), '[]'::jsonb)
  into shift_payload
  from public.shifts shift
  join public.schedules schedule
    on schedule.id = shift.schedule_id
   and schedule.status = 'published'
  join public.shift_assignments assignment
    on assignment.shift_id = shift.id
   and assignment.status in ('assigned', 'confirmed')
  join public.employees employee
    on employee.id = assignment.employee_id
   and employee.status = 'active'
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  where shift.canceled_at is null
    and (shift.starts_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date
      between target_from_date and target_through_date;

  with base as (
    select item.value as value
    from jsonb_array_elements(coalesce(base_events, '[]'::jsonb)) item(value)
  ),
  enriched as (
    select
      base.value
      || jsonb_build_object(
        'shiftId', coalesce(native_event.shift_id, legacy_call_off.shift_id),
        'reviewOutcome', native_event.review_outcome,
        'reviewedAt', native_event.reviewed_at,
        'reviewedByName', case when reviewer.id is null then null else btrim(coalesce(reviewer.preferred_name, reviewer.first_name) || ' ' || reviewer.last_name) end,
        'decisionNote', native_event.decision_note,
        'reviewable', native_event.id is not null,
        'actionHistory', coalesce(action_history.items, '[]'::jsonb),
        'reconciliation', case
          when coalesce(native_event.shift_id, legacy_call_off.shift_id) is null then null
          else private.get_attendance_reconciliation_group_snapshot(coalesce(native_event.shift_id, legacy_call_off.shift_id))
        end
      ) as value
    from base
    left join public.attendance_accountability_events native_event
      on base.value ->> 'sourceTable' = 'attendance_accountability_events'
     and native_event.id = (base.value ->> 'id')::uuid
    left join public.call_off_reports legacy_call_off
      on base.value ->> 'sourceTable' = 'call_off_reports'
     and legacy_call_off.id = (base.value ->> 'id')::uuid
    left join public.employees reviewer on reviewer.id = native_event.reviewed_by
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'id', action.id,
        'action', action.action,
        'reason', action.reason,
        'actorId', action.actor_id,
        'actorName', btrim(coalesce(actor.preferred_name, actor.first_name) || ' ' || actor.last_name),
        'actionAt', action.action_at
      ) order by action.action_at desc, action.id) as items
      from public.attendance_accountability_event_actions action
      join public.employees actor on actor.id = action.actor_id
      where action.event_id = native_event.id
    ) action_history on true
  )
  select coalesce(jsonb_agg(enriched.value order by enriched.value ->> 'operationalDate' desc, lower(enriched.value ->> 'employeeName'), enriched.value ->> 'createdAt' desc), '[]'::jsonb)
  into event_payload
  from enriched;

  select coalesce(jsonb_agg(jsonb_build_object(
    'employeeId', grouped.employee_id,
    'employeeName', grouped.employee_name,
    'unresolvedCount', grouped.unresolved_count,
    'blockingCount', grouped.blocking_count,
    'oldestDetectedAt', grouped.oldest_detected_at,
    'newestDetectedAt', grouped.newest_detected_at,
    'codes', grouped.codes
  ) order by grouped.blocking_count desc, grouped.unresolved_count desc, lower(grouped.employee_name)), '[]'::jsonb)
  into exception_payload
  from (
    select
      exception.employee_id,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      count(*)::integer as unresolved_count,
      count(*) filter (where exception.severity = 'blocking')::integer as blocking_count,
      min(exception.detected_at) as oldest_detected_at,
      max(exception.detected_at) as newest_detected_at,
      to_jsonb(array_agg(distinct exception.exception_code order by exception.exception_code)) as codes
    from public.timekeeping_operational_exceptions exception
    join public.employees employee on employee.id = exception.employee_id
    where exception.status = 'unresolved'
      and (exception.scheduled_start_at at time zone 'America/Denver')::date between target_from_date and target_through_date
    group by exception.employee_id, employee.preferred_name, employee.first_name, employee.last_name
  ) grouped;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'operationalTimeZone', 'America/Denver',
    'capabilities', jsonb_build_object(
      'canCreate', public.has_effective_permission('accountability.create'),
      'canManage', public.has_effective_permission('accountability.manage')
    ),
    'employees', employee_payload,
    'shiftOptions', shift_payload,
    'events', event_payload,
    'exceptionSummaries', exception_payload
  );
end
$$;

revoke all on table public.attendance_accountability_event_actions from public, anon;
grant select on table public.attendance_accountability_event_actions to authenticated;

revoke all on function public.create_attendance_accountability_event(uuid, uuid, text, date, text) from public, anon;
revoke all on function public.review_attendance_accountability_event(uuid, text, text) from public, anon;
revoke all on function public.get_accountability_workspace(date, date) from public, anon;

grant execute on function public.create_attendance_accountability_event(uuid, uuid, text, date, text) to authenticated;
grant execute on function public.review_attendance_accountability_event(uuid, text, text) to authenticated;
grant execute on function public.get_accountability_workspace(date, date) to authenticated;

notify pgrst, 'reload schema';

commit;
