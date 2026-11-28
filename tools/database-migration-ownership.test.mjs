import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildOwnershipManifest, readSourceTree, verifyOwnershipBaseline } from './database-migration-ownership.mjs'

const source = (owner, version, name, disposition = 'requires-ledger-reconciliation') => ({ owner, version, name, disposition, filename: `${version}_${name}.sql`, normalizedSourceSha256: 'a'.repeat(64) })
const manifest = (ledgerRows, sources) => buildOwnershipManifest({ ledgerRows, sources, capturedAt: '2026-10-19T00:00:00Z', ledgerSha256: 'test' })

test('version/name disagreement does not authorize replay or claim SQL equivalence', () => {
  const result = manifest([{ version: '22', name: 'client_fix', statements: ['select 1'] }], [source('Sygilant', '11', 'client_fix')])
  assert.equal(result.entries[0].sourceMatch, 'name-matches-different-version')
  assert.equal(result.entries[0].owner, 'Sygilant')
  assert.equal(result.entries[0].replayAuthorization, 'none-no-bulk-push')
  assert.equal(result.localSources[0].disposition, 'local-version-differs-from-applied-version-do-not-replay')
})

test('missing statement source stays blocked and multiple possible owners require review', () => {
  const result = manifest([{ version: '11', name: 'shared', statements: [] }], [source('SygShift', '11', 'shared'), source('Sygilant', '11', 'shared')])
  assert.equal(result.entries[0].recoveryStatus, 'missing-statement-source-blocked')
  assert.equal(result.entries[0].owner, 'unassigned-shared-ownership-review')
  assert.equal(result.summary.missingStatementArrays, 1)
})

test('withdrawn cross-project source remains explicitly forbidden when absent from production', () => {
  const result = manifest([], [source('Sygilant', '202609020003', 'external_mfa_assurances', 'withdrawn-cross-project-assurance-do-not-apply')])
  assert.equal(result.localSources[0].disposition, 'withdrawn-cross-project-assurance-do-not-apply')
  assert.equal(result.summary.withdrawnCrossProjectSources, 1)
})

test('duplicated production versions fail rather than resolving silently', () => {
  assert.throws(() => manifest([{ version: '11', statements: [] }, { version: '11', statements: [] }], []), /duplicated version/u)
})

test('documented source ownership does not conceal a different shared database boundary owner', () => {
  const result = buildOwnershipManifest({
    ledgerRows: [{ version: '11', name: 'shared_consumer', statements: ['select 1'] }],
    sources: [source('SygShift', '11', 'shared_consumer'), source('Sygilant', '11', 'shared_consumer')],
    ownershipDecisions: { 11: { sourceOwner: 'Sygilant', databaseBoundaryOwner: 'SygShift', evidence: ['owning release record'] } },
  })
  assert.equal(result.entries[0].owner, 'Sygilant')
  assert.equal(result.entries[0].ownershipDecision.databaseBoundaryOwner, 'SygShift')
})

test('exact reviewed baseline passes nondrift verification while denying history-equivalence and bulk-push claims', () => {
  const reviewed = manifest([{ version: '11', name: 'client_fix', statements: ['select 1'] }], [source('Sygilant', '11', 'client_fix')])
  const current = structuredClone(reviewed)
  current.localSources[0].path = 'D:/a-portable-checkout/supabase/migrations/11_client_fix.sql'
  reviewed.localSources[0].path = 'C:/another-checkout/supabase/migrations/11_client_fix.sql'
  const result = verifyOwnershipBaseline(current, reviewed)
  assert.equal(result.accepted, true)
  assert.equal(result.claimsHistoryEquivalence, false)
  assert.equal(result.bulkMigrationPushAuthorized, false)
})

test('changed SQL with the same applied version and name fails the reviewed baseline gate', () => {
  const sources = [source('Sygilant', '11', 'client_fix')]
  const reviewed = manifest([{ version: '11', name: 'client_fix', statements: ['select 1'] }], sources)
  const current = manifest([{ version: '11', name: 'client_fix', statements: ['select 2'] }], sources)
  assert.equal(verifyOwnershipBaseline(current, reviewed).accepted, false)
  assert.match(verifyOwnershipBaseline(current, reviewed).driftErrors.join('\n'), /statement-array checksum changed/u)
})

test('NULL and empty applied statement arrays are distinct exact-ledger states', () => {
  const sources = [source('SygShift', '11', 'one')]
  const reviewed = manifest([{ version: '11', name: 'one', statements: null }], sources)
  const current = manifest([{ version: '11', name: 'one', statements: [] }], sources)
  assert.equal(reviewed.formatVersion, 2)
  assert.equal(reviewed.entries[0].statementCount, 0)
  assert.equal(current.entries[0].statementCount, 0)
  assert.equal(reviewed.entries[0].statementArrayState, 'null')
  assert.equal(current.entries[0].statementArrayState, 'array')
  assert.notEqual(reviewed.entries[0].statementArraySha256, current.entries[0].statementArraySha256)
  assert.equal(verifyOwnershipBaseline(current, reviewed).accepted, false)
  assert.match(verifyOwnershipBaseline(current, reviewed).driftErrors.join('\n'), /statement-array checksum changed/u)
})

test('legacy baseline cannot silently claim exact NULL versus empty array equivalence', () => {
  const reviewed = manifest([{ version: '11', name: 'one', statements: null }], [source('SygShift', '11', 'one')])
  const current = structuredClone(reviewed)
  reviewed.formatVersion = 1
  assert.throws(() => verifyOwnershipBaseline(current, reviewed), /requires a reviewed format v2 baseline/u)
})

test('removed or newly applied versions fail without silently accepting the new ledger', () => {
  const sources = [source('SygShift', '11', 'one'), source('SygShift', '22', 'two')]
  const reviewed = manifest([{ version: '11', name: 'one', statements: ['select 1'] }], sources)
  const removed = manifest([], sources)
  const added = manifest([{ version: '11', name: 'one', statements: ['select 1'] }, { version: '22', name: 'two', statements: ['select 2'] }], sources)
  assert.match(verifyOwnershipBaseline(removed, reviewed).driftErrors.join('\n'), /Applied version removed/u)
  assert.match(verifyOwnershipBaseline(added, reviewed).driftErrors.join('\n'), /Unreviewed applied version added/u)
})

test('owning-source checksum changes fail by owner and filename rather than absolute path', () => {
  const reviewed = manifest([{ version: '11', name: 'one', statements: ['select 1'] }], [source('SygShift', '11', 'one')])
  const current = structuredClone(reviewed)
  current.localSources[0].normalizedSourceSha256 = 'b'.repeat(64)
  assert.match(verifyOwnershipBaseline(current, reviewed).driftErrors.join('\n'), /Owning-source checksum changed: SygShift\/11_one.sql/u)
})

test('require-reconciled refuses an exact nondrift baseline with timestamp gaps or empty applied statements', () => {
  const current = manifest([{ version: '22', name: 'one', statements: [] }], [source('SygShift', '11', 'one')])
  const result = verifyOwnershipBaseline(current, current, { requireReconciled: true })
  assert.equal(result.accepted, false)
  assert.equal(result.driftErrors.length, 0)
  assert.match(result.reconciliationErrors.join('\n'), /timestamp difference/u)
  assert.match(result.reconciliationErrors.join('\n'), /Empty applied statement array/u)
})

test('a changed applied name fails even when SQL and version are identical', () => {
  const reviewed = manifest([{ version: '11', name: 'one', statements: ['select 1'] }], [source('SygShift', '11', 'one')])
  const current = structuredClone(reviewed)
  current.entries[0].name = 'renamed'
  assert.match(verifyOwnershipBaseline(current, reviewed).driftErrors.join('\n'), /Applied migration name changed/u)
})

function scanFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sygshift-migration-ownership-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true })
  return root
}

test('the audit recognizes separately governed hosted HR SQL as a Sygilant owning source', (t) => {
  const root = scanFixture(t)
  const sql = 'select 1;\n'
  writeFileSync(join(root, 'supabase', 'migrations', '11_one.sql'), sql)
  assert.deepEqual(readSourceTree(root, 'Sygilant').map(({ filename }) => filename), ['11_one.sql'])

  const version = '20261127000224'
  const name = 'guided_hr_required_employee_response'
  const filename = version + '_' + name + '.sql'
  const canonical = join(root, 'supabase', 'guided-hr-canonical')
  mkdirSync(canonical)
  const canonicalPath = join(canonical, filename)
  writeFileSync(canonicalPath, sql)
  const rows = [{ version, name, statements: [sql] }]
  const reviewed = manifest(rows, readSourceTree(root, 'Sygilant'))
  assert.equal(reviewed.entries[0].owner, 'Sygilant')
  assert.equal(reviewed.entries[0].sourceMatch, 'exact-version-and-name')
  assert.equal(reviewed.entries[0].sourceCandidates[0].path, canonicalPath)
  assert.equal(reviewed.entries[0].replayAuthorization, 'none-no-bulk-push')
  assert.equal(verifyOwnershipBaseline(reviewed, reviewed).accepted, true)

  writeFileSync(canonicalPath, 'select 2;\n')
  const changed = manifest(rows, readSourceTree(root, 'Sygilant'))
  assert.deepEqual(verifyOwnershipBaseline(changed, reviewed).driftErrors, [
    'Owning-source checksum changed: Sygilant/' + filename,
  ])
})

test('only Sygilant scans the exact canonical HR directory without traversing other folders', (t) => {
  const root = scanFixture(t)
  for (const [directory, file] of [
    ['migrations', '11_one.sql'],
    ['guided-hr-canonical', '22_canonical.sql'],
    ['guided-hr-canonical/nested', '33_nested.sql'],
    ['other-shared-sql', '44_unreviewed.sql'],
  ]) {
    const folder = join(root, 'supabase', directory)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, file), 'select 1;\n')
  }
  assert.deepEqual(readSourceTree(root, 'SygShift').map(({ filename }) => filename), ['11_one.sql'])
  assert.deepEqual(readSourceTree(root, 'Sygilant').map(({ filename }) => filename), ['11_one.sql', '22_canonical.sql'])
})
