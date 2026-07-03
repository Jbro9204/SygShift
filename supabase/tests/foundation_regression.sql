\set ON_ERROR_STOP on

begin;

do $$
declare
  first_username text;
  second_username text;
  third_username text;
begin
  insert into public.employees (id, first_name, last_name)
  values ('00000000-0000-0000-0000-000000000011', 'Jordan', 'Brown')
  returning username into first_username;

  insert into public.employees (id, first_name, last_name)
  values ('00000000-0000-0000-0000-000000000012', 'John', 'Brown')
  returning username into second_username;

  delete from public.employees where id = '00000000-0000-0000-0000-000000000011';

  insert into public.employees (id, first_name, last_name)
  values ('00000000-0000-0000-0000-000000000013', 'Jane', 'Brown')
  returning username into third_username;

  if first_username <> 'jbrown'
    or second_username <> 'jbrown2'
    or third_username <> 'jbrown3'
  then
    raise exception 'Username generation or non-reuse regression.';
  end if;
end
$$;

insert into public.employees (id, first_name, last_name, role)
values
  ('00000000-0000-0000-0000-000000000001', 'Avery', 'Admin', 'admin'),
  ('00000000-0000-0000-0000-000000000002', 'Sam', 'Supervisor', 'supervisor'),
  ('00000000-0000-0000-0000-000000000003', 'Arden', 'Guard', 'guard'),
  ('00000000-0000-0000-0000-000000000004', 'Blake', 'Guard', 'guard'),
  ('00000000-0000-0000-0000-000000000005', 'Casey', 'Guard', 'guard');

insert into auth.users (id, email)
values
  ('10000000-0000-0000-0000-000000000002', 'supervisor@example.invalid'),
  ('10000000-0000-0000-0000-000000000005', 'guard@example.invalid');

insert into private.employee_accounts (employee_id, auth_user_id, activated_at)
values
  (
    '00000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002',
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000005',
    '10000000-0000-0000-0000-000000000005',
    now()
  );

insert into public.sites (id, code, name)
values ('20000000-0000-0000-0000-000000000001', 'TEST', 'Regression Test Site');

insert into public.posts (id, site_id, name, requires_armed)
values
  (
    '30000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'Armed Post',
    true
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001',
    'Unarmed Post',
    false
  );

insert into public.schedules (id, week_starts_on, created_by)
values (
  '40000000-0000-0000-0000-000000000001',
  date '2026-07-05',
  '00000000-0000-0000-0000-000000000002'
);

insert into public.shifts (
  id,
  schedule_id,
  post_id,
  starts_at,
  ends_at,
  headcount_required,
  created_by
) values
  (
    '50000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    timestamptz '2026-07-06 08:00:00-06',
    timestamptz '2026-07-06 16:00:00-06',
    1,
    '00000000-0000-0000-0000-000000000002'
  ),
  (
    '50000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002',
    timestamptz '2026-07-06 09:00:00-06',
    timestamptz '2026-07-06 17:00:00-06',
    2,
    '00000000-0000-0000-0000-000000000002'
  ),
  (
    '50000000-0000-0000-0000-000000000003',
    '40000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002',
    timestamptz '2026-07-07 08:00:00-06',
    timestamptz '2026-07-07 16:00:00-06',
    1,
    '00000000-0000-0000-0000-000000000002'
  );

do $$
declare
  blocked boolean := false;
begin
  begin
    insert into public.shift_assignments (
      shift_id,
      employee_id,
      assigned_by
    ) values (
      '50000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000002'
    );
  exception when others then
    blocked := sqlerrm like '%valid armed qualification%';
  end;
  if not blocked then
    raise exception 'Unqualified armed assignment was not blocked.';
  end if;
end
$$;

insert into public.employee_credentials (
  employee_id,
  kind,
  status,
  valid_from,
  expires_on
) values
  (
    '00000000-0000-0000-0000-000000000003',
    'armed_guard',
    'active',
    date '2026-01-01',
    date '2026-12-31'
  ),
  (
    '00000000-0000-0000-0000-000000000004',
    'armed_guard',
    'active',
    date '2026-01-01',
    date '2026-12-31'
  );

insert into public.shift_assignments (shift_id, employee_id, assigned_by)
values (
  '50000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000002'
);

do $$
declare
  capacity_blocked boolean := false;
  overlap_blocked boolean := false;
begin
  begin
    insert into public.shift_assignments (shift_id, employee_id, assigned_by)
    values (
      '50000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000004',
      '00000000-0000-0000-0000-000000000002'
    );
  exception when others then
    capacity_blocked := sqlerrm like '%required number%';
  end;

  begin
    insert into public.shift_assignments (shift_id, employee_id, assigned_by)
    values (
      '50000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000002'
    );
  exception when others then
    overlap_blocked := sqlerrm like '%overlapping shift%';
  end;

  if not capacity_blocked then
    raise exception 'Shift capacity regression.';
  end if;
  if not overlap_blocked then
    raise exception 'Shift overlap regression.';
  end if;
end
$$;

update public.schedules
set
  status = 'published',
  published_at = now(),
  published_by = '00000000-0000-0000-0000-000000000002'
where id = '40000000-0000-0000-0000-000000000001';

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000005';
set local "request.jwt.claims" = '{"aal":"aal1"}';

select 1 / case when count(*) = 0 then 1 else 0 end as armed_shift_hidden
from public.shifts
where id = '50000000-0000-0000-0000-000000000001';

select 1 / case when count(*) = 1 then 1 else 0 end as unarmed_shift_visible
from public.shifts
where id = '50000000-0000-0000-0000-000000000003';

reset role;

do $$
declare
  update_blocked boolean := false;
  insert_blocked boolean := false;
begin
  begin
    update public.shifts
    set notes = 'This must not be saved.'
    where id = '50000000-0000-0000-0000-000000000001';
  exception when others then
    update_blocked := sqlerrm like '%Published schedule records are immutable%';
  end;

  begin
    insert into public.shifts (
      schedule_id,
      post_id,
      starts_at,
      ends_at,
      created_by
    ) values (
      '40000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002',
      timestamptz '2026-07-08 08:00:00-06',
      timestamptz '2026-07-08 16:00:00-06',
      '00000000-0000-0000-0000-000000000002'
    );
  exception when others then
    insert_blocked := sqlerrm like '%Published schedule records are immutable%';
  end;

  if not update_blocked or not insert_blocked then
    raise exception 'Published schedule immutability regression.';
  end if;
end
$$;

insert into public.time_events (
  id,
  employee_id,
  shift_id,
  kind,
  source,
  idempotency_key
) values (
  '60000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000003',
  '50000000-0000-0000-0000-000000000001',
  'clock_in',
  'web',
  'regression-clock-in'
);

do $$
declare
  blocked boolean := false;
begin
  begin
    update public.time_events
    set recorded_at = recorded_at + interval '1 minute'
    where id = '60000000-0000-0000-0000-000000000001';
  exception when others then
    blocked := sqlerrm like '%append-only%';
  end;
  if not blocked then
    raise exception 'Time event append-only regression.';
  end if;
end
$$;

insert into private.source_files (
  id,
  original_filename,
  sha256,
  byte_size,
  storage_path
) values (
  '70000000-0000-0000-0000-000000000001',
  'regression.xlsx',
  repeat('a', 64),
  1,
  'private/regression.xlsx'
);

insert into private.import_runs (
  id,
  source_file_id,
  status,
  extractor_version,
  blocking_issue_count,
  reconciliation_digest
) values (
  '71000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000001',
  'reconciled',
  'regression',
  1,
  repeat('b', 64)
);

insert into private.import_candidates (
  id,
  import_run_id,
  kind,
  candidate_key,
  confidence,
  payload,
  fingerprint
) values (
  '72000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000001',
  'employee',
  'regression',
  'blocking_review',
  '{}'::jsonb,
  repeat('c', 64)
);

insert into private.import_issues (
  id,
  import_run_id,
  severity,
  code,
  message
) values (
  '73000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000001',
  'blocking',
  'REGRESSION',
  'Regression promotion blocker'
);

do $$
declare
  blocked boolean := false;
begin
  begin
    update private.import_runs
    set status = 'promoted'
    where id = '71000000-0000-0000-0000-000000000001';
  exception when others then
    blocked := sqlerrm like '%not eligible for promotion%';
  end;
  if not blocked then
    raise exception 'Unsafe import promotion was not blocked.';
  end if;
end
$$;

update private.import_candidates
set
  review_status = 'accepted',
  reviewed_by = '00000000-0000-0000-0000-000000000001',
  reviewed_at = now(),
  review_note = 'Regression approval'
where id = '72000000-0000-0000-0000-000000000001';

update private.import_issues
set
  resolution = 'Regression resolution',
  resolved_by = '00000000-0000-0000-0000-000000000001',
  resolved_at = now()
where id = '73000000-0000-0000-0000-000000000001';

update private.import_runs
set blocking_issue_count = 0
where id = '71000000-0000-0000-0000-000000000001';

update private.import_runs
set status = 'promoted', promoted_at = now(), promoted_by = '00000000-0000-0000-0000-000000000001'
where id = '71000000-0000-0000-0000-000000000001';

select 1 / case when status = 'promoted' then 1 else 0 end as safe_import_promoted
from private.import_runs
where id = '71000000-0000-0000-0000-000000000001';

select 'foundation_regression: PASS' as result;

rollback;
