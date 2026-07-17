set search_path = '';

create or replace function public.get_overview_metrics_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  active_clock_count integer;
  open_shift_count integer;
  pending_request_count integer;
  clock_exception_count integer;
begin
  if private.current_employee_id() is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view dashboard metrics.';
  end if;

  with latest_event as (
    select distinct on (event.employee_id)
      event.employee_id,
      event.kind,
      event.effective_at
    from public.time_events event
    where event.voided_at is null
      and event.effective_at >= clock_timestamp() - interval '18 hours'
    order by event.employee_id, event.effective_at desc, event.created_at desc
  )
  select count(*) into active_clock_count
  from latest_event event
  where event.kind in ('clock_in', 'break_start', 'break_end');

  select count(*) into open_shift_count
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  where schedule.status = 'published'
    and shift.is_open
    and shift.ends_at > clock_timestamp()
    and shift.starts_at < clock_timestamp() + interval '14 days';

  select
    (
      select count(*) from public.time_off_requests request where request.status = 'pending'
    )
    + (
      select count(*) from public.shift_requests request
      join public.shifts shift on shift.id = request.shift_id
      where request.status = 'pending'
        and shift.ends_at > clock_timestamp()
    )
    + (
      select count(*) from public.call_off_reports report
      join public.shifts shift on shift.id = report.shift_id
      where report.announcement_id is null
        and report.resolved_at is null
        and shift.ends_at > clock_timestamp()
    )
  into pending_request_count;

  select count(*) into clock_exception_count
  from public.time_event_corrections correction
  where correction.approved_at is null
    and correction.declined_at is null;

  return jsonb_build_object(
    'onDutyNow', active_clock_count,
    'openShifts', open_shift_count,
    'pendingRequests', pending_request_count,
    'clockExceptions', clock_exception_count
  );
end
$$;

revoke all on function public.get_overview_metrics_payload() from public, anon;
grant execute on function public.get_overview_metrics_payload() to authenticated;
