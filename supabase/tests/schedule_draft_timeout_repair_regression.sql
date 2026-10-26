\set ON_ERROR_STOP on

begin;

set local statement_timeout = '30s';

create temporary table schedule_timeout_guard_fixture (
  sequence_number integer primary key,
  employee_id uuid not null unique
) on commit drop;

insert into schedule_timeout_guard_fixture (sequence_number, employee_id)
select guard_number, gen_random_uuid()
from generate_series(1, 122) guard_number;

create temporary table schedule_timeout_shift_fixture (
  sequence_number integer primary key,
  shift_id uuid not null unique
) on commit drop;

insert into schedule_timeout_shift_fixture (sequence_number, shift_id)
select shift_number, gen_random_uuid()
from generate_series(1, 124) shift_number;

insert into public.employees (id, first_name, last_name, role)
values ('81000000-0000-0000-0000-000000000001', 'Draft', 'TimeoutSupervisor', 'supervisor');

insert into public.employees (id, first_name, last_name, role)
select fixture.employee_id, 'Draft', 'LoadGuard' || fixture.sequence_number::text, 'guard'
from schedule_timeout_guard_fixture fixture
order by fixture.sequence_number;

insert into auth.users (id, email)
values
  ('82000000-0000-0000-0000-000000000001', 'schedule-timeout-supervisor@example.invalid'),
  ('82000000-0000-0000-0000-000000000002', 'schedule-timeout-guard@example.invalid');

insert into private.employee_accounts (employee_id, auth_user_id, activated_at)
values (
  '81000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001',
  now()
);

insert into private.employee_accounts (employee_id, auth_user_id, activated_at)
select fixture.employee_id, '82000000-0000-0000-0000-000000000002', now()
from schedule_timeout_guard_fixture fixture
where fixture.sequence_number = 1;

insert into public.sites (id, code, name)
values ('83000000-0000-0000-0000-000000000001', 'DRAFT-PERF', 'Draft Performance Site');

insert into public.posts (id, site_id, name, requires_armed)
values (
  '84000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001',
  'Draft Performance Post',
  false
);

insert into public.schedules (id, week_starts_on, revision, status, created_by)
values (
  '85000000-0000-0000-0000-000000000001',
  date '2099-10-04',
  1,
  'draft',
  '81000000-0000-0000-0000-000000000001'
);

insert into public.shifts (
  id, schedule_id, post_id, starts_at, ends_at, time_zone,
  headcount_required, notes, work_type, payroll_category, created_by
)
select
  fixture.shift_id,
  '85000000-0000-0000-0000-000000000001',
  '84000000-0000-0000-0000-000000000001',
  timestamptz '2099-10-04 00:00:00-06' + ((fixture.sequence_number - 1) * interval '1 hour'),
  timestamptz '2099-10-04 00:00:00-06' + (fixture.sequence_number * interval '1 hour'),
  'America/Denver',
  1,
  'Draft timeout regression ' || fixture.sequence_number::text,
  'post',
  'regular',
  '81000000-0000-0000-0000-000000000001'
from schedule_timeout_shift_fixture fixture
order by fixture.sequence_number;

insert into public.shift_assignments (shift_id, employee_id, assigned_by)
select
  shift_fixture.shift_id,
  guard_fixture.employee_id,
  '81000000-0000-0000-0000-000000000001'
from schedule_timeout_shift_fixture shift_fixture
join schedule_timeout_guard_fixture guard_fixture
  on guard_fixture.sequence_number = shift_fixture.sequence_number
where shift_fixture.sequence_number <= 122
order by shift_fixture.sequence_number;

insert into public.schedule_assignment_overrides (
  shift_id, employee_id, override_kind, note, created_by
)
select
  shift_fixture.shift_id,
  guard_fixture.employee_id,
  'availability',
  'Draft timeout regression availability evidence.',
  '81000000-0000-0000-0000-000000000001'
from schedule_timeout_shift_fixture shift_fixture
join schedule_timeout_guard_fixture guard_fixture
  on guard_fixture.sequence_number = shift_fixture.sequence_number
where shift_fixture.sequence_number % 10 = 0
  and shift_fixture.sequence_number <= 122
order by shift_fixture.sequence_number;

-- Match and slightly exceed the production override-table cardinality that
-- exposed the per-assignment sequential scans. These records are deliberately
-- unrelated to the target week and must not affect its copied payload.
insert into public.schedules (id, week_starts_on, revision, status, created_by)
values (
  '85000000-0000-0000-0000-000000000099',
  date '2099-09-27',
  1,
  'draft',
  '81000000-0000-0000-0000-000000000001'
);

insert into public.shifts (
  id, schedule_id, post_id, starts_at, ends_at, headcount_required, created_by
) values (
  '86000000-0000-0000-0000-000000000099',
  '85000000-0000-0000-0000-000000000099',
  '84000000-0000-0000-0000-000000000001',
  timestamptz '2099-09-27 08:00:00-06',
  timestamptz '2099-09-27 09:00:00-06',
  1,
  '81000000-0000-0000-0000-000000000001'
);

insert into public.shift_assignments (shift_id, employee_id, assigned_by)
select
  '86000000-0000-0000-0000-000000000099',
  fixture.employee_id,
  '81000000-0000-0000-0000-000000000001'
from schedule_timeout_guard_fixture fixture
where fixture.sequence_number = 1;

insert into public.schedule_assignment_overrides (
  shift_id, employee_id, override_kind, note, created_by
)
select
  '86000000-0000-0000-0000-000000000099',
  fixture.employee_id,
  'availability',
  'Unrelated override scale row ' || override_number::text,
  '81000000-0000-0000-0000-000000000001'
from schedule_timeout_guard_fixture fixture
cross join generate_series(1, 10000) override_number
where fixture.sequence_number = 1;

update public.schedules
set
  status = 'published',
  published_at = clock_timestamp(),
  published_by = '81000000-0000-0000-0000-000000000001'
where id = '85000000-0000-0000-0000-000000000001';

set local statement_timeout = '7s';

set local role authenticated;
set local "request.jwt.claim.sub" = '82000000-0000-0000-0000-000000000002';
set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
declare
  denied boolean := false;
begin
  begin
    perform public.ensure_schedule_draft(date '2099-10-04');
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'An employee without schedule-management access created a draft.';
  end if;
end
$$;

reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '82000000-0000-0000-0000-000000000001';
set local "request.jwt.claims" = '{"aal":"aal1"}';

do $$
declare
  denied boolean := false;
begin
  begin
    perform public.ensure_schedule_draft(date '2099-10-04');
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'An AAL1 schedule manager created a draft.';
  end if;
end
$$;

reset role;

do $$
begin
  if exists (
    select 1 from public.schedules schedule
    where schedule.week_starts_on = date '2099-10-04'
      and schedule.status = 'draft'
  ) then
    raise exception 'A denied draft request retained schedule rows.';
  end if;
end
$$;

set local role authenticated;
set local "request.jwt.claim.sub" = '82000000-0000-0000-0000-000000000001';
set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
begin
  perform public.ensure_schedule_draft(date '2099-10-04');
end
$$;

do $$
declare
  draft_schedule_id uuid;
  first_shift_count integer;
  first_assignment_count integer;
  first_override_count integer;
begin
  select schedule.id into strict draft_schedule_id
  from public.schedules schedule
  where schedule.week_starts_on = date '2099-10-04'
    and schedule.status = 'draft';

  select count(*) into first_shift_count
  from public.shifts shift
  where shift.schedule_id = draft_schedule_id
    and shift.canceled_at is null;

  select count(*) into first_assignment_count
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  where shift.schedule_id = draft_schedule_id
    and assignment.status in ('assigned', 'confirmed', 'completed');

  select count(*) into first_override_count
  from public.schedule_assignment_overrides override_record
  join public.shifts shift on shift.id = override_record.shift_id
  where shift.schedule_id = draft_schedule_id;

  if first_shift_count <> 124 then
    raise exception 'Expected 124 active draft shifts, found %.', first_shift_count;
  end if;
  if first_assignment_count <> 122 then
    raise exception 'Expected 122 active draft assignments, found %.', first_assignment_count;
  end if;
  if first_override_count <> 12 then
    raise exception 'Expected 12 copied assignment overrides, found %.', first_override_count;
  end if;
  if (select count(*) from public.shifts shift where shift.schedule_id = draft_schedule_id and shift.is_open) <> 2 then
    raise exception 'The two unassigned draft shifts were not the only open shifts.';
  end if;

  if exists (
    select 1
    from public.shifts source_shift
    full join public.shifts draft_shift
      on draft_shift.schedule_id = draft_schedule_id
     and draft_shift.starts_at = source_shift.starts_at
     and draft_shift.ends_at = source_shift.ends_at
     and draft_shift.notes = source_shift.notes
     and draft_shift.work_type = source_shift.work_type
     and draft_shift.payroll_category = source_shift.payroll_category
    where source_shift.schedule_id = '85000000-0000-0000-0000-000000000001'
      and (draft_shift.id is null or draft_shift.id = source_shift.id)
  ) then
    raise exception 'The draft shifts did not preserve source fields with new identities.';
  end if;

  if exists (
    select 1
    from public.shift_assignments source_assignment
    join public.shifts source_shift on source_shift.id = source_assignment.shift_id
    join public.shifts draft_shift
      on draft_shift.schedule_id = draft_schedule_id
     and draft_shift.starts_at = source_shift.starts_at
     and draft_shift.ends_at = source_shift.ends_at
    left join public.shift_assignments draft_assignment
      on draft_assignment.shift_id = draft_shift.id
     and draft_assignment.employee_id = source_assignment.employee_id
    where source_shift.schedule_id = '85000000-0000-0000-0000-000000000001'
      and source_assignment.status in ('assigned', 'confirmed', 'completed')
      and (
        draft_assignment.id is null
        or draft_assignment.status is distinct from source_assignment.status
        or draft_assignment.assigned_by is distinct from source_assignment.assigned_by
        or draft_assignment.assigned_at is distinct from source_assignment.assigned_at
        or draft_assignment.confirmed_at is distinct from source_assignment.confirmed_at
        or draft_assignment.canceled_at is distinct from source_assignment.canceled_at
        or draft_assignment.cancellation_reason is distinct from source_assignment.cancellation_reason
      )
  ) then
    raise exception 'The draft assignment evidence did not match the published source.';
  end if;

  if exists (
    select 1
    from public.schedule_assignment_overrides source_override
    join public.shifts source_shift on source_shift.id = source_override.shift_id
    join public.shifts draft_shift
      on draft_shift.schedule_id = draft_schedule_id
     and draft_shift.starts_at = source_shift.starts_at
     and draft_shift.ends_at = source_shift.ends_at
    left join public.schedule_assignment_overrides draft_override
      on draft_override.shift_id = draft_shift.id
     and draft_override.employee_id = source_override.employee_id
     and draft_override.override_kind = source_override.override_kind
     and draft_override.note = source_override.note
     and draft_override.created_by = source_override.created_by
     and draft_override.created_at = source_override.created_at
    where source_shift.schedule_id = '85000000-0000-0000-0000-000000000001'
      and draft_override.id is null
  ) then
    raise exception 'The draft override evidence did not match the published source.';
  end if;

  perform public.ensure_schedule_draft(date '2099-10-04');

  if (select count(*) from public.schedules schedule where schedule.week_starts_on = date '2099-10-04' and schedule.status = 'draft') <> 1
     or (select count(*) from public.shifts shift where shift.schedule_id = draft_schedule_id and shift.canceled_at is null) <> first_shift_count
     or (select count(*) from public.shift_assignments assignment join public.shifts shift on shift.id = assignment.shift_id where shift.schedule_id = draft_schedule_id and assignment.status in ('assigned', 'confirmed', 'completed')) <> first_assignment_count
     or (select count(*) from public.schedule_assignment_overrides override_record join public.shifts shift on shift.id = override_record.shift_id where shift.schedule_id = draft_schedule_id) <> first_override_count then
    raise exception 'Repeated draft preparation was not idempotent.';
  end if;
end
$$;

reset role;

-- The workflow above deliberately runs as an authenticated schedule manager.
-- Inspect the private append-only audit ledger only after returning to the
-- migration-test owner; authenticated users must not gain direct ledger read
-- access merely so this regression can assert the write.
do $$
declare
  draft_schedule_id uuid;
begin
  select schedule.id into strict draft_schedule_id
  from public.schedules schedule
  where schedule.week_starts_on = date '2099-10-04'
    and schedule.status = 'draft';

  if (
    select count(*)
    from private.audit_events audit
    where audit.schema_name = 'public'
      and audit.table_name = 'schedules'
      and audit.operation = 'ensure_draft'
      and audit.row_id = draft_schedule_id::text
  ) <> 1 then
    raise exception 'The explicit ensure-draft audit event was not preserved exactly once.';
  end if;
end
$$;

do $$
declare
  ensure_function pg_catalog.pg_proc%rowtype;
  normalize_function pg_catalog.pg_proc%rowtype;
begin
  select * into strict ensure_function
  from pg_catalog.pg_proc
  where oid = 'public.ensure_schedule_draft(date)'::regprocedure;

  select * into strict normalize_function
  from pg_catalog.pg_proc
  where oid = 'private.normalize_schedule_duplicate_shift_blocks(uuid)'::regprocedure;

  if pg_get_userbyid(ensure_function.proowner) <> 'postgres'
     or ensure_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or ensure_function.proconfig is distinct from array['search_path=""']::text[]
     or not ensure_function.prosecdef
     or ensure_function.provolatile <> 'v' then
    raise exception 'The schedule draft function security boundary changed.';
  end if;

  if pg_get_userbyid(normalize_function.proowner) <> 'postgres'
     or normalize_function.proacl::text is distinct from '{postgres=X/postgres}'
     or normalize_function.proconfig is distinct from array['search_path=""']::text[]
     or not normalize_function.prosecdef
     or normalize_function.provolatile <> 'v' then
    raise exception 'The duplicate normalizer security boundary changed.';
  end if;
end
$$;

-- Force a controlled clone failure after the schedule row would normally be
-- created. The caught statement must leave neither the draft nor partial rows.
insert into public.schedules (id, week_starts_on, revision, status, created_by)
values (
  '85000000-0000-0000-0000-000000000002',
  date '2099-10-11',
  1,
  'draft',
  '81000000-0000-0000-0000-000000000001'
);

insert into public.shifts (
  id, schedule_id, post_id, starts_at, ends_at, notes, created_by
) values
  (
    '86000000-0000-0000-0000-000000000001',
    '85000000-0000-0000-0000-000000000002',
    '84000000-0000-0000-0000-000000000001',
    timestamptz '2099-10-11 08:00:00-06',
    timestamptz '2099-10-11 09:00:00-06',
    'Atomic clone first row.',
    '81000000-0000-0000-0000-000000000001'
  ),
  (
    '86000000-0000-0000-0000-000000000002',
    '85000000-0000-0000-0000-000000000002',
    '84000000-0000-0000-0000-000000000001',
    timestamptz '2099-10-11 09:00:00-06',
    timestamptz '2099-10-11 10:00:00-06',
    'FORCE_ATOMIC_CLONE_FAILURE',
    '81000000-0000-0000-0000-000000000001'
  );

update public.schedules
set
  status = 'published',
  published_at = clock_timestamp(),
  published_by = '81000000-0000-0000-0000-000000000001'
where id = '85000000-0000-0000-0000-000000000002';

create function pg_temp.reject_partial_schedule_clone()
returns trigger
language plpgsql
as $$
begin
  if new.notes = 'FORCE_ATOMIC_CLONE_FAILURE' then
    raise exception 'controlled atomic clone failure';
  end if;
  return new;
end
$$;

create trigger schedule_timeout_atomicity_guard
before insert on public.shifts
for each row execute function pg_temp.reject_partial_schedule_clone();

set local role authenticated;
set local "request.jwt.claim.sub" = '82000000-0000-0000-0000-000000000001';
set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
declare
  failed_as_expected boolean := false;
begin
  begin
    perform public.ensure_schedule_draft(date '2099-10-11');
  exception when others then
    failed_as_expected := sqlerrm = 'controlled atomic clone failure';
  end;

  if not failed_as_expected then
    raise exception 'The controlled draft clone failure did not surface.';
  end if;
end
$$;

reset role;

do $$
begin
  if exists (
    select 1
    from public.schedules schedule
    where schedule.week_starts_on = date '2099-10-11'
      and schedule.status = 'draft'
  ) then
    raise exception 'A failed clone retained a partial draft schedule.';
  end if;

  if exists (
    select 1
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    where schedule.week_starts_on = date '2099-10-11'
      and schedule.revision > 1
  ) then
    raise exception 'A failed clone retained partial shift rows.';
  end if;
end
$$;

select 'schedule_draft_timeout_repair_regression: PASS' as result;

rollback;
