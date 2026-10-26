-- Guarded forward recovery for a partial schedule-performance release where
-- 20261026142017_schedule_draft_set_based_clone.sql committed but
-- 20261026151000_schedule_edit_copy_on_write.sql did not commit. This restores
-- the exact reviewed production definitions and security boundaries that were
-- present immediately before 142017. The independent 141835 online index is
-- intentionally retained; use its own recovery only if that index must also be
-- removed.

begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $schedule_set_based_clone_recovery_preflight$
declare
  ensure_function pg_catalog.pg_proc%rowtype;
  normalize_function pg_catalog.pg_proc%rowtype;
  ensure_sql text;
  normalize_sql text;
begin
  -- A committed 151000 release requires the full 151000 recovery. Refuse to
  -- partially recover it with this earlier boundary.
  if to_regprocedure('public.scheduler_materialize_and_update_shift_v1(uuid,text,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text,text)') is not null
     or to_regprocedure('private.materialize_schedule_draft_revision(date)') is not null
     or to_regprocedure('public.get_weekly_schedule_payload_unversioned_20261026(date)') is not null
     or to_regprocedure('private.add_schedule_shift_version_tokens(jsonb)') is not null
     or to_regprocedure('private.schedule_shift_version_token(uuid,integer,public.schedule_status,timestamp with time zone,uuid,timestamp with time zone)') is not null
     or to_regclass('private.schedule_shift_revision_links') is not null then
    raise check_violation using message = 'The copy-on-write release is present; use the guarded 151000 recovery instead.';
  end if;

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
     or position('with target_shifts as materialized (' in normalize_sql) = 0
     or position('join public.shift_assignments assignment on assignment.shift_id = target_shift.id' in normalize_sql) = 0
     or pg_get_userbyid(ensure_function.proowner) <> 'postgres'
     or pg_get_userbyid(normalize_function.proowner) <> 'postgres'
     or ensure_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or normalize_function.proacl::text is distinct from '{postgres=X/postgres}'
     or ensure_function.proconfig is distinct from array['search_path=""']::text[]
     or normalize_function.proconfig is distinct from array['search_path=""']::text[]
     or not ensure_function.prosecdef
     or not normalize_function.prosecdef
     or ensure_function.provolatile <> 'v'
     or normalize_function.provolatile <> 'v' then
    raise check_violation using message = 'The installed 142017 schedule definitions or security boundary drifted; recovery stopped without changes.';
  end if;
end
$schedule_set_based_clone_recovery_preflight$;

-- Verified prior production definition. Expected pg_get_functiondef MD5:
-- df3b5a57e81dcb7f426a45c8a7f0e3f6.
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
    with active_assignment_counts as (
      select assignment.shift_id,
        count(*) filter (where assignment.status in ('assigned', 'confirmed', 'completed'))::integer as active_assignments
      from public.shift_assignments assignment
      group by assignment.shift_id
    ), grouped_shifts as (
      select
        shift.schedule_id, shift.post_id, shift.event_id, shift.starts_at, shift.ends_at,
        shift.time_zone, shift.requires_armed,
        array_agg(shift.id order by coalesce(active_assignment_counts.active_assignments, 0) desc, shift.created_at, shift.id) as shift_ids,
        (array_agg(shift.id order by coalesce(active_assignment_counts.active_assignments, 0) desc, shift.created_at, shift.id))[1] as survivor_shift_id,
        greatest(max(shift.headcount_required), sum(coalesce(active_assignment_counts.active_assignments, 0))::integer, 1) as normalized_headcount,
        bool_or(shift.is_overtime) as normalized_is_overtime
      from public.shifts shift
      left join active_assignment_counts on active_assignment_counts.shift_id = shift.id
      where shift.schedule_id = target_schedule_id
        and shift.canceled_at is null
        and shift.coverage_source_shift_id is null
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

revoke all on function private.normalize_schedule_duplicate_shift_blocks(uuid)
  from public, anon, authenticated, service_role;

-- Verified prior production definition. Expected pg_get_functiondef MD5:
-- b14f552161e0a3df53604bfd9067838c.
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
  copied_shift public.shifts%rowtype;
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
    for copied_shift in
      select shift.*
      from public.shifts shift
      where shift.schedule_id = source_schedule.id
        and shift.canceled_at is null
      order by shift.starts_at, shift.created_at, shift.id
    loop
      perform private.copy_schedule_shift_block(
        copied_shift.id,
        new_schedule_id,
        actor_id,
        null,
        null
      );
    end loop;
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

revoke all on function public.ensure_schedule_draft(date)
  from public, anon, authenticated, service_role;
grant execute on function public.ensure_schedule_draft(date)
  to authenticated, service_role;

do $schedule_set_based_clone_recovery_postflight$
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
     or md5(pg_get_functiondef(normalize_function.oid)) <> 'df3b5a57e81dcb7f426a45c8a7f0e3f6'
     or pg_get_userbyid(ensure_function.proowner) <> 'postgres'
     or pg_get_userbyid(normalize_function.proowner) <> 'postgres'
     or ensure_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or normalize_function.proacl::text is distinct from '{postgres=X/postgres}'
     or ensure_function.proconfig is distinct from array['search_path=""']::text[]
     or normalize_function.proconfig is distinct from array['search_path=""']::text[]
     or not ensure_function.prosecdef
     or not normalize_function.prosecdef
     or ensure_function.provolatile <> 'v'
     or normalize_function.provolatile <> 'v'
     or to_regprocedure('public.scheduler_materialize_and_update_shift_v1(uuid,text,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text,text)') is not null
     or to_regprocedure('private.materialize_schedule_draft_revision(date)') is not null
     or to_regprocedure('public.get_weekly_schedule_payload_unversioned_20261026(date)') is not null
     or to_regprocedure('private.add_schedule_shift_version_tokens(jsonb)') is not null
     or to_regprocedure('private.schedule_shift_version_token(uuid,integer,public.schedule_status,timestamp with time zone,uuid,timestamp with time zone)') is not null
     or to_regclass('private.schedule_shift_revision_links') is not null then
    raise check_violation using message = 'The 142017 partial-release recovery did not restore the reviewed production boundary.';
  end if;
end
$schedule_set_based_clone_recovery_postflight$;

notify pgrst, 'reload schema';

commit;
