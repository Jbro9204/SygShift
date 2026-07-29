begin;

create table if not exists public.time_event_location_overrides (
  id uuid primary key default gen_random_uuid(),
  time_event_id uuid not null references public.time_events(id) on delete restrict,
  location_name text not null,
  time_zone text not null default 'America/Denver',
  reason text not null,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint time_event_location_overrides_location_present check (btrim(location_name) <> ''),
  constraint time_event_location_overrides_reason_present check (btrim(reason) <> '')
);

create index if not exists time_event_location_overrides_event_idx
  on public.time_event_location_overrides (time_event_id, created_at desc, id desc);

create index if not exists time_event_location_overrides_created_by_idx
  on public.time_event_location_overrides (created_by, created_at desc);

alter table public.time_event_location_overrides enable row level security;

drop policy if exists time_event_location_overrides_read on public.time_event_location_overrides;
create policy time_event_location_overrides_read on public.time_event_location_overrides
for select
using (
  public.is_supervisor_or_admin()
  or public.has_effective_permission('time.view')
  or public.has_effective_permission('time.manage')
  or exists (
    select 1
    from public.time_events event
    where event.id = time_event_location_overrides.time_event_id
      and event.employee_id = public.current_employee_id()
  )
);

drop trigger if exists time_event_location_overrides_append_only on public.time_event_location_overrides;
create trigger time_event_location_overrides_append_only
before update or delete on public.time_event_location_overrides
for each row execute function private.prevent_append_only_change();

drop trigger if exists time_event_location_overrides_audit on public.time_event_location_overrides;
create trigger time_event_location_overrides_audit
after insert on public.time_event_location_overrides
for each row execute function private.write_audit_event();

alter table public.time_event_maintenance_notes
  drop constraint if exists time_event_maintenance_notes_action;

alter table public.time_event_maintenance_notes
  add constraint time_event_maintenance_notes_action
  check (action in ('manual_add', 'time_adjust', 'void', 'location_update'));

create or replace function public.supervisor_update_time_event_location(
  target_time_event_id uuid,
  target_location_name text,
  target_time_zone text default 'America/Denver',
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
  clean_location text := btrim(coalesce(target_location_name, ''));
  clean_time_zone text := coalesce(nullif(btrim(coalesce(target_time_zone, '')), ''), 'America/Denver');
  clean_reason text := btrim(coalesce(target_reason, ''));
  target_event public.time_events%rowtype;
  inserted_override public.time_event_location_overrides%rowtype;
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

  if clean_location = '' then
    raise check_violation using message = 'A corrected location is required.';
  end if;

  if length(clean_location) > 180 then
    raise check_violation using message = 'Corrected location must be 180 characters or less.';
  end if;

  if clean_reason = '' then
    raise check_violation using message = 'A maintenance reason is required.';
  end if;

  select * into target_event
  from public.time_events event
  where event.id = target_time_event_id;

  if target_event.id is null then
    raise no_data_found using message = 'The selected time event was not found.';
  end if;

  insert into public.time_event_location_overrides (
    time_event_id,
    location_name,
    time_zone,
    reason,
    created_by
  )
  values (
    target_time_event_id,
    clean_location,
    clean_time_zone,
    clean_reason,
    actor_id
  )
  returning * into inserted_override;

  insert into public.time_event_maintenance_notes (
    time_event_id,
    action,
    note,
    created_by
  )
  values (
    target_time_event_id,
    'location_update',
    clean_reason,
    actor_id
  );

  return jsonb_build_object(
    'id', inserted_override.id,
    'timeEventId', inserted_override.time_event_id,
    'locationName', inserted_override.location_name,
    'timeZone', inserted_override.time_zone,
    'reason', inserted_override.reason,
    'createdBy', inserted_override.created_by,
    'createdAt', inserted_override.created_at
  );
end
$$;

revoke all on function public.supervisor_update_time_event_location(uuid, text, text, text) from public, anon;
grant execute on function public.supervisor_update_time_event_location(uuid, text, text, text) to authenticated;

do $patch_time_maintenance$
declare
  function_sql text;
begin
  select pg_get_functiondef('public.get_time_maintenance(date, date, uuid)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'public.get_time_maintenance(date, date, uuid) was not found.';
  end if;

  if position('latest_location_override as (' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      '  event_rows as (',
      '  latest_location_override as (
    select distinct on (location_override.time_event_id)
      location_override.time_event_id,
      location_override.location_name,
      location_override.time_zone
    from public.time_event_location_overrides location_override
    order by location_override.time_event_id, location_override.created_at desc, location_override.id desc
  ),
  event_rows as ('
    );

    function_sql := replace(
      function_sql,
      '    left join note_summary on note_summary.time_event_id = event.id
    left join public.shifts shift on shift.id = event.shift_id',
      '    left join note_summary on note_summary.time_event_id = event.id
    left join latest_location_override on latest_location_override.time_event_id = event.id
    left join public.shifts shift on shift.id = event.shift_id'
    );

    function_sql := replace(
      function_sql,
      '      schedule_event.name as event_name,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, ''Unscheduled'') as location_name,
      coalesce(shift.time_zone, ''America/Denver'') as time_zone',
      '      schedule_event.name as event_name,
      coalesce(latest_location_override.location_name, schedule_event.location_name, site.name, post.name, schedule_event.name, ''Unscheduled Location'') as location_name,
      coalesce(latest_location_override.time_zone, shift.time_zone, ''America/Denver'') as time_zone'
    );

    execute function_sql;
  end if;
end
$patch_time_maintenance$;

do $patch_time_review$
declare
  function_sql text;
begin
  select pg_get_functiondef('public.get_timekeeping_review(date, date)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'public.get_timekeeping_review(date, date) was not found.';
  end if;

  if position('location_override_name' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      '      event.employee_id,
      event.shift_id,
      event.kind,
      event.recorded_at,',
      '      event.employee_id,
      event.shift_id,
      (
        select location_override.location_name
        from public.time_event_location_overrides location_override
        where location_override.time_event_id = event.id
        order by location_override.created_at desc, location_override.id desc
        limit 1
      ) as location_override_name,
      (
        select location_override.time_zone
        from public.time_event_location_overrides location_override
        where location_override.time_event_id = event.id
        order by location_override.created_at desc, location_override.id desc
        limit 1
      ) as location_override_time_zone,
      event.kind,
      event.recorded_at,'
    );

    function_sql := replace(
      function_sql,
      '      event.shift_id,
      event.group_key,
      min(event.operational_date) as operational_date,',
      '      event.shift_id,
      event.group_key,
      (array_remove(array_agg(event.location_override_name order by event.effective_at desc, event.recorded_at desc, event.id desc), null))[1] as location_override_name,
      (array_remove(array_agg(event.location_override_time_zone order by event.effective_at desc, event.recorded_at desc, event.id desc), null))[1] as location_override_time_zone,
      min(event.operational_date) as operational_date,'
    );

    function_sql := replace(
      function_sql,
      '      shift.time_zone,
      shift.requires_armed,',
      '      coalesce(grouped.location_override_time_zone, shift.time_zone, rules.time_zone) as time_zone,
      shift.requires_armed,'
    );

    function_sql := replace(
      function_sql,
      '      schedule_event.name as event_name,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, ''Unscheduled'') as location_name,',
      '      schedule_event.name as event_name,
      coalesce(grouped.location_override_name, schedule_event.location_name, site.name, post.name, schedule_event.name, ''Unscheduled Location'') as location_name,'
    );

    execute function_sql;
  end if;
end
$patch_time_review$;

notify pgrst, 'reload schema';

commit;
