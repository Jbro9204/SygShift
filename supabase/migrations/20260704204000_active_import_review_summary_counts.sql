create or replace function public.get_import_review_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform private.require_import_admin();

  select jsonb_build_object(
    'importRunId', run.id,
    'status', run.status,
    'sourceSha256', source.sha256,
    'sourceFilename', source.original_filename,
    'sourceCellCount', coalesce(run.source_cell_count, 0),
    'candidateCount', coalesce(run.normalized_record_count, 0),
    'blockingIssueCount', coalesce((
      select count(*)
      from private.import_issues issue
      where issue.import_run_id = run.id
        and issue.severity = 'blocking'
        and issue.resolved_at is null
    ), 0),
    'warningCount', coalesce((
      select count(*)
      from private.import_issues issue
      where issue.import_run_id = run.id
        and issue.severity = 'warning'
        and issue.resolved_at is null
    ), 0),
    'reconciliationDigest', run.reconciliation_digest,
    'createdAt', run.created_at,
    'candidateCounts', coalesce((
      select jsonb_object_agg(counts.key, counts.value)
      from (
        select candidate.kind || ':' || candidate.review_status as key, count(*) as value
        from private.import_candidates candidate
        where candidate.import_run_id = run.id
        group by candidate.kind, candidate.review_status
        order by candidate.kind, candidate.review_status
      ) counts
    ), '{}'::jsonb),
    'issueCounts', coalesce((
      select jsonb_object_agg(counts.key, counts.value)
      from (
        select issue.severity || ':' || case when issue.resolved_at is null then 'open' else 'resolved' end as key,
          count(*) as value
        from private.import_issues issue
        where issue.import_run_id = run.id
        group by issue.severity, issue.resolved_at is null
        order by issue.severity, issue.resolved_at is null
      ) counts
    ), '{}'::jsonb)
  ) into result
  from private.import_runs run
  join private.source_files source on source.id = run.source_file_id
  order by run.created_at desc
  limit 1;

  return result;
end
$$;

create or replace function public.get_bible_schedule_preview(target_week_starts_on date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with latest_import as (
    select import_run.id
    from private.import_runs import_run
    order by import_run.created_at desc
    limit 1
  ), schedule_candidate as (
    select candidate.*
    from private.import_candidates candidate
    join latest_import on latest_import.id = candidate.import_run_id
    where candidate.kind = 'weekly_schedule'
      and (candidate.payload ->> 'weekStartsOn')::date = target_week_starts_on
    order by candidate.candidate_key
    limit 1
  ), shift_candidates as (
    select candidate.*
    from private.import_candidates candidate
    join latest_import on latest_import.id = candidate.import_run_id
    where candidate.kind = 'shift'
      and (candidate.payload #>> '{sourceSchedule,weekStartsOn}')::date = target_week_starts_on
  ), issue_counts as (
    select
      count(*) filter (where issue.severity = 'blocking' and issue.resolved_at is null)::integer as blocking_count,
      count(*) filter (where issue.severity = 'warning' and issue.resolved_at is null)::integer as warning_count
    from private.import_issues issue
    join latest_import on latest_import.id = issue.import_run_id
  )
  select jsonb_build_object(
    'importRunId', latest_import.id,
    'weekStartsOn', target_week_starts_on,
    'weekEndsOn', schedule_candidate.payload ->> 'weekEndsOn',
    'sourceSheetName', schedule_candidate.payload ->> 'sourceSheetName',
    'sourceSheetIndex', nullif(schedule_candidate.payload ->> 'sourceSheetIndex', '')::integer,
    'blockingIssueCount', coalesce(issue_counts.blocking_count, 0),
    'warningIssueCount', coalesce(issue_counts.warning_count, 0),
    'shifts',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', shift_candidate.id,
            'candidateKey', shift_candidate.candidate_key,
            'reviewStatus', shift_candidate.review_status,
            'localDate', shift_candidate.payload ->> 'localDate',
            'startTime', shift_candidate.payload ->> 'startTime',
            'endTime', shift_candidate.payload ->> 'endTime',
            'crossesMidnight', coalesce((shift_candidate.payload ->> 'crossesMidnight')::boolean, false),
            'contextLabel', nullif(shift_candidate.payload ->> 'contextLabel', ''),
            'siteKeyCandidate', nullif(shift_candidate.payload ->> 'siteKeyCandidate', ''),
            'assigneeLabel', nullif(shift_candidate.payload ->> 'assigneeLabel', ''),
            'openCandidate', coalesce((shift_candidate.payload ->> 'openCandidate')::boolean, false),
            'qualificationCandidate', nullif(shift_candidate.payload ->> 'qualificationCandidate', ''),
            'confidence', nullif(shift_candidate.payload ->> 'confidence', ''),
            'sourceTimeAddress', shift_candidate.payload #>> '{sourceTime,address}',
            'sourceAssignmentAddress', shift_candidate.payload #>> '{sourceAssignment,address}'
          )
          order by
            shift_candidate.payload ->> 'contextLabel',
            shift_candidate.payload ->> 'localDate',
            shift_candidate.payload ->> 'startTime',
            shift_candidate.candidate_key
        )
        from shift_candidates shift_candidate
      ),
      '[]'::jsonb
    )
  )
  from latest_import
  left join schedule_candidate on true
  cross join issue_counts
  where exists (select 1 from schedule_candidate)
$$;

create or replace function public.get_imported_schedule_preview(target_week_starts_on date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.get_bible_schedule_preview(target_week_starts_on)
$$;

revoke all on function public.get_import_review_summary() from public, anon;
revoke all on function public.get_bible_schedule_preview(date) from public, anon;
revoke all on function public.get_imported_schedule_preview(date) from public, anon;
grant execute on function public.get_import_review_summary() to authenticated;
grant execute on function public.get_bible_schedule_preview(date) to authenticated;
grant execute on function public.get_imported_schedule_preview(date) to authenticated;
