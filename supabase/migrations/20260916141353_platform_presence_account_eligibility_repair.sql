-- An active employee record without a linked login account is not available.
-- Require the account row explicitly so LEFT JOIN nulls cannot be interpreted
-- as an enabled account.

create or replace function private.platform_presence_for(target_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with account_state as (
    select
      account.employee_id is not null
        and employee.status = 'active'
        and account.disabled_at is null as enabled
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

revoke all on function private.platform_presence_for(uuid) from public, anon, authenticated;

comment on function private.platform_presence_for(uuid) is
  'Aggregates approximate cross-application presence; employees without an enabled linked login account are always offline.';
