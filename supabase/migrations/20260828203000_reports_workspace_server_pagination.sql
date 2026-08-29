begin;

create or replace function private.report_legal_employee_name(display_name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select concat_ws(' ', employee.first_name, employee.last_name)
  from public.employees employee
  where lower(concat_ws(' ', employee.first_name, employee.last_name)) = lower(coalesce(display_name, ''))
     or lower(concat_ws(' ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name)) = lower(coalesce(display_name, ''))
  order by
    case when lower(concat_ws(' ', employee.first_name, employee.last_name)) = lower(coalesce(display_name, '')) then 0 else 1 end,
    employee.id
  limit 1
$$;

revoke all on function private.report_legal_employee_name(text) from public, anon, authenticated;

create or replace function public.get_timekeeping_operations_report_page(
  target_report_key text,
  target_from_date date,
  target_through_date date,
  target_scope text default 'active',
  target_search text default null,
  target_filter_key text default null,
  target_filter_value text default null,
  target_sort text default 'priority',
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  source_payload jsonb;
  source_rows jsonb;
  normalized_rows jsonb;
  filtered_rows jsonb;
  scoped_rows jsonb;
  page_rows jsonb;
  active_count integer := 0;
  archive_count integer := 0;
  total_count integer := 0;
  total_pages integer := 0;
  allowed_reports constant text[] := array[
    'timekeepingExceptions',
    'automaticClockOuts',
    'manualTimeEntryAudit',
    'timeAdjustmentRequests',
    'attendanceCallOffs',
    'scheduledVsActual',
    'coverageUnfilled',
    'overtimePayrollRisk'
  ];
  allowed_filter_keys constant text[] := array[
    'employeeName', 'sitePost', 'exceptionCode', 'status', 'resolutionMethod',
    'adjustmentStatus', 'issueType', 'reviewer', 'callOffType', 'payrollReady'
  ];
begin
  perform private.timekeeping_require_permission('time.reports.view');

  if target_report_key is null or not (target_report_key = any(allowed_reports)) then
    raise check_violation using message = 'Choose a valid operational report.';
  end if;
  if target_from_date is null or target_through_date is null
    or target_through_date < target_from_date
    or target_through_date - target_from_date > 366 then
    raise check_violation using message = 'Choose a valid report range of 366 days or fewer.';
  end if;
  if target_scope not in ('active', 'archive', 'all') then
    raise check_violation using message = 'Choose Active, Archive, or All records.';
  end if;
  if target_page is null or target_page < 1 then
    raise check_violation using message = 'Choose a valid report page.';
  end if;
  if target_page_size is null or target_page_size not in (10, 25, 50) then
    raise check_violation using message = 'Choose 10, 25, or 50 rows per page.';
  end if;
  if nullif(target_filter_key, '') is not null and not (target_filter_key = any(allowed_filter_keys)) then
    raise check_violation using message = 'Choose a supported report filter.';
  end if;
  if target_sort not in ('priority', 'newest', 'oldest', 'employee') then
    raise check_violation using message = 'Choose a supported report sort.';
  end if;

  source_payload := public.get_timekeeping_operations_reports(target_from_date, target_through_date);
  source_rows := coalesce(source_payload -> target_report_key, '[]'::jsonb);

  select coalesce(jsonb_agg(
    (
      case when row_value ? 'employeeName' then
        jsonb_set(
          row_value,
          '{employeeName}',
          to_jsonb(coalesce(private.report_legal_employee_name(row_value ->> 'employeeName'), row_value ->> 'employeeName')),
          true
        )
      else row_value end
      || case when row_value ? 'reviewer' and nullif(row_value ->> 'reviewer', '') is not null then
        jsonb_build_object('reviewer', coalesce(private.report_legal_employee_name(row_value ->> 'reviewer'), row_value ->> 'reviewer'))
      else '{}'::jsonb end
      || case when row_value ? 'resolvedBy' and nullif(row_value ->> 'resolvedBy', '') is not null then
        jsonb_build_object('resolvedBy', coalesce(private.report_legal_employee_name(row_value ->> 'resolvedBy'), row_value ->> 'resolvedBy'))
      else '{}'::jsonb end
      || case when row_value ? 'actor' and nullif(row_value ->> 'actor', '') is not null then
        jsonb_build_object('actor', coalesce(private.report_legal_employee_name(row_value ->> 'actor'), row_value ->> 'actor'))
      else '{}'::jsonb end
      || jsonb_build_object('_stableOrdinal', row_ordinality)
      || jsonb_build_object('_isActive', case target_report_key
        when 'timekeepingExceptions' then coalesce(row_value ->> 'status', 'unresolved') = 'unresolved'
        when 'automaticClockOuts' then coalesce(row_value ->> 'status', 'unresolved') = 'unresolved'
          or coalesce(row_value ->> 'adjustmentStatus', '') in ('submitted', 'under_review')
        when 'manualTimeEntryAudit' then true
        when 'timeAdjustmentRequests' then coalesce(row_value ->> 'status', 'submitted') in ('submitted', 'under_review')
        when 'attendanceCallOffs' then nullif(row_value ->> 'canceledAt', '') is null
        when 'scheduledVsActual' then not coalesce((row_value ->> 'payrollReady')::boolean, false)
        when 'coverageUnfilled' then coalesce((row_value ->> 'openCount')::integer, 0) > 0
          or coalesce((row_value ->> 'callOffCount')::integer, 0) > 0
        when 'overtimePayrollRisk' then true
        else true
      end)
    ) order by row_ordinality
  ), '[]'::jsonb)
  into normalized_rows
  from jsonb_array_elements(source_rows) with ordinality source(row_value, row_ordinality);

  select coalesce(jsonb_agg(row_value order by row_ordinality), '[]'::jsonb)
  into filtered_rows
  from jsonb_array_elements(normalized_rows) with ordinality rows(row_value, row_ordinality)
  where (
      nullif(btrim(coalesce(target_search, '')), '') is null
      or row_value::text ilike '%' || btrim(target_search) || '%'
    )
    and (
      nullif(target_filter_key, '') is null
      or nullif(target_filter_value, '') is null
      or lower(coalesce(row_value ->> target_filter_key, '')) = lower(target_filter_value)
    );

  select
    count(*) filter (where coalesce((row_value ->> '_isActive')::boolean, false)),
    count(*) filter (where not coalesce((row_value ->> '_isActive')::boolean, false))
  into active_count, archive_count
  from jsonb_array_elements(filtered_rows) rows(row_value);

  select coalesce(jsonb_agg(row_value), '[]'::jsonb)
  into scoped_rows
  from jsonb_array_elements(filtered_rows) rows(row_value)
  where target_scope = 'all'
    or (target_scope = 'active' and coalesce((row_value ->> '_isActive')::boolean, false))
    or (target_scope = 'archive' and not coalesce((row_value ->> '_isActive')::boolean, false));

  total_count := jsonb_array_length(scoped_rows);
  total_pages := case when total_count = 0 then 0 else ceil(total_count::numeric / target_page_size)::integer end;

  select coalesce(jsonb_agg(row_value - '_isActive' - '_stableOrdinal'), '[]'::jsonb)
  into page_rows
  from (
    select row_value
    from jsonb_array_elements(scoped_rows) rows(row_value)
    order by
      case when target_sort = 'priority' then
        case
          when row_value ->> 'status' in ('unresolved', 'submitted', 'under_review') then 0
          when coalesce((row_value ->> 'openCount')::integer, 0) > 0 then 0
          when coalesce((row_value ->> 'payrollReady')::boolean, true) = false then 0
          else 1
        end
      else 0 end,
      case when target_sort = 'employee' then lower(coalesce(row_value ->> 'employeeName', row_value ->> 'sitePost', '')) end asc,
      case when target_sort = 'oldest' then coalesce(
        row_value ->> 'detectedAt', row_value ->> 'submittedAt', row_value ->> 'reportedAt',
        row_value ->> 'scheduledStartAt', row_value ->> 'startsAt', row_value ->> 'workDate',
        row_value ->> 'operationalDate', row_value ->> 'createdAt', ''
      ) end asc,
      case when target_sort in ('priority', 'newest') then coalesce(
        row_value ->> 'detectedAt', row_value ->> 'submittedAt', row_value ->> 'reportedAt',
        row_value ->> 'scheduledStartAt', row_value ->> 'startsAt', row_value ->> 'workDate',
        row_value ->> 'operationalDate', row_value ->> 'createdAt', ''
      ) end desc,
      coalesce(row_value ->> 'id', row_value ->> 'manualEntryId', row_value ->> 'shiftId', row_value ->> 'employeeId', row_value ->> '_stableOrdinal') asc
    offset (target_page - 1) * target_page_size
    limit target_page_size
  ) page;

  return jsonb_build_object(
    'reportKey', target_report_key,
    'generatedAt', source_payload ->> 'generatedAt',
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'scope', target_scope,
    'page', target_page,
    'pageSize', target_page_size,
    'totalCount', total_count,
    'totalPages', total_pages,
    'activeCount', active_count,
    'archiveCount', archive_count,
    'rows', page_rows
  );
end
$$;

revoke all on function public.get_timekeeping_operations_report_page(text, date, date, text, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_timekeeping_operations_report_page(text, date, date, text, text, text, text, text, integer, integer) to authenticated;

notify pgrst, 'reload schema';

commit;
