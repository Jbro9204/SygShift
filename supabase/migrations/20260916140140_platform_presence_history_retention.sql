-- Preserve the fact that an employee has used either application, and their
-- last active time, independently from short-lived per-tab heartbeat rows.

create table if not exists private.platform_presence_history (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  first_active_at timestamptz not null,
  last_active_at timestamptz not null,
  constraint platform_presence_history_order_check check (last_active_at >= first_active_at)
);

insert into private.platform_presence_history (employee_id, first_active_at, last_active_at)
select session.employee_id, min(session.last_active_at), max(session.last_active_at)
from private.platform_presence_sessions session
group by session.employee_id
on conflict (employee_id) do update
set first_active_at = least(private.platform_presence_history.first_active_at, excluded.first_active_at),
    last_active_at = greatest(private.platform_presence_history.last_active_at, excluded.last_active_at);

alter table private.platform_presence_history enable row level security;
alter table private.platform_presence_history force row level security;
revoke all on private.platform_presence_history from public, anon, authenticated;

create or replace function private.capture_platform_presence_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'active' then
    insert into private.platform_presence_history (employee_id, first_active_at, last_active_at)
    values (new.employee_id, new.last_active_at, new.last_active_at)
    on conflict (employee_id) do update
    set first_active_at = least(private.platform_presence_history.first_active_at, excluded.first_active_at),
        last_active_at = greatest(private.platform_presence_history.last_active_at, excluded.last_active_at);
  end if;
  return new;
end
$$;

drop trigger if exists platform_presence_history_capture
on private.platform_presence_sessions;

create trigger platform_presence_history_capture
after insert or update of state, last_active_at
on private.platform_presence_sessions
for each row execute function private.capture_platform_presence_history();

create or replace function private.platform_presence_for(target_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with account_state as (
    select
      employee.status = 'active' and account.disabled_at is null as enabled
    from public.employees employee
    left join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_employee_id
  ), current_sessions as (
    select session.application, session.state
    from private.platform_presence_sessions session
    where session.employee_id = target_employee_id
      and session.expires_at > clock_timestamp()
  ), history as (
    select record.last_active_at
    from private.platform_presence_history record
    where record.employee_id = target_employee_id
  )
  select jsonb_build_object(
    'status', case
      when not coalesce((select enabled from account_state), false) then 'offline'
      when exists(select 1 from current_sessions where state = 'active') then 'active'
      when exists(select 1 from current_sessions) then 'away'
      when exists(select 1 from history) then 'offline'
      else 'never_active'
    end,
    'lastActiveAt', (select last_active_at from history),
    'applications', coalesce((
      select jsonb_agg(source.application order by source.application)
      from (select distinct application from current_sessions) source
    ), '[]'::jsonb),
    'accountEnabled', coalesce((select enabled from account_state), false)
  )
$$;

revoke all on function private.capture_platform_presence_history() from public, anon, authenticated;
revoke all on function private.platform_presence_for(uuid) from public, anon, authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'private.platform_presence_history', 'select')
    or has_function_privilege('authenticated', 'private.capture_platform_presence_history()', 'execute')
    or has_function_privilege('authenticated', 'private.platform_presence_for(uuid)', 'execute') then
    raise exception 'Private platform presence history is exposed.';
  end if;
end
$$;

comment on table private.platform_presence_history is
  'Private durable last-active summary for approximate application availability; never attendance, timekeeping, payroll, or disciplinary evidence.';
