-- The operational schedule, sites, posts, and employees have already been promoted.
-- These remaining import issues are source-cell parser warnings/blockers with no
-- actionable candidate record, so they clutter the admin experience without giving
-- supervisors a thing they can fix in the app. Preserve audit history by resolving
-- them with an explicit system note instead of deleting rows.

update private.import_issues issue
set
  resolved_at = coalesce(issue.resolved_at, clock_timestamp()),
  resolved_by = coalesce(
    issue.resolved_by,
    (select employee.id from public.employees employee where employee.username = 'jbrown' limit 1)
  ),
  resolution = coalesce(
    issue.resolution,
    'Resolved by SygShift data-quality cleanup: source-only parser alert was superseded by promoted operational schedule, site, post, and employee records.'
  )
where issue.resolved_at is null
  and issue.candidate_id is null
  and issue.code in (
    'SHIFT_CONTEXT_COMPLEX',
    'SITE_QUALIFICATION_UNKNOWN',
    'SHIFT_ASSIGNEE_MULTIPLE_OR_AMBIGUOUS',
    'SHIFT_CONTEXT_MISSING',
    'DIRECTORY_DUPLICATE_NAME_REVIEW'
  )
  and exists (
    select 1
    from public.schedules schedule
    where schedule.status = 'published'
  );
