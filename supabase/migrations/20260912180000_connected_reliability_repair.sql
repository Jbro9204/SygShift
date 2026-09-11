-- Repair three connected reliability regressions without rewriting business,
-- schedule, attendance, HR, permission, or audit history.

begin;

-- The required-actions checkpoint is a canary. Employees who are not enrolled
-- must take the cheap path, while enrolled employees retain the exact existing
-- permission restriction semantics.
create or replace function private.employee_has_blocking_required_actions(target_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.employee_required_action_checkpoint_enrolled(target_employee_id) then
    return false;
  end if;

  return exists (
    select 1
    from private.employee_required_action_checkpoint_rows(target_employee_id)
  );
end
$$;

create or replace function private.employee_effective_permissions(target_employee_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  checkpoint_blocks_access boolean := false;
  effective_permissions text[] := array[]::text[];
begin
  -- Evaluate the checkpoint once per permission projection. The prior SQL
  -- predicate evaluated it once for every granted permission.
  if private.employee_required_action_checkpoint_enrolled(target_employee_id) then
    checkpoint_blocks_access := private.employee_has_blocking_required_actions(target_employee_id);
  end if;

  with employee_record as (
    select employee.id, employee.role
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
    limit 1
  ),
  base_roles as (
    select access_role.id
    from public.access_roles access_role
    join employee_record employee on access_role.base_app_role = employee.role
    where access_role.system_role and access_role.active
  ),
  assigned_roles as (
    select access_role.id
    from public.employee_access_roles assignment
    join public.access_roles access_role on access_role.id = assignment.role_id
    join employee_record employee on employee.id = assignment.employee_id
    where access_role.active
  ),
  role_grants as (
    select permission.permission_code
    from public.access_role_permissions permission
    join (select id from base_roles union select id from assigned_roles) role_scope on role_scope.id = permission.role_id
    join public.permission_catalog catalog on catalog.code = permission.permission_code
    where permission.enabled and catalog.active
  ),
  direct_grants as (
    select override.permission_code
    from public.employee_permission_overrides override
    join public.permission_catalog catalog on catalog.code = override.permission_code
    where override.employee_id = target_employee_id
      and override.active and override.effect = 'grant' and catalog.active
  ),
  direct_denies as (
    select override.permission_code
    from public.employee_permission_overrides override
    where override.employee_id = target_employee_id
      and override.active and override.effect = 'deny'
  ),
  granted_permissions as (
    select permission_code from role_grants
    union
    select permission_code from direct_grants
  ),
  allowed_during_checkpoint(permission_code) as (
    values
      ('actions.self.view'::text),
      ('time.punch'::text),
      ('time.self.view'::text),
      ('accountability.report_call_off'::text),
      ('documents.signatures.sign_own'::text)
  )
  select coalesce(array_agg(distinct granted.permission_code order by granted.permission_code), array[]::text[])
  into effective_permissions
  from granted_permissions granted
  where not exists (
    select 1 from direct_denies denied where denied.permission_code = granted.permission_code
  )
    and (
      not checkpoint_blocks_access
      or exists (
        select 1 from allowed_during_checkpoint allowed where allowed.permission_code = granted.permission_code
      )
    );

  return coalesce(effective_permissions, array[]::text[]);
end
$$;

-- Accountability events are immutable historical evidence. Clone the current
-- reconciliation calculators for historical schedule revisions instead of
-- weakening the published-schedule rule used by live attendance review.
do $historical_snapshot$
declare
  function_definition text;
begin
  select pg_get_functiondef('private.get_attendance_reconciliation_snapshot(uuid)'::regprocedure)
  into function_definition;

  if function_definition is null
     or position('and schedule.status = ''published''' in function_definition) = 0 then
    raise exception 'The attendance reconciliation snapshot contract was not found.';
  end if;

  function_definition := replace(
    function_definition,
    'private.get_attendance_reconciliation_snapshot(target_shift_id uuid)',
    'private.get_accountability_reconciliation_snapshot(target_shift_id uuid)'
  );
  function_definition := replace(
    function_definition,
    'and schedule.status = ''published''',
    'and schedule.status in (''published'', ''superseded'', ''archived'')'
  );
  function_definition := replace(
    function_definition,
    'where shift.id = target_shift_id' || chr(10) || '    and shift.canceled_at is null',
    'where shift.id = target_shift_id'
  );
  execute function_definition;

  select pg_get_functiondef('private.get_attendance_reconciliation_group_snapshot_detailed(uuid)'::regprocedure)
  into function_definition;

  if function_definition is null
     or position('private.get_attendance_reconciliation_snapshot(member.id)' in function_definition) = 0
     or position('and schedule.status = ''published''' in function_definition) = 0 then
    raise exception 'The grouped attendance reconciliation snapshot contract was not found.';
  end if;

  function_definition := replace(
    function_definition,
    'private.get_attendance_reconciliation_group_snapshot_detailed(target_shift_id uuid)',
    'private.get_accountability_reconciliation_group_snapshot_historical(target_shift_id uuid)'
  );
  function_definition := replace(
    function_definition,
    'private.get_attendance_reconciliation_snapshot(member.id)',
    'private.get_accountability_reconciliation_snapshot(member.id)'
  );
  function_definition := replace(
    function_definition,
    'and schedule.status = ''published''',
    'and schedule.status in (''published'', ''superseded'', ''archived'')'
  );
  execute function_definition;
end
$historical_snapshot$;

create or replace function private.get_accountability_reconciliation_group_snapshot(target_shift_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  schedule_status text;
  snapshot jsonb;
begin
  select schedule.status::text
  into schedule_status
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  where shift.id = target_shift_id;

  if schedule_status = 'published' then
    snapshot := private.get_attendance_reconciliation_group_snapshot(target_shift_id);
  elsif schedule_status in ('superseded', 'archived') then
    snapshot := private.get_accountability_reconciliation_group_snapshot_historical(target_shift_id);

    -- A canceled historical source can be absent from the grouped calculation.
    -- Its direct immutable shift context is still valid Accountability evidence.
    if jsonb_typeof(snapshot -> 'startsAt') is distinct from 'string'
       or jsonb_typeof(snapshot -> 'endsAt') is distinct from 'string' then
      snapshot := private.get_accountability_reconciliation_snapshot(target_shift_id);
    end if;
  else
    return null;
  end if;

  if jsonb_typeof(snapshot -> 'startsAt') is distinct from 'string'
     or jsonb_typeof(snapshot -> 'endsAt') is distinct from 'string'
     or jsonb_typeof(snapshot -> 'locationName') is distinct from 'string' then
    return null;
  end if;

  return snapshot;
end
$$;

do $accountability_workspace$
declare
  function_definition text;
  prior_call text := 'private.get_attendance_reconciliation_group_snapshot(coalesce(native_event.shift_id, legacy_call_off.shift_id))';
  repaired_call text := 'private.get_accountability_reconciliation_group_snapshot(coalesce(native_event.shift_id, legacy_call_off.shift_id))';
begin
  select pg_get_functiondef('public.get_accountability_workspace(date,date)'::regprocedure)
  into function_definition;

  if function_definition is null or position(prior_call in function_definition) = 0 then
    raise exception 'The Accountability workspace reconciliation call was not found.';
  end if;

  execute replace(function_definition, prior_call, repaired_call);
end
$accountability_workspace$;

revoke all on function private.get_accountability_reconciliation_snapshot(uuid) from public, anon, authenticated;
revoke all on function private.get_accountability_reconciliation_group_snapshot_historical(uuid) from public, anon, authenticated;
revoke all on function private.get_accountability_reconciliation_group_snapshot(uuid) from public, anon, authenticated;
grant execute on function private.get_accountability_reconciliation_snapshot(uuid) to service_role;
grant execute on function private.get_accountability_reconciliation_group_snapshot_historical(uuid) to service_role;
grant execute on function private.get_accountability_reconciliation_group_snapshot(uuid) to service_role;

comment on function private.get_accountability_reconciliation_group_snapshot(uuid) is
  'Builds Accountability review context from the immutable source schedule revision while live attendance review remains restricted to the current published schedule.';

-- The safety refresh is still immediate at transaction completion, but bulk
-- schedule work now coalesces repeated row-trigger requests into one refresh
-- per affected week or employee scope.
create table if not exists private.attendance_alert_schedule_refresh_queue (
  week_starts_on date not null,
  employee_scope uuid not null,
  target_employee_id uuid,
  full_reconciliation boolean not null default true,
  queued_at timestamptz not null default clock_timestamp(),
  primary key (week_starts_on, employee_scope),
  constraint attendance_alert_schedule_refresh_queue_scope check (
    employee_scope = coalesce(target_employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
);

alter table private.attendance_alert_schedule_refresh_queue enable row level security;
revoke all on table private.attendance_alert_schedule_refresh_queue from public, anon, authenticated;

create index if not exists operational_alerts_related_exception_idx
  on public.operational_alerts (related_record_id)
  include (active, lifecycle_state)
  where related_record_type = 'timekeeping_operational_exception';

create index if not exists timekeeping_missing_clock_refresh_idx
  on public.timekeeping_operational_exceptions (status, employee_id, detected_at, scheduled_start_at, shift_id)
  include (resolution_method, scheduled_end_at, occurrence_key)
  where exception_code = 'missing_clock_in';

create or replace function private.queue_attendance_alert_schedule_refresh(
  target_week_starts_on date,
  target_employee_id uuid default null,
  target_full_reconciliation boolean default true
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  global_scope constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  if target_week_starts_on is null then
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('sygshift.attendance.alert.schedule.queue'),
    hashtext(target_week_starts_on::text)
  );

  if target_employee_id is null then
    delete from private.attendance_alert_schedule_refresh_queue queued
    where queued.week_starts_on = target_week_starts_on
      and queued.target_employee_id is not null;

    insert into private.attendance_alert_schedule_refresh_queue as queued (
      week_starts_on,
      employee_scope,
      target_employee_id,
      full_reconciliation
    ) values (
      target_week_starts_on,
      global_scope,
      null,
      target_full_reconciliation
    )
    on conflict (week_starts_on, employee_scope) do update
    set
      full_reconciliation = queued.full_reconciliation or excluded.full_reconciliation,
      queued_at = clock_timestamp();
    return;
  end if;

  if exists (
    select 1
    from private.attendance_alert_schedule_refresh_queue queued
    where queued.week_starts_on = target_week_starts_on
      and queued.employee_scope = global_scope
  ) then
    return;
  end if;

  insert into private.attendance_alert_schedule_refresh_queue as queued (
    week_starts_on,
    employee_scope,
    target_employee_id,
    full_reconciliation
  ) values (
    target_week_starts_on,
    target_employee_id,
    target_employee_id,
    target_full_reconciliation
  )
  on conflict (week_starts_on, employee_scope) do update
  set
    full_reconciliation = queued.full_reconciliation or excluded.full_reconciliation,
    queued_at = clock_timestamp();
end
$$;

create or replace function private.run_queued_attendance_alert_schedule_refresh()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  queued_record private.attendance_alert_schedule_refresh_queue%rowtype;
begin
  delete from private.attendance_alert_schedule_refresh_queue queued
  where queued.week_starts_on = new.week_starts_on
    and queued.employee_scope = new.employee_scope
  returning * into queued_record;

  if not found then
    return new;
  end if;

  perform private.refresh_attendance_alert_schedule_state(
    queued_record.week_starts_on,
    queued_record.target_employee_id,
    queued_record.full_reconciliation
  );
  return new;
end
$$;

revoke all on function private.queue_attendance_alert_schedule_refresh(date, uuid, boolean) from public, anon, authenticated;
revoke all on function private.run_queued_attendance_alert_schedule_refresh() from public, anon, authenticated;

drop trigger if exists run_queued_attendance_alert_schedule_refresh on private.attendance_alert_schedule_refresh_queue;
create constraint trigger run_queued_attendance_alert_schedule_refresh
after insert or update on private.attendance_alert_schedule_refresh_queue
deferrable initially deferred
for each row execute function private.run_queued_attendance_alert_schedule_refresh();

do $coalesce_schedule_triggers$
declare
  function_identity regprocedure;
  function_definition text;
begin
  foreach function_identity in array array[
    'private.refresh_attendance_alerts_after_schedule_change()'::regprocedure,
    'private.refresh_attendance_alerts_after_assignment_change()'::regprocedure,
    'private.refresh_attendance_alerts_after_shift_change()'::regprocedure
  ] loop
    select pg_get_functiondef(function_identity) into function_definition;

    if function_definition is null
       or position('private.refresh_attendance_alert_schedule_state(' in function_definition) = 0 then
      raise exception 'Attendance schedule refresh trigger contract was not found for %.', function_identity;
    end if;

    execute replace(
      function_definition,
      'private.refresh_attendance_alert_schedule_state(',
      'private.queue_attendance_alert_schedule_refresh('
    );
  end loop;
end
$coalesce_schedule_triggers$;

comment on table private.attendance_alert_schedule_refresh_queue is
  'Transaction-scoped coalescing queue that prevents bulk schedule changes from repeating the same attendance reconciliation scan.';

notify pgrst, 'reload schema';

commit;
