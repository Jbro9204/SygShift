begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $schedule_draft_timeout_preflight$
declare
  ensure_function pg_catalog.pg_proc%rowtype;
  normalize_function pg_catalog.pg_proc%rowtype;
begin
  select * into strict ensure_function
  from pg_catalog.pg_proc
  where oid = 'public.ensure_schedule_draft(date)'::regprocedure;

  select * into strict normalize_function
  from pg_catalog.pg_proc
  where oid = 'private.normalize_schedule_duplicate_shift_blocks(uuid)'::regprocedure;

  if md5(pg_get_functiondef(ensure_function.oid)) <> 'b14f552161e0a3df53604bfd9067838c'
     or pg_get_userbyid(ensure_function.proowner) <> 'postgres'
     or ensure_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or ensure_function.proconfig is distinct from array['search_path=""']::text[]
     or not ensure_function.prosecdef
     or ensure_function.provolatile <> 'v' then
    raise check_violation using message = 'The schedule draft function or its security boundary differs from the reviewed production baseline.';
  end if;

  if md5(pg_get_functiondef(normalize_function.oid)) <> 'df3b5a57e81dcb7f426a45c8a7f0e3f6'
     or pg_get_userbyid(normalize_function.proowner) <> 'postgres'
     or normalize_function.proacl::text is distinct from '{postgres=X/postgres}'
     or normalize_function.proconfig is distinct from array['search_path=""']::text[]
     or not normalize_function.prosecdef
     or normalize_function.provolatile <> 'v' then
    raise check_violation using message = 'The schedule duplicate normalizer or its security boundary differs from the reviewed production baseline.';
  end if;
end
$schedule_draft_timeout_preflight$;

-- Keep duplicate detection scoped to the schedule being normalized. The
-- previous assignment-count CTE grouped every retained assignment before it
-- joined the target schedule.
create or replace function private.normalize_schedule_duplicate_shift_blocks(target_schedule_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_schedule_status public.schedule_status;
  duplicate_group record;
  duplicate_shift_ids uuid[];
  normalized_blocks integer := 0;
begin
  if target_schedule_id is null then return 0; end if;

  select schedule.status into target_schedule_status
  from public.schedules schedule
  where schedule.id = target_schedule_id;

  if target_schedule_status is null or target_schedule_status = 'published' then return 0; end if;

  perform pg_advisory_xact_lock(hashtext('schedule-duplicate-normalize:' || target_schedule_id::text));

  for duplicate_group in
    with target_shifts as materialized (
      select shift.id
      from public.shifts shift
      where shift.schedule_id = target_schedule_id
        and shift.canceled_at is null
        and shift.coverage_source_shift_id is null
    ), active_assignment_counts as (
      select assignment.shift_id,
        count(*) filter (where assignment.status in ('assigned', 'confirmed', 'completed'))::integer as active_assignments
      from target_shifts target_shift
      join public.shift_assignments assignment on assignment.shift_id = target_shift.id
      group by assignment.shift_id
    ), grouped_shifts as (
      select
        shift.schedule_id, shift.post_id, shift.event_id, shift.starts_at, shift.ends_at,
        shift.time_zone, shift.requires_armed,
        array_agg(shift.id order by coalesce(active_assignment_counts.active_assignments, 0) desc, shift.created_at, shift.id) as shift_ids,
        (array_agg(shift.id order by coalesce(active_assignment_counts.active_assignments, 0) desc, shift.created_at, shift.id))[1] as survivor_shift_id,
        greatest(max(shift.headcount_required), sum(coalesce(active_assignment_counts.active_assignments, 0))::integer, 1) as normalized_headcount,
        bool_or(shift.is_overtime) as normalized_is_overtime
      from target_shifts target_shift
      join public.shifts shift on shift.id = target_shift.id
      left join active_assignment_counts on active_assignment_counts.shift_id = shift.id
      group by shift.schedule_id, shift.post_id, shift.event_id, shift.starts_at,
        shift.ends_at, shift.time_zone, shift.requires_armed
      having count(*) > 1
    )
    select * from grouped_shifts
  loop
    duplicate_shift_ids := array_remove(duplicate_group.shift_ids, duplicate_group.survivor_shift_id);
    if duplicate_shift_ids is null or array_length(duplicate_shift_ids, 1) is null then continue; end if;

    update public.shifts shift
    set headcount_required = duplicate_group.normalized_headcount,
        is_overtime = coalesce(shift.is_overtime, false) or coalesce(duplicate_group.normalized_is_overtime, false),
        is_open = true, updated_at = clock_timestamp()
    where shift.id = duplicate_group.survivor_shift_id;

    update public.schedule_assignment_overrides override_record
    set shift_id = duplicate_group.survivor_shift_id
    where override_record.shift_id = any(duplicate_shift_ids);

    update public.shift_assignments duplicate_assignment
    set status = 'canceled', canceled_at = coalesce(duplicate_assignment.canceled_at, clock_timestamp()),
        cancellation_reason = coalesce(nullif(btrim(duplicate_assignment.cancellation_reason), ''), 'Duplicate schedule block normalized.'),
        updated_at = clock_timestamp()
    where duplicate_assignment.shift_id = any(duplicate_shift_ids)
      and duplicate_assignment.status in ('assigned', 'confirmed', 'completed')
      and exists (
        select 1 from public.shift_assignments survivor_assignment
        where survivor_assignment.shift_id = duplicate_group.survivor_shift_id
          and survivor_assignment.employee_id = duplicate_assignment.employee_id
          and survivor_assignment.status in ('assigned', 'confirmed', 'completed')
      );

    update public.shift_assignments assignment
    set shift_id = duplicate_group.survivor_shift_id, updated_at = clock_timestamp()
    where assignment.shift_id = any(duplicate_shift_ids)
      and assignment.status in ('assigned', 'confirmed', 'completed');

    update public.shifts duplicate_shift
    set is_open = false, canceled_at = coalesce(duplicate_shift.canceled_at, clock_timestamp()),
        canceled_by = coalesce(actor_id, duplicate_shift.created_by),
        cancellation_reason = coalesce(nullif(btrim(duplicate_shift.cancellation_reason), ''),
          'Duplicate schedule block normalized into the primary block.'),
        updated_at = clock_timestamp()
    where duplicate_shift.id = any(duplicate_shift_ids);

    update public.shifts survivor_shift
    set is_open = private.active_shift_assignment_count(survivor_shift.id) < survivor_shift.headcount_required,
        updated_at = clock_timestamp()
    where survivor_shift.id = duplicate_group.survivor_shift_id;

    normalized_blocks := normalized_blocks + 1;
  end loop;

  return normalized_blocks;
end
$$;

-- Prepare a new draft with one set-based clone instead of invoking the
-- shift-copy helper once per block. All ordinary table triggers remain enabled,
-- so qualification, time-off, overlap, capacity, audit, and open-state rules
-- continue to run for every copied row. Overrides are intentionally inserted
-- before assignments, matching the prior helper's qualification-override order.
create or replace function public.ensure_schedule_draft(target_week_starts_on date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  draft_schedule public.schedules%rowtype;
  source_schedule public.schedules%rowtype;
  new_schedule_id uuid;
  next_revision integer;
  shift_id_map jsonb := '{}'::jsonb;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to work on schedule drafts.';
  end if;

  if target_week_starts_on is null then
    raise check_violation using message = 'A schedule week is required.';
  end if;

  perform pg_advisory_xact_lock(hashtext('schedule-draft:' || target_week_starts_on::text));

  update public.schedules stale
  set
    status = 'archived',
    updated_at = clock_timestamp()
  where stale.week_starts_on = target_week_starts_on
    and stale.status = 'draft'
    and exists (
      select 1
      from public.schedules newer
      where newer.week_starts_on = stale.week_starts_on
        and newer.revision > stale.revision
        and newer.status in ('draft', 'published')
    );

  select schedule.* into draft_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and schedule.status = 'draft'
  order by schedule.revision desc
  limit 1;

  if draft_schedule.id is not null then
    perform private.normalize_schedule_duplicate_shift_blocks(draft_schedule.id);
    return public.get_weekly_schedule_payload(target_week_starts_on);
  end if;

  select schedule.* into source_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and schedule.status in ('published', 'superseded')
  order by schedule.revision desc
  limit 1;

  select coalesce(max(schedule.revision), 0) + 1 into next_revision
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on;

  insert into public.schedules (
    week_starts_on,
    revision,
    status,
    previous_revision_id,
    created_by
  ) values (
    target_week_starts_on,
    next_revision,
    'draft',
    source_schedule.id,
    actor_id
  )
  returning id into new_schedule_id;

  if source_schedule.id is not null then
    select coalesce(jsonb_object_agg(source_shift.id::text, gen_random_uuid()), '{}'::jsonb)
    into shift_id_map
    from public.shifts source_shift
    where source_shift.schedule_id = source_schedule.id
      and source_shift.canceled_at is null;

    insert into public.shifts (
      id, schedule_id, post_id, event_id, starts_at, ends_at, time_zone,
      headcount_required, requires_armed, is_open, is_overtime, notes,
      work_type, payroll_category, time_zone_source, time_zone_employee_id,
      assignment_type, coverage_source_shift_id, created_by
    )
    select
      (shift_id_map ->> source_shift.id::text)::uuid,
      new_schedule_id,
      source_shift.post_id,
      source_shift.event_id,
      source_shift.starts_at,
      source_shift.ends_at,
      source_shift.time_zone,
      source_shift.headcount_required,
      source_shift.requires_armed,
      source_shift.is_open,
      source_shift.is_overtime,
      source_shift.notes,
      source_shift.work_type,
      source_shift.payroll_category,
      source_shift.time_zone_source,
      source_shift.time_zone_employee_id,
      source_shift.assignment_type,
      source_shift.coverage_source_shift_id,
      actor_id
    from public.shifts source_shift
    where source_shift.schedule_id = source_schedule.id
      and source_shift.canceled_at is null
    order by source_shift.starts_at, source_shift.created_at, source_shift.id;

    insert into public.schedule_assignment_overrides (
      shift_id, employee_id, override_kind, note, created_by, created_at
    )
    select
      (shift_id_map ->> override_record.shift_id::text)::uuid,
      override_record.employee_id,
      override_record.override_kind,
      override_record.note,
      override_record.created_by,
      override_record.created_at
    from public.schedule_assignment_overrides override_record
    join public.shifts source_shift on source_shift.id = override_record.shift_id
    where source_shift.schedule_id = source_schedule.id
      and source_shift.canceled_at is null
      and exists (
        select 1
        from public.shift_assignments source_assignment
        where source_assignment.shift_id = override_record.shift_id
          and source_assignment.employee_id = override_record.employee_id
          and source_assignment.status in ('assigned', 'confirmed', 'completed')
      )
    order by override_record.shift_id, override_record.employee_id, override_record.created_at, override_record.id;

    insert into public.shift_assignments (
      shift_id, employee_id, status, assigned_by, assigned_at,
      confirmed_at, canceled_at, cancellation_reason
    )
    select
      (shift_id_map ->> assignment.shift_id::text)::uuid,
      assignment.employee_id,
      assignment.status,
      assignment.assigned_by,
      assignment.assigned_at,
      assignment.confirmed_at,
      assignment.canceled_at,
      assignment.cancellation_reason
    from public.shift_assignments assignment
    join public.shifts source_shift on source_shift.id = assignment.shift_id
    where source_shift.schedule_id = source_schedule.id
      and source_shift.canceled_at is null
      and assignment.status in ('assigned', 'confirmed', 'completed')
    order by assignment.employee_id, source_shift.starts_at, assignment.shift_id, assignment.id;

    -- Preserve the canonical helper's final open-state reconciliation. The
    -- ordinary insert/assignment triggers normally leave these rows correct,
    -- so the distinct predicate avoids timestamp/audit churn while retaining
    -- a set-based safety net for zero-assignment and future trigger cases.
    with copied_assignment_counts as (
      select copied_shift.id as shift_id,
        count(copied_assignment.id) filter (
          where copied_assignment.status in ('assigned', 'confirmed', 'completed')
        )::integer as active_assignments
      from public.shifts copied_shift
      left join public.shift_assignments copied_assignment
        on copied_assignment.shift_id = copied_shift.id
      where copied_shift.schedule_id = new_schedule_id
      group by copied_shift.id
    )
    update public.shifts copied_shift
    set
      is_open = assignment_count.active_assignments < copied_shift.headcount_required,
      updated_at = clock_timestamp()
    from copied_assignment_counts assignment_count
    where copied_shift.id = assignment_count.shift_id
      and copied_shift.is_open is distinct from (
        assignment_count.active_assignments < copied_shift.headcount_required
      );
  end if;

  perform private.normalize_schedule_duplicate_shift_blocks(new_schedule_id);

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    auth.uid(),
    actor_id,
    'public',
    'schedules',
    'ensure_draft',
    new_schedule_id::text,
    case when source_schedule.id is null then null else to_jsonb(source_schedule) end,
    jsonb_build_object(
      'week_starts_on', target_week_starts_on,
      'draft_schedule_id', new_schedule_id,
      'source_schedule_id', source_schedule.id
    )
  );

  return public.get_weekly_schedule_payload(target_week_starts_on);
end;
$$;

do $schedule_draft_timeout_postflight$
declare
  ensure_function pg_catalog.pg_proc%rowtype;
  normalize_function pg_catalog.pg_proc%rowtype;
  ensure_sql text;
  normalize_sql text;
begin
  select * into strict ensure_function
  from pg_catalog.pg_proc
  where oid = 'public.ensure_schedule_draft(date)'::regprocedure;

  select * into strict normalize_function
  from pg_catalog.pg_proc
  where oid = 'private.normalize_schedule_duplicate_shift_blocks(uuid)'::regprocedure;

  ensure_sql := pg_get_functiondef(ensure_function.oid);
  normalize_sql := pg_get_functiondef(normalize_function.oid);

  if position('jsonb_object_agg(source_shift.id::text, gen_random_uuid())' in ensure_sql) = 0
     or position('with copied_assignment_counts as (' in ensure_sql) = 0
     or position('perform private.copy_schedule_shift_block(' in ensure_sql) > 0
     or pg_get_userbyid(ensure_function.proowner) <> 'postgres'
     or ensure_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or ensure_function.proconfig is distinct from array['search_path=""']::text[]
     or not ensure_function.prosecdef
     or ensure_function.provolatile <> 'v' then
    raise check_violation using message = 'The set-based schedule draft function did not install with its preserved security boundary.';
  end if;

  if position('with target_shifts as materialized (' in normalize_sql) = 0
     or position('join public.shift_assignments assignment on assignment.shift_id = target_shift.id' in normalize_sql) = 0
     or pg_get_userbyid(normalize_function.proowner) <> 'postgres'
     or normalize_function.proacl::text is distinct from '{postgres=X/postgres}'
     or normalize_function.proconfig is distinct from array['search_path=""']::text[]
     or not normalize_function.prosecdef
     or normalize_function.provolatile <> 'v' then
    raise check_violation using message = 'The scoped duplicate normalizer did not install with its preserved security boundary.';
  end if;
end
$schedule_draft_timeout_postflight$;

notify pgrst, 'reload schema';

commit;
