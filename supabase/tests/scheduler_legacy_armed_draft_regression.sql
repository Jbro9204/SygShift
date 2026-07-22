\set ON_ERROR_STOP on

begin;

insert into public.employees (id, first_name, last_name, role)
values
  ('71000000-0000-0000-0000-000000000001', 'Legacy', 'Scheduler', 'supervisor'),
  ('71000000-0000-0000-0000-000000000002', 'Legacy', 'Assigned', 'guard'),
  ('71000000-0000-0000-0000-000000000003', 'New', 'Unqualified', 'guard');

insert into auth.users (id, email)
values ('72000000-0000-0000-0000-000000000001', 'legacy-scheduler@example.invalid');

insert into private.employee_accounts (employee_id, auth_user_id, activated_at)
values (
  '71000000-0000-0000-0000-000000000001',
  '72000000-0000-0000-0000-000000000001',
  now()
);

insert into public.employee_credentials (
  employee_id,
  kind,
  status,
  credential_number,
  valid_from,
  expires_on
) values (
  '71000000-0000-0000-0000-000000000002',
  'armed_guard',
  'active',
  'LEGACY-REGRESSION',
  date '2026-01-01',
  date '2100-12-31'
);

insert into public.sites (id, code, name)
values ('73000000-0000-0000-0000-000000000001', 'LEGACY', 'Legacy Armed Site');

insert into public.posts (id, site_id, name, requires_armed)
values (
  '74000000-0000-0000-0000-000000000001',
  '73000000-0000-0000-0000-000000000001',
  'Legacy Armed Post',
  true
);

insert into public.schedules (
  id,
  week_starts_on,
  revision,
  status,
  created_by
) values (
  '75000000-0000-0000-0000-000000000001',
  date '2099-08-02',
  1,
  'draft',
  '71000000-0000-0000-0000-000000000001'
);

insert into public.shifts (
  id,
  schedule_id,
  post_id,
  starts_at,
  ends_at,
  headcount_required,
  created_by
) values (
  '76000000-0000-0000-0000-000000000001',
  '75000000-0000-0000-0000-000000000001',
  '74000000-0000-0000-0000-000000000001',
  timestamptz '2099-08-03 08:00:00-06',
  timestamptz '2099-08-03 16:00:00-06',
  1,
  '71000000-0000-0000-0000-000000000001'
);

insert into public.shift_assignments (shift_id, employee_id, assigned_by)
values (
  '76000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000002',
  '71000000-0000-0000-0000-000000000001'
);

update public.schedules
set
  status = 'published',
  published_at = clock_timestamp(),
  published_by = '71000000-0000-0000-0000-000000000001'
where id = '75000000-0000-0000-0000-000000000001';

update public.employee_credentials
set expires_on = date '2099-08-02'
where employee_id = '71000000-0000-0000-0000-000000000002'
  and kind = 'armed_guard';

set local role authenticated;
set local "request.jwt.claim.sub" = '72000000-0000-0000-0000-000000000001';
set local "request.jwt.claims" = '{"aal":"aal2"}';

select public.ensure_schedule_draft(date '2099-08-02');

select 1 / case when count(*) = 1 then 1 else 0 end as inherited_assignment_preserved
from public.shift_assignments assignment
join public.shifts shift on shift.id = assignment.shift_id
join public.schedules schedule on schedule.id = shift.schedule_id
where schedule.week_starts_on = date '2099-08-02'
  and schedule.status = 'draft'
  and assignment.employee_id = '71000000-0000-0000-0000-000000000002'
  and assignment.status = 'assigned';

do $$
declare
  draft_shift_id uuid;
  blocked boolean := false;
begin
  select shift.id into draft_shift_id
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  where schedule.week_starts_on = date '2099-08-02'
    and schedule.status = 'draft';

  begin
    insert into public.shift_assignments (shift_id, employee_id, assigned_by)
    values (
      draft_shift_id,
      '71000000-0000-0000-0000-000000000003',
      '71000000-0000-0000-0000-000000000001'
    );
  exception when others then
    blocked := sqlerrm like '%valid armed qualification%';
  end;

  if not blocked then
    raise exception 'A new unqualified armed assignment was not blocked.';
  end if;
end
$$;

reset role;

select 'scheduler_legacy_armed_draft_regression: PASS' as result;

rollback;
