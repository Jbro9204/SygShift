-- Synthetic-only extension for the isolated native early-return runner.
-- Load after time-off-cancellation-postgres.sql, never on a linked database.
create function private.current_employee_id() returns uuid language sql stable as $$select public.current_employee_id()$$;
alter table public.employees add column employee_number text;
alter table public.employees add column username text;
alter table public.time_off_requests alter column id set default gen_random_uuid();
create table public.maintenance_windows(title text,access_mode text,ends_at timestamptz,
  status text,starts_at timestamptz,feature_codes text[]);
create table public.sites(id uuid primary key,name text,code text);
create table public.posts(id uuid primary key,site_id uuid,name text);
create table public.events(id uuid primary key,name text,location_name text);
alter table public.shifts add column time_zone text default 'America/Denver';
alter table public.shifts add column post_id uuid;
alter table public.shifts add column event_id uuid;
create table public.attendance_accountability_events(id uuid primary key,event_type text,status text,
  employee_id uuid,operational_date date,starts_at timestamptz,ends_at timestamptz,shift_id uuid,
  note text,created_at timestamptz,call_off_report_id uuid);
create table public.call_off_reports(id uuid primary key,employee_id uuid,shift_id uuid,
  reason text,reported_at timestamptz,resolved_at timestamptz);
create function private.can_manage_schedule_drafts() returns boolean language sql stable as $$select true$$;
create function public.replace_schedule_week_draft_with_work_types(uuid,date,boolean,boolean)
returns jsonb language sql as $$select '{}'::jsonb$$;
revoke all on function public.replace_schedule_week_draft_with_work_types(uuid,date,boolean,boolean) from public,anon;
grant execute on function public.replace_schedule_week_draft_with_work_types(uuid,date,boolean,boolean) to authenticated;
create function private.time_off_affected_shifts(uuid,date,date,time,time,text)
returns jsonb language sql stable as $$select '[]'::jsonb$$;
-- Sentinel financial reader: production's actual source hash is verified by
-- the separate read-only deployment guard, not replaced in this fixture.
create function private.get_timekeeping_review_base(date,date)
returns jsonb language sql stable as $$select '{"financialSource":"unchanged"}'::jsonb$$;
insert into public.employees(id,first_name,last_name,employment_type,status,time_zone,role,employee_number,username)
select ('11000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'Synthetic','Employee '||n,'hourly','active','America/New_York','guard','FIXTURE-'||n,'fixture'||n
from generate_series(101,120) n;
insert into private.fixture_accounts(employee_id)
select id from public.employees where id::text like '11000000-%';
insert into public.time_off_requests(id,employee_id,starts_on,ends_on,status,request_type,
  employment_type_snapshot,pay_treatment,submission_snapshot,affected_shifts_snapshot,
  decided_by,decided_at,decision_note,decision_snapshot)
select ('21000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('11000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  case when n=107 then current_date+3 when n=108 then current_date-4 else current_date-2 end,
  case when n=107 then current_date+5 when n=108 then current_date-3 else current_date+2 end,
  'approved','unpaid_time_off','hourly','unpaid',jsonb_build_object('timeZone','America/New_York'),
  '[]'::jsonb,'10000000-0000-4000-8000-000000000001',clock_timestamp()-interval '3 days',
  'Original approval must remain exact.',jsonb_build_object('original',true,'fixture',n)
from generate_series(101,120) n;
update public.employees set employment_type='salary' where id='11000000-0000-4000-8000-000000000102';
update public.time_off_requests set employment_type_snapshot='salary' where id='21000000-0000-4000-8000-000000000103';
update public.time_off_requests set request_type='sick_time',pay_treatment='sick_policy' where id='21000000-0000-4000-8000-000000000104';
update public.time_off_requests set employee_id='10000000-0000-4000-8000-000000000001' where id='21000000-0000-4000-8000-000000000109';
update public.time_off_requests set employment_type_snapshot=null where id='21000000-0000-4000-8000-000000000110';
update public.time_off_requests set submission_snapshot='{}'::jsonb where id='21000000-0000-4000-8000-000000000113';
insert into private.hr_leave_cases values('31000000-0000-4000-8000-000000000105','21000000-0000-4000-8000-000000000105');
insert into private.payroll_export_batches values('41000000-0000-4000-8000-000000000106',current_date-2,current_date+2);
insert into private.payroll_export_rows values('51000000-0000-4000-8000-000000000106','41000000-0000-4000-8000-000000000106','11000000-0000-4000-8000-000000000106');
