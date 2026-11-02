import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renderAuthBanSerializationRepairSql, validateAuthBanRepairManifest } from './auth-ban-serialization-repair.mjs'

// This runner has no production connection mode. Every SQL statement is sent
// through explicit loopback connection arguments to a newly initialized cluster.
// Application .env files, database URLs, credentials and account APIs are unused.
assert.equal(process.versions.node, '24.19.0', 'Use the repository-pinned Node.js 24.19.0 runtime.')
const extension = process.platform === 'win32' ? '.exe' : ''
const bin = resolve(process.env.AUTH_BAN_TEST_POSTGRES_BIN ?? (process.platform === 'win32'
  ? 'C:/Program Files/PostgreSQL/18/bin' : '/usr/lib/postgresql/18/bin'))
for (const name of ['initdb', 'postgres', 'pg_ctl', 'psql', 'createdb']) {
  assert(existsSync(join(bin, name + extension)), `Native isolated PostgreSQL binary missing: ${name}`)
}
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PG|^(?:DATABASE_URL|SUPABASE_)/iu.test(name)))
const directory = mkdtempSync(join(tmpdir(), 'sygshift-auth-ban-serialization-'))
const data = join(directory, 'data')
const database = 'auth_ban_serialization_synthetic'
const socket = net.createServer()
await new Promise((resolvePort, reject) => {
  socket.once('error', reject)
  socket.listen(0, '127.0.0.1', resolvePort)
})
const port = socket.address().port
await new Promise((resolveClose, reject) => socket.close((error) => error ? reject(error) : resolveClose()))
assert(port > 1024 && port !== 5432, 'The fixture must not use the default PostgreSQL port.')

function command(name, args, options = {}) {
  return spawnSync(join(bin, name + extension), args, {
    encoding: 'utf8', windowsHide: true, timeout: 45_000,
    env: environment, maxBuffer: 4 * 1024 * 1024, ...options,
  })
}
function run(name, args, options = {}) {
  const result = command(name, args, options)
  assert.equal(result.status, 0, `${name} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`)
  return result.stdout
}
const connectionArgs = ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', database]
function execute(source) {
  return command('psql', ['-X', '--no-password', ...connectionArgs, '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-'], { input: source })
}
function sql(source) {
  const result = execute(source)
  assert.equal(result.status, 0, `Synthetic SQL failed: ${result.error?.message ?? result.stderr ?? result.stdout}`)
  return result.stdout.trim()
}
function json(source) {
  return JSON.parse(sql(source))
}
function startSql(source, { keepOpen = false } = {}) {
  const child = spawn(join(bin, 'psql' + extension), ['-X', '--no-password', ...connectionArgs,
    '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-'], { env: environment, windowsHide: true, stdio: 'pipe' })
  let stdout = ''
  let stderr = ''
  let finished = false
  const watchers = new Set()
  const update = () => {
    for (const watcher of watchers) watcher()
  }
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); update() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); update() })
  const completion = new Promise((resolveCompletion, reject) => {
    child.once('error', reject)
    child.once('close', (status) => {
      finished = true
      clearTimeout(timeout)
      update()
      resolveCompletion({ status, stdout, stderr })
    })
  })
  const timeout = setTimeout(() => child.kill(), 15_000)
  if (keepOpen) child.stdin.write(source)
  else child.stdin.end(source)
  return {
    completion,
    end: (remaining) => child.stdin.end(remaining),
    stop: () => { if (!finished) child.kill() },
    waitFor: (pattern) => new Promise((resolveOutput, reject) => {
      const inspect = () => {
        if (pattern.test(stdout + stderr)) {
          watchers.delete(inspect)
          resolveOutput()
        } else if (finished) {
          watchers.delete(inspect)
          reject(new Error(`Synthetic concurrent SQL ended before ${pattern}: ${stderr}`))
        }
      }
      watchers.add(inspect)
      inspect()
    }),
  }
}
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`
const rowHash = (source) => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((${source})::text, 'UTF8')), 'hex')`
const targetId = '71000000-0000-4000-8000-000000000001'
const employeeId = '72000000-0000-4000-8000-000000000001'
const businessRelations = [
  'public.schedules', 'public.shifts', 'public.shift_assignments', 'public.time_events',
  'public.time_event_corrections', 'private.payroll_export_batches',
  'private.payroll_export_rows', 'private.payroll_batch_assignments',
]
const preservedRelations = [
  'auth.identities', 'auth.sessions', 'auth.refresh_tokens', 'auth.mfa_factors',
  'auth.mfa_challenges', 'private.employee_accounts', 'public.employees',
  'private.emergency_access_authority', 'supabase_migrations.schema_migrations', ...businessRelations,
]

const fixture = `
create schema auth;
create schema private;
create schema supabase_migrations;
revoke all on schema private from public;
revoke create on schema public from public;
create table supabase_migrations.schema_migrations (
  version text primary key, name text not null, statements text[] not null
);
insert into supabase_migrations.schema_migrations values
  ('20000101000000', 'synthetic_fixture_only', array['select true;']);
create table auth.users (
  id uuid primary key, email text not null, encrypted_password text not null,
  banned_until timestamptz, raw_app_meta_data jsonb not null,
  raw_user_meta_data jsonb not null, confirmation_token text not null,
  recovery_token text not null, email_change_token_new text not null,
  reauthentication_token text not null, created_at timestamptz not null,
  updated_at timestamptz not null, last_sign_in_at timestamptz,
  email_confirmed_at timestamptz, phone text, phone_confirmed_at timestamptz,
  is_sso_user boolean not null, is_anonymous boolean not null,
  deleted_at timestamptz
);
create table public.employees (
  id uuid primary key, username text unique not null, status text not null,
  first_name text not null, last_name text not null,
  role text not null, hire_date date not null
);
alter table public.employees enable row level security;
create table private.employee_accounts (
  auth_user_id uuid unique not null references auth.users(id),
  employee_id uuid primary key references public.employees(id),
  disabled_at timestamptz, activated_at timestamptz not null,
  disabled_by uuid, disabled_reason text,
  must_change_password boolean not null, password_changed_at timestamptz,
  auth_tokens_invalid_before_epoch bigint not null,
  current_emergency_revocation_id uuid,
  updated_at timestamptz not null
);
create table private.emergency_access_authority (
  auth_user_id uuid primary key references auth.users(id),
  employee_id uuid not null references public.employees(id),
  access_state text not null, disabled_at timestamptz,
  access_generation bigint not null
);
create table private.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz default clock_timestamp(),
  auth_user_id uuid, employee_id uuid, request_id text,
  schema_name text not null, table_name text not null, operation text not null,
  row_id text, old_record jsonb, new_record jsonb
);
insert into auth.users values
  ('${targetId}', 'synthetic-target@example.invalid', 'synthetic-password-hash-never-valid',
   'infinity', '{"provider":"email","synthetic":true}', '{"synthetic":true}',
   'synthetic-confirmation', 'synthetic-recovery', 'synthetic-email-change',
   'synthetic-reauthentication', '2025-01-01Z', '2026-01-01Z', '2026-01-02Z',
   '2025-01-01Z', '+15550000001', '2025-01-01Z', false, false, null),
  ('71000000-0000-4000-8000-000000000002', 'synthetic-other@example.invalid',
   'synthetic-unrelated-password-hash-never-valid', null,
   '{"provider":"email","synthetic":true}', '{"synthetic":true}',
   'synthetic-other-confirmation', 'synthetic-other-recovery',
   'synthetic-other-email-change', 'synthetic-other-reauthentication',
   '2025-01-01Z', '2026-01-01Z', null, '2025-01-01Z', null, null, false, false, null);
insert into public.employees values
  ('${employeeId}', 'synthetic_target', 'active', 'Synthetic', 'Target', 'guard', '2025-01-01');
insert into private.employee_accounts values
  ('${targetId}', '${employeeId}', '2026-01-03Z', '2025-01-01Z', null,
   'Synthetic independent access deny; preserve without reopening access.',
   true, '2025-01-01Z', 1700000000, null, '2026-01-03Z');
insert into private.emergency_access_authority values
  ('${targetId}', '${employeeId}', 'active', null, 7);
insert into private.audit_events (
  auth_user_id, employee_id, request_id, schema_name, table_name, operation,
  row_id, old_record, new_record
) values (
  '${targetId}', '${employeeId}', 'synthetic-prior-audit', 'private',
  'employee_accounts', 'SYNTHETIC_PRIOR_ACCESS_DENY', '${employeeId}',
  '{"disabled_at":null}', '{"disabled_at":"2026-01-03T00:00:00Z"}'
);
${['identities', 'sessions', 'refresh_tokens', 'mfa_factors', 'mfa_challenges'].map((name, index) => `
create table auth.${name} (
  id uuid primary key, user_id uuid not null references auth.users(id),
  fixture_payload jsonb not null
);
insert into auth.${name} values (
  '73000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}',
  '${targetId}', '{"synthetic":true,"neverValidCredential":"${name}-preserve"}'
);`).join('\n')}
${businessRelations.map((relation, index) => `
create table ${relation} (
  id uuid primary key, employee_id uuid not null references public.employees(id),
  fixture_payload jsonb not null, occurred_at timestamptz not null
);
alter table ${relation} enable row level security;
insert into ${relation} values (
  '74000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}',
  '${employeeId}', '{"synthetic":true,"preserve":"${relation}","paidMinutes":480}', '2026-01-01Z'
), (
  '75000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}',
  '${employeeId}', '{"synthetic":true,"preserve":"${relation}","paidMinutes":30}', '2026-01-02Z'
);`).join('\n')}
`

function captureManifest() {
  const capturedAt = new Date().toISOString()
  const businessFingerprints = Object.fromEntries(businessRelations.map((relation) => [relation, json(`
    select jsonb_build_object('rows', count(*), 'sha256', ${rowHash("coalesce(string_agg(row_hash, '' order by row_hash), '')")})
    from (select ${rowHash('to_jsonb(r)')} as row_hash from ${relation} r) fingerprint;
  `)]))
  return validateAuthBanRepairManifest({
    formatVersion: 1, targetProject: 'eqkdfrbwtioiqtjsyglg', requestId: randomUUID(),
    capturedAt, reason: 'Synthetic local Auth ban serialization regression; preserve the independent deny.',
    replacementBannedUntil: new Date(Date.parse(capturedAt) + 876_000 * 3_600_000).toISOString(),
    expectedCount: 1,
    affectedRows: [json(`
      select jsonb_build_object(
        'authUserId', u.id,
        'fullRowSha256', ${rowHash('to_jsonb(u)')},
        'protectedRowSha256', ${rowHash("to_jsonb(u) - 'banned_until'")},
        'accountRowSha256', ${rowHash("coalesce(to_jsonb(a)::text, 'null')")},
        'employeeRowSha256', ${rowHash("coalesce(to_jsonb(e)::text, 'null')")},
        'centralAuthorityRowSha256', ${rowHash("coalesce(to_jsonb(c)::text, 'null')")}
      )
      from auth.users u
      left join private.employee_accounts a on a.auth_user_id=u.id
      left join public.employees e on e.id=a.employee_id
      left join private.emergency_access_authority c on c.auth_user_id=u.id
      where u.id='${targetId}';
    `)], businessFingerprints,
  })
}

function snapshot({ protectBan = false, includeAudit = true } = {}) {
  const entries = [
    ['auth.users', `select ${protectBan ? "to_jsonb(r) - 'banned_until'" : 'to_jsonb(r)'} as record from auth.users r`],
    ...preservedRelations.map((relation) => [relation, `select to_jsonb(r) as record from ${relation} r`]),
    ...(includeAudit ? [['private.audit_events', 'select to_jsonb(r) as record from private.audit_events r']] : []),
  ]
  return json(`select jsonb_build_object(${entries.map(([relation, query]) => `
    ${literal(relation)}, (select coalesce(jsonb_agg(record order by record::text), '[]') from (${query}) records)
  `).join(',')});`)
}

const scenarios = []
function rejectUnchanged(name, manifest, messagePattern) {
  const before = snapshot()
  const result = execute(renderAuthBanSerializationRepairSql(manifest, { mode: 'activation' }))
  assert.notEqual(result.status, 0, `${name}: unsafe activation unexpectedly succeeded.`)
  assert.match(result.stderr, messagePattern, `${name}: the expected guard did not reject the request.`)
  assert.deepEqual(snapshot(), before, `${name}: rejection retained data or audit changes.`)
  scenarios.push(name)
}

const zeroWriteFootprint = `not exists (
  select 1 from pg_catalog.pg_stat_xact_user_tables
  where n_tup_ins<>0 or n_tup_upd<>0 or n_tup_del<>0
)`
const exactRepairWriteFootprint = `(
  (select row(n_tup_ins,n_tup_upd,n_tup_del)=row(0,1,0)
    from pg_catalog.pg_stat_xact_user_tables where relid='auth.users'::regclass)
  and (select row(n_tup_ins,n_tup_upd,n_tup_del)=row(1,0,0)
    from pg_catalog.pg_stat_xact_user_tables where relid='private.audit_events'::regclass)
  and not exists (select 1 from pg_catalog.pg_stat_xact_user_tables
    where relid not in ('auth.users'::regclass,'private.audit_events'::regclass)
      and (n_tup_ins<>0 or n_tup_upd<>0 or n_tup_del<>0))
)`

function verifyTransactionCounterVisibility() {
  const before = snapshot()
  const ownWrites = `
    if (${zeroWriteFootprint}) is distinct from true then raise exception 'Synthetic transaction did not start clean.'; end if;
    update auth.users set banned_until=banned_until where id='${targetId}';
    insert into private.audit_events(schema_name,table_name,operation)
      values('auth','users','SYNTHETIC_TRANSACTION_COUNTER_PROBE');
    if (${exactRepairWriteFootprint}) is distinct from true then raise exception 'Own transaction counters were not visible inside DO.'; end if;
    raise notice 'synthetic-own-write-counters-visible-inside-do';
  `
  const visible = execute(`begin; set transaction isolation level repeatable read;
    do $fixture$ begin ${ownWrites} end $fixture$; rollback;`)
  assert.equal(visible.status, 0, visible.stderr)
  assert.match(visible.stderr, /synthetic-own-write-counters-visible-inside-do/u)
  assert.deepEqual(snapshot(), before, 'Standalone counter visibility probe retained writes.')
  scenarios.push('native_own_write_counters_update_immediately_inside_do')

  const unexpected = execute(`begin; set transaction isolation level repeatable read;
    do $fixture$ begin ${ownWrites}
      update public.schedules set fixture_payload=fixture_payload || '{"unexpectedSideWrite":true}'::jsonb;
      if (${exactRepairWriteFootprint}) is distinct from true then
        raise exception 'Synthetic unexpected same-transaction side write rejected.';
      end if;
      raise exception 'Synthetic side write escaped its transaction counter guard.';
    end $fixture$; rollback;`)
  assert.notEqual(unexpected.status, 0)
  assert.match(unexpected.stderr, /Synthetic unexpected same-transaction side write rejected/u)
  assert.deepEqual(snapshot(), before, 'Rejected same-transaction side write retained Auth, audit or business changes.')
  scenarios.push('native_transaction_counter_guard_rejects_side_write_and_rolls_back')
}

async function verifyConcurrentTransactionCounterIsolation() {
  const before = snapshot()
  const lock = '7612449012345'
  const concurrentId = '77000000-0000-4000-8000-000000000001'
  const holder = startSql(`begin; select pg_catalog.pg_advisory_xact_lock(${lock});
    do $fixture$ begin raise notice 'synthetic-concurrent-holder-ready'; end $fixture$;\n`, { keepOpen: true })
  let observer
  try {
    await holder.waitFor(/synthetic-concurrent-holder-ready/u)
    observer = startSql(`begin; set transaction isolation level repeatable read;
      do $fixture$ begin
        perform count(*) from public.schedules;
        if (${zeroWriteFootprint}) is distinct from true then raise exception 'Observer transaction did not start clean.'; end if;
        raise notice 'synthetic-concurrent-observer-ready';
        perform pg_catalog.pg_advisory_xact_lock(${lock});
        if (${zeroWriteFootprint}) is distinct from true then raise exception 'Separate connection polluted own transaction counters.'; end if;
        if exists(select 1 from public.schedules where id='${concurrentId}') then raise exception 'Concurrent test did not retain repeatable-read isolation.'; end if;
        raise notice 'synthetic-concurrent-writer-excluded-from-own-counters';
      end $fixture$; rollback;`)
    await observer.waitFor(/synthetic-concurrent-observer-ready/u)
    sql(`insert into public.schedules values ('${concurrentId}', '${employeeId}',
      '{"synthetic":true,"separateConcurrentConnection":true}', '2026-01-04Z');`)
    assert.equal(sql(`select count(*) from public.schedules where id='${concurrentId}';`), '1')
    holder.end('commit;\n')
    const [held, observed] = await Promise.all([holder.completion, observer.completion])
    assert.equal(held.status, 0, held.stderr)
    assert.equal(observed.status, 0, observed.stderr)
    assert.match(observed.stderr, /synthetic-concurrent-writer-excluded-from-own-counters/u)
    const changed = snapshot()
    const expectedScheduleRows = [...before['public.schedules'], {
      id: concurrentId, employee_id: employeeId,
      fixture_payload: { synthetic: true, separateConcurrentConnection: true },
      occurred_at: '2026-01-04T00:00:00+00:00',
    }]
    assert.equal(changed['public.schedules'].length, expectedScheduleRows.length)
    assert.deepEqual(changed['public.schedules'].find((row) => row.id === concurrentId), expectedScheduleRows.at(-1))
    changed['public.schedules'] = changed['public.schedules'].filter((row) => row.id !== concurrentId)
    assert.deepEqual(changed, before, 'Concurrent writer or observer changed unrelated data.')
    sql(`delete from public.schedules where id='${concurrentId}';`)
    assert.deepEqual(snapshot(), before, 'Concurrent isolation scenario did not restore the synthetic fixture.')
    scenarios.push('native_transaction_counters_exclude_separate_concurrent_business_write')
  } finally {
    holder.stop()
    observer?.stop()
    await Promise.allSettled([holder.completion, ...(observer ? [observer.completion] : [])])
  }
}

let started = false
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C'])
  // All server configuration is supplied as arguments: no global sockets,
  // inherited PGDATA, existing cluster, fixed port, or config file is accepted.
  run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1 -c unix_socket_directories= -c max_connections=10 -c timezone=UTC -c statement_timeout=10000 -c lock_timeout=1000`, '-w', 'start'], { stdio: 'ignore' })
  started = true
  run('createdb', ['--no-password', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', database])
  assert.equal(sql('show data_directory;').replaceAll('\\', '/').toLowerCase(), data.replaceAll('\\', '/').toLowerCase(), 'The fixture connected to the wrong cluster.')

  sql(fixture)
  verifyTransactionCounterVisibility()
  await verifyConcurrentTransactionCounterIsolation()
  const before = snapshot()
  const manifest = captureManifest()
  const postflightMarker = '-- Transaction write-footprint postflight.'
  const instrumented = renderAuthBanSerializationRepairSql(manifest, { mode: 'activation' })
  assert.equal(instrumented.split(postflightMarker).length, 2, 'The generated transaction footprint check must have one stable test marker.')
  const rejectedSideWrite = execute(instrumented.replace(postflightMarker, `
    -- Disposable-test instrumentation only: prove the generated postflight rejects this write.
    update public.schedules set fixture_payload=fixture_payload || '{"unexpectedSameTransactionWrite":true}'::jsonb;
    ${postflightMarker}
  `))
  assert.notEqual(rejectedSideWrite.status, 0, 'The generated activation accepted an unexpected same-transaction business write.')
  assert.match(rejectedSideWrite.stderr, /exact reviewed Auth and audit footprint/u)
  assert.deepEqual(snapshot(), before, 'Generated footprint rejection retained a ban, receipt or unexpected business write.')
  scenarios.push('generated_transaction_postflight_rejects_side_write_and_rolls_back')
  const rehearsal = renderAuthBanSerializationRepairSql(manifest)
  assert.match(rehearsal, /ROLLBACK\s*;\s*$/iu, 'The default rehearsal must end in rollback.')
  sql(rehearsal)
  assert.deepEqual(snapshot(), before, 'Rehearsal retained a ban, credential, audit or business change.')
  scenarios.push('default_rehearsal_rolls_back_ban_and_audit')

  for (const field of ['fullRowSha256', 'protectedRowSha256', 'accountRowSha256', 'employeeRowSha256', 'centralAuthorityRowSha256']) {
    const changed = structuredClone(manifest)
    changed.affectedRows[0][field] = '0'.repeat(64)
    rejectUnchanged(`reject_${field}`, changed, /fingerprint|hash|snapshot|mismatch|drift|context changed/iu)
  }
  // The SQL must reject an actual extra non-finite row, rather than merely a
  // malformed JS expectedCount field. The manifest remains structurally valid.
  sql("update auth.users set banned_until='infinity' where id='71000000-0000-4000-8000-000000000002';")
  rejectUnchanged('reject_actual_nonfinite_cohort_count_drift', manifest, /count|cohort|non.finite/iu)
  sql("update auth.users set banned_until=null where id='71000000-0000-4000-8000-000000000002';")

  sql(`update private.employee_accounts set disabled_at=null where auth_user_id='${targetId}';`)
  rejectUnchanged('reject_unblocked_target_even_with_matching_hashes', captureManifest(), /disabled|independent|deny|block/iu)
  sql(`update private.employee_accounts set disabled_at='2026-01-03Z' where auth_user_id='${targetId}';`)
  assert.deepEqual(snapshot(), before, 'Negative scenario setup was not restored exactly.')

  // An independent disabled SygShift account does not require inventing a
  // central revocation. A missing LEFT JOIN row must hash the literal JSON null.
  sql(`delete from private.emergency_access_authority where auth_user_id='${targetId}';`)
  const noCentralManifest = captureManifest()
  assert.equal(noCentralManifest.affectedRows[0].centralAuthorityRowSha256, sql(`select ${rowHash("'null'")};`))
  const noCentralBefore = snapshot()
  sql(renderAuthBanSerializationRepairSql(noCentralManifest))
  assert.deepEqual(snapshot(), noCentralBefore, 'Missing-central-row rehearsal retained changes.')
  sql(`insert into private.emergency_access_authority values ('${targetId}', '${employeeId}', 'active', null, 7);`)
  assert.deepEqual(snapshot(), before, 'Central-row scenario setup was not restored exactly.')
  scenarios.push('independent_deny_rehearsal_accepts_absent_central_authority')

  // Business fingerprints in the captured manifest are context, not an old
  // snapshot gate that would reject legitimate intervening operational work.
  // The repair must preserve current business rows within its own transaction.
  sql(`insert into public.schedules values (
    '76000000-0000-4000-8000-000000000001', '${employeeId}',
    '{"synthetic":true,"legitimateInterveningSchedule":true}', '2026-01-04Z'
  );`)
  const currentBefore = snapshot()
  sql(renderAuthBanSerializationRepairSql(manifest))
  assert.deepEqual(snapshot(), currentBefore, 'Rehearsal did not preserve current business data after capture.')
  scenarios.push('stale_business_manifest_context_does_not_block_current_preserved_data')

  const protectedBefore = snapshot({ protectBan: true, includeAudit: false })
  const oldAudit = currentBefore['private.audit_events']
  sql(renderAuthBanSerializationRepairSql(manifest, { mode: 'activation' }))
  assert.equal(sql(`select isfinite(banned_until) and banned_until=${literal(manifest.replacementBannedUntil)}::timestamptz
    and banned_until >= clock_timestamp()+interval '875999 hours' from auth.users where id='${targetId}';`), 't')
  assert.equal(sql('select count(*) from auth.users where banned_until is not null and not isfinite(banned_until);'), '0')
  assert.deepEqual(snapshot({ protectBan: true, includeAudit: false }), protectedBefore,
    'Activation changed data other than the single banned_until field and receipt.')
  const auditAfter = json('select jsonb_agg(to_jsonb(a) order by id) from private.audit_events a;')
  assert.equal(auditAfter.length, oldAudit.length + 1, 'Activation must append exactly one audit row.')
  assert.deepEqual(auditAfter.slice(0, oldAudit.length), oldAudit, 'Existing audit history changed.')
  const receipt = auditAfter.at(-1)
  assert.equal(receipt.operation, 'AUTH_BAN_SERIALIZATION_REPAIR')
  assert.equal(receipt.schema_name, 'auth')
  assert.equal(receipt.table_name, 'users')
  assert.equal(receipt.request_id, manifest.requestId)
  assert.equal(receipt.row_id, targetId)
  assert.deepEqual(receipt.old_record, { banned_until: 'infinity' })
  assert.deepEqual(Object.keys(receipt.new_record).sort(), ['banned_until', 'manifestSha256', 'reason', 'requestId'].sort())
  assert.equal(Date.parse(receipt.new_record.banned_until), Date.parse(manifest.replacementBannedUntil))
  assert.equal(receipt.new_record.reason, manifest.reason)
  assert.equal(receipt.new_record.requestId, manifest.requestId)
  assert.match(receipt.new_record.manifestSha256, /^[a-f0-9]{64}$/u)
  scenarios.push('activation_changes_one_ban_only_and_appends_minimal_receipt')

  const activated = snapshot()
  sql(renderAuthBanSerializationRepairSql(manifest, { mode: 'activation' }))
  assert.deepEqual(snapshot(), activated, 'Idempotent activation extended the ban or appended another receipt.')
  scenarios.push('same_request_retry_preserves_expiry_and_receipt')

  console.log(JSON.stringify({
    passed: true, postgresEngine: run('postgres', ['--version']).trim(),
    syntheticOnly: true, productionConnections: 0, scenarios,
    protectedAuthAndCredentialRowsPreserved: true,
    independentAccountDenyPreserved: true, employeeAndCentralAuthorityPreserved: true,
    businessRelationsPreserved: businessRelations.length, priorAuditRowsPreserved: oldAudit.length,
    receiptRowsAppended: 1, artifacts: directory,
  }, null, 2))
} catch (error) {
  let log = ''
  try { log = readFileSync(join(directory, 'postgres.log'), 'utf8').slice(-4_000) } catch { /* keep the original failure */ }
  throw new Error(`${error.message}\nDisposable fixture: ${directory}\n${log}`, { cause: error })
} finally {
  if (started || existsSync(join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
}
