begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Retiring an unassigned vacancy must not cancel an immutable published shift.
-- The existing schedule guard already permits its live is_open flag to close.
-- Keep every other retirement action and the original draft cancellation path.
do $repair$
declare
  target_oid oid := to_regprocedure('private.retire_call_off_live_artifacts(uuid,text,text,timestamp with time zone,uuid)');
  original_source text;
  repaired_source text;
  original_metadata jsonb;
  prior_guard text;
  needle text := $old$      update public.shifts coverage_shift
      set is_open = false,
          canceled_at = coalesce(coverage_shift.canceled_at, target_retired_at),
          canceled_by = case
            when coverage_shift.canceled_at is not null then coverage_shift.canceled_by
            when target_outcome in ('covered', 'no_replacement', 'canceled')
              then target_actor_id
            else null
          end,
          cancellation_reason = case
            when coverage_shift.canceled_at is null
              then 'Call-off lifecycle retirement: ' || target_reason
            else coalesce(
              nullif(btrim(coverage_shift.cancellation_reason), ''),
              'The generated coverage shift was already canceled before lifecycle reconciliation.'
            )
          end,
          updated_at = clock_timestamp()
      where coverage_shift.id = coverage_before.coverage_shift_id
        -- Only the generated, still-unassigned vacancy shift is disposable.
        -- An assigned replacement remains part of the durable schedule history.
        and coverage_shift.coverage_source_shift_id is not null
        and coverage_before.status <> 'assigned'
        and coverage_before.coverage_mode is distinct from 'assigned_guard'
        and coverage_before.replacement_assignment_id is null
        and not exists (
          select 1
          from public.shift_assignments assignment
          where assignment.shift_id = coverage_shift.id
            and assignment.status in ('assigned', 'confirmed', 'completed')
        )
        and (
          coverage_shift.canceled_at is null
          or coverage_shift.is_open
        );$old$;
  replacement text := $new$      update public.shifts coverage_shift
      set is_open = false,
          canceled_at = case when coverage_schedule.status = 'published'
            then coverage_shift.canceled_at
            else coalesce(coverage_shift.canceled_at, target_retired_at) end,
          canceled_by = case
            when coverage_schedule.status = 'published' then coverage_shift.canceled_by
            when coverage_shift.canceled_at is not null then coverage_shift.canceled_by
            when target_outcome in ('covered', 'no_replacement', 'canceled')
              then target_actor_id
            else null
          end,
          cancellation_reason = case
            when coverage_schedule.status = 'published' then coverage_shift.cancellation_reason
            when coverage_shift.canceled_at is null
              then 'Call-off lifecycle retirement: ' || target_reason
            else coalesce(
              nullif(btrim(coverage_shift.cancellation_reason), ''),
              'The generated coverage shift was already canceled before lifecycle reconciliation.'
            )
          end,
          updated_at = clock_timestamp()
      from public.schedules coverage_schedule
      where coverage_shift.id = coverage_before.coverage_shift_id
        and coverage_schedule.id = coverage_shift.schedule_id
        -- Only the generated, still-unassigned vacancy shift is disposable.
        -- An assigned replacement remains part of the durable schedule history.
        and coverage_shift.coverage_source_shift_id is not null
        and coverage_before.status <> 'assigned'
        and coverage_before.coverage_mode is distinct from 'assigned_guard'
        and coverage_before.replacement_assignment_id is null
        and not exists (
          select 1
          from public.shift_assignments assignment
          where assignment.shift_id = coverage_shift.id
            and assignment.status in ('assigned', 'confirmed', 'completed')
        )
        and (
          (coverage_schedule.status = 'published' and coverage_shift.is_open)
          or (coverage_schedule.status <> 'published' and (
            coverage_shift.canceled_at is null or coverage_shift.is_open
          ))
        );$new$;
begin
  select p.prosrc, jsonb_build_object('owner',p.proowner,'acl',p.proacl,
    'security',p.prosecdef,'volatility',p.provolatile,'configuration',p.proconfig,
    'arguments',p.proargtypes,'result',p.prorettype)
  into original_source, original_metadata
  from pg_catalog.pg_proc p where p.oid = target_oid;
  if target_oid is null or md5(original_source) is distinct from 'c0d8d7de4ec4eb11c00ee7a979ddc4ca'
    or not exists (select 1 from pg_catalog.pg_proc p where p.oid=target_oid
      and pg_catalog.pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.provolatile='v'
      and 'search_path=""'=any(coalesce(p.proconfig,array[]::text[])))
    or position(needle in original_source)=0
    or position(needle in substring(original_source from position(needle in original_source)+length(needle)))>0 then
    raise object_not_in_prerequisite_state using message='Coverage retirement changed since review; no repair was applied.';
  end if;
  select p.prosrc into prior_guard from pg_catalog.pg_proc p
    where p.oid=to_regprocedure('private.protect_published_schedule_child()');
  if md5(prior_guard) is distinct from 'efac774cca6d6020a0ba60cf05268ada' then
    raise object_not_in_prerequisite_state using message='Published schedule protection changed since review; no repair was applied.';
  end if;
  repaired_source := replace(original_source,needle,replacement);
  execute replace(pg_catalog.pg_get_functiondef(target_oid),original_source,repaired_source);
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid=target_oid
    and p.prosrc=repaired_source
    and jsonb_build_object('owner',p.proowner,'acl',p.proacl,
      'security',p.prosecdef,'volatility',p.provolatile,'configuration',p.proconfig,
      'arguments',p.proargtypes,'result',p.prorettype)=original_metadata)
    or (select p.prosrc from pg_catalog.pg_proc p
      where p.oid='private.protect_published_schedule_child()'::regprocedure) is distinct from prior_guard then
    raise check_violation using message='Coverage retirement repair did not preserve its security or schedule protection.';
  end if;
end;
$repair$;

commit;
