begin;

set local statement_timeout = '8s';

do $$
declare
  actor_id uuid;
  actor_auth_id uuid;
  target_employee_id uuid;
  target_week date;
  permission_codes text[];
begin
  select employee.id, account.auth_user_id
  into actor_id, actor_auth_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and not private.employee_required_action_checkpoint_enrolled(employee.id)
  order by (employee.username = 'jbrown') desc, employee.id
  limit 1;

  if actor_id is not null then
    permission_codes := private.employee_effective_permissions(actor_id);
    if permission_codes is null then
      raise exception 'Effective permissions returned null.';
    end if;

    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', actor_auth_id, 'role', 'authenticated', 'aal', 'aal2')::text,
      true
    );
    perform public.get_hr_people_record(actor_id);
  end if;

  if exists (
    select 1
    from public.attendance_accountability_events accountability_event
    join public.shifts source_shift on source_shift.id = accountability_event.shift_id
    join public.schedules source_schedule on source_schedule.id = source_shift.schedule_id
    cross join lateral (
      select private.get_accountability_reconciliation_group_snapshot(source_shift.id) as value
    ) reconciliation
    where source_schedule.status in ('superseded', 'archived')
      and source_shift.starts_at is not null
      and source_shift.ends_at is not null
      and (
        jsonb_typeof(reconciliation.value -> 'startsAt') is distinct from 'string'
        or jsonb_typeof(reconciliation.value -> 'endsAt') is distinct from 'string'
        or jsonb_typeof(reconciliation.value -> 'locationName') is distinct from 'string'
      )
  ) then
    raise exception 'A historical Accountability event still has an invalid reconciliation contract.';
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select schedule.week_starts_on
  into target_week
  from public.schedules schedule
  where schedule.status in ('published', 'superseded')
  order by schedule.week_starts_on desc
  limit 1;

  select employee.id
  into target_employee_id
  from public.employees employee
  where employee.status = 'active'
  order by employee.id
  limit 1;

  if target_week is not null and target_employee_id is not null then
    perform private.queue_attendance_alert_schedule_refresh(target_week, target_employee_id, true);
    perform private.queue_attendance_alert_schedule_refresh(target_week, target_employee_id, true);
    perform private.queue_attendance_alert_schedule_refresh(target_week, null, true);

    if (
      select count(*)
      from private.attendance_alert_schedule_refresh_queue queued
      where queued.week_starts_on = target_week
    ) <> 1 then
      raise exception 'Attendance refresh requests were not coalesced to one scope.';
    end if;

    if exists (
      select 1
      from private.attendance_alert_schedule_refresh_queue queued
      where queued.week_starts_on = target_week
        and queued.target_employee_id is not null
    ) then
      raise exception 'A week-wide refresh did not supersede narrower employee refreshes.';
    end if;
  end if;

  if exists (
    select 1
    from pg_proc function_record
    join pg_namespace namespace_record on namespace_record.oid = function_record.pronamespace
    where namespace_record.nspname = 'private'
      and function_record.proname in (
        'refresh_attendance_alerts_after_schedule_change',
        'refresh_attendance_alerts_after_assignment_change',
        'refresh_attendance_alerts_after_shift_change'
      )
      and position(
        'private.queue_attendance_alert_schedule_refresh('
        in pg_get_functiondef(function_record.oid)
      ) = 0
  ) then
    raise exception 'An attendance schedule trigger still runs reconciliation directly.';
  end if;
end
$$;

rollback;
