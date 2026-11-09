begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- The open-state trigger is authoritative for is_open. Teach it the existing
-- terminal coverage state instead of bypassing it or canceling published rows.
do $repair$
declare
  target_oid oid := to_regprocedure('private.normalize_shift_open_state_before_write()');
  original_source text;
  original_metadata jsonb;
  prior_guard text;
  replacement text := $body$
declare
  assignment_count integer;
begin
  if new.canceled_at is not null then
    new.is_open := false;
    return new;
  end if;

  assignment_count := private.active_shift_assignment_count(new.id);
  if new.coverage_source_shift_id is not null and assignment_count = 0
    and exists (
      select 1 from public.shift_coverage_cases coverage
      where coverage.coverage_shift_id = new.id
        and coverage.source_shift_id = new.coverage_source_shift_id
        and coverage.status = 'closed'
        and coverage.resolved_at is not null
        and coverage.coverage_mode is distinct from 'assigned_guard'
        and coverage.replacement_assignment_id is null
        and coverage.replacement_employee_id is null
    )
  then
    new.is_open := false;
    return new;
  end if;

  new.is_open := assignment_count < greatest(coalesce(new.headcount_required, 1), 1);
  return new;
end
$body$;
begin
  select p.prosrc, jsonb_build_object('owner',p.proowner,'acl',p.proacl,
    'security',p.prosecdef,'volatility',p.provolatile,'configuration',p.proconfig,
    'arguments',p.proargtypes,'result',p.prorettype)
  into original_source, original_metadata
  from pg_catalog.pg_proc p where p.oid=target_oid;
  if md5(original_source) is distinct from '58e872dbab10fb2b31624b5850f4b4e7'
    or not exists (select 1 from pg_catalog.pg_proc p where p.oid=target_oid
      and pg_catalog.pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.provolatile='v'
      and 'search_path=""'=any(coalesce(p.proconfig,array[]::text[]))) then
    raise object_not_in_prerequisite_state using message='Shift open-state normalization changed since review; no repair was applied.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_index i
    join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
    where i.indrelid='public.shift_coverage_cases'::regclass
      and i.indisunique and i.indisvalid and i.indisready
      and i.indnkeyatts=1 and i.indpred is null and i.indexprs is null
      and a.attname='coverage_shift_id'
  ) then
    raise object_not_in_prerequisite_state using message='Coverage shifts must have one authoritative coverage case before open-state repair.';
  end if;
  select p.prosrc into prior_guard from pg_catalog.pg_proc p
    where p.oid=to_regprocedure('private.protect_published_schedule_child()');
  if md5(prior_guard) is distinct from 'efac774cca6d6020a0ba60cf05268ada' then
    raise object_not_in_prerequisite_state using message='Published schedule protection changed since review; no repair was applied.';
  end if;
  execute replace(pg_catalog.pg_get_functiondef(target_oid),original_source,replacement);
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid=target_oid
    and p.prosrc=replacement
    and jsonb_build_object('owner',p.proowner,'acl',p.proacl,
      'security',p.prosecdef,'volatility',p.provolatile,'configuration',p.proconfig,
      'arguments',p.proargtypes,'result',p.prorettype)=original_metadata)
    or (select p.prosrc from pg_catalog.pg_proc p
      where p.oid='private.protect_published_schedule_child()'::regprocedure) is distinct from prior_guard then
    raise check_violation using message='Open-state repair did not preserve security metadata or schedule protection.';
  end if;
end;
$repair$;

-- Close the coverage case before its one existing shift write. This allows the
-- normalizer to see the authoritative terminal case in this same transaction.
-- The same original snapshot still drives all assigned-replacement exclusions.
do $ordering$
declare
  target_oid oid := to_regprocedure('private.retire_call_off_live_artifacts(uuid,text,text,timestamp with time zone,uuid)');
  original_source text;
  original_metadata jsonb;
  repaired_source text;
  shift_block text;
  block_start integer;
  block_end integer;
  begin_marker text := E'    if coverage_before.coverage_shift_id is not null then\n      update public.shifts coverage_shift';
  end_marker text := E'    if coverage_before.status in (''draft'', ''open_pool'', ''patrol_review'') then';
  anchor text := E'      end if;\n    end if;\n  end if;\n\n  update private.employee_push_deliveries delivery';
begin
  select p.prosrc, jsonb_build_object('owner',p.proowner,'acl',p.proacl,
    'security',p.prosecdef,'volatility',p.provolatile,'configuration',p.proconfig,
    'arguments',p.proargtypes,'result',p.prorettype)
  into original_source, original_metadata
  from pg_catalog.pg_proc p where p.oid=target_oid;
  if md5(original_source) is distinct from '87eac69efc4ed2052124984ed7a02d7a'
    or not exists (select 1 from pg_catalog.pg_proc p where p.oid=target_oid
      and pg_catalog.pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.provolatile='v'
      and 'search_path=""'=any(coalesce(p.proconfig,array[]::text[]))) then
    raise object_not_in_prerequisite_state using message='Reviewed coverage retirement prerequisite changed; no ordering repair was applied.';
  end if;
  block_start := position(begin_marker in original_source);
  block_end := position(end_marker in original_source);
  if block_start=0 or block_end<=block_start or position(anchor in original_source)=0
    or position(begin_marker in substring(original_source from block_start+length(begin_marker)))>0
    or position(anchor in substring(original_source from position(anchor in original_source)+length(anchor)))>0 then
    raise check_violation using message='The exact coverage retirement statements could not be located safely.';
  end if;
  shift_block := substring(original_source from block_start for block_end-block_start);
  repaired_source := substring(original_source from 1 for block_start-1)||substring(original_source from block_end);
  repaired_source := replace(repaired_source,anchor,
    E'      end if;\n    end if;\n\n'||shift_block||E'  end if;\n\n  update private.employee_push_deliveries delivery');
  execute replace(pg_catalog.pg_get_functiondef(target_oid),original_source,repaired_source);
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid=target_oid
    and p.prosrc=repaired_source
    and jsonb_build_object('owner',p.proowner,'acl',p.proacl,
      'security',p.prosecdef,'volatility',p.provolatile,'configuration',p.proconfig,
      'arguments',p.proargtypes,'result',p.prorettype)=original_metadata) then
    raise check_violation using message='Coverage ordering repair did not preserve function security metadata.';
  end if;
end;
$ordering$;

commit;
