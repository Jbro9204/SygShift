import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { buildPatrolRepairBaseline, capturePatrolRepairBaseline, parsePatrolBaselineArguments,
  patrolBaselineAdditions, patrolBaselineOutputName, patrolBaselineReview, patrolPriorBaseline,
  verifyPatrolRepairBaseline } from './capture-patrol-repair-baseline.mjs'

const root = resolve(import.meta.dirname, '..')
const digest = value => createHash('sha256').update(value).digest('hex')
const versions = {
  before: ['20261113162436'],
  'after-sygilant': ['20261113162436', '20261117181328'],
  'after-route': ['20261113162436', '20261117182334'],
  'after-both': ['20261113162436', '20261117181328', '20261117182334'],
}
function fixture(phase = 'after-both') {
  const reviewed = JSON.parse(readFileSync(join(root, 'docs/reliability', patrolPriorBaseline.filename), 'utf8'))
  const additions = patrolBaselineAdditions.map(item => ({ owner: item.owner, version: item.version, name: item.name,
    filename: `${item.version}_${item.name}.sql`, normalizedSourceSha256: item.sourceHash }))
  const entries = patrolBaselineAdditions.filter(item => versions[phase].includes(item.version)).map(item => ({
    owner: item.owner, version: item.version, name: item.name, sourceMatch: 'exact-version-and-name',
    statementArrayState: 'array', statementCount: item.statementCount, orderedStatementsSha256: item.ledgerHash,
    statementArraySha256: item.arrayHash, sourceCandidates: [additions.find(source => source.version === item.version)],
  }))
  return { reviewed, current: structuredClone({ ...reviewed, entries: [...reviewed.entries, ...entries],
    localSources: [...reviewed.localSources, ...additions] }) }
}

for (const phase of Object.keys(versions)) test(`accepts only exact ${phase} state and preserves all historical evidence`, () => {
  const f = fixture(phase), review = verifyPatrolRepairBaseline(f.current, f.reviewed, phase)
  assert.equal(review.appliedCount, 462 + versions[phase].length)
  assert.equal(review.historicalEntriesPreserved, true)
  assert.equal(review.historicalSourceChecksumsPreserved, true)
  assert.equal(review.allowedSourceAdditions.length, 3)
})

for (const [name, mutate] of [
  ['old statement array', f => { f.current.entries[0].statementArraySha256 = 'changed' }],
  ['old owner', f => { f.current.entries[0].owner = 'wrong-owner' }],
  ['old name', f => { f.current.entries[0].name = 'changed' }],
  ['removed old version', f => { f.current.entries.shift() }],
  ['old source SQL', f => { f.current.localSources[0].normalizedSourceSha256 = 'changed' }],
  ['removed old source', f => { f.current.localSources.shift() }],
  ['unknown local source', f => { f.current.localSources.push({ owner: 'SygShift', filename: '999_rogue.sql', normalizedSourceSha256: 'rogue' }) }],
  ['duplicate new source', f => { f.current.localSources.push(structuredClone(f.current.localSources.at(-1))) }],
  ['new source identity', f => { f.current.localSources.at(-1).filename = 'rogue.sql' }],
  ['new source SQL', f => { f.current.localSources.at(-1).normalizedSourceSha256 = 'changed' }],
  ['new source version', f => { f.current.localSources.at(-1).version = '999' }],
  ['new source name', f => { f.current.localSources.at(-1).name = 'rogue' }],
  ['new applied version', f => { f.current.entries.at(-1).version = '999' }],
  ['new applied name', f => { f.current.entries.at(-1).name = 'rogue' }],
  ['new applied owner', f => { f.current.entries.at(-1).owner = 'Sygilant' }],
  ['new SQL order', f => { f.current.entries.at(-1).orderedStatementsSha256 = 'changed' }],
  ['new exact statement array', f => { f.current.entries.at(-1).statementArraySha256 = 'changed' }],
  ['new SQL count', f => { f.current.entries.at(-1).statementCount -= 1 }],
  ['new null array', f => { f.current.entries.at(-1).statementArrayState = 'null' }],
  ['new ambiguous owner', f => { f.current.entries.at(-1).sourceCandidates.push(structuredClone(f.current.entries.at(-1).sourceCandidates[0])) }],
  ['new applied source hash', f => { f.current.entries.at(-1).sourceCandidates[0].normalizedSourceSha256 = 'changed' }],
  ['wrong source matching mode', f => { f.current.entries.at(-1).sourceMatch = 'name-matches-different-version' }],
]) test(`rejects ${name} drift`, () => {
  const f = fixture(); mutate(f)
  assert.throws(() => verifyPatrolRepairBaseline(f.current, f.reviewed, 'after-both'))
})

test('a 464-entry ledger cannot substitute the wrong repair for the declared phase', () => {
  const f = fixture('after-route')
  assert.throws(() => verifyPatrolRepairBaseline(f.current, f.reviewed, 'after-sygilant'), /Unreviewed applied identity/)
})
test('pending approved source does not authorize its applied version in the before phase', () => {
  const f = fixture('after-sygilant')
  assert.throws(() => verifyPatrolRepairBaseline(f.current, f.reviewed, 'before'), /Unexpected applied migration count/)
})
test('expected-state evidence never claims live activation or proven rollback', () => {
  const f = fixture(), review = verifyPatrolRepairBaseline(f.current, f.reviewed, 'after-both')
  const metadata = patrolBaselineReview(review, true)
  assert.equal(metadata.observedProductionState, false)
  assert.equal(metadata.expectedUncommittedState, true)
  assert.match(metadata.limitation, /not proof of production activation or successful rollback/)
  assert.equal(patrolBaselineReview(review).observedProductionState, true)
  assert.throws(() => patrolBaselineReview({ ...review, phase: 'before' }, true))
})
test('invalid expected-state phase is rejected before interpreting supplied rows', () => {
  assert.throws(() => buildPatrolRepairBaseline({ phase: 'before', expectedUncommittedState: true }), /complete reviewed release/)
})
test('actual local source and predecessor fingerprints equal their pinned reviewed values', () => {
  assert.equal(digest(readFileSync(join(root, 'docs/reliability', patrolPriorBaseline.filename))), patrolPriorBaseline.sha256)
  const route = patrolBaselineAdditions.find(item => item.owner === 'SygShift')
  const source = readFileSync(join(root, 'supabase/migrations', `${route.version}_${route.name}.sql`), 'utf8').replaceAll('\r\n', '\n')
  assert.equal(digest(source), route.sourceHash)
  assert.equal(fixture().reviewed.entries.length, 462)
})
test('CLI has no bypass or arbitrary baseline/output override', () => {
  assert.deepEqual(parsePatrolBaselineArguments(['--phase', 'before']), { phase: 'before' })
  for (const args of [[], ['--phase', 'any'], ['--phase', 'before', '--phase', 'after-both'],
    ['--phase', 'before', '--force', 'yes'], ['--phase', 'before', '--output', 'different'],
    ['--phase', 'before', '--rehearsal-ledger', '/tmp/ledger.json']]) assert.throws(() => parsePatrolBaselineArguments(args))
  assert.equal(patrolBaselineOutputName('after-both', true), 'migration-ownership-2026-11-17-patrol-expected-after-both-v2.json')
  assert.notEqual(patrolBaselineOutputName('after-both'), patrolBaselineOutputName('after-both', true))
})
test('existing baseline is never overwritten and no query is attempted', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'patrol-baseline-test-'))
  assert(resolve(directory).startsWith(resolve(tmpdir()) + '/') || resolve(directory).startsWith(resolve(tmpdir()) + '\\'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const destination = join(directory, 'docs/reliability')
  mkdirSync(destination, { recursive: true })
  const output = join(destination, patrolBaselineOutputName('before'))
  writeFileSync(output, 'retained evidence')
  let calls = 0
  await assert.rejects(capturePatrolRepairBaseline({ shiftRoot: directory, sygilantRoot: join(directory, 'other'), phase: 'before' }, {
    run: async () => { calls += 1; throw new Error('must not run') },
  }), /Refusing to overwrite/)
  assert.equal(calls, 0)
  assert.equal(readFileSync(output, 'utf8'), 'retained evidence')
})
