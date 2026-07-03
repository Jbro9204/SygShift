begin;

create function private.require_import_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() or not public.has_mfa() then
    raise insufficient_privilege
      using message = 'Administrator access with MFA is required for source-data review.';
  end if;
end
$$;

create function public.get_import_review_summary()
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
    'blockingIssueCount', coalesce(run.blocking_issue_count, 0),
    'warningCount', coalesce(run.warning_count, 0),
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

create function public.get_import_candidates_page(
  target_import_run_id uuid,
  target_kind text default null,
  target_review_status text default 'pending',
  page_size integer default 50,
  page_offset integer default 0
)
returns table (
  id uuid,
  kind text,
  candidate_key text,
  confidence text,
  review_status text,
  payload jsonb,
  source_references jsonb,
  fingerprint text,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_import_admin();
  if target_kind is not null and target_kind not in ('weekly_schedule', 'employee', 'site', 'shift') then
    raise check_violation using message = 'Invalid import candidate kind.';
  end if;
  if target_review_status is not null
    and target_review_status not in ('pending', 'accepted', 'rejected', 'superseded')
  then
    raise check_violation using message = 'Invalid candidate review status.';
  end if;
  if page_size < 1 or page_size > 100 or page_offset < 0 then
    raise check_violation using message = 'Invalid import review page request.';
  end if;

  return query
  select
    candidate.id,
    candidate.kind,
    candidate.candidate_key,
    candidate.confidence,
    candidate.review_status,
    candidate.payload,
    candidate.source_references,
    candidate.fingerprint,
    candidate.created_at,
    count(*) over() as total_count
  from private.import_candidates candidate
  where candidate.import_run_id = target_import_run_id
    and (target_kind is null or candidate.kind = target_kind)
    and (target_review_status is null or candidate.review_status = target_review_status)
  order by
    case candidate.confidence when 'blocking_review' then 0 else 1 end,
    candidate.kind,
    candidate.candidate_key,
    candidate.id
  limit page_size offset page_offset;
end
$$;

create function public.get_import_issues_page(
  target_import_run_id uuid,
  target_severity public.issue_severity default null,
  target_resolved boolean default false,
  page_size integer default 50,
  page_offset integer default 0
)
returns table (
  id uuid,
  severity public.issue_severity,
  code text,
  message text,
  source_reference jsonb,
  related_sources jsonb,
  resolution text,
  resolved_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_import_admin();
  if page_size < 1 or page_size > 100 or page_offset < 0 then
    raise check_violation using message = 'Invalid import issue page request.';
  end if;

  return query
  select
    issue.id,
    issue.severity,
    issue.code,
    issue.message,
    issue.source_reference,
    issue.related_sources,
    issue.resolution,
    issue.resolved_at,
    count(*) over() as total_count
  from private.import_issues issue
  where issue.import_run_id = target_import_run_id
    and (target_severity is null or issue.severity = target_severity)
    and (target_resolved = (issue.resolved_at is not null))
  order by
    case issue.severity when 'blocking' then 0 when 'warning' then 1 else 2 end,
    issue.code,
    issue.id
  limit page_size offset page_offset;
end
$$;

create function public.review_import_candidate(
  target_candidate_id uuid,
  target_decision text,
  target_note text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  candidate_record private.import_candidates%rowtype;
  resulting_record jsonb;
begin
  perform private.require_import_admin();
  if target_decision not in ('accepted', 'rejected', 'superseded') then
    raise check_violation using message = 'Invalid candidate review decision.';
  end if;
  if btrim(coalesce(target_note, '')) = '' then
    raise check_violation using message = 'A review note is required.';
  end if;
  if char_length(target_note) > 4000 then
    raise check_violation using message = 'The review note exceeds 4,000 characters.';
  end if;

  select * into candidate_record
  from private.import_candidates candidate
  where candidate.id = target_candidate_id and candidate.review_status = 'pending'
  for update;

  if not found then
    raise check_violation using message = 'The import candidate is no longer pending.';
  end if;

  update private.import_candidates
  set
    review_status = target_decision,
    reviewed_by = reviewer_id,
    reviewed_at = clock_timestamp(),
    review_note = btrim(target_note)
  where id = target_candidate_id
  returning to_jsonb(import_candidates.*) into resulting_record;

  insert into private.import_review_decisions (
    import_run_id,
    candidate_id,
    decision,
    note,
    decided_by,
    previous_record,
    resulting_record
  ) values (
    candidate_record.import_run_id,
    candidate_record.id,
    target_decision,
    btrim(target_note),
    reviewer_id,
    to_jsonb(candidate_record),
    resulting_record
  );

  return true;
end
$$;

create function public.resolve_import_issue(target_issue_id uuid, target_resolution text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  issue_record private.import_issues%rowtype;
  resulting_record jsonb;
  open_blocking integer;
  open_warnings integer;
begin
  perform private.require_import_admin();
  if btrim(coalesce(target_resolution, '')) = '' then
    raise check_violation using message = 'An issue resolution is required.';
  end if;
  if char_length(target_resolution) > 4000 then
    raise check_violation using message = 'The issue resolution exceeds 4,000 characters.';
  end if;

  select * into issue_record
  from private.import_issues issue
  where issue.id = target_issue_id and issue.resolved_at is null
  for update;

  if not found then
    raise check_violation using message = 'The import issue is already resolved or unavailable.';
  end if;

  update private.import_issues
  set
    resolution = btrim(target_resolution),
    resolved_by = reviewer_id,
    resolved_at = clock_timestamp()
  where id = target_issue_id
  returning to_jsonb(import_issues.*) into resulting_record;

  insert into private.import_review_decisions (
    import_run_id,
    issue_id,
    decision,
    note,
    decided_by,
    previous_record,
    resulting_record
  ) values (
    issue_record.import_run_id,
    issue_record.id,
    'resolved',
    btrim(target_resolution),
    reviewer_id,
    to_jsonb(issue_record),
    resulting_record
  );

  select
    count(*) filter (where severity = 'blocking' and resolved_at is null),
    count(*) filter (where severity = 'warning' and resolved_at is null)
  into open_blocking, open_warnings
  from private.import_issues
  where import_run_id = issue_record.import_run_id;

  update private.import_runs
  set blocking_issue_count = open_blocking, warning_count = open_warnings
  where id = issue_record.import_run_id;

  return true;
end
$$;

revoke all on function public.get_import_review_summary() from public, anon;
revoke all on function public.get_import_candidates_page(uuid, text, text, integer, integer) from public, anon;
revoke all on function public.get_import_issues_page(uuid, public.issue_severity, boolean, integer, integer) from public, anon;
revoke all on function public.review_import_candidate(uuid, text, text) from public, anon;
revoke all on function public.resolve_import_issue(uuid, text) from public, anon;

grant execute on function public.get_import_review_summary() to authenticated;
grant execute on function public.get_import_candidates_page(uuid, text, text, integer, integer) to authenticated;
grant execute on function public.get_import_issues_page(uuid, public.issue_severity, boolean, integer, integer) to authenticated;
grant execute on function public.review_import_candidate(uuid, text, text) to authenticated;
grant execute on function public.resolve_import_issue(uuid, text) to authenticated;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;

commit;
