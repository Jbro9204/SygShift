create or replace function public.get_notification_center()
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  pending_count integer;
  delivered_count integer;
  failed_count integer;
  recent_records jsonb;
begin
  if not public.is_supervisor_or_admin() then
    raise insufficient_privilege using message = 'Supervisor or Admin access is required to view notification delivery.';
  end if;

  select
    count(*) filter (where delivered_at is null and failed_at is null)::integer,
    count(*) filter (where delivered_at is not null)::integer,
    count(*) filter (where failed_at is not null)::integer
  into pending_count, delivered_count, failed_count
  from private.notification_outbox;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', notification.id,
    'messageType', notification.message_type,
    'aggregateType', notification.aggregate_type,
    'aggregateId', notification.aggregate_id,
    'attemptCount', notification.attempt_count,
    'availableAt', notification.available_at,
    'createdAt', notification.created_at,
    'deliveredAt', notification.delivered_at,
    'failedAt', notification.failed_at,
    'lastError', notification.last_error
  ) order by notification.created_at desc), '[]'::jsonb)
  into recent_records
  from (
    select *
    from private.notification_outbox
    order by created_at desc
    limit 25
  ) notification;

  return jsonb_build_object(
    'summary', jsonb_build_object(
      'pending', coalesce(pending_count, 0),
      'delivered', coalesce(delivered_count, 0),
      'failed', coalesce(failed_count, 0)
    ),
    'recent', recent_records
  );
end;
$$;

create or replace function public.get_operations_report()
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  result jsonb;
begin
  if not public.is_supervisor_or_admin() then
    raise insufficient_privilege using message = 'Supervisor or Admin access is required to view operations reports.';
  end if;

  select jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'people', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where status = 'active'),
        'guards', count(*) filter (where role = 'guard'),
        'supervisors', count(*) filter (where role = 'supervisor'),
        'admins', count(*) filter (where role = 'admin'),
        'salary', count(*) filter (where employment_type = 'salary'),
        'hourly', count(*) filter (where employment_type = 'hourly')
      )
      from public.employees
    ),
    'schedule', (
      select jsonb_build_object(
        'weeks', count(distinct schedule.id),
        'shifts', count(shift.id),
        'assignedSlots', count(assignment.id) filter (where assignment.status in ('assigned', 'confirmed', 'completed')),
        'openShifts', count(shift.id) filter (where shift.is_open),
        'reviewNeeded', count(shift.id) filter (where shift.notes ilike '%review needed%'),
        'armedOpenShifts', count(shift.id) filter (where shift.is_open and shift.requires_armed)
      )
      from public.schedules schedule
      left join public.shifts shift on shift.schedule_id = schedule.id
      left join public.shift_assignments assignment on assignment.shift_id = shift.id
      where schedule.status = 'published'
    ),
    'sites', (
      select jsonb_build_object(
        'activeSites', count(*) filter (where active),
        'totalSites', count(*)
      )
      from public.sites
    ),
    'posts', (
      select jsonb_build_object(
        'activePosts', count(*) filter (where active),
        'totalPosts', count(*)
      )
      from public.posts
    ),
    'requests', jsonb_build_object(
      'timeOffPending', (select count(*) from public.time_off_requests where status = 'pending'),
      'shiftPending', (select count(*) from public.shift_requests where status = 'pending'),
      'callOffsOpen', (select count(*) from public.call_off_reports where resolved_at is null)
    ),
    'timekeeping', jsonb_build_object(
      'timeEvents', (select count(*) from public.time_events),
      'pendingCorrections', (select count(*) from public.time_event_corrections where approved_at is null and declined_at is null),
      'lockedPayrollBatches', (select count(*) from private.payroll_export_batches)
    ),
    'notifications', (
      select jsonb_build_object(
        'pending', count(*) filter (where delivered_at is null and failed_at is null),
        'delivered', count(*) filter (where delivered_at is not null),
        'failed', count(*) filter (where failed_at is not null)
      )
      from private.notification_outbox
    ),
    'publishedWeeks', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'weekStartsOn', week_starts_on,
        'revision', revision,
        'shifts', shift_count,
        'openShifts', open_count,
        'assignedSlots', assigned_count
      ) order by week_starts_on), '[]'::jsonb)
      from (
        select
          schedule.week_starts_on,
          schedule.revision,
          count(shift.id)::integer as shift_count,
          count(shift.id) filter (where shift.is_open)::integer as open_count,
          count(assignment.id) filter (where assignment.status in ('assigned', 'confirmed', 'completed'))::integer as assigned_count
        from public.schedules schedule
        left join public.shifts shift on shift.schedule_id = schedule.id
        left join public.shift_assignments assignment on assignment.shift_id = shift.id
        where schedule.status = 'published'
        group by schedule.week_starts_on, schedule.revision
      ) weeks
    )
  )
  into result;

  return result;
end;
$$;

revoke all on function public.get_notification_center() from public, anon;
revoke all on function public.get_operations_report() from public, anon;
grant execute on function public.get_notification_center() to authenticated;
grant execute on function public.get_operations_report() to authenticated;
