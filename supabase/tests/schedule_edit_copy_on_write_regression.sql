\set ON_ERROR_STOP on

begin;

set local statement_timeout = '7s';

insert into public.employees (id, first_name, last_name, role)
values
  ('8a000000-0000-0000-0000-000000000001', 'Copy', 'OnWriteSupervisor', 'supervisor'),
  ('8a000000-0000-0000-0000-000000000002', 'Assigned', 'Guard', 'guard');

insert into auth.users (id, email)
values ('8b000000-0000-0000-0000-000000000001', 'schedule-copy-on-write@example.invalid');

insert into private.employee_accounts (employee_id, auth_user_id, activated_at)
values (
  '8a000000-0000-0000-0000-000000000001',
  '8b000000-0000-0000-0000-000000000001',
  clock_timestamp()
);

insert into public.sites (id, code, name, time_zone)
values (
  '8c000000-0000-0000-0000-000000000001',
  'COPY-ON-WRITE',
  'Schedule Copy On Write',
  'America/Denver'
);

insert into public.posts (id, site_id, name, requires_armed)
values (
  '8d000000-0000-0000-0000-000000000001',
  '8c000000-0000-0000-0000-000000000001',
  'Schedule Copy On Write Post',
  false
);

insert into public.schedules (
  id, week_starts_on, revision, status, created_by
) values
  (
    '8e000000-0000-0000-0000-000000000001',
    date '2099-10-25',
    1,
    'draft',
    '8a000000-0000-0000-0000-000000000001'
  ),
  (
    '8e000000-0000-0000-0000-000000000002',
    date '2099-11-01',
    1,
    'draft',
    '8a000000-0000-0000-0000-000000000001'
  );

insert into public.shifts (
  id, schedule_id, post_id, starts_at, ends_at, time_zone,
  headcount_required, requires_armed, is_open, is_overtime,
  notes, work_type, payroll_category, created_by
) values
  (
    '8f000000-0000-0000-0000-000000000001',
    '8e000000-0000-0000-0000-000000000001',
    '8d000000-0000-0000-0000-000000000001',
    timestamptz '2099-10-25 08:00:00-06',
    timestamptz '2099-10-25 16:00:00-06',
    'America/Denver',
    1,
    false,
    true,
    false,
    'Published source must remain immutable.',
    'post',
    'regular',
    '8a000000-0000-0000-0000-000000000001'
  ),
  (
    '8f000000-0000-0000-0000-000000000002',
    '8e000000-0000-0000-0000-000000000002',
    '8d000000-0000-0000-0000-000000000001',
    timestamptz '2099-11-01 08:00:00-07',
    timestamptz '2099-11-01 16:00:00-07',
    'America/Denver',
    1,
    false,
    true,
    false,
    'Atomic failure source must remain immutable.',
    'post',
    'regular',
    '8a000000-0000-0000-0000-000000000001'
  );

-- Qualification and availability evidence must exist before the assignment,
-- matching the reviewed 142017 materializer order and its trigger contract.
insert into public.schedule_assignment_overrides (
  shift_id, employee_id, override_kind, note, created_by
) values (
  '8f000000-0000-0000-0000-000000000001',
  '8a000000-0000-0000-0000-000000000002',
  'availability',
  'Source availability evidence must survive materialization.',
  '8a000000-0000-0000-0000-000000000001'
);

insert into public.shift_assignments (
  shift_id, employee_id, status, assigned_by, assigned_at
) values (
  '8f000000-0000-0000-0000-000000000001',
  '8a000000-0000-0000-0000-000000000002',
  'assigned',
  '8a000000-0000-0000-0000-000000000001',
  clock_timestamp()
);

update public.schedules schedule
set
  status = 'published',
  published_at = clock_timestamp(),
  published_by = '8a000000-0000-0000-0000-000000000001'
where schedule.id in (
  '8e000000-0000-0000-0000-000000000001',
  '8e000000-0000-0000-0000-000000000002'
);

select set_config(
  'test.schedule_copy_on_write_source_token',
  private.schedule_shift_version_token(
    schedule.id, schedule.revision, schedule.status, schedule.updated_at,
    shift.id, shift.updated_at
  ),
  false
)
from public.shifts shift
join public.schedules schedule on schedule.id = shift.schedule_id
where shift.id = '8f000000-0000-0000-0000-000000000001';

select set_config(
  'test.schedule_copy_on_write_failure_token',
  private.schedule_shift_version_token(
    schedule.id, schedule.revision, schedule.status, schedule.updated_at,
    shift.id, shift.updated_at
  ),
  false
)
from public.shifts shift
join public.schedules schedule on schedule.id = shift.schedule_id
where shift.id = '8f000000-0000-0000-0000-000000000002';

-- An MFA failure is rejected before any revision is materialized.
set local role authenticated;
set local "request.jwt.claim.sub" = '8b000000-0000-0000-0000-000000000001';
set local "request.jwt.claims" = '{"aal":"aal1"}';

do $$
declare
  denied boolean := false;
begin
  begin
    perform public.scheduler_materialize_and_update_shift_v1(
      target_shift_id => '8f000000-0000-0000-0000-000000000001',
      expected_shift_version => current_setting('test.schedule_copy_on_write_source_token'),
      shift_operational_date => date '2099-10-25',
      shift_start_time => time '09:00',
      shift_end_time => time '17:00',
      target_headcount => 1,
      target_is_open => true,
      target_is_overtime => false,
      target_notes => 'Denied write',
      target_work_type => 'post'
    );
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'An AAL1 schedule edit was not denied.';
  end if;
end
$$;

reset role;

do $$
begin
  if exists (
    select 1 from public.schedules schedule
    where schedule.week_starts_on = date '2099-10-25'
      and schedule.status = 'draft'
  ) then
    raise exception 'A denied edit materialized a draft.';
  end if;
end
$$;

-- Save performs the first mutation: one draft, one exact lineage row, and the
-- requested edit in the draft while retaining the published evidence.
set local role authenticated;
set local "request.jwt.claim.sub" = '8b000000-0000-0000-0000-000000000001';
set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
declare
  payload jsonb;
begin
  payload := public.scheduler_materialize_and_update_shift_v1(
    target_shift_id => '8f000000-0000-0000-0000-000000000001',
    expected_shift_version => current_setting('test.schedule_copy_on_write_source_token'),
    shift_operational_date => date '2099-10-25',
    shift_start_time => time '09:00',
    shift_end_time => time '17:00',
    target_headcount => 1,
    target_is_open => true,
    target_is_overtime => false,
    target_notes => 'Saved only in the working draft.',
    target_work_type => 'post',
    target_employee_id => '8a000000-0000-0000-0000-000000000002',
    target_payroll_category => 'regular'
  );

  if payload ->> 'status' <> 'draft' then
    raise exception 'The atomic edit did not return the working draft.';
  end if;
  if nullif(payload -> 'shifts' -> 0 ->> 'versionToken', '') is null then
    raise exception 'The saved draft payload did not return a shift version token.';
  end if;
  if payload -> 'shifts' -> 0 ->> 'work_type' <> 'post'
     or payload -> 'shifts' -> 0 ->> 'assignment_type' <> 'standard'
     or payload -> 'shifts' -> 0 ->> 'payrollCategory' <> 'regular' then
    raise exception 'The saved draft payload did not return the final row-backed shift fields.';
  end if;
end
$$;

reset role;

do $$
declare
  materialized_schedule_id uuid;
  draft_shift_id uuid;
begin
  select schedule.id into strict materialized_schedule_id
  from public.schedules schedule
  where schedule.week_starts_on = date '2099-10-25'
    and schedule.status = 'draft';

  select link.draft_shift_id into strict draft_shift_id
  from private.schedule_shift_revision_links link
  where link.draft_schedule_id = materialized_schedule_id
    and link.source_shift_id = '8f000000-0000-0000-0000-000000000001';

  if draft_shift_id = '8f000000-0000-0000-0000-000000000001' then
    raise exception 'The draft reused the immutable source shift identity.';
  end if;
  if not exists (
    select 1 from public.shifts shift
    where shift.id = draft_shift_id
      and shift.starts_at = timestamptz '2099-10-25 09:00:00-06'
      and shift.ends_at = timestamptz '2099-10-25 17:00:00-06'
      and shift.notes = 'Saved only in the working draft.'
  ) then
    raise exception 'The requested edit was not applied to the exact draft copy.';
  end if;
  if not exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = draft_shift_id
      and assignment.employee_id = '8a000000-0000-0000-0000-000000000002'
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) then
    raise exception 'The assigned employee was not preserved through materialization and edit.';
  end if;
  if not exists (
    select 1
    from public.schedule_assignment_overrides override_record
    where override_record.shift_id = draft_shift_id
      and override_record.employee_id = '8a000000-0000-0000-0000-000000000002'
      and override_record.override_kind = 'availability'
      and override_record.note = 'Source availability evidence must survive materialization.'
  ) then
    raise exception 'The assignment override evidence was not preserved through materialization and edit.';
  end if;
  if not exists (
    select 1 from public.shifts shift
    where shift.id = '8f000000-0000-0000-0000-000000000001'
      and shift.starts_at = timestamptz '2099-10-25 08:00:00-06'
      and shift.ends_at = timestamptz '2099-10-25 16:00:00-06'
      and shift.notes = 'Published source must remain immutable.'
  ) then
    raise exception 'The published source shift was changed.';
  end if;
  if (select count(*) from public.schedules schedule where schedule.week_starts_on = date '2099-10-25' and schedule.status = 'draft') <> 1
     or (select count(*) from private.schedule_shift_revision_links link where link.draft_schedule_id = materialized_schedule_id) <> 1 then
    raise exception 'The first Save did not create exactly one draft and lineage row.';
  end if;
end
$$;

-- A repeated published-source request cannot overwrite the working revision
-- created by the first Save. It fails closed without duplicating the week.
set local role authenticated;
set local "request.jwt.claim.sub" = '8b000000-0000-0000-0000-000000000001';
set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
declare
  rejected_as_stale boolean := false;
begin
  begin
    perform public.scheduler_materialize_and_update_shift_v1(
      target_shift_id => '8f000000-0000-0000-0000-000000000001',
      expected_shift_version => current_setting('test.schedule_copy_on_write_source_token'),
      shift_operational_date => date '2099-10-25',
      shift_start_time => time '09:00',
      shift_end_time => time '17:00',
      target_headcount => 1,
      target_is_open => true,
      target_is_overtime => false,
      target_notes => 'Repeated stale save must not win.',
      target_work_type => 'post',
      target_employee_id => '8a000000-0000-0000-0000-000000000002',
      target_payroll_category => 'regular'
    );
  exception when serialization_failure then
    rejected_as_stale := true;
  end;

  if not rejected_as_stale then
    raise exception 'A repeated published-source Save overwrote the current draft.';
  end if;
end
$$;

reset role;

do $$
begin
  if (select count(*) from public.schedules schedule where schedule.week_starts_on = date '2099-10-25' and schedule.status = 'draft') <> 1
     or (select count(*) from private.schedule_shift_revision_links link where link.source_shift_id = '8f000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'A repeated stale Save duplicated the revision or shift lineage.';
  end if;
end
$$;

-- A direct draft editor carries the exact row/revision token. A concurrent
-- save changes updated_at, so the stale editor must fail before overwriting it.
select set_config(
  'test.schedule_copy_on_write_draft_token',
  private.schedule_shift_version_token(
    schedule.id, schedule.revision, schedule.status, schedule.updated_at,
    shift.id, shift.updated_at
  ),
  false
)
from private.schedule_shift_revision_links link
join public.shifts shift on shift.id = link.draft_shift_id
join public.schedules schedule on schedule.id = shift.schedule_id
where link.source_shift_id = '8f000000-0000-0000-0000-000000000001';

select set_config(
  'test.schedule_copy_on_write_draft_shift_id',
  link.draft_shift_id::text,
  false
)
from private.schedule_shift_revision_links link
where link.source_shift_id = '8f000000-0000-0000-0000-000000000001';

update public.shifts shift
set notes = 'Concurrent scheduler saved this value.'
where shift.id = (
  select link.draft_shift_id
  from private.schedule_shift_revision_links link
  where link.source_shift_id = '8f000000-0000-0000-0000-000000000001'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '8b000000-0000-0000-0000-000000000001';
set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
declare
  draft_shift_id uuid;
  denied_as_stale boolean := false;
begin
  draft_shift_id := current_setting('test.schedule_copy_on_write_draft_shift_id')::uuid;

  begin
    perform public.scheduler_materialize_and_update_shift_v1(
      target_shift_id => draft_shift_id,
      expected_shift_version => current_setting('test.schedule_copy_on_write_draft_token'),
      shift_operational_date => date '2099-10-25',
      shift_start_time => time '10:00',
      shift_end_time => time '18:00',
      target_headcount => 1,
      target_is_open => true,
      target_is_overtime => false,
      target_notes => 'Stale scheduler must not win.',
      target_work_type => 'post'
    );
  exception when serialization_failure then
    denied_as_stale := true;
  end;

  if not denied_as_stale then
    raise exception 'A stale direct-draft editor overwrote a concurrent save.';
  end if;
end
$$;

reset role;

do $$
begin
  if not exists (
    select 1 from public.shifts shift
    where shift.id = (
      select link.draft_shift_id
      from private.schedule_shift_revision_links link
      where link.source_shift_id = '8f000000-0000-0000-0000-000000000001'
    )
      and shift.notes = 'Concurrent scheduler saved this value.'
      and shift.starts_at = timestamptz '2099-10-25 09:00:00-06'
      and shift.ends_at = timestamptz '2099-10-25 17:00:00-06'
  ) then
    raise exception 'The stale-save rejection did not preserve the concurrent edit.';
  end if;
end
$$;

-- Any validation failure after materialization rolls the new draft and its
-- lineage back with the same database statement.
set local role authenticated;
set local "request.jwt.claim.sub" = '8b000000-0000-0000-0000-000000000001';
set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
declare
  failed_as_expected boolean := false;
begin
  begin
    perform public.scheduler_materialize_and_update_shift_v1(
      target_shift_id => '8f000000-0000-0000-0000-000000000002',
      expected_shift_version => current_setting('test.schedule_copy_on_write_failure_token'),
      shift_operational_date => null,
      shift_start_time => time '09:00',
      shift_end_time => time '17:00',
      target_headcount => 1,
      target_is_open => true,
      target_is_overtime => false,
      target_notes => 'Must roll back',
      target_work_type => 'post'
    );
  exception when check_violation then
    failed_as_expected := true;
  end;

  if not failed_as_expected then
    raise exception 'The controlled edit validation failure did not surface.';
  end if;
end
$$;

reset role;

do $$
begin
  if exists (
    select 1 from public.schedules schedule
    where schedule.week_starts_on = date '2099-11-01'
      and schedule.status = 'draft'
  ) then
    raise exception 'A failed Save retained a partial draft.';
  end if;
  if exists (
    select 1 from private.schedule_shift_revision_links link
    where link.source_shift_id = '8f000000-0000-0000-0000-000000000002'
  ) then
    raise exception 'A failed Save retained partial shift lineage.';
  end if;
  if not exists (
    select 1 from public.shifts shift
    where shift.id = '8f000000-0000-0000-0000-000000000002'
      and shift.notes = 'Atomic failure source must remain immutable.'
  ) then
    raise exception 'A failed Save changed its published source.';
  end if;
end
$$;

select 'schedule_edit_copy_on_write_regression: PASS' as result;

rollback;
