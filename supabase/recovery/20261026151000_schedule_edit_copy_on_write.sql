-- Guarded forward recovery for the coupled schedule draft performance and
-- copy-on-write release. Execute only after rolling the browser bundle back to
-- a build that calls scheduler_update_typed_draft_shift_with_payroll_category_v1.
-- This restores the exact reviewed pre-release materializer and duplicate
-- normalizer definitions. The lineage table remains as inert audit evidence.

begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $schedule_copy_on_write_recovery_preflight$
declare
  atomic_update_function pg_catalog.pg_proc%rowtype;
  materializer_function pg_catalog.pg_proc%rowtype;
  ensure_function pg_catalog.pg_proc%rowtype;
  payload_function pg_catalog.pg_proc%rowtype;
  unversioned_payload_function pg_catalog.pg_proc%rowtype;
  normalize_function pg_catalog.pg_proc%rowtype;
  atomic_update_sql text;
  materializer_sql text;
  ensure_sql text;
  normalize_sql text;
begin
  if to_regprocedure('public.scheduler_materialize_and_update_shift_v1(uuid,text,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text,text)') is null
     or to_regprocedure('private.materialize_schedule_draft_revision(date)') is null
     or to_regprocedure('public.get_weekly_schedule_payload_unversioned_20261026(date)') is null
     or to_regclass('private.schedule_shift_revision_links') is null then
    raise check_violation using message = 'The installed schedule copy-on-write boundary does not match this recovery.';
  end if;

  select * into strict atomic_update_function
  from pg_catalog.pg_proc
  where oid = 'public.scheduler_materialize_and_update_shift_v1(uuid,text,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text,text)'::regprocedure;
  select * into strict materializer_function
  from pg_catalog.pg_proc
  where oid = 'private.materialize_schedule_draft_revision(date)'::regprocedure;
  select * into strict ensure_function
  from pg_catalog.pg_proc
  where oid = 'public.ensure_schedule_draft(date)'::regprocedure;
  select * into strict payload_function
  from pg_catalog.pg_proc
  where oid = 'public.get_weekly_schedule_payload(date)'::regprocedure;
  select * into strict unversioned_payload_function
  from pg_catalog.pg_proc
  where oid = 'public.get_weekly_schedule_payload_unversioned_20261026(date)'::regprocedure;
  select * into strict normalize_function
  from pg_catalog.pg_proc
  where oid = 'private.normalize_schedule_duplicate_shift_blocks(uuid)'::regprocedure;

  atomic_update_sql := pg_get_functiondef(atomic_update_function.oid);
  materializer_sql := pg_get_functiondef(materializer_function.oid);
  ensure_sql := pg_get_functiondef(ensure_function.oid);
  normalize_sql := pg_get_functiondef(normalize_function.oid);

  if position('expected_shift_version is distinct from current_shift_version' in atomic_update_sql) = 0
     or position('private.schedule_shift_revision_links' in atomic_update_sql) = 0
     or position('insert into private.schedule_shift_revision_links' in materializer_sql) = 0
     or position('private.materialize_schedule_draft_revision(target_week_starts_on)' in ensure_sql) = 0
     or position('with target_shifts as materialized (' in normalize_sql) = 0
     or pg_get_userbyid(atomic_update_function.proowner) <> 'postgres'
     or pg_get_userbyid(materializer_function.proowner) <> 'postgres'
     or pg_get_userbyid(ensure_function.proowner) <> 'postgres'
     or pg_get_userbyid(payload_function.proowner) <> 'postgres'
     or pg_get_userbyid(unversioned_payload_function.proowner) <> 'postgres'
     or pg_get_userbyid(normalize_function.proowner) <> 'postgres'
     or atomic_update_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres}'
     or materializer_function.proacl::text is distinct from '{postgres=X/postgres}'
     or ensure_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or payload_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or unversioned_payload_function.proacl::text is distinct from '{postgres=X/postgres}'
     or normalize_function.proacl::text is distinct from '{postgres=X/postgres}'
     or atomic_update_function.proconfig is distinct from array['search_path=""']::text[]
     or materializer_function.proconfig is distinct from array['search_path=""']::text[]
     or ensure_function.proconfig is distinct from array['search_path=""']::text[]
     or payload_function.proconfig is distinct from array['search_path=""']::text[]
     or unversioned_payload_function.proconfig is distinct from array['search_path=public, private']::text[]
     or normalize_function.proconfig is distinct from array['search_path=""']::text[]
     or not atomic_update_function.prosecdef
     or not materializer_function.prosecdef
     or not ensure_function.prosecdef
     or not payload_function.prosecdef
     or not unversioned_payload_function.prosecdef
     or not normalize_function.prosecdef then
    raise check_violation using message = 'The installed schedule copy-on-write definitions or security boundary drifted; recovery stopped without changes.';
  end if;
end
$schedule_copy_on_write_recovery_preflight$;

revoke all on function public.scheduler_materialize_and_update_shift_v1(
  uuid, text, date, time without time zone, time without time zone, integer,
  boolean, boolean, text, text, uuid, text, text, text, text, text
) from public, anon, authenticated;
drop function public.scheduler_materialize_and_update_shift_v1(
  uuid, text, date, time without time zone, time without time zone, integer,
  boolean, boolean, text, text, uuid, text, text, text, text, text
);

drop function public.get_weekly_schedule_payload(date);
alter function public.get_weekly_schedule_payload_unversioned_20261026(date)
  rename to get_weekly_schedule_payload;
revoke all on function public.get_weekly_schedule_payload(date)
  from public, anon, authenticated, service_role;
grant execute on function public.get_weekly_schedule_payload(date)
  to authenticated, service_role;

drop function private.add_schedule_shift_version_tokens(jsonb);
drop function private.schedule_shift_version_token(
  uuid, integer, public.schedule_status, timestamptz, uuid, timestamptz
);

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

revoke all on function public.ensure_schedule_draft(date) from public, anon;
grant execute on function public.ensure_schedule_draft(date) to authenticated, service_role;

drop function private.materialize_schedule_draft_revision(date);

comment on table private.schedule_shift_revision_links is
  'Inactive source-to-draft lineage retained after guarded schedule copy-on-write recovery; no browser role has access.';

do $schedule_copy_on_write_recovery_postflight$
declare
  ensure_function pg_catalog.pg_proc%rowtype;
  normalize_function pg_catalog.pg_proc%rowtype;
  payload_function pg_catalog.pg_proc%rowtype;
begin
  select * into strict ensure_function
  from pg_catalog.pg_proc
  where oid = 'public.ensure_schedule_draft(date)'::regprocedure;
  select * into strict normalize_function
  from pg_catalog.pg_proc
  where oid = 'private.normalize_schedule_duplicate_shift_blocks(uuid)'::regprocedure;
  select * into strict payload_function
  from pg_catalog.pg_proc
  where oid = 'public.get_weekly_schedule_payload(date)'::regprocedure;

  if md5(pg_get_functiondef(ensure_function.oid)) <> 'b14f552161e0a3df53604bfd9067838c'
     or md5(pg_get_functiondef(normalize_function.oid)) <> 'df3b5a57e81dcb7f426a45c8a7f0e3f6'
     or pg_get_userbyid(ensure_function.proowner) <> 'postgres'
     or pg_get_userbyid(normalize_function.proowner) <> 'postgres'
     or pg_get_userbyid(payload_function.proowner) <> 'postgres'
     or ensure_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or normalize_function.proacl::text is distinct from '{postgres=X/postgres}'
     or ensure_function.proconfig is distinct from array['search_path=""']::text[]
     or normalize_function.proconfig is distinct from array['search_path=""']::text[]
     or payload_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or payload_function.proconfig is distinct from array['search_path=public, private']::text[]
     or not ensure_function.prosecdef
     or not normalize_function.prosecdef
     or not payload_function.prosecdef
     or ensure_function.provolatile <> 'v'
     or normalize_function.provolatile <> 'v'
     or payload_function.provolatile <> 's'
     or to_regprocedure('public.scheduler_materialize_and_update_shift_v1(uuid,text,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text,text)') is not null
     or to_regprocedure('private.materialize_schedule_draft_revision(date)') is not null
     or to_regprocedure('public.get_weekly_schedule_payload_unversioned_20261026(date)') is not null
     or to_regprocedure('private.add_schedule_shift_version_tokens(jsonb)') is not null
     or to_regprocedure('private.schedule_shift_version_token(uuid,integer,public.schedule_status,timestamp with time zone,uuid,timestamp with time zone)') is not null
     or has_table_privilege('anon', 'private.schedule_shift_revision_links', 'select')
     or has_table_privilege('authenticated', 'private.schedule_shift_revision_links', 'select')
     or has_table_privilege('service_role', 'private.schedule_shift_revision_links', 'select') then
    raise check_violation using message = 'The guarded schedule recovery did not restore the reviewed production boundary.';
  end if;
end
$schedule_copy_on_write_recovery_postflight$;

notify pgrst, 'reload schema';

commit;
