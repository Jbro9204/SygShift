set search_path = '';

create table if not exists public.time_event_maintenance_notes (
  id uuid primary key default gen_random_uuid(),
  time_event_id uuid not null references public.time_events(id) on delete restrict,
  action text not null,
  note text not null,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint time_event_maintenance_notes_action check (action in ('manual_add', 'time_adjust', 'void')),
  constraint time_event_maintenance_notes_note_present check (btrim(note) <> '')
);

create index if not exists time_event_maintenance_notes_event_idx
  on public.time_event_maintenance_notes (time_event_id, created_at desc);

create index if not exists time_event_maintenance_notes_created_by_idx
  on public.time_event_maintenance_notes (created_by, created_at desc);

alter table public.time_event_maintenance_notes enable row level security;

drop policy if exists time_event_maintenance_notes_read on public.time_event_maintenance_notes;
create policy time_event_maintenance_notes_read on public.time_event_maintenance_notes
for select
using (
  public.is_supervisor_or_admin()
  or exists (
    select 1
    from public.time_events event
    where event.id = time_event_maintenance_notes.time_event_id
      and event.employee_id = public.current_employee_id()
  )
);

drop trigger if exists time_event_maintenance_notes_append_only on public.time_event_maintenance_notes;
create trigger time_event_maintenance_notes_append_only
before update or delete on public.time_event_maintenance_notes
for each row execute function private.prevent_append_only_change();

drop trigger if exists time_event_maintenance_notes_audit on public.time_event_maintenance_notes;
create trigger time_event_maintenance_notes_audit
after insert on public.time_event_maintenance_notes
for each row execute function private.write_audit_event();

create or replace function public.get_time_maintenance(
  target_from_date date,
  target_through_date date,
  target_employee_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  employees_payload jsonb;
  events_payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Operations access with MFA is required for time maintenance.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Time maintenance ranges are limited to 46 days.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', employee.id,
    'username', employee.username,
    'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'role', employee.role,
    'employmentType', employee.employment_type,
    'status', employee.status
  ) order by employee.last_name, employee.first_name), '[]'::jsonb)
  into employees_payload
  from public.employees employee
  where employee.status in ('active', 'leave')
    and employee.username is not null;

  with latest_correction as (
    select distinct on (correction.time_event_id)
      correction.time_event_id,
      correction.replacement_time,
      correction.voided,
      correction.reason,
      correction.approved_at
    from public.time_event_corrections correction
    where correction.approved_at is not null
    order by correction.time_event_id, correction.approved_at desc
  ),
  pending_corrections as (
    select
      correction.time_event_id,
      count(*)::integer as pending_count
    from public.time_event_corrections correction
    where correction.approved_at is null
      and correction.declined_at is null
    group by correction.time_event_id
  ),
  note_summary as (
    select
      note.time_event_id,
      count(*)::integer as note_count,
      (array_agg(note.note order by note.created_at desc, note.id desc))[1] as latest_note,
      (array_agg(note.action order by note.created_at desc, note.id desc))[1] as latest_action
    from public.time_event_maintenance_notes note
    group by note.time_event_id
  ),
  event_rows as (
    select
      event.id,
      event.employee_id,
      employee.username,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.role,
      employee.employment_type,
      event.shift_id,
      event.kind,
      event.recorded_at,
      coalesce(latest_correction.replacement_time, event.recorded_at) as effective_at,
      event.client_recorded_at,
      event.source,
      event.created_by,
      btrim(coalesce(creator.preferred_name, creator.first_name) || ' ' || creator.last_name) as created_by_name,
      coalesce(latest_correction.voided, false) as voided,
      coalesce(pending_corrections.pending_count, 0) as pending_correction_count,
      coalesce(note_summary.note_count, 0) as maintenance_note_count,
      note_summary.latest_note,
      note_summary.latest_action,
      post.name as post_name,
      site.name as site_name,
      site.code as site_code,
      schedule_event.name as event_name,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Unscheduled') as location_name,
      coalesce(shift.time_zone, 'America/Denver') as time_zone
    from public.time_events event
    join public.employees employee on employee.id = event.employee_id
    left join public.employees creator on creator.id = event.created_by
    left join latest_correction on latest_correction.time_event_id = event.id
    left join pending_corrections on pending_corrections.time_event_id = event.id
    left join note_summary on note_summary.time_event_id = event.id
    left join public.shifts shift on shift.id = event.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    where (target_employee_id is null or event.employee_id = target_employee_id)
      and (coalesce(latest_correction.replacement_time, event.recorded_at) at time zone 'America/Denver')::date
        between target_from_date and target_through_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'employeeId', employee_id,
    'username', username,
    'employeeName', employee_name,
    'role', role,
    'employmentType', employment_type,
    'shiftId', shift_id,
    'kind', kind,
    'recordedAt', recorded_at,
    'effectiveAt', effective_at,
    'clientRecordedAt', client_recorded_at,
    'source', source,
    'createdBy', created_by,
    'createdByName', created_by_name,
    'voided', voided,
    'pendingCorrectionCount', pending_correction_count,
    'maintenanceNoteCount', maintenance_note_count,
    'latestNote', latest_note,
    'latestAction', latest_action,
    'siteName', site_name,
    'siteCode', site_code,
    'postName', post_name,
    'eventName', event_name,
    'locationName', location_name,
    'timeZone', time_zone
  ) order by effective_at desc, employee_name), '[]'::jsonb)
  into events_payload
  from event_rows;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'operationalTimeZone', 'America/Denver',
    'employees', employees_payload,
    'events', events_payload
  );
end
$$;

create or replace function public.supervisor_record_time_event(
  target_employee_id uuid,
  target_kind public.time_event_kind,
  target_effective_at timestamptz,
  target_shift_id uuid default null,
  target_reason text default null,
  target_idempotency_key text default null
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
  safe_key text := coalesce(nullif(btrim(coalesce(target_idempotency_key, '')), ''), gen_random_uuid()::text);
  target_employee public.employees%rowtype;
  existing_event public.time_events%rowtype;
  inserted_event public.time_events%rowtype;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Operations access with MFA is required to maintain employee time.';
  end if;

  if target_employee_id is null or target_kind is null or target_effective_at is null then
    raise check_violation using message = 'Employee, punch type, and punch time are required.';
  end if;

  if clean_reason = '' then
    raise check_violation using message = 'A maintenance reason is required.';
  end if;

  if target_effective_at > clock_timestamp() + interval '15 minutes' then
    raise check_violation using message = 'Manual time events cannot be created in the future.';
  end if;

  select * into target_employee
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status in ('active', 'leave');

  if target_employee.id is null then
    raise no_data_found using message = 'The selected employee is not active.';
  end if;

  if target_shift_id is not null and not exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = target_shift_id
      and assignment.employee_id = target_employee_id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) then
    raise check_violation using message = 'The selected shift is not assigned to this employee.';
  end if;

  select * into existing_event
  from public.time_events event
  where event.idempotency_key = safe_key;

  if existing_event.id is not null then
    inserted_event := existing_event;
  else
    insert into public.time_events (
      employee_id,
      shift_id,
      kind,
      recorded_at,
      client_recorded_at,
      source,
      idempotency_key,
      created_by
    )
    values (
      target_employee_id,
      target_shift_id,
      target_kind,
      target_effective_at,
      null,
      'supervisor',
      safe_key,
      actor_id
    )
    returning * into inserted_event;

    insert into public.time_event_maintenance_notes (
      time_event_id,
      action,
      note,
      created_by
    )
    values (
      inserted_event.id,
      'manual_add',
      clean_reason,
      actor_id
    );
  end if;

  return jsonb_build_object(
    'id', inserted_event.id,
    'employeeId', inserted_event.employee_id,
    'shiftId', inserted_event.shift_id,
    'kind', inserted_event.kind,
    'recordedAt', inserted_event.recorded_at,
    'effectiveAt', inserted_event.recorded_at,
    'clientRecordedAt', inserted_event.client_recorded_at,
    'source', inserted_event.source,
    'voided', false
  );
end
$$;

create or replace function public.supervisor_correct_time_event(
  target_time_event_id uuid,
  target_replacement_time timestamptz default null,
  target_voided boolean default false,
  target_reason text default null
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
  target_event public.time_events%rowtype;
  inserted_correction public.time_event_corrections%rowtype;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Operations access with MFA is required to maintain employee time.';
  end if;

  if target_time_event_id is null then
    raise check_violation using message = 'A time event is required.';
  end if;

  if clean_reason = '' then
    raise check_violation using message = 'A maintenance reason is required.';
  end if;

  if coalesce(target_voided, false) and target_replacement_time is not null then
    raise check_violation using message = 'Void the punch or change its time, not both.';
  end if;

  if not coalesce(target_voided, false) and target_replacement_time is null then
    raise check_violation using message = 'A replacement time is required unless the punch is being voided.';
  end if;

  if target_replacement_time is not null and target_replacement_time > clock_timestamp() + interval '15 minutes' then
    raise check_violation using message = 'Replacement time cannot be in the future.';
  end if;

  select * into target_event
  from public.time_events event
  where event.id = target_time_event_id;

  if target_event.id is null then
    raise no_data_found using message = 'The selected time event was not found.';
  end if;

  insert into public.time_event_corrections (
    time_event_id,
    replacement_time,
    voided,
    reason,
    requested_by,
    approved_by,
    approved_at,
    decision_note
  )
  values (
    target_time_event_id,
    target_replacement_time,
    coalesce(target_voided, false),
    clean_reason,
    actor_id,
    actor_id,
    clock_timestamp(),
    'Operations maintenance correction.'
  )
  returning * into inserted_correction;

  insert into public.time_event_maintenance_notes (
    time_event_id,
    action,
    note,
    created_by
  )
  values (
    target_time_event_id,
    case when coalesce(target_voided, false) then 'void' else 'time_adjust' end,
    clean_reason,
    actor_id
  );

  return jsonb_build_object(
    'id', inserted_correction.id,
    'timeEventId', inserted_correction.time_event_id,
    'replacementTime', inserted_correction.replacement_time,
    'voided', inserted_correction.voided,
    'requestedBy', inserted_correction.requested_by,
    'approvedBy', inserted_correction.approved_by,
    'approvedAt', inserted_correction.approved_at,
    'reason', inserted_correction.reason
  );
end
$$;

revoke all on function public.get_time_maintenance(date, date, uuid) from public, anon;
revoke all on function public.supervisor_record_time_event(uuid, public.time_event_kind, timestamptz, uuid, text, text) from public, anon;
revoke all on function public.supervisor_correct_time_event(uuid, timestamptz, boolean, text) from public, anon;

grant execute on function public.get_time_maintenance(date, date, uuid) to authenticated;
grant execute on function public.supervisor_record_time_event(uuid, public.time_event_kind, timestamptz, uuid, text, text) to authenticated;
grant execute on function public.supervisor_correct_time_event(uuid, timestamptz, boolean, text) to authenticated;
