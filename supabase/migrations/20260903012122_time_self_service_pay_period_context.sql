begin;

-- Employee self-service needs the active payroll window, but it must not call
-- the privileged payroll-rules endpoint. This function returns only the
-- non-sensitive boundary data required to load the signed-in employee's own
-- time rows. Full payroll configuration remains behind get_payroll_rules(),
-- its effective permission checks, and recent MFA.
create or replace function public.get_payroll_period_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  rules private.payroll_rules%rowtype;
  server_timestamp timestamptz := statement_timestamp();
  operational_date date;
  current_week_start date;
  period jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into rules
  from private.payroll_rules
  where id = true;

  if not found then
    raise object_not_in_prerequisite_state using message = 'Payroll period configuration is unavailable.';
  end if;

  operational_date := (server_timestamp at time zone rules.time_zone)::date;
  current_week_start := operational_date
    - mod(extract(dow from operational_date)::integer - rules.week_starts_on + 7, 7);
  period := private.get_payroll_period_for_week(current_week_start);

  if not coalesce((period ->> 'resolved')::boolean, false) then
    raise object_not_in_prerequisite_state using message = 'The current payroll period could not be resolved.';
  end if;

  return jsonb_build_object(
    'serverTimestamp', server_timestamp,
    'fromDate', period ->> 'periodStartsOn',
    'throughDate', period ->> 'periodEndsOn',
    'timeZone', rules.time_zone,
    'weekStartsOn', rules.week_starts_on,
    'weekStartsOnLabel', (array['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])[rules.week_starts_on + 1],
    'payFrequency', rules.pay_frequency,
    'payrollConfigurationVersion', rules.payroll_configuration_version
  );
end
$$;

revoke all on function public.get_payroll_period_context() from public, anon;
grant execute on function public.get_payroll_period_context() to authenticated;

comment on function public.get_payroll_period_context() is
  'Returns the current non-sensitive payroll period boundary for an active employee. Full payroll rules remain permission- and MFA-protected.';

notify pgrst, 'reload schema';

commit;
