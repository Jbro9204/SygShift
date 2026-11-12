-- Isolated-only extension, after time-off-cancellation-postgres.sql.
create type public.app_role as enum('guard','dispatcher','scheduler','recruiting_licensing','supervisor','admin');
alter table public.employees alter column role type public.app_role using role::public.app_role;
alter table public.employees add column employee_number text;
alter table public.employees add column username text;
create table private.employee_accounts(employee_id uuid primary key,auth_user_id uuid,disabled_at timestamptz,auth_tokens_invalid_before_epoch bigint default 0);
create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,created_at timestamptz);
create table private.emergency_revoked_auth_sessions(auth_session_id uuid,auth_user_id uuid);
create function auth.jwt() returns jsonb language sql stable as $$select jsonb_build_object('session_id',coalesce(nullif(current_setting('fixture.session',true),''),auth.uid()::text),'iat',extract(epoch from now())::bigint)$$;
create function public.get_effective_permissions() returns text[] language sql stable security definer set search_path='' as $$
select coalesce((select permissions from private.fixture_accounts where employee_id=public.current_employee_id()),'{}'::text[])$$;
insert into private.employee_accounts(employee_id,auth_user_id)select id,id from public.employees;
insert into auth.sessions select id,id,null,now()-interval '1 hour' from public.employees;
create table private.time_off_request_cancellations(request_id uuid primary key,employee_id uuid,canceled_by uuid,canceled_at timestamptz,note text);
create table private.time_off_request_early_returns(request_id uuid primary key,employee_id uuid,ended_by uuid,ended_at timestamptz,recorded_at timestamptz,note text,time_zone text);
grant usage on schema auth to authenticated;
grant execute on function auth.uid(),auth.jwt() to authenticated;
