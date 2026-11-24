create schema private; create schema auth;
create role anon; create role authenticated; create role service_role;
create function pg_temp.fx(n integer) returns uuid language sql immutable
  as $$select ('c7400000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid$$;
create table public.employees(id uuid primary key, status text);
create table public.clients(id uuid primary key, status text, archived_at timestamptz);
create table public.sites(id uuid primary key, client_id uuid references public.clients(id), active boolean);
create table public.posts(id uuid primary key, site_id uuid references public.sites(id), active boolean, requires_armed boolean);
create table public.schedules(id uuid primary key,status text,week_starts_on date,revision integer,published_at timestamptz);
create table public.shifts(id uuid primary key, schedule_id uuid references public.schedules(id), post_id uuid references public.posts(id), starts_at timestamptz, ends_at timestamptz,
  time_zone text default 'America/Denver', requires_armed boolean default false, canceled_at timestamptz, event_id uuid, work_type text default 'post', assignment_type text default 'standard');
create table public.shift_assignments(id uuid primary key,shift_id uuid references public.shifts(id),employee_id uuid references public.employees(id),
  status text default 'assigned',canceled_at timestamptz,assigned_at timestamptz default now());
create table public.patrol_assignments(id uuid primary key,shift_id uuid,employee_id uuid,status text,canceled_at timestamptz);
create table private.patrol_schedule_continuity(id uuid,assignment_id uuid,target_shift_id uuid);
create table private.patrol_schedule_resolution_receipts(continuity_id uuid);
create table private.schedule_shift_revision_links(source_shift_id uuid,draft_shift_id uuid);
create table private.audit_events(auth_user_id uuid,employee_id uuid,schema_name text,table_name text,operation text,row_id text,old_record jsonb,new_record jsonb);
create table public.time_events(id uuid primary key);
create table private.payroll_rows(id uuid primary key);
create function private.current_employee_id() returns uuid language sql stable as $$select nullif(current_setting('fixture.actor',true),'')::uuid$$;
create function private.patrol_can_manage() returns boolean language sql stable as $$
  select private.current_employee_id()=pg_temp.fx(1) and current_setting('fixture.mfa',true)='yes'$$;
create function public.has_effective_permission(text) returns boolean language sql stable as $$
  select $1='patrol.assignments.manage' and private.current_employee_id()=pg_temp.fx(4) and current_setting('fixture.mfa',true)='yes'$$;
create function auth.uid() returns uuid language sql stable as $$ select private.current_employee_id() $$;
create function auth.role() returns text language sql stable as $$ select current_setting('fixture.role',true) $$;
insert into public.employees select pg_temp.fx(n),'active' from generate_series(1,4) n;
insert into public.clients(id,status) values (pg_temp.fx(10),'active'),(pg_temp.fx(11),'active'),(pg_temp.fx(12),'paused');
insert into public.sites values (pg_temp.fx(20),pg_temp.fx(10),true),(pg_temp.fx(21),pg_temp.fx(10),true),
  (pg_temp.fx(22),pg_temp.fx(11),true),(pg_temp.fx(23),pg_temp.fx(10),true),(pg_temp.fx(24),pg_temp.fx(12),true);
insert into public.posts values (pg_temp.fx(30),pg_temp.fx(20),true,false),(pg_temp.fx(31),pg_temp.fx(20),true,false);
insert into public.schedules values (pg_temp.fx(40),'published',current_date,2,now()),(pg_temp.fx(41),'published',current_date,1,now()-interval '1 hour');
insert into public.shifts(id,schedule_id,post_id,starts_at,ends_at)
select pg_temp.fx(n),pg_temp.fx(case n when 57 then 41 else 40 end),pg_temp.fx(case n when 53 then 31 else 30 end),
  case when n in (54,56) then now()-interval '2 hours' else now() end,
  case n when 54 then now()-interval '1 hour' when 56 then now()+interval '1 minute' else now()+interval '1 hour' end
from generate_series(50,57) n;
insert into public.shift_assignments(id,shift_id,employee_id)
select pg_temp.fx(n+10),pg_temp.fx(n),pg_temp.fx(case n when 52 then 3 else 2 end) from generate_series(50,57) n;
insert into public.patrol_assignments values (pg_temp.fx(70),pg_temp.fx(55),pg_temp.fx(2),'active',null);
insert into public.time_events values (pg_temp.fx(71));
insert into private.payroll_rows values (pg_temp.fx(72));
create temporary table results(name text, passed boolean);
create function pg_temp.expect_failure(code text, statement text) returns boolean language plpgsql as $$
begin
  execute statement;
  return false;
exception when others then
  if sqlstate<>code then raise; end if;
  return true;
end;
$$;
create temporary view protected_state as select jsonb_build_object(
  'shifts',(select jsonb_agg(to_jsonb(x) order by id) from public.shifts x where id <> pg_temp.fx(56)),
  'schedule',(select jsonb_agg(to_jsonb(x) order by id) from public.schedules x),
  'assignments',(select jsonb_agg(to_jsonb(x) order by id) from public.shift_assignments x),
  'native',(select jsonb_agg(to_jsonb(x) order by id) from public.patrol_assignments x),
  'clock',(select jsonb_agg(to_jsonb(x) order by id) from public.time_events x),
  'payroll',(select jsonb_agg(to_jsonb(x) order by id) from private.payroll_rows x)
) as state;
create temporary table protected_before as select state from protected_state;
