begin;

-- Time Maintenance reports scheduled hours by the shift's operational start
-- date. An overnight shift that starts before the requested range belongs to
-- the earlier operational day and must not leak into the next range merely
-- because it ends after midnight.
do $repair_team_attendance_schedule_range$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef('public.get_team_attendance_summary(date,date)'::regprocedure)
  into function_sql;

  updated_sql := replace(
    function_sql,
    E'      and (shift.starts_at at time zone coalesce(shift.time_zone, operational_time_zone))::date <= target_through_date\n      and (shift.ends_at at time zone coalesce(shift.time_zone, operational_time_zone))::date >= target_from_date',
    E'      and shift.canceled_at is null\n      and (shift.starts_at at time zone coalesce(shift.time_zone, operational_time_zone))::date between target_from_date and target_through_date'
  );

  if updated_sql = function_sql
    or position('shift.canceled_at is null' in updated_sql) = 0
    or position(
      '(shift.starts_at at time zone coalesce(shift.time_zone, operational_time_zone))::date between target_from_date and target_through_date'
      in updated_sql
    ) = 0
    or position(
      '(shift.ends_at at time zone coalesce(shift.time_zone, operational_time_zone))::date >= target_from_date'
      in updated_sql
    ) > 0
  then
    raise check_violation using message = 'Time Maintenance scheduled range could not be repaired safely.';
  end if;

  execute updated_sql;
end
$repair_team_attendance_schedule_range$;

notify pgrst, 'reload schema';

commit;
