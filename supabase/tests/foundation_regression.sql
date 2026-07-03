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
  ('10000000-0000-0000-0000-000000000001', 'admin@example.invalid'),
  ('10000000-0000-0000-0000-000000000002', 'supervisor@example.invalid'),
  ('10000000-0000-0000-0000-000000000003', 'armed-guard@example.invalid'),
  ('10000000-0000-0000-0000-000000000004', 'replacement-guard@example.invalid'),
  ('10000000-0000-0000-0000-000000000005', 'guard@example.invalid');

insert into private.employee_accounts (employee_id, auth_user_id, activated_at)
values
  (
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002',
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000003',
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000004',
    '10000000-0000-0000-0000-000000000004',
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000005',
    '10000000-0000-0000-0000-000000000005',
    now()
  );

insert into private.employee_contacts (employee_id, company_email, mobile_phone)
values (
  '00000000-0000-0000-0000-000000000005',
  'casey@example.invalid',
  '555-0105'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000005';
set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_employee_directory();
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Guard accessed the protected employee directory.';
  end if;
end
$$;

set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000002';
set local "request.jwt.claims" = '{"aal":"aal1"}';

do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_employee_directory();
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Supervisor accessed protected directory without MFA.';
  end if;
end
$$;

set local "request.jwt.claims" = '{"aal":"aal2"}';

select 1 / case when count(*) = 1 then 1 else 0 end as protected_directory_visible
from public.get_employee_directory()
where id = '00000000-0000-0000-0000-000000000005'
  and company_email = 'casey@example.invalid'
  and mobile_phone = '555-0105';

reset role;

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
  date '2099-07-05',
  '00000000-0000-0000-0000-000000000002'
);

insert into public.shifts (
  id,
  schedule_id,
  post_id,
  starts_at,
  ends_at,
  headcount_required,
  is_open,
  created_by
) values
  (
    '50000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    timestamptz '2099-07-06 08:00:00-06',
    timestamptz '2099-07-06 16:00:00-06',
    1,
    false,
    '00000000-0000-0000-0000-000000000002'
  ),
  (
    '50000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002',
    timestamptz '2099-07-06 09:00:00-06',
    timestamptz '2099-07-06 17:00:00-06',
    2,
    false,
    '00000000-0000-0000-0000-000000000002'
  ),
  (
    '50000000-0000-0000-0000-000000000003',
    '40000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002',
    timestamptz '2099-07-07 08:00:00-06',
    timestamptz '2099-07-07 16:00:00-06',
    1,
    true,
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
    date '2100-12-31'
  ),
  (
    '00000000-0000-0000-0000-000000000004',
    'armed_guard',
    'active',
    date '2026-01-01',
    date '2100-12-31'
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

do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.submit_shift_request(
      '50000000-0000-0000-0000-000000000001',
      null
    );
  exception when check_violation then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Unqualified guard requested an armed opening.';
  end if;
end
$$;

select public.submit_shift_request(
  '50000000-0000-0000-0000-000000000003',
  'Available for this opening.'
) as submitted_shift_request;

select 1 / case when count(*) = 1 then 1 else 0 end as pending_request_created
from public.shift_requests
where shift_id = '50000000-0000-0000-0000-000000000003'
  and employee_id = '00000000-0000-0000-0000-000000000005'
  and status = 'pending';

select public.withdraw_shift_request(id) as request_withdrawn
from public.shift_requests
where shift_id = '50000000-0000-0000-0000-000000000003'
  and employee_id = '00000000-0000-0000-0000-000000000005';

select 1 / case when count(*) = 1 then 1 else 0 end as withdrawn_request_preserved
from public.shift_requests
where shift_id = '50000000-0000-0000-0000-000000000003'
  and employee_id = '00000000-0000-0000-0000-000000000005'
  and status = 'withdrawn';

select public.submit_time_off_request(
  date '2099-07-07',
  date '2099-07-07',
  null,
  null,
  'Planned time off regression.'
) as submitted_time_off_request;

do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.submit_time_off_request(
      date '2099-07-07',
      date '2099-07-08',
      null,
      null,
      'This overlaps an active request.'
    );
  exception when unique_violation then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Overlapping time-off request was accepted.';
  end if;
end
$$;

reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000003';
set local "request.jwt.claims" = '{"aal":"aal1"}';

select public.report_call_off(
  '50000000-0000-0000-0000-000000000001',
  'Unable to work the assigned shift.'
) as submitted_call_off;

select public.submit_time_off_request(
  date '2099-07-06',
  date '2099-07-06',
  null,
  null,
  'Time off overlaps the assigned shift.'
) as assigned_employee_time_off;

do $$
declare
  blocked boolean := false;
  call_off_id uuid;
begin
  select id into call_off_id
  from public.call_off_reports
  where shift_id = '50000000-0000-0000-0000-000000000001';

  begin
    perform public.publish_call_off_opening(
      call_off_id,
      'Replacement guard needed',
      'A qualified guard may request this opening.'
    );
  exception when others then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Guard published a call-off announcement.';
  end if;
end
$$;

reset role;

select 1 / case when count(*) = 1 then 1 else 0 end as supervisor_alert_queued
from private.notification_outbox
where message_type = 'call_off_supervisor_alert';

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000002';
set local "request.jwt.claims" = '{"aal":"aal1"}';

do $$
declare
  blocked boolean := false;
  call_off_id uuid;
begin
  select id into call_off_id
  from public.call_off_reports
  where shift_id = '50000000-0000-0000-0000-000000000001';

  begin
    perform public.publish_call_off_opening(
      call_off_id,
      'Replacement guard needed',
      'A qualified guard may request this opening.'
    );
  exception when others then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Supervisor published a call-off announcement without MFA.';
  end if;
end
$$;

set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
declare
  blocked boolean := false;
  time_off_id uuid;
begin
  select id into time_off_id
  from public.time_off_requests
  where employee_id = '00000000-0000-0000-0000-000000000003'
    and status = 'pending';

  begin
    perform public.decide_time_off_request(time_off_id, 'approved', null);
  exception when check_violation then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Time off was approved while an overlapping assignment remained active.';
  end if;
end
$$;

select public.publish_call_off_opening(
  id,
  'Replacement guard needed',
  'A qualified guard may request this opening.'
) as call_off_opening_published
from public.call_off_reports
where shift_id = '50000000-0000-0000-0000-000000000001';

select public.decide_time_off_request(id, 'approved', null) as assigned_time_off_approved
from public.time_off_requests
where employee_id = '00000000-0000-0000-0000-000000000003'
  and status = 'pending';

select public.decide_time_off_request(id, 'approved', null) as guard_time_off_approved
from public.time_off_requests
where employee_id = '00000000-0000-0000-0000-000000000005'
  and status = 'pending';

do $$
declare
  blocked boolean := false;
begin
  begin
    insert into public.shift_assignments (shift_id, employee_id, assigned_by)
    values (
      '50000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000005',
      '00000000-0000-0000-0000-000000000002'
    );
  exception when others then
    blocked := sqlerrm like '%approved time off%';
  end;
  if not blocked then
    raise exception 'Assignment ignored approved time off.';
  end if;
end
$$;

reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000004';
set local "request.jwt.claims" = '{"aal":"aal1"}';

select public.submit_shift_request(
  '50000000-0000-0000-0000-000000000001',
  'Available as the replacement guard.'
) as replacement_request_submitted;

reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000002';
set local "request.jwt.claims" = '{"aal":"aal2"}';

select public.decide_shift_request(id, 'approved', null) as replacement_request_approved
from public.shift_requests
where shift_id = '50000000-0000-0000-0000-000000000001'
  and employee_id = '00000000-0000-0000-0000-000000000004'
  and status = 'pending';

select 1 / case when count(*) = 1 then 1 else 0 end as replacement_assignment_created
from public.shift_assignments
where shift_id = '50000000-0000-0000-0000-000000000001'
  and employee_id = '00000000-0000-0000-0000-000000000004'
  and status = 'assigned';

select 1 / case when count(*) = 1 then 1 else 0 end as filled_shift_closed
from public.shifts
where id = '50000000-0000-0000-0000-000000000001'
  and is_open = false;

reset role;

select 1 / case when count(*) = 1 then 1 else 0 end as announcement_delivery_queued
from private.notification_outbox
where message_type = 'announcement_published';

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
      timestamptz '2099-07-08 08:00:00-06',
      timestamptz '2099-07-08 16:00:00-06',
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

insert into private.source_sheets (
  id,
  import_run_id,
  sheet_index,
  name,
  max_row,
  max_column
) values (
  '74000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000001',
  0,
  'Formatting-only regression',
  0,
  0
);

select public.ingest_ooxml_cell_metadata(
  '71000000-0000-0000-0000-000000000001',
  '[{"sheetIndex":0,"address":"AA12","bold":true}]'::jsonb
) as formatting_only_metadata_ingested;

select 1 / case when count(*) = 1 then 1 else 0 end as formatting_only_cell_preserved
from private.source_cells cell
join private.source_cell_metadata metadata on metadata.source_cell_id = cell.id
where cell.source_sheet_id = '74000000-0000-0000-0000-000000000001'
  and cell.cell_address = 'AA12'
  and cell.row_number = 12
  and cell.column_number = 27
  and cell.evidence_origin = 'ooxml_only'
  and metadata.bold;

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

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000002';
set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_import_review_summary();
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Supervisor accessed the Admin-only import review center.';
  end if;
end
$$;

set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000001';
set local "request.jwt.claims" = '{"aal":"aal1"}';

do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_import_review_summary();
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Administrator accessed import review without MFA.';
  end if;
end
$$;

set local "request.jwt.claims" = '{"aal":"aal2"}';

select 1 / case when summary ->> 'importRunId' = '71000000-0000-0000-0000-000000000001'
  and (summary ->> 'candidateCount')::integer = 0
  and (summary ->> 'blockingIssueCount')::integer = 1
then 1 else 0 end as import_review_summary_visible
from (select public.get_import_review_summary() as summary) review;

select 1 / case when count(*) = 1 then 1 else 0 end as pending_import_candidate_visible
from public.get_import_candidates_page(
  '71000000-0000-0000-0000-000000000001',
  'employee',
  'pending',
  50,
  0
)
where id = '72000000-0000-0000-0000-000000000001'
  and total_count = 1;

select 1 / case when count(*) = 1 then 1 else 0 end as blocking_import_issue_visible
from public.get_import_issues_page(
  '71000000-0000-0000-0000-000000000001',
  'blocking',
  false,
  50,
  0
)
where id = '73000000-0000-0000-0000-000000000001'
  and total_count = 1;

select public.review_import_candidate(
  '72000000-0000-0000-0000-000000000001',
  'accepted',
  'Regression approval'
) as import_candidate_reviewed;

select public.resolve_import_issue(
  '73000000-0000-0000-0000-000000000001',
  'Regression resolution'
) as import_issue_resolved;

reset role;

select 1 / case when count(*) = 2 then 1 else 0 end as import_review_history_preserved
from private.import_review_decisions
where import_run_id = '71000000-0000-0000-0000-000000000001';

select 1 / case when blocking_issue_count = 0 then 1 else 0 end as import_issue_counts_reconciled
from private.import_runs
where id = '71000000-0000-0000-0000-000000000001';

update private.import_runs
set status = 'promoted', promoted_at = now(), promoted_by = '00000000-0000-0000-0000-000000000001'
where id = '71000000-0000-0000-0000-000000000001';

select 1 / case when status = 'promoted' then 1 else 0 end as safe_import_promoted
from private.import_runs
where id = '71000000-0000-0000-0000-000000000001';

insert into private.import_runs (
  id,
  source_file_id,
  status,
  extractor_version,
  reconciliation_digest
) values (
  '81000000-0000-4000-8000-000000000001',
  '70000000-0000-0000-0000-000000000001',
  'review',
  'mapping-regression',
  repeat('d', 64)
);

insert into private.import_candidates (
  id,
  import_run_id,
  kind,
  candidate_key,
  confidence,
  payload,
  fingerprint
) values
  (
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'employee',
    'mapping-regression-employee',
    'review',
    '{"name":"Regression Guard","roleCandidate":"guard","statusCandidate":"active","armed":false}'::jsonb,
    repeat('e', 64)
  ),
  (
    '83000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'site',
    'regression-site',
    'review',
    '{"siteKeyCandidate":"regression-site","labelVariants":["Regression Site"],"qualificationCandidate":"unarmed"}'::jsonb,
    repeat('f', 64)
  ),
  (
    '84000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'weekly_schedule',
    'mapping-regression-schedule',
    'review',
    '{"weekStartsOn":"2099-08-02"}'::jsonb,
    repeat('0', 64)
  ),
  (
    '85000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'shift',
    'mapping-regression-shift',
    'review',
    '{"localDate":"2099-08-03","startTime":"08:00","endTime":"16:00","crossesMidnight":false,"siteKeyCandidate":"regression-site","contextLabel":"Regression Site","assigneeLabel":"Regression Guard","sourceSchedule":{"weekStartsOn":"2099-08-02"}}'::jsonb,
    repeat('1', 64)
  ),
  (
    '86000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'weekly_schedule',
    'mapping-regression-schedule-2',
    'review',
    '{"weekStartsOn":"2099-08-09"}'::jsonb,
    repeat('2', 64)
  ),
  (
    '87000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'shift',
    'mapping-regression-shift-2',
    'review',
    '{"localDate":"2099-08-10","startTime":"08:00","endTime":"16:00","crossesMidnight":false,"siteKeyCandidate":"regression-site","contextLabel":"Regression Site","assigneeLabel":"Regression Guard","sourceSchedule":{"weekStartsOn":"2099-08-09"}}'::jsonb,
    repeat('3', 64)
  );

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000002';
set local "request.jwt.claims" = '{"aal":"aal2"}';

do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_import_mapping_readiness(
      '81000000-0000-4000-8000-000000000001',
      date '2099-08-02',
      date '2099-08-08'
    );
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then
    raise exception 'Supervisor accessed the Admin-only operational import mapping.';
  end if;
end
$$;

set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000001';

select public.save_import_employee_mapping(
  '82000000-0000-4000-8000-000000000001',
  'Regression',
  null,
  'Guard',
  null,
  'guard',
  'hourly',
  'active',
  null,
  null,
  null,
  null,
  null,
  'not_armed',
  null,
  null,
  'Regression employee mapping'
) as employee_mapping_saved;

select public.save_import_site_mapping(
  '83000000-0000-4000-8000-000000000001',
  'regression-site',
  'REG2',
  'Mapped Regression Site',
  'Mapped Post',
  false,
  true,
  'Regression site mapping'
) as site_mapping_saved;

select public.save_import_assignee_alias_mapping(
  '81000000-0000-4000-8000-000000000001',
  'Regression Guard',
  'employee',
  array['candidate:82000000-0000-4000-8000-000000000001'],
  'Regression alias mapping'
) as alias_mapping_saved;

select public.accept_import_schedule_scope(
  '81000000-0000-4000-8000-000000000001',
  date '2099-08-02',
  date '2099-08-08',
  'Regression schedule acceptance'
) as schedule_scope_accepted;

select 1 / case when (readiness ->> 'directoryReady')::boolean
  and (readiness ->> 'scheduleReady')::boolean
  and (readiness ->> 'shiftCandidateCount')::integer = 1
then 1 else 0 end as mapping_scope_ready
from (
  select public.get_import_mapping_readiness(
    '81000000-0000-4000-8000-000000000001',
    date '2099-08-02',
    date '2099-08-08'
  ) readiness
) review;

select public.promote_import_scope(
  '81000000-0000-4000-8000-000000000001',
  date '2099-08-02',
  date '2099-08-08',
  false,
  'Regression atomic promotion'
) as mapping_scope_promoted;

select public.accept_import_schedule_scope(
  '81000000-0000-4000-8000-000000000001',
  date '2099-08-09',
  date '2099-08-15',
  'Regression second schedule acceptance'
) as second_schedule_scope_accepted;

select public.promote_import_scope(
  '81000000-0000-4000-8000-000000000001',
  date '2099-08-09',
  date '2099-08-15',
  false,
  'Regression reused-entity promotion'
) as second_mapping_scope_promoted;

reset role;

select 1 / case when employee_count = 1
  and site_count = 1
  and post_count = 1
  and schedule_count = 1
  and shift_count = 1
  and assignment_count = 1
  and excluded_shift_count = 0
then 1 else 0 end as promotion_batch_reconciled
from private.import_promotion_batches
where import_run_id = '81000000-0000-4000-8000-000000000001'
  and from_date = date '2099-08-02';

select 1 / case when employee_count = 0
  and site_count = 0
  and post_count = 0
  and schedule_count = 1
  and shift_count = 1
  and assignment_count = 1
then 1 else 0 end as reusable_entities_not_duplicated
from private.import_promotion_batches
where import_run_id = '81000000-0000-4000-8000-000000000001'
  and from_date = date '2099-08-09';

select 1 / case when count(*) = 9 then 1 else 0 end as canonical_provenance_preserved
from private.import_entity_links
where import_run_id = '81000000-0000-4000-8000-000000000001';

do $$
declare
  blocked boolean := false;
begin
  begin
    update private.import_mapping_decisions
    set note = 'Tampered'
    where import_run_id = '81000000-0000-4000-8000-000000000001';
  exception when others then
    blocked := sqlerrm like '%append-only%';
  end;
  if not blocked then
    raise exception 'Import mapping history was not append-only.';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'private'
      and has_function_privilege('authenticated', function.oid, 'EXECUTE')
  ) then
    raise exception 'Authenticated role retained execute access to a private function.';
  end if;
end
$$;

select 'foundation_regression: PASS' as result;

rollback;
