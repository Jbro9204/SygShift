begin;

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
      count(*) filter (where issue.severity = 'blocking' and issue.resolution is null)::integer as blocking_count,
      count(*) filter (where issue.severity = 'warning' and issue.resolution is null)::integer as warning_count
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

revoke all on function public.get_bible_schedule_preview(date) from public, anon;
grant execute on function public.get_bible_schedule_preview(date) to authenticated;

commit;
