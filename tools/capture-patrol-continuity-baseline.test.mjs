import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { verifyContinuityBaseline } from './capture-patrol-continuity-baseline.mjs'

const read = name => JSON.parse(readFileSync(new URL(`../docs/reliability/${name}`, import.meta.url), 'utf8'))
const plan = read('patrol-continuity-release-2026-11-18.json')
const previous = read(plan.priorBaseline)
const observed = read('migration-ownership-2026-11-18-continuity-consumers-v4.json')
// Model the pending phase with the reviewed current sources, without relabeling
// the separately retained, observed 467-entry production capture as a prior state.
const current = { ...observed, entries: observed.entries.filter(entry => previous.entries.some(old => old.version === entry.version)) }

test('accepts the observed consumer phase with the final pending activation source', () => {
  assert.equal(verifyContinuityBaseline(observed, previous, plan, 'consumers').appliedCount, 467)
})

test('accepts only the exact unchanged predecessor and three reviewed pending sources', () => {
  assert.equal(verifyContinuityBaseline(current, previous, plan, 'before').appliedCount, 465)
})

test('rejects historical ledger and source changes', () => {
  const ledger = structuredClone(current)
  ledger.entries[0].name += '_drift'
  assert.throws(() => verifyContinuityBaseline(ledger, previous, plan, 'before'))
  const source = structuredClone(current)
  source.localSources[0].normalizedSourceSha256 = '0'.repeat(64)
  assert.throws(() => verifyContinuityBaseline(source, previous, plan, 'before'))
})

test('rejects changed new sources and unapproved activation phases', () => {
  const source = structuredClone(current)
  source.localSources.find(item => item.filename === plan.targets[0].file).normalizedSourceSha256 = '0'.repeat(64)
  assert.throws(() => verifyContinuityBaseline(source, previous, plan, 'before'))
  assert.throws(() => verifyContinuityBaseline(current, previous, plan, 'complete'))
  assert.throws(() => verifyContinuityBaseline(current, previous, plan, 'unknown'))
})

test('requires the exact statement array, not only an equivalent joined SQL checksum', () => {
  const target = plan.targets[0]
  const withFoundation = structuredClone(current)
  const source = current.localSources.find(item => item.filename === target.file)
  withFoundation.entries.push({ version: target.version, owner: target.owner, name: target.name, sourceMatch: 'exact-version-and-name', statementArrayState: 'array', statementCount: target.statementCount, orderedStatementsSha256: target.ledgerHash, statementArraySha256: target.statementArrayHash, sourceCandidates: [source] })
  assert.equal(verifyContinuityBaseline(withFoundation, previous, plan, 'foundation').appliedCount, 466)
  withFoundation.entries.at(-1).statementArraySha256 = '0'.repeat(64)
  assert.throws(() => verifyContinuityBaseline(withFoundation, previous, plan, 'foundation'))
})
