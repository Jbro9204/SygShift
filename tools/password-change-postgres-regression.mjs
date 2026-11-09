import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { isolatedPostgresRuntime, startIsolatedPostgres, stopIsolatedPostgres } from './isolated-postgres-startup.mjs'

// Deliberately no production, environment-file, or connection-string mode.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^(DATABASE_URL|SUPABASE_)/u.test(key)))
const { bin, extension: ext } = isolatedPostgresRuntime({ platform: process.platform,
  override: process.env.PASSWORD_TEST_POSTGRES_BIN, environment: env })
const folder = mkdtempSync(join(tmpdir(), 'sygshift-password-change-'))
const data = join(folder, 'data')
const listener = net.createServer()
await new Promise((done, fail) => { listener.once('error', fail); listener.listen(0, '127.0.0.1', done) })
const port = listener.address().port
await new Promise((done, fail) => listener.close(error => error ? fail(error) : done()))
assert(port > 1024 && port !== 5432)
function cmd(name, args, input) {
  return spawnSync(join(bin, name + ext), args, { input, encoding: 'utf8', windowsHide: true, timeout: 30_000, env, maxBuffer: 4 * 1024 * 1024 })
}
function run(name, args, input) {
  const result = cmd(name, args, input)
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.error}`)
  return result.stdout.trim()
}
const connection = ['-X', '--no-password', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-']
const sql = source => run('psql', connection, source)
const failSql = source => { const result = cmd('psql', connection, source); assert.notEqual(result.status, 0, 'Expected SQL denial'); return result.stderr }
const asyncSql = source => new Promise((done, fail) => {
  const child = spawn(join(bin, 'psql' + ext), connection, {env, windowsHide:true, stdio:['pipe','pipe','pipe']})
  let stdout = ''; let stderr = ''
  const timeout = setTimeout(() => child.kill(), 15_000)
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  child.on('error', error => {clearTimeout(timeout); fail(error)})
  child.on('exit', status => {clearTimeout(timeout);done({status,stdout,stderr})})
  child.stdin.end(source)
})
const A = '10000000-0000-4000-8000-000000000001'
const G = '10000000-0000-4000-8000-000000000002'
const AU = '20000000-0000-4000-8000-000000000001'
const GU = '20000000-0000-4000-8000-000000000002'
const AS = '30000000-0000-4000-8000-000000000001'
const OLD = '30000000-0000-4000-8000-000000000002'
const NEW = '30000000-0000-4000-8000-000000000003'
const BATCH = '40000000-0000-4000-8000-000000000001'
const role = value => `select set_config('request.jwt.claim.role','${value}',false);`
const claims = (user, session) => `select set_config('request.jwt.claim.sub','${user}',false); select set_config('request.jwt.claims','{"sub":"${user}","session_id":"${session}"}',false);`
const scalar = source => sql(source).split('\n').at(-1)
const canonicalOnly = process.argv[2] === '--canonical-admin'
assert(!canonicalOnly || process.argv.length === 3, 'Canonical mode accepts no external migration paths')
const projectionPath = canonicalOnly ? undefined : process.argv[2]
const adminPasswordPath = canonicalOnly ? new URL('../supabase/migrations/20261109182242_admin_chosen_password_next_login.sql', import.meta.url) : process.argv[3]
const passwordBoundaryPath = canonicalOnly ? undefined : process.argv[4]
let started = false
let rehearsalFailure
const scenarios = []
try {
  run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
  startIsolatedPostgres({ data, directory: folder, port, run })
  started = true
  sql(`create role anon; create role authenticated; create role service_role;
    create schema auth; create schema private;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create table auth.users(id uuid primary key,encrypted_password text,deleted_at timestamptz,banned_until timestamptz,raw_app_meta_data jsonb not null default '{}'::jsonb);
    create table auth.sessions(id uuid primary key,user_id uuid,created_at timestamptz,not_after timestamptz);
    create table public.employees(id uuid primary key,username text,status text,role text);
    create table private.employee_accounts(employee_id uuid primary key,auth_user_id uuid unique,disabled_at timestamptz,must_change_password boolean,
      password_changed_at timestamptz,activated_at timestamptz,updated_at timestamptz,invited_at timestamptz,created_at timestamptz);
    create table private.emergency_access_authority(employee_id uuid,access_state text);
    create table private.audit_events(auth_user_id uuid,employee_id uuid,schema_name text,table_name text,operation text,row_id text,new_record jsonb);
    create table public.permission_catalog(code text,active boolean,requires_mfa boolean);
    create function private.current_employee_id() returns uuid language sql stable as $$select employee_id from private.employee_accounts where auth_user_id=auth.uid()$$;
    create function public.has_mfa() returns boolean language sql stable as $$select coalesce(nullif(current_setting('test.has_mfa',true),''),'true')::boolean$$;
    create function private.employee_requires_mfa(id uuid) returns boolean language sql stable as $$select coalesce(nullif(current_setting('test.employee_requires_mfa',true),''),'false')::boolean$$;
    create table private.test_employee_permissions(employee_id uuid,permission_code text);
    create function private.employee_effective_permissions(id uuid) returns text[] language sql stable as $$select coalesce(array_agg(permission_code order by permission_code),array[]::text[]) from private.test_employee_permissions where employee_id=$1$$;
    create function public.get_effective_permissions() returns text[] language sql stable as $$select private.employee_effective_permissions(private.current_employee_id())$$;
    create function public.get_session_context() returns table(employee_id uuid,must_change_password boolean,permissions text[]) language sql stable as $$select a.employee_id,a.must_change_password,public.get_effective_permissions() from private.employee_accounts a where a.auth_user_id=auth.uid()$$;
    create function public.current_emergency_access_context() returns jsonb language sql stable as $$select '{"active":true}'::jsonb$$;
    create function public.get_session_context_emergency() returns jsonb language sql stable as $$select to_jsonb(base_row)||public.current_emergency_access_context() from public.get_session_context() base_row$$;
    create function private.emergency_access_service_role_required() returns void language plpgsql as $$begin if auth.role()<>'service_role' then raise insufficient_privilege;end if;end$$;
    create function private.employee_preview_actor_proof(id uuid,sid uuid,at_time timestamptz,method text,key_hash text) returns jsonb language sql stable as $$
      select jsonb_build_object('ok',exists(select 1 from public.employees e join auth.sessions s on s.id=$2 join private.employee_accounts a on a.employee_id=e.id and a.auth_user_id=s.user_id
        where e.id=$1 and e.role='admin' and e.status='active' and at_time between now()-interval '5 minutes' and now()+interval '30 seconds' and method='authenticator'))$$;
    create function private.employee_preview_actor_authority(id uuid,sid uuid) returns jsonb language sql stable as $$
      select jsonb_build_object('ok',exists(select 1 from public.employees e join auth.sessions s on s.id=$2 join private.employee_accounts a on a.employee_id=e.id and a.auth_user_id=s.user_id
        where e.id=$1 and e.role='admin' and e.status='active'))$$;
    insert into auth.users(id,encrypted_password) values('${AU}','admin-synthetic-password'),('${GU}','guard-synthetic-password');
    insert into public.employees values('${A}','admin','active','admin'),('${G}','guard','active','guard');
    insert into private.employee_accounts values('${A}','${AU}',null,false,now()-interval '2 days',now()-interval '2 days',now(),now()-interval '2 days',now()-interval '2 days'),
      ('${G}','${GU}',null,false,now()-interval '2 days',now()-interval '2 days',now(),now()-interval '2 days',now()-interval '2 days');
    insert into auth.sessions values('${AS}','${AU}',now()-interval '1 hour',null),('${OLD}','${GU}',now()-interval '1 hour',null),('${NEW}','${GU}',now(),null);
    insert into public.permission_catalog values('time.punch',true,false),('apps.sygilant.access',true,true),('apps.sygshift.access',true,true),('payroll.review',true,true);
    insert into private.test_employee_permissions values('${A}','admin.users.password_reset'),('${A}','admin.users.view'),('${A}','admin.users.manage'),
      ('${G}','time.punch'),('${G}','apps.sygilant.access'),('${G}','apps.sygshift.access'),('${G}','payroll.review');
  `)
  sql(readFileSync(new URL('../supabase/migrations/20261109154616_password_change_requirements_and_verified_completion.sql', import.meta.url), 'utf8'))
  if (projectionPath) sql(readFileSync(resolve(projectionPath), 'utf8'))
  assert.equal(scalar('select count(*) from private.password_change_requirements;'), '0')
  assert.equal(scalar('select enabled from private.password_change_feature_config;'), 'f')
  scenarios.push('installation creates no requirements and feature remains disabled')
  assert.equal(scalar(`${claims(GU, OLD)}select set_config('test.has_mfa','false',false);select public.get_effective_permissions()::text;`), '{apps.sygilant.access,apps.sygshift.access,time.punch}')
  assert.equal(scalar(`${claims(GU, OLD)}select set_config('test.has_mfa','false',false);select set_config('test.employee_requires_mfa','true',false);select public.get_effective_permissions()::text;`), '{time.punch}')
  assert.equal(scalar(`${claims(GU, OLD)}select set_config('test.has_mfa','true',false);select set_config('test.employee_requires_mfa','true',false);select public.get_effective_permissions()::text;`), '{apps.sygilant.access,apps.sygshift.access,payroll.review,time.punch}')
  sql(`delete from private.test_employee_permissions where employee_id='${G}' and permission_code='apps.sygshift.access';`)
  assert.equal(scalar(`${claims(GU, OLD)}select set_config('test.has_mfa','false',false);select public.get_effective_permissions()::text;`), '{apps.sygilant.access,time.punch}')
  sql(`insert into private.test_employee_permissions values('${G}','apps.sygshift.access');update public.employees set status='inactive' where id='${G}';`)
  assert.equal(scalar(`${claims(GU, OLD)}select public.get_effective_permissions()::text;`), '{}')
  sql(`update public.employees set status='active' where id='${G}';`)
  scenarios.push('Guard AAL1 launch exemptions, privileged MFA requirements, direct denials and inactive account filtering preserved')
  const payload = `jsonb_build_object('actorEmployeeId','${A}','actorAuthSessionId','${AS}','recentMfaAt',now(),'mfaMethod','authenticator','employeeIds',jsonb_build_array('${G}'),
    'expectedCount',1,'startsAt',now()-interval '10 seconds','reason','Synthetic planned password change','idempotencyKey','${BATCH}','requestHash',repeat('a',64))`
  assert.match(failSql(`${role('service_role')}select public.service_require_employee_password_changes(${payload});`), /not enabled/)
  assert.match(failSql(`${role('authenticated')}select public.service_require_employee_password_changes(${payload});`), /permission denied|insufficient_privilege/)
  scenarios.push('disabled feature and non-service callers cannot activate requirements')
  sql('update private.password_change_feature_config set enabled=true;')
  assert.match(failSql(`${role('service_role')}select public.service_preview_employee_password_changes(${payload}-'employeeIds');`), /between one and 100/)
  assert.equal(JSON.parse(scalar(`${role('service_role')}select public.service_preview_employee_password_changes(${payload});`)).eligibleCount, 1)
  assert.equal(JSON.parse(scalar(`${role('service_role')}select public.service_preview_employee_password_changes(${payload}-'recentMfaAt');`)).eligibleCount, 1)
  assert.match(failSql(`${role('service_role')}select public.service_require_employee_password_changes(${payload}-'recentMfaAt');`), /fresh verification/)
  assert.match(failSql(`${role('service_role')}select public.service_require_employee_password_changes(${payload}||jsonb_build_object('actorEmployeeId','${G}','actorAuthSessionId','${NEW}'));`), /fresh verification/)
  assert.match(failSql(`${role('service_role')}select public.service_require_employee_password_changes(${payload}||'{"expectedCount":2}'::jsonb);`), /selection changed/)
  assert.equal(scalar('select count(*) from private.password_change_requirements;'), '0')
  sql(`${role('service_role')}select public.service_require_employee_password_changes(${payload});`)
  sql(`${role('service_role')}select public.service_require_employee_password_changes(${payload});`)
  assert.equal(scalar('select count(*) from private.password_change_requirements;'), '1')
  scenarios.push('preview exact count and idempotent creation')
  assert.equal(scalar(`${claims(GU, OLD)}select (public.get_password_change_requirement()->>'mustChangePassword')::boolean;`), 'f')
  assert.equal(scalar(`${claims(GU, OLD)}select cardinality(public.get_effective_permissions());`), '4')
  assert.equal(scalar(`${claims(GU, NEW)}select (public.get_password_change_requirement()->>'mustChangePassword')::boolean;`), 'f')
  sql(`update auth.sessions set created_at=clock_timestamp() where id='${NEW}';`)
  assert.equal(scalar(`${claims(GU, NEW)}select (public.get_password_change_requirement()->>'mustChangePassword')::boolean;`), 't')
  if (projectionPath) assert.equal(scalar(`${claims(GU, NEW)}select (public.get_session_context_emergency()->>'must_change_password')::boolean;`), 't')
  assert.equal(scalar(`${claims(GU, NEW)}select cardinality(public.get_effective_permissions());`), '0')
  scenarios.push('old session retains access and new session requires change')
  assert.match(failSql(`${claims(GU, NEW)}select public.mark_password_changed();`), /No completed credential change/)
  assert.match(failSql(`${claims(GU, NEW)}select public.mark_password_changed_verified();`), /No completed credential change/)
  sql(`update auth.users set banned_until=null where id='${GU}';`)
  assert.equal(scalar('select count(*) from private.password_change_receipts;'), '0')
  sql(`update auth.users set encrypted_password='different-synthetic-password' where id='${GU}';`)
  assert.equal(scalar('select count(*) from private.password_change_receipts;'), '1')
  sql(`${claims(GU, NEW)}select public.mark_password_changed_verified();`)
  sql(`${claims(GU, NEW)}select public.mark_password_changed();`)
  assert.equal(scalar("select status from private.password_change_requirements;"), 'completed')
  assert.equal(scalar('select count(*) from private.audit_events where operation=\'self_password_changed\';'), '1')
  scenarios.push('genuine provider transition required and completion retry is idempotent')
  sql(`update auth.users set encrypted_password='synthetic-admin-reset' where id='${GU}'; update private.employee_accounts set must_change_password=true where employee_id='${G}';`)
  assert.match(failSql(`${claims(GU, NEW)}select public.mark_password_changed();`), /No completed credential change/)
  sql(`update auth.users set encrypted_password='synthetic-permanent-password' where id='${GU}';`)
  sql(`${claims(GU, NEW)}select public.mark_password_changed();`)
  assert.equal(scalar(`select must_change_password from private.employee_accounts where employee_id='${G}';`), 'f')
  assert.equal(scalar("select count(*) from information_schema.columns where table_schema='private' and table_name='password_change_receipts' and column_name like '%password%';"), '0')
  scenarios.push('temporary password cannot complete its own first-login requirement and no credential is stored')
  sql(`update public.employees set status='inactive' where id='${G}';`)
  const inactive = JSON.parse(scalar(`${role('service_role')}select public.service_preview_employee_password_changes(${payload});`))
  assert.equal(inactive.eligibleCount, 0)
  assert.equal(inactive.excluded[0].reason, 'employee_not_active')
  sql(`update public.employees set status='active' where id='${G}';`)
  const future = `${payload}||jsonb_build_object('idempotencyKey','40000000-0000-4000-8000-000000000002','startsAt',now()+interval '1 hour','requestHash',repeat('b',64))`
  sql(`${role('service_role')}select public.service_require_employee_password_changes(${future});`)
  assert.equal(scalar(`${claims(GU, NEW)}select (public.get_password_change_requirement()->>'mustChangePassword')::boolean;`), 'f')
  const pendingId = scalar("select id from private.password_change_requirements where status='pending';")
  const cancel = `${payload}||jsonb_build_object('requirementId','${pendingId}','idempotencyKey','50000000-0000-4000-8000-000000000001')`
  sql(`${role('service_role')}select public.service_cancel_employee_password_change(${cancel});`)
  sql(`${role('service_role')}select public.service_cancel_employee_password_change(${cancel});`)
  assert.equal(scalar("select count(*) from private.password_change_requirements where status='canceled';"), '1')
  assert.equal(JSON.parse(scalar(`${role('service_role')}select public.service_list_employee_password_changes(${payload}||jsonb_build_object('employeeId','${G}'));`)).requirements.length, 2)
  scenarios.push('inactive accounts excluded, future activation honored, cancel and listing retain history')
  sql(`update auth.users set encrypted_password='changed-before-new-request' where id='${GU}';`)
  const third = `${payload}||jsonb_build_object('idempotencyKey','40000000-0000-4000-8000-000000000003','requestHash',repeat('c',64))`
  sql(`${role('service_role')}select public.service_require_employee_password_changes(${third});`)
  sql(`update auth.sessions set created_at=now() where id='${NEW}';`)
  assert.match(failSql(`${claims(GU, NEW)}select public.mark_password_changed_verified();`), /No completed credential change/)
  sql(`update auth.users set encrypted_password='changed-after-new-request' where id='${GU}';`)
  sql(`${claims(GU, NEW)}select public.mark_password_changed_verified();`)
  scenarios.push('a password change before the request cannot satisfy a later requirement')
  assert.equal(scalar(`select role from public.employees where id='${G}';`), 'guard')
  assert.equal(scalar('select count(*) from auth.sessions;'), '3')
  scenarios.push('roles and prior auth sessions preserved')
  if (adminPasswordPath) {
    sql(readFileSync(canonicalOnly ? adminPasswordPath : resolve(adminPasswordPath), 'utf8'))
    assert(canonicalOnly || passwordBoundaryPath, 'Cross-app regression requires the matching access-boundary migration')
    const suite = await import('./admin-password-set-regression-cases.mjs')
    const fixture = {sql, asyncSql, scalar, failSql, claims, role, A, G, AU, GU, AS, OLD, NEW, scenarios, crossAppProjectionTested: Boolean(projectionPath)}
    const partialRequest = `jsonb_build_object('actorEmployeeId','${A}','actorAuthSessionId','${AS}','recentMfaAt',clock_timestamp(),'mfaMethod','authenticator',
      'employeeId','${G}','confirmationUsername','guard','reason','Synthetic partial-deployment boundary test','idempotencyKey','80000000-0000-4000-8000-000000000001',
      'requestHash',repeat('a',64),'requireChangeAtNextLogin',true)`
    assert.match(failSql(`${role('service_role')}select public.service_begin_employee_password_set(${partialRequest});`), /Install the individual password access boundary/)
    if (canonicalOnly) {
      // The owning repository's CI verifies its SQL against an explicit local
      // prerequisite contract, not a vendored copy of Sygilant's migration.
      // Actual cross-app boundary coverage remains a separate combined run.
      sql('create function private.assert_individual_password_boundary() returns void language plpgsql as $$begin return;end$$;')
    } else suite.installAdminPasswordBoundaryFixture(fixture, readFileSync(resolve(passwordBoundaryPath), 'utf8'))
    suite.runAdminPasswordSetRegression(fixture)
    if (!canonicalOnly) suite.runAdminPasswordBoundaryRegression(fixture)
    await suite.runAdminPasswordCancellationRaces(fixture)
  }
  console.log(JSON.stringify({ passed: true, syntheticOnly: true, productionConnections: 0, canonicalBoundaryContractFixture: canonicalOnly, crossAppProjectionTested: Boolean(projectionPath), adminPasswordSetTested: Boolean(adminPasswordPath), crossAppPasswordBoundaryTested: Boolean(passwordBoundaryPath), scenarios }, null, 2))
} catch (error) {
  rehearsalFailure = error
  throw error
} finally {
  stopIsolatedPostgres({ data, run, started, priorError: rehearsalFailure })
}
