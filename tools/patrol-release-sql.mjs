import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// SQL artifact generator only. This module never connects to a database.
export const patrolReleaseTargets = Object.freeze({
  '20261117181328_patrol_single_observations_v3.sql': {
    version: '20261117181328', name: 'patrol_single_observations_v3', owner: 'Sygilant', count: 19,
    source: '0cbf7699d3eec78646f4d1b121f8526f0de74f4257dbac3d801fa5a376e616ba',
    ledger: 'dbd23f1b8e5098541959f6e0c180d507c338a75ceb969e0d0ae0bbe97ab9b16a',
    changed: ['private.sygilant_validate_patrol_shift_log_version()', 'private.sygilant_validate_system_standard_patrol_shift_log_version()', 'private.sygilant_site_patrol_shift_log_completeness_v2(jsonb)', 'public.sygilant_service_create_patrol_shift_log_v1(uuid,text,jsonb)', 'public.sygilant_service_create_report_v2(uuid,text,jsonb,uuid)', 'private.sygilant_require_site_patrol_submission_evidence()'],
    added: ['private.sygilant_is_single_observations_patrol(jsonb)', 'private.sygilant_patrol_template_version_available(uuid,uuid)', 'private.sygilant_patrol_observation_present(jsonb)'],
  },
  '20261117182334_patrol_route_builder_integrity.sql': {
    version: '20261117182334', name: 'patrol_route_builder_integrity', owner: 'SygShift', count: 23,
    source: 'a7d909fc39b588422de844185c69caaa6b01ae4f024ffc2a5c6dc8ca653e59d1',
    ledger: '2f02d7c499e326f26f9b4d0571e2d3f1afdb117169536b9db3737f700fb695a1',
    changed: ['public.save_patrol_route(jsonb)', 'public.link_patrol_route_shift(uuid,uuid,uuid)', 'public.get_patrol_workspace()'],
    added: ['private.patrol_route_save_receipt_immutable()', 'private.save_patrol_route_version_body_v1(jsonb)', 'private.link_patrol_route_shift_body_v1(uuid,uuid,uuid)', 'private.patrol_assert_route_stops_v1(jsonb,boolean)'],
  },
})

const protectedTables = [
  'auth.users', 'auth.identities', 'auth.mfa_factors', 'auth.sessions', 'public.employees', 'public.profiles',
  'public.employee_access_roles', 'public.role_permissions', 'public.permission_catalog',
  'public.clients', 'public.sites', 'public.posts', 'public.schedules', 'public.shifts', 'public.shift_assignments',
  'public.time_events', 'private.payroll_export_batches', 'private.payroll_export_rows', 'private.payroll_rules',
  'private.payroll_batch_assignments', 'public.patrol_routes', 'public.patrol_route_versions',
  'public.patrol_route_stops', 'public.patrol_stop_requirements', 'public.patrol_assignments',
  'public.patrol_hit_obligations', 'public.patrol_hits', 'public.patrol_hit_evidence',
  'public.sygilant_reports', 'public.sygilant_report_versions', 'public.sygilant_report_evidence',
  'public.sygilant_document_templates', 'public.sygilant_document_template_versions',
  'public.sygilant_document_template_decisions', 'private.audit_events', 'public.sygilant_audit_events',
]
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`
const array = (values) => `array[${values.map(literal).join(',')}]::text[]`
const digest = (value) => createHash('sha256').update(value).digest('hex')

export function validatePatrolSource(file, source) {
  const target = patrolReleaseTargets[basename(file)]
  assert(target, 'Only the two reviewed patrol migrations are accepted')
  assert(typeof source === 'string' && !source.startsWith('\uFEFF') && !source.includes('\u0000'), 'Invalid migration encoding')
  const normalized = source.replaceAll('\r\n', '\n')
  assert(!normalized.includes('\r') && digest(normalized) === target.source, 'Reviewed migration source fingerprint mismatch')
  return { target, normalized }
}

function preservationSql(target) {
  const allowed = [...target.changed, ...target.added]
  const isHub = target.owner === 'Sygilant'
  const receipts = "to_regclass('private.patrol_route_save_receipts')"
  const newRelation = target.owner === 'SygShift'
    ? `(coalesce(c.oid=${receipts},false) or c.oid in (select indexrelid from pg_index where indrelid=${receipts}))`
    : 'false'
  const triggerException = isHub
    ? `(t.tgrelid=to_regclass('public.sygilant_report_versions') and t.tgname in ('sygilant_report_versions_validate_patrol_shift_log','sygilant_report_versions_validate_system_standard_patrol'))`
    : `(coalesce(t.tgrelid=${receipts},false) or (t.tgisinternal and t.tgconstraint in (select oid from pg_constraint where conrelid=${receipts})))`
  return `
create temporary table patrol_release_before(snapshot jsonb not null) on commit drop;
create function pg_temp.patrol_release_snapshot() returns jsonb language plpgsql set search_path=pg_catalog,pg_temp as $patrol_snapshot$
declare table_name text; relation regclass; ordering text; predicate text; projection text;
  row_count bigint; cohort_hash text; tables jsonb := '{}'::jsonb; catalog jsonb;
begin
  foreach table_name in array ${array(protectedTables)} loop
    relation := to_regclass(table_name);
    if relation is null then tables := tables || jsonb_build_object(table_name,jsonb_build_object('present',false)); continue; end if;
    select string_agg(format('r.%I',a.attname),',' order by key.position) into ordering
    from pg_index i cross join lateral unnest(i.indkey) with ordinality key(attnum,position)
    join pg_attribute a on a.attrelid=i.indrelid and a.attnum=key.attnum
    where i.indrelid=relation and i.indisprimary;
    ordering := coalesce(ordering,'r.ctid');
    predicate := 'true'; projection := 'to_jsonb(r)';
    if ${isHub} then
      if table_name='public.sygilant_document_template_versions' then
        predicate := $predicate$r.id::text !~ '^b1130000-0000-4000-8000-0000000000(0[1-9]|10)$'$predicate$;
      elsif table_name='public.sygilant_document_template_decisions' then
        predicate := $predicate$coalesce(r.idempotency_key::text,'') !~ '^b1150000-0000-4000-8000-0000000000(0[1-9]|10)$'$predicate$;
      elsif table_name='public.sygilant_document_templates' then
        projection := $projection$case when r.id::text ~ '^b1110000-0000-4000-8000-0000000000(0[1-9]|10)$'
          then to_jsonb(r)-array['current_version_id','active_version_id','current_version_number','row_version','updated_at'] else to_jsonb(r) end$projection$;
      end if;
    end if;
    if table_name in ('private.audit_events','public.sygilant_audit_events')
      and exists(select 1 from pg_attribute where attrelid=relation and attname='created_at' and not attisdropped) then
      predicate := 'r.created_at < transaction_timestamp()';
    end if;
    execute format('select count(*) from %s r where %s',relation,predicate) into row_count;
    execute format('select md5(coalesce(string_agg(fingerprint,'''' order by position),'''')) from (select md5((%s)::text) fingerprint,row_number() over(order by %s) position from %s r where %s order by %s limit 128) sample',projection,ordering,relation,predicate,ordering) into cohort_hash;
    tables := tables || jsonb_build_object(table_name,jsonb_build_object('present',true,'rows',row_count,'cohortLimit',128,'cohortMd5',cohort_hash));
  end loop;
  select jsonb_build_object(
    'functions',(select md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' order by p.oid),'')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^(pg_|information_schema$)' and not p.oid=any(array(select to_regprocedure(signature)::oid from unnest(${array(allowed)}) signature where to_regprocedure(signature) is not null))),
    'changedFunctionSecurity',(select md5(coalesce(string_agg(md5((to_jsonb(p)-'prosrc')::text),'' order by p.oid),'')) from pg_proc p where p.oid=any(array(select to_regprocedure(signature)::oid from unnest(${array(target.changed)}) signature))),
    'relations',(select md5(coalesce(string_agg(md5(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reloptions)::text),'' order by c.oid),'')) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^(pg_|information_schema$)' and not ${newRelation}),
    'triggers',(select md5(coalesce(string_agg(md5((to_jsonb(t)||jsonb_build_object('definition',pg_get_triggerdef(t.oid)))::text),'' order by t.oid),'')) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^(pg_|information_schema$)' and not (${triggerException})),
    'constraints',(select md5(coalesce(string_agg(md5(to_jsonb(k)::text),'' order by k.oid),'')) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname !~ '^(pg_|information_schema$)' and k.conrelid is distinct from ${target.owner === 'SygShift' ? receipts : 'null::oid'}),
    'policies',(select md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' order by p.oid),'')) from pg_policy p),
    'roles',(select md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by r.oid),'')) from pg_roles r),
    'memberships',(select md5(coalesce(string_agg(md5(to_jsonb(m)::text),'' order by m.roleid,m.member,m.grantor),'')) from pg_auth_members m),
    'defaultAcls',(select md5(coalesce(string_agg(md5(to_jsonb(a)::text),'' order by a.oid),'')) from pg_default_acl a),
    'schemas',(select md5(coalesce(string_agg(md5(jsonb_build_array(n.nspname,n.nspowner,n.nspacl)::text),'' order by n.oid),'')) from pg_namespace n where n.nspname !~ '^pg_'),
    'priorLedger',(select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.version)::text,'[]')) from supabase_migrations.schema_migrations m where m.version<>${literal(target.version)})
  ) into catalog;
  return jsonb_build_object('tables',tables,'catalog',catalog);
end;
$patrol_snapshot$;
insert into patrol_release_before select pg_temp.patrol_release_snapshot();
`
}

function postflightSql(target, mode) {
  const newFunctionChecks = target.added.map(signature => `
  if to_regprocedure(${literal(signature)}) is null or has_function_privilege('anon',${literal(signature)},'execute')
    or has_function_privilege('authenticated',${literal(signature)},'execute') then
    raise check_violation using message='A private patrol helper is missing or exposed'; end if;`).join('')
  const ownerCheck = target.owner === 'SygShift' ? `
  if not exists(select 1 from pg_class where oid='private.patrol_route_save_receipts'::regclass and relrowsecurity and relforcerowsecurity)
    or exists(select 1 from unnest(array['anon','authenticated','service_role']) role where has_table_privilege(role,'private.patrol_route_save_receipts','select,insert,update,delete'))
    or (select count(*) from private.patrol_route_save_receipts) <> 0 then
    raise check_violation using message='Patrol receipts were exposed or unexpectedly populated'; end if;
  if exists(select 1 from unnest(${array(target.added)}) signature where has_function_privilege('service_role',signature,'execute')) then
    raise check_violation using message='A private route writer is exposed to service_role'; end if;` : `
  if exists(select 1 from unnest(${array(target.added)}) signature where not has_function_privilege('service_role',signature,'execute')) then
    raise check_violation using message='A protected patrol helper lacks its service-only grant'; end if;
  if (select count(*) from public.sygilant_document_template_versions where id::text ~ '^b1130000-0000-4000-8000-0000000000(0[1-9]|10)$' and version_number=3)<>10
    or (select count(*) from public.sygilant_document_template_decisions where idempotency_key::text ~ '^b1150000-0000-4000-8000-0000000000(0[1-9]|10)$')<>10
    or (select count(*) from public.sygilant_document_templates where id::text ~ '^b1110000-0000-4000-8000-0000000000(0[1-9]|10)$' and active_version_id::text=replace(id::text,'b1110000-','b1130000-') and current_version_id=active_version_id and current_version_number=3)<>10 then
    raise check_violation using message='The ten governed patrol templates did not activate exactly'; end if;`
  return `
do $patrol_postflight$
begin
  if (select snapshot from patrol_release_before) is distinct from pg_temp.patrol_release_snapshot() then
    raise check_violation using message='Protected record cohorts, counts, security catalog or prior migration history changed'; end if;
  if not exists(select 1 from supabase_migrations.schema_migrations where version=${literal(target.version)} and name=${literal(target.name)}
    and array_length(statements,1)=${target.count}
    and encode(extensions.digest(convert_to(array_to_string(statements,E';\\n'),'UTF8'),'sha256'),'hex')=${literal(target.ledger)}) then
    raise check_violation using message='The exact reviewed migration ledger was not retained'; end if;
  ${newFunctionChecks}
  ${ownerCheck}
end;
$patrol_postflight$;
select jsonb_build_object('proof',jsonb_build_object('migration',${literal(target.version)},'owner',${literal(target.owner)},
  'sourceSha256',${literal(target.source)},'ledgerSha256',${literal(target.ledger)},'statementCount',${target.count},
  'protectedCohortsAndCatalogEqual',true,'cohortLimit',128,'transactionDisposition',${literal(mode === 'rehearsal' ? 'rollback-requested-verify-command-completion' : 'commit-requested-verify-command-completion')},
  'snapshot',(select snapshot from patrol_release_before)),
  'ledgerRows',(select jsonb_agg(to_jsonb(m) order by version) from supabase_migrations.schema_migrations m));
${mode === 'rehearsal' ? 'rollback' : 'commit'};
`
}

export async function renderPatrolRelease({ file, hubRoot, mode, ledgerMd5 }) {
  assert(isAbsolute(file) && isAbsolute(hubRoot), 'Use explicit absolute migration and renderer-root paths')
  assert(mode === 'rehearsal' || mode === 'activate', 'Mode must be rehearsal or activate')
  assert.match(ledgerMd5, /^[a-f0-9]{32}$/u, 'A freshly verified migration-ledger MD5 is required')
  const { target, normalized } = validatePatrolSource(file, readFileSync(file, 'utf8'))
  const renderer = await import(pathToFileURL(join(hubRoot, 'scripts/render-supabase-migration-activation.mjs')).href)
  const activation = renderer.renderActivationBatch({ filePath: file, source: normalized, expectedVersion: target.version,
    expectedName: target.name, expectedSourceHash: target.source, expectedLedgerHash: target.ledger, expectedStatementCount: target.count })
  const statements = renderer.splitAndTrimStatements(activation)
  assert.match(statements[0], /\bbegin\s*$/iu)
  assert.match(statements.at(-1), /^commit$/iu)
  const body = statements.slice(1, -1).filter(statement => !/^set local (lock_timeout|statement_timeout)\s*=/iu.test(statement))
  const queries = patrolSafetyQueries(basename(file), mode, ledgerMd5)
  const sql = `${queries.before}\n${body.map(statement => `${statement};`).join('\n\n')}\n${queries.after}`
  const checked = renderer.splitAndTrimStatements(sql)
  assert.equal(checked.filter(statement => /^(?:begin\b|commit\b|rollback\b)/iu.test(statement)).length, 2, 'One outer transaction is required')
  assert.match(checked.at(-1), mode === 'rehearsal' ? /^rollback$/iu : /^commit$/iu)
  return { sql, target, sqlSha256: digest(sql) }
}

// Separately testable safety queries; these fragments alone never activate a migration.
export function patrolSafetyQueries(filename, mode, ledgerMd5) {
  const target = patrolReleaseTargets[filename]
  assert(target, 'Only the two reviewed patrol migrations are accepted')
  assert(mode === 'rehearsal' || mode === 'activate', 'Mode must be rehearsal or activate')
  assert.match(ledgerMd5, /^[a-f0-9]{32}$/u, 'A freshly verified migration-ledger MD5 is required')
  const before = `begin isolation level repeatable read;
set local lock_timeout='3s';
set local statement_timeout='30s';
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $patrol_ledger$ begin
  if (select md5(coalesce(jsonb_agg(to_jsonb(m) order by version)::text,'[]')) from supabase_migrations.schema_migrations m) <> ${literal(ledgerMd5)} then
    raise object_not_in_prerequisite_state using message='The migration ledger changed since preflight'; end if;
end; $patrol_ledger$;
${preservationSql(target)}
`
  return { before, after: postflightSql(target, mode), target }
}

async function main() {
  const options = {}
  const mapping = { '--file': 'file', '--hub-root': 'hubRoot', '--mode': 'mode', '--ledger-md5': 'ledgerMd5' }
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 2) {
    const key = mapping[args[index]]
    assert(key && args[index + 1] && !options[key], 'Use --file, --hub-root, --mode and --ledger-md5 exactly once')
    options[key] = args[index + 1]
  }
  const result = await renderPatrolRelease(options)
  process.stdout.write(result.sql)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
