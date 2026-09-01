-- Salaried employees do not use the shift punch workflow and therefore must
-- never generate missing-clock-in operational exceptions or live alerts.
-- Preserve the audit trail by resolving existing records instead of deleting
-- them, and immediately reconcile records when an employee is reclassified.

begin;

alter table public.timekeeping_operational_exception_actions
  drop constraint if exists timekeeping_operational_exception_action;
alter table public.timekeeping_operational_exception_actions
  add constraint timekeeping_operational_exception_action check (
    action in (
      'created',
      'resolved_manual_entry',
      'resolved_adjustment',
      'resolved_call_off',
      'resolved_shift_canceled',
      'resolved_clock_in_received',
      'resolved_assignment_changed',
      'resolved_duplicate',
      'resolved_employment_exempt',
      'dismissed',
      'reopened'
    )
  );

create or replace function private.resolve_salaried_missing_clock_in_records(
  target_employee_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  resolved_exception_count integer := 0;
  cleared_alert_count integer := 0;
begin
  with resolved as (
    update public.timekeeping_operational_exceptions exception
    set
      status = 'resolved',
      resolution_method = 'employment_exempt',
      resolution_note = 'Resolved automatically because salaried employees are exempt from shift clock-in requirements.',
      resolved_by = null,
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp()
    from public.employees employee
    where employee.id = exception.employee_id
      and employee.employment_type = 'salary'::public.employment_type
      and (target_employee_id is null or employee.id = target_employee_id)
      and exception.exception_code = 'missing_clock_in'
      and exception.status = 'unresolved'
    returning exception.*
  ), recorded as (
    insert into public.timekeeping_operational_exception_actions (
      exception_id,
      action,
      reason,
      actor_id,
      snapshot
    )
    select
      resolved.id,
      'resolved_employment_exempt',
      resolved.resolution_note,
      null,
      to_jsonb(resolved)
    from resolved
    returning id
  )
  select count(*) into resolved_exception_count from recorded;

  with cleared as (
    update public.operational_alerts alert
    set
      active = false,
      lifecycle_state = 'resolved',
      cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
      clear_source = 'automatic_resolution',
      cleared_reason = 'Salaried employees are exempt from shift clock-in requirements.',
      lifecycle_evaluated_at = clock_timestamp()
    from public.employees employee
    where employee.id = alert.employee_id
      and employee.employment_type = 'salary'::public.employment_type
      and (target_employee_id is null or employee.id = target_employee_id)
      and alert.alert_type = 'missing_clock_in'
      and (alert.active or alert.lifecycle_state <> 'resolved')
    returning alert.id
  )
  select count(*) into cleared_alert_count from cleared;

  return jsonb_build_object(
    'resolvedExceptionCount', resolved_exception_count,
    'clearedAlertCount', cleared_alert_count
  );
end
$$;

revoke all on function private.resolve_salaried_missing_clock_in_records(uuid) from public, anon, authenticated;

create or replace function private.prevent_salaried_missing_clock_in_exception()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.exception_code = 'missing_clock_in'
     and exists (
       select 1
       from public.employees employee
       where employee.id = new.employee_id
         and employee.employment_type = 'salary'::public.employment_type
     ) then
    return null;
  end if;

  return new;
end
$$;

revoke all on function private.prevent_salaried_missing_clock_in_exception() from public, anon, authenticated;

drop trigger if exists prevent_salaried_missing_clock_in_exception
  on public.timekeeping_operational_exceptions;
create trigger prevent_salaried_missing_clock_in_exception
before insert on public.timekeeping_operational_exceptions
for each row execute function private.prevent_salaried_missing_clock_in_exception();

create or replace function private.prevent_salaried_missing_clock_in_alert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.alert_type = 'missing_clock_in'
     and new.employee_id is not null
     and exists (
       select 1
       from public.employees employee
       where employee.id = new.employee_id
         and employee.employment_type = 'salary'::public.employment_type
     ) then
    return null;
  end if;

  return new;
end
$$;

revoke all on function private.prevent_salaried_missing_clock_in_alert() from public, anon, authenticated;

drop trigger if exists prevent_salaried_missing_clock_in_alert
  on public.operational_alerts;
create trigger prevent_salaried_missing_clock_in_alert
before insert on public.operational_alerts
for each row execute function private.prevent_salaried_missing_clock_in_alert();

create or replace function private.reconcile_salary_clock_alerts_after_classification_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.employment_type = 'salary'::public.employment_type
     and old.employment_type is distinct from new.employment_type then
    perform private.resolve_salaried_missing_clock_in_records(new.id);
  end if;

  return new;
end
$$;

revoke all on function private.reconcile_salary_clock_alerts_after_classification_change() from public, anon, authenticated;

drop trigger if exists reconcile_salary_clock_alerts_after_classification_change
  on public.employees;
create trigger reconcile_salary_clock_alerts_after_classification_change
after update of employment_type on public.employees
for each row execute function private.reconcile_salary_clock_alerts_after_classification_change();

-- Close any existing salaried missing-clock records now. The exceptions and
-- their actions remain available for audit; only the live alert is cleared.
select private.resolve_salaried_missing_clock_in_records(null);

do $$
begin
  if exists (
    select 1
    from public.timekeeping_operational_exceptions exception
    join public.employees employee on employee.id = exception.employee_id
    where employee.employment_type = 'salary'::public.employment_type
      and exception.exception_code = 'missing_clock_in'
      and exception.status = 'unresolved'
  ) then
    raise exception 'Salaried missing-clock-in exceptions remain unresolved.';
  end if;

  if exists (
    select 1
    from public.operational_alerts alert
    join public.employees employee on employee.id = alert.employee_id
    where employee.employment_type = 'salary'::public.employment_type
      and alert.alert_type = 'missing_clock_in'
      and alert.active
  ) then
    raise exception 'Salaried missing-clock-in alerts remain active.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
