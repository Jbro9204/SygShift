begin;

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  (
    'time.punch',
    'Time & Attendance',
    'Use time clock',
    'Clock in, start or end breaks, and clock out for the signed-in employee account.',
    'standard',
    false,
    true,
    true
  )
on conflict (code) do update
set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  locked = excluded.locked,
  active = true,
  updated_at = now();

with punch_roles(role_code) as (
  values
    ('system_guard'),
    ('system_dispatcher'),
    ('system_scheduler'),
    ('system_recruiting_licensing'),
    ('system_supervisor'),
    ('system_admin')
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, 'time.punch', true
from punch_roles punch_role
join public.access_roles role on role.code = punch_role.role_code
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

do $time_dashboard_permission$
declare
  function_sql text;
  old_block text := $old$
  if viewer_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required for timekeeping.';
  end if;
$old$;
  new_block text := $new$
  if viewer_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required for timekeeping.';
  end if;

  if not (
    public.has_effective_permission('time.self.view')
    or public.has_effective_permission('time.punch')
    or public.has_effective_permission('time.view')
    or public.has_effective_permission('time.manage')
    or public.has_effective_permission('time.export_payroll')
  ) then
    raise insufficient_privilege using message = 'Time clock access is required for timekeeping.';
  end if;
$new$;
begin
  select pg_get_functiondef('public.get_timekeeping_dashboard(date)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'public.get_timekeeping_dashboard(date) was not found.';
  end if;

  if position('Time clock access is required for timekeeping.' in function_sql) = 0 then
    function_sql := replace(function_sql, old_block, new_block);
  end if;

  if position('Time clock access is required for timekeeping.' in function_sql) = 0 then
    raise check_violation using message = 'Time dashboard permission guard was not applied.';
  end if;

  execute function_sql;
end
$time_dashboard_permission$;

do $time_event_permission$
declare
  function_sql text;
  old_block text := $old$
  if actor_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required to record time.';
  end if;
$old$;
  new_block text := $new$
  if actor_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required to record time.';
  end if;

  if not (
    public.has_effective_permission('time.punch')
    or public.has_effective_permission('time.manage')
  ) then
    raise insufficient_privilege using message = 'Time clock permission is required to record time.';
  end if;
$new$;
begin
  select pg_get_functiondef('public.record_time_event(public.time_event_kind, uuid, timestamptz, text)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'public.record_time_event(public.time_event_kind, uuid, timestamptz, text) was not found.';
  end if;

  if position('Time clock permission is required to record time.' in function_sql) = 0 then
    function_sql := replace(function_sql, old_block, new_block);
  end if;

  if position('Time clock permission is required to record time.' in function_sql) = 0 then
    raise check_violation using message = 'Time punch permission guard was not applied.';
  end if;

  execute function_sql;
end
$time_event_permission$;

revoke all on function public.get_timekeeping_dashboard(date) from public, anon;
revoke all on function public.record_time_event(public.time_event_kind, uuid, timestamptz, text) from public, anon;
grant execute on function public.get_timekeeping_dashboard(date) to authenticated;
grant execute on function public.record_time_event(public.time_event_kind, uuid, timestamptz, text) to authenticated;

notify pgrst, 'reload schema';

commit;
