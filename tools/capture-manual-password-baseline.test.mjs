import assert from 'node:assert/strict'
import test from 'node:test'
import { approvedManualPasswordAdditions, approvedManualPasswordNormalizerAdditions, verifyManualPasswordBaselineAddition, verifyManualPasswordNormalizerBaselineAddition } from './capture-manual-password-baseline.mjs'

function fixture() {
  const source = { owner: 'SygShift', filename: '20260101000000_old.sql', normalizedSourceSha256: 'old-source' }
  const entries = Array.from({ length: 450 }, (_, index) => ({ version: `1${String(index).padStart(11, '0')}`, name: `old_${index}`, owner: 'SygShift', statementArraySha256: `old-${index}` }))
  const reviewed = { formatVersion: 2, entries, localSources: [source] }
  const fingerprints = new Map(approvedManualPasswordAdditions.map((item, index) => [item.version, { statementCount: 3, ledgerHash: `ledger-${index}`, sourceHash: `source-${index}` }]))
  const added = approvedManualPasswordAdditions.map((item, index) => ({ ...item, sourceMatch: 'exact-version-and-name', statementArrayState: 'array', statementCount: 3,
    statementArraySha256: `array-${index}`, orderedStatementsSha256: `ledger-${index}`, sourceCandidates: [{ owner: item.owner, filename: `${item.version}_${item.name}.sql`, normalizedSourceSha256: `source-${index}` }] }))
  const current = { formatVersion: 2, entries: [...entries.map(entry => ({ ...entry })), ...added], localSources: [{ ...source }, ...added.map(entry => ({ ...entry.sourceCandidates[0], version: entry.version, name: entry.name }))] }
  return { current, reviewed, fingerprints }
}
test('admits exactly the six reviewed additions and preserves old source checksums', () => {
  const f = fixture(); const result = verifyManualPasswordBaselineAddition(f.current, f.reviewed, f.fingerprints)
  assert.equal(result.appliedCount, 456); assert.equal(result.added.length, 6); assert.equal(result.historicalEntriesPreserved, true)
})
test('refuses old applied statement drift', () => {
  const f = fixture(); f.current.entries[0].statementArraySha256 = 'changed'
  assert.throws(() => verifyManualPasswordBaselineAddition(f.current, f.reviewed, f.fingerprints), /Historical baseline changed/)
})
test('refuses old owning source drift', () => {
  const f = fixture(); f.current.localSources[0].normalizedSourceSha256 = 'changed'
  assert.throws(() => verifyManualPasswordBaselineAddition(f.current, f.reviewed, f.fingerprints), /Historical baseline changed/)
})
test('refuses missing or unapproved migration additions', () => {
  const f = fixture(); f.current.entries.pop()
  assert.throws(() => verifyManualPasswordBaselineAddition(f.current, f.reviewed, f.fingerprints), /All six/)
  const other = fixture(); other.current.entries.at(-1).name = 'unapproved'
  assert.throws(() => verifyManualPasswordBaselineAddition(other.current, other.reviewed, other.fingerprints), /Unapproved applied migration/)
})
test('refuses newly applied SQL that differs from its owning source', () => {
  const f = fixture(); f.current.entries.at(-1).orderedStatementsSha256 = 'changed'
  assert.throws(() => verifyManualPasswordBaselineAddition(f.current, f.reviewed, f.fingerprints), /Applied SQL differs/)
})
test('refuses unreviewed local source additions', () => {
  const f = fixture(); f.current.localSources.push({ owner: 'Sygilant', filename: '999_unapproved.sql', version: '999', name: 'unapproved', normalizedSourceSha256: 'new' })
  assert.throws(() => verifyManualPasswordBaselineAddition(f.current, f.reviewed, f.fingerprints), /Unreviewed owning source addition/)
})

function normalizerFixture() {
  const previous = fixture().current
  const item = approvedManualPasswordNormalizerAdditions[0]
  const source = { owner: item.owner, filename: `${item.version}_${item.name}.sql`, version: item.version, name: item.name, normalizedSourceSha256: 'normalizer-source' }
  const entry = { ...item, sourceMatch: 'exact-version-and-name', statementArrayState: 'array', statementCount: 3,
    statementArraySha256: 'normalizer-array', orderedStatementsSha256: 'normalizer-ledger', sourceCandidates: [source] }
  return { reviewed: previous,
    current: { formatVersion: 2, entries: [...structuredClone(previous.entries), entry], localSources: [...structuredClone(previous.localSources), source] },
    fingerprints: new Map([[item.version, { statementCount: 3, ledgerHash: 'normalizer-ledger', sourceHash: 'normalizer-source' }]]) }
}
test('normalizer mode preserves all 456 prior entries and admits only the one reviewed repair', () => {
  const f = normalizerFixture()
  const result = verifyManualPasswordNormalizerBaselineAddition(f.current, f.reviewed, f.fingerprints)
  assert.equal(result.oldAppliedCount, 456); assert.equal(result.appliedCount, 457)
  assert.equal(result.added.length, 1); assert.equal(result.added[0].version, '20261109204156')
})
test('normalizer mode refuses any prior manual-password ledger or source drift', () => {
  const f = normalizerFixture(); f.current.entries[455].statementArraySha256 = 'drift'
  assert.throws(() => verifyManualPasswordNormalizerBaselineAddition(f.current, f.reviewed, f.fingerprints), /Historical baseline changed/)
  const source = normalizerFixture(); source.current.localSources[2].normalizedSourceSha256 = 'drift'
  assert.throws(() => verifyManualPasswordNormalizerBaselineAddition(source.current, source.reviewed, source.fingerprints), /Historical baseline changed/)
})
test('normalizer mode refuses another migration or changed normalizer SQL', () => {
  const f = normalizerFixture(); f.current.entries.at(-1).name = 'different_repair'
  assert.throws(() => verifyManualPasswordNormalizerBaselineAddition(f.current, f.reviewed, f.fingerprints), /Unapproved applied migration/)
  const sql = normalizerFixture(); sql.current.entries.at(-1).orderedStatementsSha256 = 'different-sql'
  assert.throws(() => verifyManualPasswordNormalizerBaselineAddition(sql.current, sql.reviewed, sql.fingerprints), /Applied SQL differs/)
})
test('normalizer mode cannot capture before the repair is applied or use the older 450 baseline', () => {
  const f = normalizerFixture(); f.current.entries.pop()
  assert.throws(() => verifyManualPasswordNormalizerBaselineAddition(f.current, f.reviewed, f.fingerprints), /Only the authorized normalizer/)
  const older = fixture()
  assert.throws(() => verifyManualPasswordNormalizerBaselineAddition(older.current, older.reviewed, older.fingerprints), /Unexpected prior baseline count/)
})
