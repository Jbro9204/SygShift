import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { validateGeneratedTransaction } from './sql-transaction-boundary.mjs'

export const authBanRepairBusinessRelations = Object.freeze([
  'public.schedules', 'public.shifts', 'public.shift_assignments', 'public.time_events',
  'public.time_event_corrections', 'private.payroll_export_batches',
  'private.payroll_export_rows', 'private.payroll_batch_assignments',
])
const project = 'eqkdfrbwtioiqtjsyglg'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const sha = /^[0-9a-f]{64}$/u
const digest = (value) => createHash('sha256').update(value).digest('hex')
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const iso = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

export function validateAuthBanRepairManifest(input) {
  if (!input || input.formatVersion !== 1 || input.targetProject !== project || !uuid.test(input.requestId ?? '')) throw new Error('Invalid repair manifest identity.')
  if (!iso(input.capturedAt) || !iso(input.replacementBannedUntil)
    || Date.parse(input.replacementBannedUntil) - Date.parse(input.capturedAt) !== 876_000 * 3_600_000) throw new Error('Capture one finite expiration exactly 876000 hours after the manifest time.')
  if (typeof input.reason !== 'string' || input.reason.trim().length < 12 || input.reason.trim().length > 1000 || /[\u0000-\u001f]/u.test(input.reason)) throw new Error('A clear repair reason is required.')
  if (input.reason.includes('$auth_ban_serialization_repair$')) throw new Error('The repair reason cannot contain the SQL block delimiter.')
  if (input.expectedCount !== 1 || !Array.isArray(input.affectedRows) || input.affectedRows.length !== 1) throw new Error('This reviewed repair requires exactly one affected account.')
  const row = input.affectedRows[0]
  if (!row || !uuid.test(row.authUserId ?? '')) throw new Error('Invalid affected-account identity.')
  const keys = ['fullRowSha256', 'protectedRowSha256', 'accountRowSha256', 'employeeRowSha256', 'centralAuthorityRowSha256']
  for (const key of keys) if (!sha.test(row[key] ?? '')) throw new Error('Exact protected-row fingerprints are required.')
  const business = {}
  for (const relation of authBanRepairBusinessRelations) {
    const item = input.businessFingerprints?.[relation]
    if (!item || !Number.isSafeInteger(item.rows) || item.rows < 0 || !sha.test(item.sha256 ?? '')) throw new Error('The reviewed business snapshot is incomplete.')
    business[relation] = { rows: item.rows, sha256: item.sha256 }
  }
  return { formatVersion: 1, targetProject: project, requestId: input.requestId.toLowerCase(), capturedAt: input.capturedAt,
    reason: input.reason.trim(), replacementBannedUntil: input.replacementBannedUntil, expectedCount: 1,
    affectedRows: [{ authUserId: row.authUserId.toLowerCase(), ...Object.fromEntries(keys.map((key) => [key, row[key]])) }],
    businessFingerprints: business }
}

export function authBanRepairManifestSha256(input) { return digest(JSON.stringify(validateAuthBanRepairManifest(input))) }

const hashSql = (expression) => `encode(sha256(convert_to(${expression},'UTF8')),'hex')`
const rowHashSql = (alias) => hashSql(`coalesce(to_jsonb(${alias})::text,'null')`)
const relatedRowsSql = (id) => `(select jsonb_build_object('account',${rowHashSql('account')},'employee',${rowHashSql('employee')},'central',${rowHashSql('authority')},'disabled',coalesce(account.disabled_at is not null,false))
 from auth.users auth_user left join private.employee_accounts account on account.auth_user_id=auth_user.id
 left join public.employees employee on employee.id=account.employee_id
 left join private.emergency_access_authority authority on authority.auth_user_id=auth_user.id where auth_user.id=${id})`

export function renderAuthBanSerializationRepairSql(input, { mode = 'rehearsal' } = {}) {
  if (!['rehearsal', 'activation'].includes(mode)) throw new Error('Choose rehearsal or activation explicitly.')
  const manifest = validateAuthBanRepairManifest(input)
  const manifestSha = authBanRepairManifestSha256(manifest)
  const target = manifest.affectedRows[0]
  const id = `${quote(target.authUserId)}::uuid`
  const others = `(select jsonb_build_object('rows',count(*),'sha256',${hashSql("coalesce(string_agg(row_hash,'' order by row_hash),'')")}) from (select ${rowHashSql('auth_user')} as row_hash from auth.users auth_user where auth_user.id<>${id}) hashes)`
  const writeSet = `(select coalesce(jsonb_object_agg(relid::text,jsonb_build_object('inserted',n_tup_ins,'updated',n_tup_upd,'deleted',n_tup_del)),'{}'::jsonb) from pg_stat_xact_user_tables where n_tup_ins<>0 or n_tup_upd<>0 or n_tup_del<>0)`
  const expectedWriteSet = `jsonb_build_object(('auth.users'::regclass::oid)::text,jsonb_build_object('inserted',0,'updated',1,'deleted',0),('private.audit_events'::regclass::oid)::text,jsonb_build_object('inserted',1,'updated',0,'deleted',0))`
  const sql = `-- Operational repair only. No migration, schema change, account restoration, or database connection is performed by the renderer.
begin;
set transaction isolation level repeatable read;
set local lock_timeout='2s';
set local statement_timeout='5s';
do $auth_ban_serialization_repair$
declare
  request_id_constant constant text := ${quote(manifest.requestId)};
  replacement constant timestamptz := ${quote(manifest.replacementBannedUntil)}::timestamptz;
  expected_after constant jsonb := ${quote(JSON.stringify({ banned_until: manifest.replacementBannedUntil, reason: manifest.reason, requestId: manifest.requestId, manifestSha256: manifestSha }))}::jsonb;
  observed_auth auth.users%rowtype;
  related_before jsonb;
  related_after jsonb;
  others_before jsonb;
  receipt private.audit_events%rowtype;
  receipt_count bigint;
  affected_count bigint;
  locked_employee uuid;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('auth-ban-serialization-repair:'||request_id_constant,0)) then
    raise exception 'Another execution of this repair request is active.';
  end if;
  if (select count(*) from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal)<>0
    or (select count(*) from pg_trigger where tgrelid='private.audit_events'::regclass and not tgisinternal)<>0 then
    raise exception 'Unreviewed Auth or audit triggers require a new review.';
  end if;
  select * into strict observed_auth from auth.users where id=${id} for update nowait;
  select employee_id into strict locked_employee from private.employee_accounts
    where auth_user_id=${id} and disabled_at is not null for share nowait;
  related_before := ${relatedRowsSql(id)};
  if related_before->>'account' is distinct from ${quote(target.accountRowSha256)}
    or related_before->>'employee' is distinct from ${quote(target.employeeRowSha256)}
    or related_before->>'central' is distinct from ${quote(target.centralAuthorityRowSha256)}
    or related_before->>'disabled' is distinct from 'true'
    or ${hashSql("(to_jsonb(observed_auth)-'banned_until')::text")} is distinct from ${quote(target.protectedRowSha256)} then
    raise exception 'The protected account context changed; capture and review new evidence.';
  end if;
  select count(*) into receipt_count from private.audit_events where request_id=request_id_constant;
  if receipt_count>1 then raise exception 'The repair request has conflicting audit receipts.'; end if;
  if receipt_count=1 then
    select * into strict receipt from private.audit_events where request_id=request_id_constant;
    if receipt.schema_name is distinct from 'auth' or receipt.table_name is distinct from 'users'
      or receipt.operation is distinct from 'AUTH_BAN_SERIALIZATION_REPAIR'
      or receipt.row_id is distinct from ${quote(target.authUserId)}
      or receipt.old_record is distinct from '{"banned_until":"infinity"}'::jsonb
      or receipt.new_record is distinct from expected_after
      or observed_auth.banned_until is distinct from replacement
      or not isfinite(observed_auth.banned_until) or observed_auth.banned_until<=clock_timestamp() then
      raise exception 'The existing receipt does not match this exact completed repair.';
    end if;
    raise notice 'Auth ban serialization repair already applied; no change.';
    return;
  end if;
  select count(*) into affected_count from auth.users where banned_until is not null and not isfinite(banned_until);
  if affected_count<>1 or observed_auth.banned_until is distinct from 'infinity'::timestamptz
    or ${rowHashSql('observed_auth')} is distinct from ${quote(target.fullRowSha256)} then
    raise exception 'The reviewed nonfinite-ban cohort or exact target fingerprint changed.';
  end if;
  if not isfinite(replacement) or replacement<clock_timestamp()+interval '875999 hours' then
    raise exception 'The captured finite ban expiration is stale or outside the reviewed policy.';
  end if;
  if exists(select 1 from auth.users auth_user cross join lateral jsonb_each_text(to_jsonb(auth_user)) value
    join pg_attribute attribute on attribute.attrelid='auth.users'::regclass and attribute.attname=value.key
      and attribute.attnum>0 and not attribute.attisdropped and attribute.atttypid in ('timestamp'::regtype,'timestamptz'::regtype)
    where value.key<>'banned_until' and value.value in ('infinity','-infinity')) then
    raise exception 'Another Auth timestamp contains an unreviewed nonfinite value.';
  end if;
  -- These are this backend's current-transaction counters, not global statistics.
  -- Concurrent employee clock/schedule writes are outside this write footprint.
  if ${writeSet} is distinct from '{}'::jsonb then
    raise exception 'The repair transaction already contains an unreviewed write.';
  end if;
  others_before := ${others};
  update auth.users set banned_until=replacement where id=${id} and banned_until='infinity'::timestamptz;
  get diagnostics affected_count=row_count;
  if affected_count<>1 then raise exception 'The repair did not update exactly one reviewed ban.'; end if;
  select * into strict observed_auth from auth.users where id=${id};
  related_after := ${relatedRowsSql(id)};
  if observed_auth.banned_until is distinct from replacement or not isfinite(observed_auth.banned_until)
    or observed_auth.banned_until<=clock_timestamp()
    or ${hashSql("(to_jsonb(observed_auth)-'banned_until')::text")} is distinct from ${quote(target.protectedRowSha256)}
    or related_after is distinct from related_before then
    raise exception 'The repair changed protected fields or independent access denial.';
  end if;
  insert into private.audit_events(request_id,schema_name,table_name,operation,row_id,old_record,new_record)
    values(request_id_constant,'auth','users','AUTH_BAN_SERIALIZATION_REPAIR',${quote(target.authUserId)},'{"banned_until":"infinity"}'::jsonb,expected_after)
    returning * into strict receipt;
  if receipt.schema_name is distinct from 'auth' or receipt.table_name is distinct from 'users'
    or receipt.operation is distinct from 'AUTH_BAN_SERIALIZATION_REPAIR'
    or receipt.request_id is distinct from request_id_constant or receipt.row_id is distinct from ${quote(target.authUserId)}
    or receipt.old_record is distinct from '{"banned_until":"infinity"}'::jsonb
    or receipt.new_record is distinct from expected_after or receipt.auth_user_id is not null or receipt.employee_id is not null
    or ${others} is distinct from others_before then
    raise exception 'Protected business, Auth, migration, or audit preservation failed.';
  end if;
  -- Transaction write-footprint postflight.
  if ${writeSet} is distinct from ${expectedWriteSet} then
    raise exception 'The transaction wrote outside the exact reviewed Auth and audit footprint.';
  end if;
  raise notice 'Auth ban serialization repair verified; access remains disabled and banned.';
end
$auth_ban_serialization_repair$;
${mode === 'activation' ? 'commit' : 'rollback'};
`
  validateGeneratedTransaction(sql, mode === 'activation' ? 'commit' : 'rollback', 'Auth ban serialization repair')
  return sql
}

function requireIgnoredPath(path) {
  const cwd = dirname(resolve(path))
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true })
  if (root.status !== 0 || spawnSync('git', ['check-ignore', '--quiet', '--', resolve(path)], { cwd: root.stdout.trim(), windowsHide: true }).status !== 0) throw new Error('Private manifests and SQL outputs must stay in an explicitly ignored artifact directory.')
}

function main() {
  const args = process.argv.slice(2)
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    if (!['--manifest', '--out', '--mode'].includes(args[index]) || !args[index + 1] || options.has(args[index])) throw new Error('Use --manifest path --out ignored.sql [--mode rehearsal|activation].')
    options.set(args[index], args[index + 1])
  }
  if (!options.get('--manifest') || !options.get('--out')) throw new Error('An ignored private manifest and ignored SQL output are required.')
  requireIgnoredPath(options.get('--manifest')); requireIgnoredPath(options.get('--out'))
  const manifest = validateAuthBanRepairManifest(JSON.parse(readFileSync(resolve(options.get('--manifest')), 'utf8')))
  const mode = options.get('--mode') ?? 'rehearsal'
  const sql = renderAuthBanSerializationRepairSql(manifest, { mode })
  writeFileSync(resolve(options.get('--out')), sql, { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ mode, output: resolve(options.get('--out')), manifestSha256: authBanRepairManifestSha256(manifest), databaseExecuted: false }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch { console.error('Auth ban repair preparation refused. Review the private manifest, output path, and mode. No database command ran.'); process.exitCode = 1 }
}
