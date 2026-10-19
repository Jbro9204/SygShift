-- Forward-only repair of seven verified SQL defects; preserves function ownership, grants, security and release gates.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $repair$
declare
  patch record;
  change jsonb;
  definition text;
  prior_owner oid;
  prior_acl aclitem[];
  prior_config text[];
  prior_definer boolean;
begin
  for patch in select * from jsonb_to_recordset($patches$[{"identity":"private.enqueue_hr_workflow_jobs(uuid,jsonb)","before":"e69fd6a8935b55c6502f92248a714a29","after":"cd8b61bf52c83bd1bd04c4d3e838a844","changes":[{"from":"target_instance_id::text || ':' || step->>'key'","to":"target_instance_id::text || ':' || (step->>'key')","occurrences":1}]},{"identity":"private.promote_import_people_legacy_guard_body(uuid)","before":"eecd82ea50680361a630561de2edbc75","after":"86ee059304a36c5a839fedb9f6dd9ab5","changes":[{"from":"order by received_at desc nulls last, started_at desc nulls last, id desc","to":"order by created_at desc nulls last, started_at desc nulls last, id desc","occurrences":1}]},{"identity":"private.promote_locked_colorado_import_scope_legacy_body(uuid,date,date,boolean,text)","before":"a70d094272efe88dd96aef88611d1a2b","after":"fbf5063cedab982db1bbd68da7320814","changes":[{"from":"AS $function$\ndeclare","to":"AS $function$\n<<lint_repair_scope>>\ndeclare","occurrences":1},{"from":"link.promotion_batch_id = promotion_batch_id","to":"link.promotion_batch_id = lint_repair_scope.promotion_batch_id","occurrences":1}]},{"identity":"public.service_promote_import_people(uuid)","before":"1e999c94944929f54d0e58c25e827a91","after":"64fefe570a853cceb4849de9e6c360b2","changes":[{"from":"order by import_run.received_at desc nulls last,","to":"order by import_run.created_at desc nulls last,","occurrences":1}]},{"identity":"public.service_save_hr_workflow_draft(uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb,text)","before":"090ba7346063557cdce3a017ce1c7ff2","after":"8a92a9194ca7c20c538951eb1146691a","changes":[{"from":"AS $function$\ndeclare","to":"AS $function$\n<<lint_repair_scope>>\ndeclare","occurrences":1},{"from":"version.definition_id = definition_id","to":"version.definition_id = lint_repair_scope.definition_id","occurrences":2}]},{"identity":"public.service_enqueue_hr_task_escalations(timestamp with time zone)","before":"e3d7fb0dae3b009f52bd2bf07cceb1a9","after":"be2f6531e878182a7dc323b629bbec39","changes":[{"from":"select due.id from due_tasks)","to":"select due.id from due_tasks due)","occurrences":1}]},{"identity":"public.service_hr_operational_action(uuid,text,text,jsonb,text,text,timestamp with time zone)","before":"6a0a4f2e5ba7bd8022b4da9b80b7d361","after":"fdd14e527348e0c3d8302f8f545e5db7","changes":[{"from":"update private.hr_talent_goals set status=clean_status","to":"update private.hr_talent_goals as goal set status=clean_status","occurrences":1},{"from":"returning id,employee_id into result_id,employee_id","to":"returning goal.id,goal.employee_id into result_id,employee_id","occurrences":1}]}]$patches$::jsonb)
    as item(identity text, before text, after text, changes jsonb)
  loop
    select pg_get_functiondef(p.oid), p.proowner, p.proacl, p.proconfig, p.prosecdef
    into strict definition, prior_owner, prior_acl, prior_config, prior_definer
    from pg_proc p where p.oid = patch.identity::regprocedure;
    if md5(definition) is distinct from patch.before then
      raise exception 'The reviewed function baseline has drifted: %', patch.identity;
    end if;
    for change in select value from jsonb_array_elements(patch.changes) loop
      if (length(definition)-length(replace(definition,change->>'from','')))/length(change->>'from')
        <> (change->>'occurrences')::integer then
        raise exception 'Reviewed replacement count differs: %', patch.identity;
      end if;
      definition := replace(definition,change->>'from',change->>'to');
    end loop;
    if md5(definition) is distinct from patch.after then raise exception 'Prepared replacement fingerprint differs.'; end if;
    execute definition;
    if exists (select 1 from pg_proc p where p.oid=patch.identity::regprocedure
      and (p.proowner is distinct from prior_owner or p.proacl is distinct from prior_acl
        or p.proconfig is distinct from prior_config or p.prosecdef is distinct from prior_definer)) then
      raise exception 'Function security metadata changed: %', patch.identity;
    end if;
    if md5(pg_get_functiondef(patch.identity::regprocedure)) is distinct from patch.after then
      raise exception 'Installed function fingerprint differs: %', patch.identity;
    end if;
  end loop;
end;
$repair$;
commit;
