import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { pathToFileURL } from 'node:url'

// Generates reviewed artifacts only; never connects to a database or Auth.
const expectedFunctions = [
  ['public.get_effective_permissions()', 'cb47e2a167b4e3972b1a344ec1153d45', 's'],
  ['public.get_session_context_emergency()', '7f923c0f2fb6166c66a985651c83d829', 's'],
  ['public.mark_password_changed()', 'e297d01a24dc201aa40433c1e6e0f00e', 'v'],
  ['public.sygilant_emergency_access_pre_request()', 'b85e75a99a87f4b91cc632a7d8f3ce79', 's'],
]
const identity = [
  ['shift', '20261109154616', 'password_change_requirements_and_verified_completion'],
  ['hub', '20261109155422', 'password_change_session_projection'],
  ['shift', '20261109182242', 'admin_chosen_password_next_login'],
  ['hub', '20261109182407', 'individual_password_change_access_boundary'],
]
const hash = text => createHash('sha256').update(text).digest('hex')
const maximumMigrationBytes = 32 * 1024 * 1024

export function normalizeMigrationBytes(bytes) {
  assert(bytes instanceof Uint8Array, 'Migration source must be UTF-8 bytes')
  assert(bytes.byteLength <= maximumMigrationBytes, 'Migration exceeds the 32 MiB safety limit')
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  assert(!source.startsWith('\uFEFF'), 'Migration must not contain a UTF-8 byte-order mark')
  assert(!source.includes('\u0000'), 'Migration contains a NUL byte')
  const normalized = source.replaceAll('\r\n', '\n')
  assert(!normalized.includes('\r'), 'Migration contains a bare carriage return')
  assert(normalized.trim(), 'Migration is empty')
  assert(normalized.trimEnd().endsWith(';'), 'Migration must end with a semicolon')
  return normalized
}

export async function prepareManualPasswordRelease({ shiftRoot, hubRoot, ledgerMd5, outputDirectory }) {
  assert.match(ledgerMd5, /^[0-9a-f]{32}$/u, 'Supply the freshly captured production migration-ledger MD5')
  for (const [name, value] of Object.entries({ shiftRoot, hubRoot, outputDirectory })) {
    assert(typeof value === 'string' && isAbsolute(value), `${name} must be an explicit absolute path`)
  }
  const { fingerprintMigration, renderActivationBatch, splitAndTrimStatements } = await import(
    pathToFileURL(join(hubRoot, 'scripts/render-supabase-migration-activation.mjs')).href
  )
  const bodies = []
  const sources = []
  for (const [owner, version, name] of identity) {
    const filePath = join(owner === 'shift' ? shiftRoot : hubRoot, 'supabase/migrations', `${version}_${name}.sql`)
    assert(statSync(filePath).isFile(), 'Migration source must be a regular file')
    const source = normalizeMigrationBytes(readFileSync(filePath))
    const fingerprint = fingerprintMigration(source)
    const rendered = renderActivationBatch({ filePath, source, expectedVersion: version, expectedName: name,
      expectedSourceHash: fingerprint.sourceHash, expectedLedgerHash: fingerprint.ledgerHash,
      expectedStatementCount: fingerprint.statementCount })
    // The existing renderer validates exactly one BEGIN/body/COMMIT envelope.
    // Combine those checked bodies beneath one outer transaction, never four.
    const statements = splitAndTrimStatements(rendered)
    assert.match(statements[0], /\bbegin\s*$/iu)
    assert.match(statements.at(-1), /^commit$/iu)
    bodies.push(statements.slice(1, -1).map(statement => `${statement};`).join('\n\n'))
    sources.push({ owner, version, name, sourceSha256: fingerprint.sourceHash,
      ledgerSha256: fingerprint.ledgerHash, statementCount: fingerprint.statementCount })
  }
  const functionChecks = expectedFunctions.map(([signature, sourceMd5, volatility]) => `
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid=to_regprocedure('${signature}')
      and pg_catalog.pg_get_userbyid(p.proowner)='postgres'
      and p.prosecdef and p.provolatile='${volatility}'
      and 'search_path=""'=any(coalesce(p.proconfig,array[]::text[]))
      and md5(regexp_replace(p.prosrc,'[[:space:]]+','','g'))='${sourceMd5}'
  ) then
    raise object_not_in_prerequisite_state using message='Password release stopped: ${signature} changed since review.';
  end if;`).join('\n')
  const prefix = `begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $password_release_preflight$
begin
  if (select md5(coalesce(jsonb_agg(to_jsonb(m) order by version)::text,'[]'))
      from supabase_migrations.schema_migrations m) <> '${ledgerMd5}' then
    raise object_not_in_prerequisite_state using message='Password release stopped: migration ledger changed since review.';
  end if;
${functionChecks}
end;
$password_release_preflight$;
`
  const suffix = `
do $password_release_postflight$
begin
  if (select md5(coalesce(jsonb_agg(to_jsonb(m) order by version)::text,'[]'))
      from supabase_migrations.schema_migrations m
      where version not in (${identity.map(([, version]) => `'${version}'`).join(',')})) <> '${ledgerMd5}'
    or (select count(*) from supabase_migrations.schema_migrations
      where version in (${identity.map(([, version]) => `'${version}'`).join(',')})) <> ${identity.length} then
    raise check_violation using message='Password release changed prior migration history or did not record all four owned migrations.';
  end if;
  perform private.assert_individual_password_boundary();
  if (select enabled from private.password_change_feature_config where singleton) is distinct from false
    or exists(select 1 from private.admin_password_set_operations)
    or exists(select 1 from private.password_change_requirements) then
    raise check_violation using message='Password release must start with campaigns off and no employee enrollment.';
  end if;
end;
$password_release_postflight$;
`
  const content = `${prefix}\n${bodies.join('\n\n')}\n${suffix}`
  const install = `${content}\ncommit;\n`
  const rehearsal = `${content}\nrollback;\n`
  const manifest = { capturedLedgerMd5: ledgerMd5, expectedFunctions, sources,
    installSha256: hash(install), rehearsalSha256: hash(rehearsal),
    scope: 'Manual employee password only. No emails, credentials, employee enrollment, or campaign activation.' }
  mkdirSync(outputDirectory, { recursive: true })
  writeFileSync(join(outputDirectory, 'install.sql'), install)
  writeFileSync(join(outputDirectory, 'rehearsal.sql'), rehearsal)
  writeFileSync(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [shiftRoot, hubRoot, ledgerMd5, outputDirectory] = process.argv.slice(2)
  assert(shiftRoot && hubRoot && outputDirectory, 'Expected SygShift root, Sygilant root, ledger MD5 and output directory')
  console.log(JSON.stringify(await prepareManualPasswordRelease({ shiftRoot: resolve(shiftRoot), hubRoot: resolve(hubRoot), ledgerMd5, outputDirectory: resolve(outputDirectory) }), null, 2))
}
