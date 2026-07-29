begin;

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  (
    'time.self.view',
    'Time & Attendance',
    'View own time',
    'View only the signed-in employee''s Time & Attendance dashboard, punch history, and pay-period totals.',
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

update public.permission_catalog
set
  name = 'View team time records',
  description = 'View permitted employee time records and payroll review data. Own-time viewing uses time.self.view.',
  requires_mfa = true,
  updated_at = now()
where code = 'time.view';

with base_roles(role_code) as (
  values
    ('system_guard'),
    ('system_dispatcher'),
    ('system_scheduler'),
    ('system_recruiting_licensing'),
    ('system_supervisor'),
    ('system_admin')
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, 'time.self.view', true
from base_roles base
join public.access_roles role on role.code = base.role_code
on conflict (role_id, permission_code) do update
set enabled = true, updated_at = now();

do $employee_own_time$
declare
  function_sql text;
  old_permission_block text := $old$
  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.view')
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.export_payroll')
    ) then
    raise insufficient_privilege using message = 'Time review permission with MFA is required.';
  end if;
$old$;
  new_permission_block text := $new$
  can_view_team_time := public.has_mfa()
    and (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.export_payroll')
    );
$new$;
begin
  select pg_get_functiondef('public.get_timekeeping_review(date, date)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'public.get_timekeeping_review(date, date) was not found.';
  end if;

  if position('can_view_team_time boolean' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      '  rules private.payroll_rules%rowtype;' || chr(10) || '  review_rows jsonb;',
      '  rules private.payroll_rules%rowtype;' || chr(10) || '  can_view_team_time boolean := false;' || chr(10) || '  review_rows jsonb;'
    );
  end if;

  if position(old_permission_block in function_sql) > 0 then
    function_sql := replace(function_sql, old_permission_block, new_permission_block);
  elsif position('Supervisor or Admin access with MFA is required for time review.' in function_sql) > 0 then
    function_sql := replace(
      function_sql,
      $legacy$  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Supervisor or Admin access with MFA is required for time review.';
  end if;
$legacy$,
      new_permission_block
    );
  end if;

  if position('Time review permission with MFA is required.' in function_sql) > 0
    or position('Supervisor or Admin access with MFA is required for time review.' in function_sql) > 0 then
    raise check_violation using message = 'Own-time permission block was not applied to get_timekeeping_review.';
  end if;

  function_sql := replace(
    function_sql,
    '    where not event.voided' || chr(10) || '      and (event.effective_at at time zone rules.time_zone)::date between target_from_date and target_through_date',
    '    where not event.voided' || chr(10) || '      and (can_view_team_time or event.employee_id = reviewer_id)' || chr(10) || '      and (event.effective_at at time zone rules.time_zone)::date between target_from_date and target_through_date'
  );

  function_sql := replace(
    function_sql,
    '      on employee.employment_type = ''salary''' || chr(10) || '     and employee.status in (''active'', ''leave'')',
    '      on employee.employment_type = ''salary''' || chr(10) || '     and employee.status in (''active'', ''leave'')' || chr(10) || '     and (can_view_team_time or employee.id = reviewer_id)'
  );

  function_sql := replace(
    function_sql,
    '  where correction.approved_at is null' || chr(10) || '    and correction.declined_at is null' || chr(10) || '    and (event.recorded_at at time zone rules.time_zone)::date between target_from_date and target_through_date',
    '  where correction.approved_at is null' || chr(10) || '    and correction.declined_at is null' || chr(10) || '    and (can_view_team_time or event.employee_id = reviewer_id)' || chr(10) || '    and (event.recorded_at at time zone rules.time_zone)::date between target_from_date and target_through_date'
  );

  if position('can_view_team_time or event.employee_id = reviewer_id' in function_sql) = 0 then
    raise check_violation using message = 'Own-time filter was not applied to get_timekeeping_review.';
  end if;

  execute function_sql;
end
$employee_own_time$;

notify pgrst, 'reload schema';

commit;
