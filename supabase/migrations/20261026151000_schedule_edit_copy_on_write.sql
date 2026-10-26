begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $schedule_edit_copy_on_write_preflight$
declare
  ensure_function pg_catalog.pg_proc%rowtype;
  normalize_function pg_catalog.pg_proc%rowtype;
  payload_function pg_catalog.pg_proc%rowtype;
  ensure_sql text;
  normalize_sql text;
begin
  select * into strict ensure_function
  from pg_catalog.pg_proc
  where oid = 'public.ensure_schedule_draft(date)'::regprocedure;

  ensure_sql := pg_get_functiondef(ensure_function.oid);
  select * into strict normalize_function
  from pg_catalog.pg_proc
  where oid = 'private.normalize_schedule_duplicate_shift_blocks(uuid)'::regprocedure;
  normalize_sql := pg_get_functiondef(normalize_function.oid);
  select * into strict payload_function
  from pg_catalog.pg_proc
  where oid = 'public.get_weekly_schedule_payload(date)'::regprocedure;

  if position('jsonb_object_agg(source_shift.id::text, gen_random_uuid())' in ensure_sql) = 0
     or position('perform private.copy_schedule_shift_block(' in ensure_sql) > 0
     or pg_get_userbyid(ensure_function.proowner) <> 'postgres'
     or ensure_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or ensure_function.proconfig is distinct from array['search_path=""']::text[]
     or not ensure_function.prosecdef
     or ensure_function.provolatile <> 'v' then
    raise check_violation using message = 'The schedule draft materializer differs from the reviewed set-based baseline.';
  end if;
  if position('with target_shifts as materialized (' in normalize_sql) = 0
     or position('join public.shift_assignments assignment on assignment.shift_id = target_shift.id' in normalize_sql) = 0
     or pg_get_userbyid(normalize_function.proowner) <> 'postgres'
     or normalize_function.proacl::text is distinct from '{postgres=X/postgres}'
     or normalize_function.proconfig is distinct from array['search_path=""']::text[]
     or not normalize_function.prosecdef
     or normalize_function.provolatile <> 'v' then
    raise check_violation using message = 'The schedule duplicate normalizer differs from the reviewed scoped baseline.';
  end if;
  if pg_get_userbyid(payload_function.proowner) <> 'postgres'
     or payload_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or payload_function.proconfig is distinct from array['search_path=public, private']::text[]
     or not payload_function.prosecdef
     or payload_function.provolatile <> 's' then
    raise check_violation using message = 'The weekly schedule payload differs from the reviewed production boundary.';
  end if;
  if to_regprocedure('public.get_weekly_schedule_payload_unversioned_20261026(date)') is not null
     or to_regprocedure('public.scheduler_materialize_and_update_shift_v1(uuid,text,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text,text)') is not null then
    raise check_violation using message = 'The schedule copy-on-write boundary already exists outside this migration.';
  end if;
end
$schedule_edit_copy_on_write_preflight$;

-- Durable revision lineage replaces browser-side matching by time and location.
-- It is private because it is implementation provenance, not a Data API surface.
create table private.schedule_shift_revision_links (
  draft_schedule_id uuid not null references public.schedules(id) on delete restrict,
  source_schedule_id uuid not null references public.schedules(id) on delete restrict,
  source_shift_id uuid not null references public.shifts(id) on delete restrict,
  draft_shift_id uuid not null references public.shifts(id) on delete restrict,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  primary key (draft_schedule_id, source_shift_id),
  constraint schedule_shift_revision_links_distinct_shift check (source_shift_id <> draft_shift_id)
);

create index schedule_shift_revision_links_draft_shift_idx
  on private.schedule_shift_revision_links (draft_shift_id);

create index schedule_shift_revision_links_source_idx
  on private.schedule_shift_revision_links (source_shift_id, draft_schedule_id);

revoke all on table private.schedule_shift_revision_links from public, anon, authenticated, service_role;

comment on table private.schedule_shift_revision_links is
  'Exact immutable source-to-draft shift identity for copy-on-write schedule revision changes. Browsers never infer a copied row by time or location.';

-- Backfill only provably one-to-one lineage for a working draft that existed
-- before this migration. Ambiguous historical duplicates intentionally remain
-- unmapped and fail closed rather than guessing which block an editor meant.
with lineage_candidates as (
  select
    draft_schedule.id as draft_schedule_id,
    source_schedule.id as source_schedule_id,
    source_shift.id as source_shift_id,
    draft_shift.id as draft_shift_id,
    draft_schedule.created_by,
    count(*) over (
      partition by draft_schedule.id, source_shift.id
    ) as draft_matches_for_source
  from public.schedules draft_schedule
  join public.schedules source_schedule
    on source_schedule.id = draft_schedule.previous_revision_id
  join public.shifts source_shift
    on source_shift.schedule_id = source_schedule.id
   and source_shift.canceled_at is null
  join public.shifts draft_shift
    on draft_shift.schedule_id = draft_schedule.id
   and draft_shift.canceled_at is null
   and draft_shift.post_id is not distinct from source_shift.post_id
   and draft_shift.event_id is not distinct from source_shift.event_id
   and draft_shift.starts_at = source_shift.starts_at
   and draft_shift.ends_at = source_shift.ends_at
   and draft_shift.time_zone = source_shift.time_zone
   and draft_shift.requires_armed = source_shift.requires_armed
   and draft_shift.coverage_source_shift_id is not distinct from source_shift.coverage_source_shift_id
  where draft_schedule.status = 'draft'
)
insert into private.schedule_shift_revision_links (
  draft_schedule_id, source_schedule_id, source_shift_id,
  draft_shift_id, created_by
)
select
  candidate.draft_schedule_id,
  candidate.source_schedule_id,
  candidate.source_shift_id,
  candidate.draft_shift_id,
  candidate.created_by
from lineage_candidates candidate
where candidate.draft_matches_for_source = 1;

create function private.schedule_shift_version_token(
  target_schedule_id uuid,
  target_schedule_revision integer,
  target_schedule_status public.schedule_status,
  target_schedule_updated_at timestamptz,
  target_shift_id uuid,
  target_shift_updated_at timestamptz
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select concat_ws(
    ':',
    target_schedule_id::text,
    target_schedule_revision::text,
    target_schedule_status::text,
    to_char(target_schedule_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    target_shift_id::text,
    to_char(target_shift_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )
$$;

revoke all on function private.schedule_shift_version_token(
  uuid, integer, public.schedule_status, timestamptz, uuid, timestamptz
)
  from public, anon, authenticated, service_role;

create function private.add_schedule_shift_version_tokens(target_payload jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when target_payload is null then null
    else jsonb_set(
      target_payload,
      '{shifts}',
      coalesce((
        select jsonb_agg(
          item.value || jsonb_build_object(
            'versionToken',
            private.schedule_shift_version_token(
              schedule.id,
              schedule.revision,
              schedule.status,
              schedule.updated_at,
              shift.id,
              shift.updated_at
            ),
            'assignment_type', shift.assignment_type,
            'work_type', shift.work_type,
            'payrollCategory', shift.payroll_category
          )
          order by item.ordinality
        )
        from jsonb_array_elements(coalesce(target_payload -> 'shifts', '[]'::jsonb))
          with ordinality as item(value, ordinality)
        join public.shifts shift on shift.id = (item.value ->> 'id')::uuid
        join public.schedules schedule on schedule.id = shift.schedule_id
      ), '[]'::jsonb),
      true
    )
  end
$$;

revoke all on function private.add_schedule_shift_version_tokens(jsonb)
  from public, anon, authenticated, service_role;

-- Preserve the exact prior payload implementation under a private-call-only
-- compatibility name. The public signature remains unchanged and adds only a
-- server-issued optimistic-concurrency token to each returned shift.
alter function public.get_weekly_schedule_payload(date)
  rename to get_weekly_schedule_payload_unversioned_20261026;
revoke all on function public.get_weekly_schedule_payload_unversioned_20261026(date)
  from public, anon, authenticated, service_role;

create function public.get_weekly_schedule_payload(target_week_starts_on date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.add_schedule_shift_version_tokens(
    public.get_weekly_schedule_payload_unversioned_20261026(target_week_starts_on)
  )
$$;

revoke all on function public.get_weekly_schedule_payload(date) from public, anon, authenticated, service_role;
grant execute on function public.get_weekly_schedule_payload(date) to authenticated, service_role;

create function private.materialize_schedule_draft_revision(target_week_starts_on date)
returns uuid
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
  set status = 'archived', updated_at = clock_timestamp()
  where stale.week_starts_on = target_week_starts_on
    and stale.status = 'draft'
    and exists (
      select 1 from public.schedules newer
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
    return draft_schedule.id;
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
    week_starts_on, revision, status, previous_revision_id, created_by
  ) values (
    target_week_starts_on, next_revision, 'draft', source_schedule.id, actor_id
  ) returning id into new_schedule_id;

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

    insert into private.schedule_shift_revision_links (
      draft_schedule_id, source_schedule_id, source_shift_id, draft_shift_id, created_by
    )
    select
      new_schedule_id,
      source_schedule.id,
      source_shift.id,
      (shift_id_map ->> source_shift.id::text)::uuid,
      actor_id
    from public.shifts source_shift
    where source_shift.schedule_id = source_schedule.id
      and source_shift.canceled_at is null;

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
        select 1 from public.shift_assignments source_assignment
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
    set is_open = assignment_count.active_assignments < copied_shift.headcount_required,
        updated_at = clock_timestamp()
    from copied_assignment_counts assignment_count
    where copied_shift.id = assignment_count.shift_id
      and copied_shift.is_open is distinct from (
        assignment_count.active_assignments < copied_shift.headcount_required
      );
  end if;

  perform private.normalize_schedule_duplicate_shift_blocks(new_schedule_id);

  -- Duplicate normalization deliberately merges semantically identical
  -- source blocks. Preserve every source identity while pointing each one to
  -- the single live survivor chosen by that canonical normalizer.
  update private.schedule_shift_revision_links link
  set draft_shift_id = survivor.id
  from public.shifts copied_shift
  join lateral (
    select live_shift.id
    from public.shifts live_shift
    where live_shift.schedule_id = new_schedule_id
      and live_shift.canceled_at is null
      and live_shift.coverage_source_shift_id is null
      and live_shift.post_id is not distinct from copied_shift.post_id
      and live_shift.event_id is not distinct from copied_shift.event_id
      and live_shift.starts_at = copied_shift.starts_at
      and live_shift.ends_at = copied_shift.ends_at
      and live_shift.time_zone = copied_shift.time_zone
      and live_shift.requires_armed = copied_shift.requires_armed
    order by live_shift.created_at, live_shift.id
    limit 1
  ) survivor on true
  where link.draft_schedule_id = new_schedule_id
    and copied_shift.id = link.draft_shift_id
    and copied_shift.canceled_at is not null;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation,
    row_id, old_record, new_record
  ) values (
    auth.uid(), actor_id, 'public', 'schedules', 'ensure_draft',
    new_schedule_id::text,
    case when source_schedule.id is null then null else to_jsonb(source_schedule) end,
    jsonb_build_object(
      'week_starts_on', target_week_starts_on,
      'draft_schedule_id', new_schedule_id,
      'source_schedule_id', source_schedule.id,
      'materialization', 'copy_on_write'
    )
  );

  return new_schedule_id;
end
$$;

revoke all on function private.materialize_schedule_draft_revision(date)
  from public, anon, authenticated, service_role;

create or replace function public.ensure_schedule_draft(target_week_starts_on date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.materialize_schedule_draft_revision(target_week_starts_on);
  return public.get_weekly_schedule_payload(target_week_starts_on);
end
$$;

create function public.scheduler_materialize_and_update_shift_v1(
  target_shift_id uuid,
  expected_shift_version text,
  shift_operational_date date,
  shift_start_time time without time zone,
  shift_end_time time without time zone,
  target_headcount integer,
  target_is_open boolean,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null,
  target_overtime_override_note text default null,
  target_dispatch_mode text default 'primary_shift',
  target_payroll_category text default 'regular'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  source_shift public.shifts%rowtype;
  source_schedule public.schedules%rowtype;
  source_schedule_id uuid;
  observed_schedule_status public.schedule_status;
  observed_week_starts_on date;
  materialized_draft_schedule_id uuid;
  editable_shift_id uuid;
  latest_source_schedule_id uuid;
  active_draft_schedule_id uuid;
  current_shift_version text;
  updated_payload jsonb;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to edit a schedule shift.';
  end if;

  -- Discover the parent without taking a row lock. Published-source saves take
  -- the week advisory lock before row locks (the same order used by publish),
  -- while direct draft saves lock the draft schedule before its shift. This
  -- avoids the schedule-row/shift-row/advisory lock inversion that previously
  -- surfaced as statement timeouts under concurrent scheduler activity.
  select shift.schedule_id into source_schedule_id
  from public.shifts shift
  where shift.id = target_shift_id
    and shift.canceled_at is null;

  if source_schedule_id is null then
    raise check_violation using message = 'The selected schedule shift is no longer available. Refresh the schedule and try again.';
  end if;

  select schedule.status, schedule.week_starts_on
    into observed_schedule_status, observed_week_starts_on
  from public.schedules schedule
  where schedule.id = source_schedule_id;

  if observed_schedule_status in ('published', 'superseded') then
    perform pg_advisory_xact_lock(hashtext('schedule-draft:' || observed_week_starts_on::text));
  elsif observed_schedule_status is distinct from 'draft' then
    raise check_violation using message = 'Only the current published schedule or its working draft can be edited.';
  end if;

  select schedule.* into source_schedule
  from public.schedules schedule
  where schedule.id = source_schedule_id
  for share;

  select shift.* into source_shift
  from public.shifts shift
  where shift.id = target_shift_id
    and shift.schedule_id = source_schedule.id
    and shift.canceled_at is null
  for update;

  if source_shift.id is null then
    raise serialization_failure using message = 'This shift changed while the editor was saving. Refresh the schedule and review the current values before retrying.';
  end if;

  if observed_schedule_status = 'draft' and source_schedule.status <> 'draft' then
    raise serialization_failure using message = 'This schedule was published after the editor opened. Refresh before making another change.';
  end if;
  if observed_schedule_status in ('published', 'superseded')
     and source_schedule.status not in ('published', 'superseded') then
    raise serialization_failure using message = 'This schedule revision changed while the editor was saving. Refresh before retrying.';
  end if;

  current_shift_version := private.schedule_shift_version_token(
    source_schedule.id,
    source_schedule.revision,
    source_schedule.status,
    source_schedule.updated_at,
    source_shift.id,
    source_shift.updated_at
  );
  if nullif(btrim(coalesce(expected_shift_version, '')), '') is null
     or expected_shift_version is distinct from current_shift_version then
    raise serialization_failure using message = 'This shift changed after the editor opened. Refresh the schedule and review the current values before saving.';
  end if;

  if source_schedule.status = 'draft' then
    editable_shift_id := source_shift.id;
  elsif source_schedule.status in ('published', 'superseded') then
    select schedule.id into latest_source_schedule_id
    from public.schedules schedule
    where schedule.week_starts_on = source_schedule.week_starts_on
      and schedule.status in ('published', 'superseded')
    order by schedule.revision desc
    limit 1;

    if latest_source_schedule_id is distinct from source_schedule.id then
      raise serialization_failure using message = 'The schedule changed after this shift was opened. Refresh and review the current revision before saving.';
    end if;

    select schedule.id into active_draft_schedule_id
    from public.schedules schedule
    where schedule.week_starts_on = source_schedule.week_starts_on
      and schedule.status = 'draft'
    order by schedule.revision desc
    limit 1;

    if active_draft_schedule_id is not null then
      raise serialization_failure using message = 'A working draft was created after this published shift was opened. Refresh and edit the current draft before saving.';
    end if;

    materialized_draft_schedule_id := private.materialize_schedule_draft_revision(source_schedule.week_starts_on);

    select link.draft_shift_id into editable_shift_id
    from private.schedule_shift_revision_links link
    join public.shifts draft_shift
      on draft_shift.id = link.draft_shift_id
     and draft_shift.schedule_id = materialized_draft_schedule_id
     and draft_shift.canceled_at is null
    where link.draft_schedule_id = materialized_draft_schedule_id
      and link.source_shift_id = source_shift.id;

    if editable_shift_id is null then
      raise serialization_failure using message = 'This pre-existing draft does not contain verified one-to-one shift lineage. Open the current draft and select its exact shift before editing.';
    end if;
  else
    raise check_violation using message = 'Only the current published schedule or its working draft can be edited.';
  end if;

  updated_payload := public.scheduler_update_typed_draft_shift_with_payroll_category_v1(
    editable_shift_id,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_open,
    target_is_overtime,
    target_notes,
    target_work_type,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note,
    target_overtime_override_note,
    target_dispatch_mode,
    target_payroll_category
  );

  -- The validated update boundary already built the schedule payload. Refresh
  -- only row-backed edit fields and concurrency tokens after its final work-
  -- type/payroll-category writes instead of executing the full weekly payload
  -- query a third time.
  return private.add_schedule_shift_version_tokens(updated_payload);
end
$$;

revoke all on function public.scheduler_materialize_and_update_shift_v1(
  uuid, text, date, time without time zone, time without time zone, integer,
  boolean, boolean, text, text, uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.scheduler_materialize_and_update_shift_v1(
  uuid, text, date, time without time zone, time without time zone, integer,
  boolean, boolean, text, text, uuid, text, text, text, text, text
) to authenticated;

comment on function public.scheduler_materialize_and_update_shift_v1(
  uuid, text, date, time without time zone, time without time zone, integer,
  boolean, boolean, text, text, uuid, text, text, text, text, text
) is
  'Atomically materializes the working schedule revision on first Save, resolves exact shift lineage, applies the edit, and returns the committed draft. Opening the editor performs no write.';

do $schedule_edit_copy_on_write_postflight$
declare
  materializer pg_catalog.pg_proc%rowtype;
  ensure_function pg_catalog.pg_proc%rowtype;
  update_function pg_catalog.pg_proc%rowtype;
  payload_function pg_catalog.pg_proc%rowtype;
  unversioned_payload_function pg_catalog.pg_proc%rowtype;
  normalize_function pg_catalog.pg_proc%rowtype;
  update_sql text;
  normalize_sql text;
begin
  select * into strict materializer
  from pg_catalog.pg_proc
  where oid = 'private.materialize_schedule_draft_revision(date)'::regprocedure;
  select * into strict ensure_function
  from pg_catalog.pg_proc
  where oid = 'public.ensure_schedule_draft(date)'::regprocedure;
  select * into strict update_function
  from pg_catalog.pg_proc
  where oid = 'public.scheduler_materialize_and_update_shift_v1(uuid,text,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text,text)'::regprocedure;
  select * into strict payload_function
  from pg_catalog.pg_proc
  where oid = 'public.get_weekly_schedule_payload(date)'::regprocedure;
  select * into strict unversioned_payload_function
  from pg_catalog.pg_proc
  where oid = 'public.get_weekly_schedule_payload_unversioned_20261026(date)'::regprocedure;
  select * into strict normalize_function
  from pg_catalog.pg_proc
  where oid = 'private.normalize_schedule_duplicate_shift_blocks(uuid)'::regprocedure;

  update_sql := pg_get_functiondef(update_function.oid);
  normalize_sql := pg_get_functiondef(normalize_function.oid);
  if pg_get_userbyid(materializer.proowner) <> 'postgres'
     or materializer.proacl::text is distinct from '{postgres=X/postgres}'
     or materializer.proconfig is distinct from array['search_path=""']::text[]
     or not materializer.prosecdef
     or pg_get_userbyid(ensure_function.proowner) <> 'postgres'
     or ensure_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or ensure_function.proconfig is distinct from array['search_path=""']::text[]
     or not ensure_function.prosecdef
     or pg_get_userbyid(update_function.proowner) <> 'postgres'
     or update_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres}'
     or update_function.proconfig is distinct from array['search_path=""']::text[]
     or not update_function.prosecdef
     or position('private.materialize_schedule_draft_revision(source_schedule.week_starts_on)' in update_sql) = 0
     or position('private.schedule_shift_revision_links' in update_sql) = 0
     or position('expected_shift_version is distinct from current_shift_version' in update_sql) = 0
     or position('return private.add_schedule_shift_version_tokens(updated_payload)' in update_sql) = 0
     or position('for update' in update_sql) = 0
     or pg_get_userbyid(payload_function.proowner) <> 'postgres'
     or payload_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or payload_function.proconfig is distinct from array['search_path=""']::text[]
     or not payload_function.prosecdef
     or pg_get_userbyid(unversioned_payload_function.proowner) <> 'postgres'
     or unversioned_payload_function.proacl::text is distinct from '{postgres=X/postgres}'
     or unversioned_payload_function.proconfig is distinct from array['search_path=public, private']::text[]
     or not unversioned_payload_function.prosecdef
     or pg_get_userbyid(normalize_function.proowner) <> 'postgres'
     or position('with target_shifts as materialized (' in normalize_sql) = 0
     or position('join public.shift_assignments assignment on assignment.shift_id = target_shift.id' in normalize_sql) = 0
     or normalize_function.proacl::text is distinct from '{postgres=X/postgres}'
     or normalize_function.proconfig is distinct from array['search_path=""']::text[]
     or not normalize_function.prosecdef
     or to_regprocedure('private.schedule_shift_version_token(uuid,integer,public.schedule_status,timestamp with time zone,uuid,timestamp with time zone)') is null
     or has_function_privilege('authenticated', 'private.add_schedule_shift_version_tokens(jsonb)', 'execute')
     or has_function_privilege('service_role', 'private.add_schedule_shift_version_tokens(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'private.schedule_shift_version_token(uuid,integer,public.schedule_status,timestamp with time zone,uuid,timestamp with time zone)', 'execute')
     or has_function_privilege('service_role', 'private.schedule_shift_version_token(uuid,integer,public.schedule_status,timestamp with time zone,uuid,timestamp with time zone)', 'execute')
     or has_table_privilege('anon', 'private.schedule_shift_revision_links', 'select')
     or has_table_privilege('authenticated', 'private.schedule_shift_revision_links', 'select')
     or has_table_privilege('service_role', 'private.schedule_shift_revision_links', 'select') then
    raise check_violation using message = 'The schedule edit copy-on-write boundary did not install as reviewed.';
  end if;
end
$schedule_edit_copy_on_write_postflight$;

notify pgrst, 'reload schema';

commit;
