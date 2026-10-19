import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const baseline = JSON.parse(readFileSync(resolve(root, 'backups/overnight-2026-10-19/catalog-before.json'), 'utf8'))
const functions = baseline.rows.find(({ kind }) => kind === 'functions').snapshot
const edits = [
  ['private.enqueue_hr_workflow_jobs(uuid,jsonb)', [
    ["target_instance_id::text || ':' || step->>'key'", "target_instance_id::text || ':' || (step->>'key')"],
  ]],
  ['private.promote_import_people_legacy_guard_body(uuid)', [
    ['order by received_at desc nulls last, started_at desc nulls last, id desc', 'order by created_at desc nulls last, started_at desc nulls last, id desc'],
  ]],
  ['private.promote_locked_colorado_import_scope_legacy_body(uuid,date,date,boolean,text)', [
    ['AS $function$\ndeclare', 'AS $function$\n<<lint_repair_scope>>\ndeclare'],
    ['link.promotion_batch_id = promotion_batch_id', 'link.promotion_batch_id = lint_repair_scope.promotion_batch_id'],
  ]],
  ['service_promote_import_people(uuid)', [
    ['order by import_run.received_at desc nulls last,', 'order by import_run.created_at desc nulls last,'],
  ]],
  ['service_save_hr_workflow_draft(uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb,text)', [
    ['AS $function$\ndeclare', 'AS $function$\n<<lint_repair_scope>>\ndeclare'],
    ['version.definition_id = definition_id', 'version.definition_id = lint_repair_scope.definition_id'],
  ]],
  ['service_enqueue_hr_task_escalations(timestamp with time zone)', [
    ['select due.id from due_tasks)', 'select due.id from due_tasks due)'],
  ]],
  ['service_hr_operational_action(uuid,text,text,jsonb,text,text,timestamp with time zone)', [
    ['update private.hr_talent_goals set status=clean_status', 'update private.hr_talent_goals as goal set status=clean_status'],
    ['returning id,employee_id into result_id,employee_id', 'returning goal.id,goal.employee_id into result_id,employee_id'],
  ]],
]
const md5 = (value) => createHash('md5').update(value).digest('hex')
const patches = edits.map(([identity, replacements]) => {
  const current = functions.find((item) => item.identity === identity)
  if (!current || md5(current.definition) !== current.hash) throw new Error(`Captured function fingerprint invalid: ${identity}`)
  let after = current.definition
  const changes = replacements.map(([from, to]) => {
    const occurrences = after.split(from).length - 1
    if (occurrences === 0) throw new Error(`Reviewed patch not found: ${identity}`)
    after = after.replaceAll(from, to)
    return { from, to, occurrences }
  })
  return { identity: identity.startsWith('private.') ? identity : `public.${identity}`, before: current.hash, after: md5(after), changes }
})

function body(items) {
  return `do $repair$\ndeclare\n  patch record;\n  change jsonb;\n  definition text;\n  prior_owner oid;\n  prior_acl aclitem[];\n  prior_config text[];\n  prior_definer boolean;\nbegin\n  for patch in select * from jsonb_to_recordset($patches$${JSON.stringify(items)}$patches$::jsonb)\n    as item(identity text, before text, after text, changes jsonb)\n  loop\n    select pg_get_functiondef(p.oid), p.proowner, p.proacl, p.proconfig, p.prosecdef\n    into strict definition, prior_owner, prior_acl, prior_config, prior_definer\n    from pg_proc p where p.oid = patch.identity::regprocedure;\n    if md5(definition) is distinct from patch.before then\n      raise exception 'The reviewed function baseline has drifted: %', patch.identity;\n    end if;\n    for change in select value from jsonb_array_elements(patch.changes) loop\n      if (length(definition)-length(replace(definition,change->>'from','')))/length(change->>'from')\n        <> (change->>'occurrences')::integer then\n        raise exception 'Reviewed replacement count differs: %', patch.identity;\n      end if;\n      definition := replace(definition,change->>'from',change->>'to');\n    end loop;\n    if md5(definition) is distinct from patch.after then raise exception 'Prepared replacement fingerprint differs.'; end if;\n    execute definition;\n    if exists (select 1 from pg_proc p where p.oid=patch.identity::regprocedure\n      and (p.proowner is distinct from prior_owner or p.proacl is distinct from prior_acl\n        or p.proconfig is distinct from prior_config or p.prosecdef is distinct from prior_definer)) then\n      raise exception 'Function security metadata changed: %', patch.identity;\n    end if;\n    if md5(pg_get_functiondef(patch.identity::regprocedure)) is distinct from patch.after then\n      raise exception 'Installed function fingerprint differs: %', patch.identity;\n    end if;\n  end loop;\nend;\n$repair$;`
}
const header = '-- Forward-only repair of seven verified SQL defects; preserves function ownership, grants, security and release gates.\n'
const migrationBody = body(patches)
const migration = '20261019230418_repair_verified_hr_import_lint_errors.sql'
writeFileSync(resolve(root, 'supabase/migrations', migration), `${header}begin;\nset local lock_timeout='2s';\nset local statement_timeout='30s';\n${migrationBody}\ncommit;\n`)
const ledger = `insert into supabase_migrations.schema_migrations(version,name,statements) values('20261019230418','repair_verified_hr_import_lint_errors',array[$source$${migrationBody}$source$]);`
const absent = `do $$ begin if exists(select 1 from supabase_migrations.schema_migrations where version='20261019230418') then raise exception 'The HR/import repair migration is already ledgered; do not replay.'; end if; end $$;`
writeFileSync(resolve(root, 'tmp/overnight-2026-10-19/hr-import-lint-release.sql'), `begin;\nset local lock_timeout='2s';\nset local statement_timeout='8s';\n${absent}\n${migrationBody}\n${ledger}\ncommit;\n`)
const reverse = patches.map((patch) => ({ ...patch, before: patch.after, after: patch.before, changes: patch.changes.map(({ from, to, occurrences }) => ({ from: to, to: from, occurrences })) }))
writeFileSync(resolve(root, 'supabase/recovery/20261019230418_hr_import_lint_forward_recovery.sql'), `${header}-- Recovery changes no application data and does not alter applied migration history.\nbegin;\nset local lock_timeout='2s';\nset local statement_timeout='30s';\n${body(reverse)}\ncommit;\n`)
const lint = `create extension if not exists plpgsql_check with schema extensions;\ndo $verify$\ndeclare target text; errors integer;\nbegin\n  foreach target in array array[${patches.map(({ identity }) => `'${identity}'`).join(',')}] loop\n    select count(*) into errors from extensions.plpgsql_check_function_tb(target::regprocedure, fatal_errors := false) where level='error';\n    if errors <> 0 then raise exception 'Function lint still reports % errors for %', errors, target; end if;\n  end loop;\nend;\n$verify$;`
writeFileSync(resolve(root, 'tmp/overnight-2026-10-19/hr-import-lint-rehearsal.sql'), `begin;\nset local lock_timeout='2s';\nset local statement_timeout='30s';\n${migrationBody}\n${lint}\nselect 'seven functions pass full static SQL validation' as result;\nrollback;\n`)
writeFileSync(resolve(root, 'tmp/overnight-2026-10-19/hr-import-lint-recovery-rehearsal.sql'), `begin;\nset local lock_timeout='2s';\nset local statement_timeout='30s';\n${migrationBody}\n${body(reverse)}\nselect 'seven original definitions and security metadata restored' as result;\nrollback;\n`)
writeFileSync(resolve(root, 'tmp/overnight-2026-10-19/hr-import-lint-diagnose.sql'), `begin;\nset local lock_timeout='2s';\nset local statement_timeout='30s';\n${migrationBody}\ncreate extension if not exists plpgsql_check with schema extensions;\nselect target,to_jsonb(issue) as issue from unnest(array[${patches.map(({ identity }) => `'${identity}'`).join(',')}]) target cross join lateral extensions.plpgsql_check_function_tb(target::regprocedure,fatal_errors := false) issue where level='error';\nrollback;\n`)
console.log(JSON.stringify({ migration, functions: patches.map(({ identity, before, after }) => ({ identity, before, after })) }))
