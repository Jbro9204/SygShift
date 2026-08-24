begin;

-- A Site/Post correction changes where a punch is displayed. An occurrence
-- correction changes which scheduled workday owns the punch. Keep those two
-- histories separate so an incorrect shift selection can be repaired without
-- rewriting the append-only source event.
create table if not exists public.time_event_occurrence_overrides (
  id uuid primary key default gen_random_uuid(),
  time_event_id uuid not null references public.time_events(id) on delete restrict,
  original_shift_id uuid references public.shifts(id) on delete restrict,
  replacement_shift_id uuid not null references public.shifts(id) on delete restrict,
  reason text not null,
  source text not null default 'authorized_correction',
  created_by uuid references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint time_event_occurrence_override_reason_present check (btrim(reason) <> ''),
  constraint time_event_occurrence_override_source check (source in ('authorized_correction', 'system_repair')),
  constraint time_event_occurrence_override_changes_shift check (original_shift_id is distinct from replacement_shift_id)
);

create index if not exists time_event_occurrence_overrides_event_latest_idx
  on public.time_event_occurrence_overrides (time_event_id, created_at desc, id desc);

alter table public.time_event_occurrence_overrides enable row level security;
revoke all on table public.time_event_occurrence_overrides from public, anon, authenticated;

drop trigger if exists time_event_occurrence_overrides_append_only on public.time_event_occurrence_overrides;
create trigger time_event_occurrence_overrides_append_only
before update or delete on public.time_event_occurrence_overrides
for each row execute function private.prevent_append_only_change();

drop trigger if exists time_event_occurrence_overrides_audit on public.time_event_occurrence_overrides;
create trigger time_event_occurrence_overrides_audit
after insert on public.time_event_occurrence_overrides
for each row execute function private.write_audit_event();

-- Resolve the operational occurrence override before occurrence keys and
-- payroll anchors are calculated. Display-only Site/Post overrides remain a
-- later layer and cannot silently move a punch to another workday.
create or replace function private.get_effective_time_events(
  target_employee_id uuid default null
)
returns table (
  id uuid,
  employee_id uuid,
  original_shift_id uuid,
  shift_id uuid,
  location_override_name text,
  location_override_time_zone text,
  kind public.time_event_kind,
  recorded_at timestamptz,
  effective_at timestamptz,
  has_approved_correction boolean,
  voided boolean,
  pending_correction boolean,
  manual_entry_id uuid,
  manual_clock_in_at timestamptz,
  original_shift_starts_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
with source_events as materialized (
  select event.*
  from public.time_events event
  where target_employee_id is null or event.employee_id = target_employee_id
),
latest_time as (
  select distinct on (correction.time_event_id)
    correction.time_event_id,
    correction.replacement_time
  from public.time_event_corrections correction
  join source_events event on event.id = correction.time_event_id
  where correction.approved_at is not null
    and not correction.voided
    and correction.replacement_time is not null
  order by correction.time_event_id, correction.approved_at desc, correction.created_at desc, correction.id desc
),
latest_kind as (
  select distinct on (correction.time_event_id)
    correction.time_event_id,
    correction.replacement_kind
  from public.time_event_corrections correction
  join source_events event on event.id = correction.time_event_id
  where correction.approved_at is not null
    and correction.replacement_kind is not null
  order by correction.time_event_id, correction.approved_at desc, correction.created_at desc, correction.id desc
),
correction_flags as (
  select
    correction.time_event_id,
    bool_or(correction.approved_at is not null) as has_approved_correction,
    bool_or(correction.approved_at is not null and correction.voided) as voided,
    bool_or(correction.approved_at is null and correction.declined_at is null) as pending_correction
  from public.time_event_corrections correction
  join source_events event on event.id = correction.time_event_id
  group by correction.time_event_id
),
latest_shift_override as (
  select distinct on (override.time_event_id)
    override.time_event_id,
    override.shift_id
  from public.time_event_shift_overrides override
  join source_events event on event.id = override.time_event_id
  order by override.time_event_id, override.created_at desc, override.id desc
),
latest_occurrence_override as (
  select distinct on (override.time_event_id)
    override.time_event_id,
    override.replacement_shift_id
  from public.time_event_occurrence_overrides override
  join source_events event on event.id = override.time_event_id
  order by override.time_event_id, override.created_at desc, override.id desc
),
latest_location_override as (
  select distinct on (override.time_event_id)
    override.time_event_id,
    override.location_name,
    override.time_zone
  from public.time_event_location_overrides override
  join source_events event on event.id = override.time_event_id
  order by override.time_event_id, override.created_at desc, override.id desc
),
manual_map as (
  select distinct on (mapped.time_event_id)
    mapped.time_event_id,
    mapped.manual_entry_id,
    mapped.clock_in_at
  from (
    select entry.clock_in_event_id as time_event_id, entry.id as manual_entry_id, entry.clock_in_at, entry.created_at
    from public.manual_time_entries entry
    where entry.clock_in_event_id is not null
    union all
    select entry.clock_out_event_id, entry.id, entry.clock_in_at, entry.created_at
    from public.manual_time_entries entry
    where entry.clock_out_event_id is not null
  ) mapped
  join source_events event on event.id = mapped.time_event_id
  order by mapped.time_event_id, mapped.created_at desc, mapped.manual_entry_id desc
)
select
  event.id,
  event.employee_id,
  coalesce(occurrence_override.replacement_shift_id, event.shift_id) as original_shift_id,
  coalesce(shift_override.shift_id, occurrence_override.replacement_shift_id, event.shift_id) as shift_id,
  location_override.location_name,
  location_override.time_zone,
  coalesce(kind_correction.replacement_kind, event.kind) as kind,
  event.recorded_at,
  coalesce(time_correction.replacement_time, event.recorded_at) as effective_at,
  coalesce(flags.has_approved_correction, false),
  coalesce(flags.voided, false),
  coalesce(flags.pending_correction, false),
  manual.manual_entry_id,
  manual.clock_in_at,
  occurrence_shift.starts_at
from source_events event
left join latest_time time_correction on time_correction.time_event_id = event.id
left join latest_kind kind_correction on kind_correction.time_event_id = event.id
left join correction_flags flags on flags.time_event_id = event.id
left join latest_shift_override shift_override on shift_override.time_event_id = event.id
left join latest_occurrence_override occurrence_override on occurrence_override.time_event_id = event.id
left join latest_location_override location_override on location_override.time_event_id = event.id
left join manual_map manual on manual.time_event_id = event.id
left join public.shifts occurrence_shift
  on occurrence_shift.id = coalesce(occurrence_override.replacement_shift_id, event.shift_id)
$$;

revoke all on function private.get_effective_time_events(uuid) from public, anon, authenticated;

-- Manual-punch choices need an explicit operational date. An overnight shift
-- ending on the chosen calendar date is not the shift that starts that workday.
do $add_shift_option_operational_date$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef('public.get_time_maintenance_shift_options(date,date,uuid)'::regprocedure)
  into function_sql;

  if position('''operationalDate''' in function_sql) = 0 then
    updated_sql := replace(
      function_sql,
      E'    ''startsAt'', starts_at,',
      E'    ''operationalDate'', (starts_at at time zone coalesce(time_zone, ''America/Denver''))::date,\n    ''startsAt'', starts_at,'
    );
  else
    updated_sql := function_sql;
  end if;

  if position('''operationalDate''' in updated_sql) = 0 then
    raise check_violation using message = 'Time Maintenance shift options could not be assigned an operational date safely.';
  end if;

  execute updated_sql;
end
$add_shift_option_operational_date$;

-- Reject an API request that links a new punch to a shift whose working window
-- is unrelated to that punch. The four-hour allowance covers early arrivals,
-- late relief, and verified extended work without allowing a prior overnight
-- occurrence to be selected for the next evening.
do $guard_manual_punch_shift_window$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef(
    'public.supervisor_record_time_event_with_location(uuid,public.time_event_kind,timestamptz,uuid,text,text,text,text)'::regprocedure
  ) into function_sql;

  if position('The selected Site/Post shift does not match this punch date and time.' in function_sql) = 0 then
    updated_sql := replace(
      function_sql,
      E'    if target_shift.id is null then\n      raise no_data_found using message = ''The selected Site/Post shift is no longer available.'';\n    end if;',
      E'    if target_shift.id is null then\n      raise no_data_found using message = ''The selected Site/Post shift is no longer available.'';\n    end if;\n\n    if target_effective_at < target_shift.starts_at - interval ''4 hours''\n      or target_effective_at > target_shift.ends_at + interval ''4 hours'' then\n      raise check_violation using message = ''The selected Site/Post shift does not match this punch date and time. Choose the shift for the correct workday.'';\n    end if;'
    );
  else
    updated_sql := function_sql;
  end if;

  if position('The selected Site/Post shift does not match this punch date and time.' in updated_sql) = 0 then
    raise check_violation using message = 'The manual-punch shift-window guard could not be installed safely.';
  end if;

  execute updated_sql;
end
$guard_manual_punch_shift_window$;

-- Repair the confirmed 08/13 occurrence without changing or deleting the
-- original clock-in. The paired 08/14 clock-out already references the correct
-- published shift.
insert into public.time_event_occurrence_overrides (
  time_event_id,
  original_shift_id,
  replacement_shift_id,
  reason,
  source,
  created_by
)
select
  event.id,
  event.shift_id,
  replacement.id,
  'Corrected an overnight punch that was linked to the prior operational workday.',
  'system_repair',
  null
from public.time_events event
join public.shifts original on original.id = event.shift_id
join public.shifts replacement
  on replacement.post_id is not distinct from original.post_id
  and replacement.event_id is not distinct from original.event_id
join public.schedules replacement_schedule on replacement_schedule.id = replacement.schedule_id
where event.id = '1667e7a5-aa23-4ee6-8f84-b01ef4b200d8'::uuid
  and replacement.id = '8fa1a59c-7986-4b35-a742-5546f70330a7'::uuid
  and replacement_schedule.status = 'published'
  and event.recorded_at between replacement.starts_at - interval '4 hours' and replacement.ends_at + interval '4 hours'
  and not exists (
    select 1
    from public.time_event_occurrence_overrides existing
    where existing.time_event_id = event.id
      and existing.replacement_shift_id = replacement.id
  );

notify pgrst, 'reload schema';

commit;
