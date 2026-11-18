import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Generates reviewed SQL artifacts only. It never opens a database connection.
const digest = value => createHash('sha256').update(value).digest('hex')
const literal = value => `'${String(value).replaceAll("'", "''")}'`
const array = values => `array[${values.map(literal).join(',')}]::text[]`
const knownFiles = new Set([
  '20261118133316_patrol_schedule_continuity.sql',
  '20261118133431_sygilant_patrol_revision_binding_consumers.sql',
  '20261118134218_activate_patrol_schedule_continuity.sql',
])
const protectedTables = [
  'auth.users', 'auth.identities', 'auth.sessions', 'auth.mfa_factors',
  'private.employee_accounts', 'public.employee_permission_overrides', 'private.webauthn_credentials', 'private.security_key_sessions', 'private.trusted_devices',
  'public.employees', 'public.profiles', 'public.employee_access_roles', 'public.role_permissions', 'public.permission_catalog',
  'public.clients', 'public.sites', 'public.posts', 'public.schedules', 'public.shifts', 'public.shift_assignments',
  'public.time_events', 'private.payroll_export_batches', 'private.payroll_export_rows', 'private.payroll_batch_assignments', 'private.payroll_rules',
  'public.patrol_routes', 'public.patrol_route_versions', 'public.patrol_route_stops', 'public.patrol_stop_requirements',
  'public.patrol_assignments', 'public.patrol_hit_obligations', 'public.patrol_hits', 'public.patrol_hit_evidence', 'public.patrol_makeup_assignments',
  'public.sygilant_reports', 'public.sygilant_report_versions', 'public.sygilant_report_evidence',
  'private.patrol_schedule_continuity', 'private.patrol_schedule_resolution_receipts',
]

export function validateContinuityReleaseTarget(filename, source, target) {
  assert(knownFiles.has(filename), 'Unknown continuity migration')
  assert(target?.file === filename && /^\d{14}$/.test(target.version) && filename === `${target.version}_${target.name}.sql`, 'Exact migration identity required')
  assert(['SygShift', 'Sygilant'].includes(target.owner), 'Exact migration owner required')
  assert(Array.isArray(target.changed) && Array.isArray(target.added) && Array.isArray(target.relations) && Array.isArray(target.triggers), 'Reviewed object inventory required')
  assert(/^[a-f0-9]{64}$/.test(target.sourceHash) && /^[a-f0-9]{64}$/.test(target.ledgerHash), 'Reviewed checksums required')
  const normalized = source.replaceAll('\r\n', '\n')
  assert(!normalized.includes('\r') && !normalized.includes('\u0000') && !normalized.startsWith('\uFEFF'), 'Unexpected source encoding')
  assert.equal(digest(normalized), target.sourceHash, 'Continuity migration source changed after review')
  return normalized
}

export function continuityPreservationSql(target, ledgerMd5) {
  assert(/^[a-f0-9]{32}$/.test(ledgerMd5), 'Exact predecessor ledger fingerprint required')
  const knownFunctions = [...target.changed, ...target.added.map(item => item.signature)]
  const knownRelations = target.relations
  return `begin;
set transaction isolation level repeatable read;
set local lock_timeout='3s';
set local statement_timeout='30s';
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $predecessor$ begin
  if (select md5(coalesce(jsonb_agg(to_jsonb(m) order by version)::text,'[]')) from supabase_migrations.schema_migrations m) <> ${literal(ledgerMd5)} then
    raise exception 'Migration predecessor changed; continuity activation refused';
  end if;
end $predecessor$;
create temp table continuity_before(snapshot jsonb) on commit drop;
create function pg_temp.continuity_snapshot() returns jsonb language plpgsql as $snapshot$
declare relation_name text; relation regclass; ordering text; count_rows bigint; cohort text; tables jsonb:='{}'; catalogs jsonb;
begin
  foreach relation_name in array ${array(protectedTables)} loop
    if relation_name=any(${array(knownRelations)}) then continue; end if;
    relation:=to_regclass(relation_name);
    if relation is null then tables:=tables||jsonb_build_object(relation_name,jsonb_build_object('present',false)); continue; end if;
    select string_agg(format('r.%I',a.attname),',' order by key.ordinality) into ordering
    from pg_index i cross join lateral unnest(i.indkey) with ordinality key(attnum,ordinality)
    join pg_attribute a on a.attrelid=i.indrelid and a.attnum=key.attnum where i.indrelid=relation and i.indisprimary;
    ordering:=coalesce(ordering,'r.ctid');
    execute format('select count(*) from %s',relation) into count_rows;
    execute format($query$select md5(coalesce(string_agg(hash,'' order by n),'')) from (select md5(to_jsonb(r)::text) hash,row_number() over(order by %s) n from %s r order by %s limit 128) q$query$,ordering,relation,ordering) into cohort;
    tables:=tables||jsonb_build_object(relation_name,jsonb_build_object('rows',count_rows,'cohortMd5',cohort));
  end loop;
  select jsonb_build_object(
    'functions',(select md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' order by p.oid),'')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^(pg_|information_schema$)' and not p.oid=any(array(select to_regprocedure(signature)::oid from unnest(${array(knownFunctions)}) signature where to_regprocedure(signature) is not null))),
    'changedFunctionSecurity',(select md5(coalesce(string_agg(md5((to_jsonb(p)-'prosrc')::text),'' order by p.oid),'')) from pg_proc p where p.oid=any(array(select to_regprocedure(signature)::oid from unnest(${array(target.changed)}) signature))),
    'relations',(select md5(coalesce(string_agg(md5(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reloptions)::text),'' order by c.oid),'')) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^(pg_|information_schema$)' and not (n.nspname||'.'||c.relname)=any(${array(knownRelations)}) and not exists(select 1 from pg_index i where i.indexrelid=c.oid and i.indrelid=any(array(select to_regclass(name)::oid from unnest(${array(knownRelations)}) name where to_regclass(name) is not null)))),
    'triggers',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.oid),'')) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^(pg_|information_schema$)' and not (n.nspname||'.'||c.relname||'.'||t.tgname)=any(${array(target.triggers)}) and not (n.nspname||'.'||c.relname)=any(${array(knownRelations)}) and not exists(select 1 from pg_constraint k where k.oid=t.tgconstraint and k.conrelid=any(array(select to_regclass(name)::oid from unnest(${array(knownRelations)}) name where to_regclass(name) is not null)))),
    'constraints',(select md5(coalesce(string_agg(md5(to_jsonb(k)::text),'' order by k.oid),'')) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname !~ '^(pg_|information_schema$)' and not k.conrelid=any(array(select to_regclass(name)::oid from unnest(${array(knownRelations)}) name where to_regclass(name) is not null))),
    'policies',(select md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' order by p.oid),'')) from pg_policy p),
    'roles',(select md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by r.oid),'')) from pg_roles r),
    'memberships',(select md5(coalesce(string_agg(md5(to_jsonb(m)::text),'' order by m.roleid,m.member,m.grantor),'')) from pg_auth_members m),
    'defaults',(select md5(coalesce(string_agg(md5(to_jsonb(a)::text),'' order by a.oid),'')) from pg_default_acl a),
    'schemas',(select md5(coalesce(string_agg(md5(jsonb_build_array(n.nspname,n.nspowner,n.nspacl)::text),'' order by n.oid),'')) from pg_namespace n where n.nspname !~ '^pg_'),
    'priorLedger',(select md5(coalesce(jsonb_agg(to_jsonb(m) order by version)::text,'[]')) from supabase_migrations.schema_migrations m where version<>${literal(target.version)})
  ) into catalogs;
  return jsonb_build_object('tables',tables,'catalogs',catalogs);
end $snapshot$;
insert into continuity_before select pg_temp.continuity_snapshot();`
}

export async function renderPatrolContinuityRelease({ file, hubRoot, manifest, mode, ledgerMd5 }) {
  assert(isAbsolute(file) && isAbsolute(hubRoot), 'Explicit absolute paths required')
  assert(mode === 'rehearsal' || mode === 'activate', 'Explicit transaction mode required')
  const target = manifest.targets.find(item => item.file === basename(file))
  const source = validateContinuityReleaseTarget(basename(file), readFileSync(file, 'utf8'), target)
  const renderer = await import(pathToFileURL(join(hubRoot, 'scripts/render-supabase-migration-activation.mjs')).href)
  const batch = renderer.renderActivationBatch({ filePath: file, source, expectedVersion: target.version, expectedName: target.name,
    expectedSourceHash: target.sourceHash, expectedLedgerHash: target.ledgerHash, expectedStatementCount: target.statementCount })
  const statements = renderer.splitAndTrimStatements(batch)
  assert.match(statements[0], /\bbegin\s*$/iu)
  assert.match(statements.at(-1), /^commit$/iu)
  const body = statements.slice(1,-1).filter(item => !/^set local (lock_timeout|statement_timeout)\s*=/iu.test(item))
  const checks = target.added.map(item => {
    const roles = ['anon', 'authenticated', 'service_role']
    return `if to_regprocedure(${literal(item.signature)}) is null then raise exception 'Required continuity function missing'; end if;
      ${roles.map(role => `if has_function_privilege(${literal(role)},${literal(item.signature)},'execute') is distinct from ${item.roles.includes(role) ? 'true' : 'false'} then raise exception 'Continuity function grant mismatch'; end if;`).join('\n')}`
  }).join('\n')
  const tableChecks = target.relations.map(name => `if not exists(select 1 from pg_class where oid=to_regclass(${literal(name)}) and relrowsecurity and relforcerowsecurity) then raise exception 'Continuity private table lacks enforced RLS'; end if;
    if exists(select 1 from unnest(array['anon','authenticated','service_role']) role where has_table_privilege(role,${literal(name)},'select,insert,update,delete')) then raise exception 'Continuity private table is directly exposed'; end if;`).join('\n')
  const sql = `${continuityPreservationSql(target,ledgerMd5)}\n${body.map(item => `${item};`).join('\n\n')}
do $postflight$ begin
  if (select snapshot from continuity_before) is distinct from pg_temp.continuity_snapshot() then raise exception 'Continuity preservation proof failed'; end if;
  ${checks}
  ${tableChecks}
end $postflight$;
select jsonb_build_object('version',${literal(target.version)},'preservationPassed',true,'cohortLimit',128,'mode',${literal(mode)},
  'changedFunctions',(select coalesce(jsonb_agg(jsonb_build_object('identity',signature,'definitionMd5',md5(pg_get_functiondef(to_regprocedure(signature))),'metadataMd5',md5((to_jsonb(p)-'prosrc')::text)) order by signature),'[]'::jsonb) from unnest(${array(target.changed)}) signature join pg_proc p on p.oid=to_regprocedure(signature)),
  'ledgerRows',(select jsonb_agg(to_jsonb(m) order by version) from supabase_migrations.schema_migrations m));
${mode === 'rehearsal' ? 'rollback' : 'commit'};`
  const checked = renderer.splitAndTrimStatements(sql)
  assert.equal(checked.filter(item => /^(?:begin\b|commit\b|rollback\b)/iu.test(item)).length,2, 'One complete outer transaction required')
  assert.match(checked.at(-1), mode === 'rehearsal' ? /^rollback$/iu : /^commit$/iu)
  return { sql, target, sqlSha256: digest(sql) }
}

export async function prepareContinuityRelease({ file, hubRoot, mode, ledgerMd5, outputDirectory }) {
  assert(isAbsolute(outputDirectory), 'An explicit private artifact directory is required')
  const manifest = JSON.parse(readFileSync(new URL('../docs/reliability/patrol-continuity-release-2026-11-18.json', import.meta.url),'utf8'))
  const result = await renderPatrolContinuityRelease({ file, hubRoot, manifest, mode, ledgerMd5 })
  mkdirSync(outputDirectory, { recursive: true })
  const output = join(outputDirectory, `${result.target.version}-${mode}.sql`)
  writeFileSync(output, result.sql, { flag: 'wx' })
  return { output, version: result.target.version, sqlSha256: result.sqlSha256 }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const names = new Map([['--file','file'],['--hub-root','hubRoot'],['--mode','mode'],['--ledger-md5','ledgerMd5'],['--output-directory','outputDirectory']])
  const options = {}
  for (let index=2; index<process.argv.length; index+=2) {
    const name = names.get(process.argv[index])
    assert(name && process.argv[index+1] && !Object.hasOwn(options,name), 'Use only unique explicit release arguments')
    options[name]=process.argv[index+1]
  }
  prepareContinuityRelease(options).then(result=>console.log(JSON.stringify(result))).catch(error=>{ console.error(error.message); process.exitCode=1 })
}
