-- Keep the incremental attendance safety pass bounded to recent or actively
-- operational occurrences. Schedule-change triggers still run a complete
-- reconciliation for their affected week, and the 2:00 AM pass remains full.

begin;

do $bound_safety_refresh$
declare
  function_definition text;
  prior_filter text := $prior$
      and (
        target_full_reconciliation
        or exception.detected_at >= clock_timestamp() - interval '14 days'
        or exists (
          select 1
          from public.operational_alerts alert
          where alert.related_record_type = 'timekeeping_operational_exception'
            and alert.related_record_id = exception.id
            and (alert.active or alert.lifecycle_state <> 'resolved')
        )
      )
$prior$;
  repaired_filter text := $repaired$
      and (
        target_full_reconciliation
        or exception.detected_at >= clock_timestamp() - interval '14 days'
        or exists (
          select 1
          from public.operational_alerts alert
          where alert.related_record_type = 'timekeeping_operational_exception'
            and alert.related_record_id = exception.id
            and (alert.active or alert.lifecycle_state = 'active_operations')
        )
      )
$repaired$;
begin
  select pg_get_functiondef(
    'private.refresh_attendance_alert_schedule_state(date,uuid,boolean)'::regprocedure
  ) into function_definition;

  if function_definition is null or position(prior_filter in function_definition) = 0 then
    raise exception 'The incremental attendance schedule refresh filter was not found.';
  end if;

  execute replace(function_definition, prior_filter, repaired_filter);
end
$bound_safety_refresh$;

comment on function private.refresh_attendance_alert_schedule_state(date, uuid, boolean) is
  'Reconciles current attendance-alert schedule state. Incremental safety passes are bounded to recent or active operations; targeted schedule changes and the daily service pass remain complete.';

commit;
