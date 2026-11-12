import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyRepairAdditions, verifyHistoryRepairBaseline } from './capture-history-repair-baseline.mjs'

function fixture() {
  const entries = Array.from({ length: 460 }, (_, n) => ({ version: String(n + 1), name: `old_${n}`, owner: 'SygShift', statementArraySha256: `array${n}` }))
  const localSources = entries.map(item => ({ owner: item.owner, filename: `${item.version}_${item.name}.sql`, normalizedSourceSha256: `source${item.version}` }))
  const reviewed = { formatVersion: 2, entries, localSources }
  const proofs = new Map()
  const addedSources = historyRepairAdditions.map((item, n) => ({ ...item, filename: `${item.version}_${item.name}.sql`, normalizedSourceSha256: `new${n}` }))
  const added = historyRepairAdditions.map((item, n) => {
    proofs.set(item.version, { sourceHash: `new${n}`, ledgerHash: `sql${n}`, statementCount: n + 1 })
    return { ...item, sourceMatch: 'exact-version-and-name', statementArrayState: 'array', statementCount: n + 1,
      orderedStatementsSha256: `sql${n}`, sourceCandidates: [addedSources[n]] }
  })
  return { reviewed, proofs, current: structuredClone({ formatVersion: 2, entries: [...entries, ...added], localSources: [...localSources, ...addedSources] }) }
}

test('admits only the two exact read-only repairs while preserving all historical evidence', () => {
  const { current, reviewed, proofs } = fixture()
  assert.equal(verifyHistoryRepairBaseline(current, reviewed, proofs).appliedCount, 462)
})
for (const [name, change] of [
  ['old SQL checksum', current => { current.entries[0].statementArraySha256 = 'changed' }],
  ['old owning source', current => { current.localSources[0].normalizedSourceSha256 = 'changed' }],
  ['new identity', current => { current.entries[460].version = 'unapproved' }],
  ['new SQL body', current => { current.entries[460].orderedStatementsSha256 = 'changed' }],
  ['new source body', current => { current.entries[460].sourceCandidates[0].normalizedSourceSha256 = 'changed' }],
  ['unreviewed local source', current => { current.localSources.push({ owner: 'SygShift', filename: 'rogue.sql', normalizedSourceSha256: 'rogue' }) }],
]) test(`rejects drift in ${name}`, () => {
  const { current, reviewed, proofs } = fixture()
  change(current)
  assert.throws(() => verifyHistoryRepairBaseline(current, reviewed, proofs))
})
