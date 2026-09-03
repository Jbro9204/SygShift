begin;

create temporary table scheduled_overtime_forecast_release_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.schedules) as schedule_count,
  (select count(*) from public.shifts) as shift_count,
  (select count(*) from public.shift_assignments) as assignment_count,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_number, status::text, employment_type::text, updated_at::text), '|' order by id)), md5('')) from public.employees) as employee_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, week_starts_on::text, revision::text, status::text, updated_at::text), '|' order by id)), md5('')) from public.schedules) as schedule_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, schedule_id::text, starts_at::text, ends_at::text, coalesce(canceled_at::text, ''), updated_at::text), '|' order by id)), md5('')) from public.shifts) as shift_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, shift_id::text, employee_id::text, status::text, coalesce(canceled_at::text, ''), updated_at::text), '|' order by id)), md5('')) from public.shift_assignments) as assignment_fingerprint;

create or replace function public.get_scheduled_overtime_forecast(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_schedule public.schedules%rowtype;
  employee_rows jsonb := '[]'::jsonb;
  flex_rows jsonb := '[]'::jsonb;
  overtime_employee_count integer := 0;
  armed_overtime_employee_count integer := 0;
  total_overtime_minutes integer := 0;
begin
  perform private.timekeeping_require_permission('time.reports.view');

  if target_week_starts_on is null or extract(dow from target_week_starts_on)::integer <> 0 then
    raise check_violation using message = 'Choose a Sunday as the report week.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
  order by
    case schedule.status when 'draft' then 0 when 'published' then 1 when 'superseded' then 2 else 3 end,
    schedule.revision desc,
    schedule.id
  limit 1;

  if target_schedule.id is null then
    return jsonb_build_object(
      'generatedAt', clock_timestamp(),
      'weekStartsOn', target_week_starts_on,
      'weekEndsOn', target_week_starts_on + 6,
      'schedule', null,
      'summary', jsonb_build_object('overtimeEmployees', 0, 'armedOvertimeEmployees', 0, 'totalOvertimeMinutes', 0),
      'employees', '[]'::jsonb,
      'armedFlexCandidates', '[]'::jsonb
    );
  end if;

  with assignment_rows as (
    select
      employee.id as employee_id,
      employee.employee_number,
      concat_ws(' ', employee.first_name, employee.last_name) as employee_name,
      employee.employment_type::text as employment_type,
      nullif(employee.work_classification, '') as work_classification,
      employee.job_title,
      shift.id as shift_id,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.requires_armed,
      greatest(0, round(extract(epoch from (shift.ends_at - shift.starts_at)) / 60.0)::integer) as scheduled_minutes,
      coalesce(site.name || ' · ' || post.name, nullif(event.location_name, ''), event.name, 'Scheduled assignment') as site_post,
      coalesce(override_record.note, '') as overtime_approval_note
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.employees employee on employee.id = assignment.employee_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    left join lateral (
      select assignment_override.note
      from public.schedule_assignment_overrides assignment_override
      where assignment_override.shift_id = shift.id
        and assignment_override.employee_id = employee.id
        and assignment_override.override_kind = 'scheduled_overtime'
      order by assignment_override.created_at desc, assignment_override.id desc
      limit 1
    ) override_record on true
    where shift.schedule_id = target_schedule.id
      and shift.canceled_at is null
      and assignment.canceled_at is null
      and assignment.status in ('assigned', 'confirmed', 'completed')
      and employee.status = 'active'
      and private.shift_assignment_type(shift.id) = 'standard'
  ), employee_totals as (
    select
      employee_id,
      min(employee_number) as employee_number,
      min(employee_name) as employee_name,
      min(employment_type) as employment_type,
      min(work_classification) as work_classification,
      min(job_title) as job_title,
      sum(scheduled_minutes)::integer as scheduled_minutes,
      sum(scheduled_minutes) filter (where requires_armed)::integer as armed_minutes,
      sum(scheduled_minutes) filter (where not requires_armed)::integer as unarmed_minutes,
      count(*)::integer as shift_count,
      count(*) filter (where requires_armed)::integer as armed_shift_count,
      string_agg(distinct site_post, '; ' order by site_post) as sites,
      nullif(string_agg(distinct nullif(overtime_approval_note, ''), '; ' order by nullif(overtime_approval_note, '')), '') as approval_notes,
      jsonb_agg(jsonb_build_object(
        'shiftId', shift_id,
        'date', (starts_at at time zone time_zone)::date,
        'startsAt', starts_at,
        'endsAt', ends_at,
        'timeZone', time_zone,
        'sitePost', site_post,
        'requiresArmed', requires_armed,
        'scheduledMinutes', scheduled_minutes,
        'approvalNote', nullif(overtime_approval_note, '')
      ) order by starts_at, shift_id) as shifts
    from assignment_rows
    group by employee_id
  ), overtime_rows as (
    select *, greatest(0, scheduled_minutes - 2400)::integer as overtime_minutes
    from employee_totals
    where scheduled_minutes > 2400
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'employeeId', employee_id,
      'employeeNumber', employee_number,
      'employeeName', employee_name,
      'employmentType', employment_type,
      'workClassification', work_classification,
      'jobTitle', job_title,
      'scheduledMinutes', scheduled_minutes,
      'overtimeMinutes', overtime_minutes,
      'armedMinutes', coalesce(armed_minutes, 0),
      'unarmedMinutes', coalesce(unarmed_minutes, 0),
      'shiftCount', shift_count,
      'armedShiftCount', armed_shift_count,
      'sites', sites,
      'approvalNotes', approval_notes,
      'shifts', shifts
    ) order by overtime_minutes desc, employee_name, employee_id), '[]'::jsonb),
    count(*)::integer,
    count(*) filter (where coalesce(armed_minutes, 0) > 0)::integer,
    coalesce(sum(overtime_minutes), 0)::integer
  into employee_rows, overtime_employee_count, armed_overtime_employee_count, total_overtime_minutes
  from overtime_rows;

  with scheduled_totals as (
    select
      assignment.employee_id,
      coalesce(sum(greatest(0, round(extract(epoch from (shift.ends_at - shift.starts_at)) / 60.0)::integer)), 0)::integer as scheduled_minutes
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    where shift.schedule_id = target_schedule.id
      and shift.canceled_at is null
      and assignment.canceled_at is null
      and assignment.status in ('assigned', 'confirmed', 'completed')
      and private.shift_assignment_type(shift.id) = 'standard'
    group by assignment.employee_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'employeeId', employee.id,
    'employeeNumber', employee.employee_number,
    'employeeName', concat_ws(' ', employee.first_name, employee.last_name),
    'employmentType', employee.employment_type::text,
    'jobTitle', employee.job_title,
    'scheduledMinutes', coalesce(scheduled_totals.scheduled_minutes, 0),
    'remainingMinutesBeforeOvertime', greatest(0, 2400 - coalesce(scheduled_totals.scheduled_minutes, 0)),
    'credentialValidThrough', target_week_starts_on + 6,
    'availabilityRequiresReview', true
  ) order by coalesce(scheduled_totals.scheduled_minutes, 0), employee.last_name, employee.first_name, employee.id), '[]'::jsonb)
  into flex_rows
  from public.employees employee
  left join scheduled_totals on scheduled_totals.employee_id = employee.id
  where employee.status = 'active'
    and employee.employment_type = 'flex'
    and public.has_valid_credential(employee.id, 'armed_guard', target_week_starts_on)
    and public.has_valid_credential(employee.id, 'armed_guard', target_week_starts_on + 6)
    and coalesce(scheduled_totals.scheduled_minutes, 0) < 2400;

  return jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'weekStartsOn', target_week_starts_on,
    'weekEndsOn', target_week_starts_on + 6,
    'schedule', jsonb_build_object(
      'id', target_schedule.id,
      'revision', target_schedule.revision,
      'status', target_schedule.status,
      'publishedAt', target_schedule.published_at
    ),
    'summary', jsonb_build_object(
      'overtimeEmployees', overtime_employee_count,
      'armedOvertimeEmployees', armed_overtime_employee_count,
      'totalOvertimeMinutes', total_overtime_minutes
    ),
    'employees', employee_rows,
    'armedFlexCandidates', flex_rows
  );
end
$$;

create or replace function public.authorize_scheduled_overtime_forecast_export(
  target_week_starts_on date,
  target_schedule_id uuid,
  target_employee_count integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  export_id uuid := gen_random_uuid();
  authorized_at timestamptz := clock_timestamp();
begin
  actor_id := private.timekeeping_require_permission('time.reports.view');

  if not public.is_admin() and not public.has_effective_permission('reports.export') then
    raise insufficient_privilege using message = 'Report export access is required.';
  end if;
  if target_week_starts_on is null or extract(dow from target_week_starts_on)::integer <> 0 then
    raise check_violation using message = 'Choose a Sunday as the report week.';
  end if;
  if target_schedule_id is null or not exists (
    select 1 from public.schedules schedule
    where schedule.id = target_schedule_id and schedule.week_starts_on = target_week_starts_on
  ) then
    raise check_violation using message = 'The selected schedule revision is not available.';
  end if;
  if target_employee_count is null or target_employee_count < 0 then
    raise check_violation using message = 'The report row count is invalid.';
  end if;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    auth.uid(), actor_id, 'public', 'scheduled_overtime_forecast',
    'SCHEDULED_OVERTIME_FORECAST_EXPORT', export_id::text,
    jsonb_build_object(
      'weekStartsOn', target_week_starts_on,
      'scheduleId', target_schedule_id,
      'employeeCount', target_employee_count,
      'authorizedAt', authorized_at
    )
  );

  return jsonb_build_object('authorizedAt', authorized_at, 'exportId', export_id);
end
$$;

revoke all on function public.get_scheduled_overtime_forecast(date) from public, anon, authenticated;
revoke all on function public.authorize_scheduled_overtime_forecast_export(date, uuid, integer) from public, anon, authenticated;
grant execute on function public.get_scheduled_overtime_forecast(date) to authenticated;
grant execute on function public.authorize_scheduled_overtime_forecast_export(date, uuid, integer) to authenticated;

do $$
declare baseline scheduled_overtime_forecast_release_baseline%rowtype;
begin
  select * into strict baseline from scheduled_overtime_forecast_release_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.schedule_count <> (select count(*) from public.schedules)
    or baseline.shift_count <> (select count(*) from public.shifts)
    or baseline.assignment_count <> (select count(*) from public.shift_assignments)
    or baseline.employee_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_number, status::text, employment_type::text, updated_at::text), '|' order by id)), md5('')) from public.employees)
    or baseline.schedule_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, week_starts_on::text, revision::text, status::text, updated_at::text), '|' order by id)), md5('')) from public.schedules)
    or baseline.shift_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, schedule_id::text, starts_at::text, ends_at::text, coalesce(canceled_at::text, ''), updated_at::text), '|' order by id)), md5('')) from public.shifts)
    or baseline.assignment_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, shift_id::text, employee_id::text, status::text, coalesce(canceled_at::text, ''), updated_at::text), '|' order by id)), md5('')) from public.shift_assignments)
  then
    raise exception 'Scheduled overtime report release changed protected employee or schedule data.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
