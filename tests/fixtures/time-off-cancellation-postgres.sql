-- Synthetic-only fixture. The native runner initializes an isolated loopback
-- cluster; this file must never be run against a linked application database.
create role anon; create role authenticated; create role service_role;
create schema private; create schema auth;
revoke all on schema private from public;
create type public.request_status as enum ('pending','approved','declined','withdrawn','canceled');
create table public.employees(id uuid primary key,first_name text,last_name text,preferred_name text,
  employment_type text,status text,time_zone text,role text);
create table private.fixture_accounts(employee_id uuid primary key,disabled boolean not null default false,permissions text[] not null default '{}');
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('fixture.actor',true),'')::uuid$$;
create function public.current_employee_id() returns uuid language sql stable as $$
  select employee.id from public.employees employee join private.fixture_accounts account on account.employee_id=employee.id
  where employee.id=auth.uid() and employee.status='active' and not account.disabled
$$;
create function public.has_effective_permission(permission text) returns boolean language sql stable as $$
  select coalesce(permission=any(account.permissions),false) from private.fixture_accounts account where account.employee_id=public.current_employee_id()
$$;
create function public.has_mfa() returns boolean language sql stable as $$select coalesce(current_setting('fixture.mfa',true),'false')='true'$$;
create table public.time_off_requests(id uuid primary key,employee_id uuid references public.employees,
  starts_on date,ends_on date,partial_day_start time,partial_day_end time,return_on date,
  reason text,status public.request_status,request_type text,employment_type_snapshot text,pay_treatment text,
  requested_minutes integer,submission_snapshot jsonb,affected_shifts_snapshot jsonb,created_at timestamptz default now(),updated_at timestamptz default now(),
  decided_by uuid,decided_at timestamptz,decision_note text,decision_snapshot jsonb);
create table private.hr_leave_cases(id uuid primary key,time_off_request_id uuid references public.time_off_requests);
create table private.payroll_export_batches(id uuid primary key,from_date date,through_date date);
create table private.payroll_export_rows(id uuid primary key,batch_id uuid references private.payroll_export_batches,employee_id uuid);
create table private.audit_events(id bigint generated always as identity primary key,auth_user_id uuid,employee_id uuid,schema_name text,table_name text,operation text,row_id text,old_record jsonb,new_record jsonb);
create table public.schedules(id uuid primary key,status text);
create table public.shifts(id uuid primary key,schedule_id uuid references public.schedules,starts_at timestamptz,ends_at timestamptz,canceled_at timestamptz,headcount_required integer);
create table public.shift_assignments(id uuid primary key,shift_id uuid references public.shifts,employee_id uuid,status text);
create table public.time_events(id uuid primary key,employee_id uuid,recorded_at timestamptz);
create function private.prevent_append_only_change() returns trigger language plpgsql as $$begin raise exception 'Append-only evidence cannot be changed.';end$$;
create function private.assignment_overlap_conflict(uuid,uuid,uuid) returns jsonb language sql as $$select null::jsonb$$;
create function private.assignment_overlap_conflict_message(jsonb) returns text language sql as $$select 'Synthetic overlap'::text$$;
create function public.get_request_center_payload() returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('employeeId',public.current_employee_id(),'permissions',jsonb_build_object('canManage',coalesce(public.has_effective_permission('requests.manage'),false)),
    'fixtureUnchanged','canonical payload','timeOff',coalesce((select jsonb_agg(jsonb_build_object('id',request.id,'employeeId',request.employee_id,'status',request.status,'decisionNote',request.decision_note) order by request.id)
      from public.time_off_requests request where request.employee_id=public.current_employee_id() or public.has_effective_permission('requests.manage')),'[]'::jsonb))
$$;
insert into public.employees values
 ('10000000-0000-4000-8000-000000000001','Review','Manager',null,'hourly','active','America/Denver','guard'),
 ('10000000-0000-4000-8000-000000000002','Hourly','Employee',null,'hourly','active','America/New_York','guard'),
 ('10000000-0000-4000-8000-000000000003','Salary','Employee',null,'salary','active','America/Denver','guard'),
 ('10000000-0000-4000-8000-000000000004','Flex','Employee',null,'flex','active','America/Chicago','guard'),
 ('10000000-0000-4000-8000-000000000005','Denied','Supervisor',null,'hourly','active','America/Denver','supervisor');
insert into private.fixture_accounts values
 ('10000000-0000-4000-8000-000000000001',false,array['requests.manage']),
 ('10000000-0000-4000-8000-000000000002',false,'{}'),
 ('10000000-0000-4000-8000-000000000003',false,'{}'),
 ('10000000-0000-4000-8000-000000000004',false,'{}'),
 ('10000000-0000-4000-8000-000000000005',false,'{}');
insert into public.time_off_requests(id,employee_id,starts_on,ends_on,status,request_type,employment_type_snapshot,pay_treatment,submission_snapshot,affected_shifts_snapshot,decided_by,decided_at,decision_note,decision_snapshot)
select ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n=2 then '10000000-0000-4000-8000-000000000003'::uuid when n=6 then '10000000-0000-4000-8000-000000000004'::uuid when n=9 then '10000000-0000-4000-8000-000000000001'::uuid else '10000000-0000-4000-8000-000000000002'::uuid end,
 case when n=4 then date '2020-06-01' when n=6 then date '2027-11-07' else date '2099-06-01'+n end,
 case when n=4 then date '2020-06-01' when n=6 then date '2027-11-07' else date '2099-06-01'+n end,
 case when n=8 then 'pending'::public.request_status else 'approved'::public.request_status end,'unpaid_time_off',
 case when n=2 then 'salary' when n=6 then 'flex' else 'hourly' end,'unpaid',
 jsonb_build_object('timeZone',case when n=6 then 'America/Chicago' else 'America/New_York' end),'[]'::jsonb,
 '10000000-0000-4000-8000-000000000001','2026-01-01Z','Original approval retained.',jsonb_build_object('original',true)
from generate_series(1,12) n;
insert into private.hr_leave_cases values('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000003');
insert into private.payroll_export_batches values('40000000-0000-4000-8000-000000000001','2099-06-06','2099-06-06');
insert into private.payroll_export_rows values('50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
insert into public.schedules values('60000000-0000-4000-8000-000000000001','published');
insert into public.shifts values('70000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','2099-06-02 13:00Z','2099-06-02 21:00Z',null,1);
insert into public.time_events values('80000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','2026-01-01 13:00Z');
