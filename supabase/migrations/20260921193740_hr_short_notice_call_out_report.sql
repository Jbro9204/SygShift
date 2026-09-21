begin;

-- HR-only short-notice call-out reporting. The report uses the actual received
-- timestamp when Dispatch or management recorded one, and falls back to the
-- immutable report timestamp for older/self-service records. Exactly four
-- hours is compliant; only records below 240 minutes are returned.
create or replace function public.get_hr_short_notice_call_out_report(
  target_from_date date,
  target_through_date date,
  target_export boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  rows_payload jsonb := '[]'::jsonb;
  short_notice_count integer := 0;
  after_start_count integer := 0;
  no_show_count integer := 0;
  uncovered_count integer := 0;
  repeat_employee_count integer := 0;
begin
  if actor_id is null
    or not public.has_mfa()
    or not public.has_effective_permission('hr.reporting.view') then
    raise insufficient_privilege using message = 'HR reporting permission with recent MFA is required.';
  end if;

  if target_export is true
    and not public.has_effective_permission('hr.reporting.export') then
    raise insufficient_privilege using message = 'HR report export permission is required.';
  end if;

  if target_from_date is null
    or target_through_date is null
    or target_through_date < target_from_date
    or target_through_date - target_from_date > 366 then
    raise check_violation using message = 'Choose a valid report range of 366 days or fewer.';
  end if;

  with short_notice_rows as materialized (
    select
      report.id,
      report.employee_id,
      concat_ws(' ', employee.first_name, employee.last_name) as employee_name,
      employee.employee_number,
      employee.job_title,
      employee.employment_type::text as employment_type,
      (shift.starts_at at time zone shift.time_zone)::date as operational_date,
      shift.starts_at as scheduled_start_at,
      shift.ends_at as scheduled_end_at,
      shift.time_zone,
      coalesce(report.call_received_at, report.reported_at) as call_received_at,
      floor(extract(epoch from (
        shift.starts_at - coalesce(report.call_received_at, report.reported_at)
      )) / 60)::integer as notice_minutes,
      case
        when attendance.event_type = 'no_call_no_show' then 'no_call_no_show'
        when report.call_off_type = 'sick' then 'called_in_sick'
        when report.reason ilike '%sick%' then 'called_in_sick'
        else 'call_off'
      end as occurrence_type,
      report.reason,
      report.operational_details,
      report.replacement_needed,
      report.canceled_at,
      coalesce(attendance.review_outcome, 'pending_hr_review') as review_outcome,
      attendance.reviewed_at,
      attendance.decision_note,
      concat_ws(' ', reviewer.first_name, reviewer.last_name) as reviewed_by_name,
      site.name as site_name,
      site.code as site_code,
      post.name as post_name,
      event.name as event_name,
      coalesce(event.location_name, site.name, post.name, 'Scheduled shift') as location_name,
      client.display_name as client_name,
      case
        when report.reported_by = report.employee_id
          and coalesce(report.received_by, report.reported_by) = report.employee_id
          then 'employee_self_service'
        when report.reported_by is not null or report.received_by is not null
          then 'management_entry'
        else 'legacy_record'
      end as submission_source,
      concat_ws(' ', receiver.first_name, receiver.last_name) as received_by_name,
      concat_ws(' ', reporter.first_name, reporter.last_name) as reported_by_name,
      case
        when report.canceled_at is not null then 'canceled'
        when coverage.coverage_mode = 'assigned_guard'
          and coverage.replacement_employee_id is not null then 'covered'
        when coverage.coverage_mode = 'no_replacement' then 'no_replacement'
        when coverage.coverage_mode = 'patrol_review' then 'patrol_review'
        when coverage.status = 'open_pool' then 'open_pool'
        when not report.replacement_needed then 'not_required'
        else 'pending'
      end as coverage_status,
      concat_ws(' ', replacement.first_name, replacement.last_name) as replacement_employee_name,
      coalesce(coverage_shift.is_overtime, false) as overtime_created,
      attendance.id as attendance_event_id
    from public.call_off_reports report
    join public.employees employee on employee.id = report.employee_id
    join public.shifts shift on shift.id = report.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    left join public.clients client on client.id = coalesce(event.client_id, site.client_id)
    left join public.employees receiver on receiver.id = report.received_by
    left join public.employees reporter on reporter.id = report.reported_by
    left join public.shift_coverage_cases coverage on coverage.call_off_report_id = report.id
    left join public.shifts coverage_shift on coverage_shift.id = coverage.coverage_shift_id
    left join public.employees replacement on replacement.id = coverage.replacement_employee_id
    left join lateral (
      select account_event.*
      from public.attendance_accountability_events account_event
      where account_event.call_off_report_id = report.id
        and account_event.status <> 'voided'
      order by account_event.created_at, account_event.id
      limit 1
    ) attendance on true
    left join public.employees reviewer on reviewer.id = attendance.reviewed_by
    where (shift.starts_at at time zone shift.time_zone)::date
      between target_from_date and target_through_date
      and coalesce(report.call_received_at, report.reported_at)
        > shift.starts_at - interval '4 hours'
  )
  select
    count(*)::integer,
    count(*) filter (where notice_minutes < 0)::integer,
    count(*) filter (where occurrence_type = 'no_call_no_show')::integer,
    count(*) filter (where replacement_needed and coverage_status in ('pending', 'open_pool', 'no_replacement', 'patrol_review'))::integer,
    (
      select count(*)::integer
      from (
        select repeat_row.employee_id
        from short_notice_rows repeat_row
        group by repeat_row.employee_id
        having count(*) > 1
      ) repeated_employees
    ),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', row.id,
      'employeeId', row.employee_id,
      'employeeName', row.employee_name,
      'employeeNumber', row.employee_number,
      'jobTitle', row.job_title,
      'employmentType', row.employment_type,
      'operationalDate', row.operational_date,
      'scheduledStartAt', row.scheduled_start_at,
      'scheduledEndAt', row.scheduled_end_at,
      'timeZone', row.time_zone,
      'callReceivedAt', row.call_received_at,
      'noticeMinutes', row.notice_minutes,
      'noticeBucket', case
        when row.notice_minutes < 0 then 'after_start'
        when row.notice_minutes < 60 then 'under_1_hour'
        when row.notice_minutes < 120 then '1_to_2_hours'
        when row.notice_minutes < 180 then '2_to_3_hours'
        else '3_to_4_hours'
      end,
      'occurrenceType', row.occurrence_type,
      'reason', row.reason,
      'operationalDetails', row.operational_details,
      'replacementNeeded', row.replacement_needed,
      'recordStatus', case when row.canceled_at is null then 'recorded' else 'canceled' end,
      'canceledAt', row.canceled_at,
      'reviewOutcome', row.review_outcome,
      'reviewedAt', row.reviewed_at,
      'reviewedByName', nullif(row.reviewed_by_name, ''),
      'decisionNote', row.decision_note,
      'clientName', row.client_name,
      'siteName', row.site_name,
      'siteCode', row.site_code,
      'postName', row.post_name,
      'eventName', row.event_name,
      'locationName', row.location_name,
      'submissionSource', row.submission_source,
      'receivedByName', nullif(row.received_by_name, ''),
      'reportedByName', nullif(row.reported_by_name, ''),
      'coverageStatus', row.coverage_status,
      'replacementEmployeeName', nullif(row.replacement_employee_name, ''),
      'overtimeCreated', row.overtime_created,
      'attendanceEventId', row.attendance_event_id,
      'actionPath', concat('/requests?callOff=', row.id)
    ) order by row.scheduled_start_at desc, row.employee_name, row.id), '[]'::jsonb)
  into short_notice_count, after_start_count, no_show_count, uncovered_count,
    repeat_employee_count, rows_payload
  from short_notice_rows row;

  if target_export is true then
    insert into private.audit_events (
      auth_user_id,
      employee_id,
      schema_name,
      table_name,
      operation,
      row_id,
      new_record
    ) values (
      auth.uid(),
      actor_id,
      'public',
      'call_off_reports',
      'EXPORT',
      'hr-short-notice-call-outs',
      jsonb_build_object(
        'fromDate', target_from_date,
        'throughDate', target_through_date,
        'noticeThresholdMinutes', 240,
        'recordCount', short_notice_count
      )
    );
  end if;

  return jsonb_build_object(
    'serverTimestamp', statement_timestamp(),
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'noticeThresholdMinutes', 240,
    'countingRule', 'Call received less than four hours before scheduled start. Exactly four hours is compliant.',
    'summary', jsonb_build_object(
      'shortNoticeCount', short_notice_count,
      'afterStartCount', after_start_count,
      'noShowCount', no_show_count,
      'uncoveredCount', uncovered_count,
      'repeatEmployeeCount', repeat_employee_count
    ),
    'rows', rows_payload
  );
end
$$;

revoke all on function public.get_hr_short_notice_call_out_report(date, date, boolean)
  from public, anon;
grant execute on function public.get_hr_short_notice_call_out_report(date, date, boolean)
  to authenticated;

notify pgrst, 'reload schema';

commit;
