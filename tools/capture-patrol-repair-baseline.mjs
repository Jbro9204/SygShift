import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildOwnershipManifest, readSourceTree, verifyOwnershipBaseline } from './database-migration-ownership.mjs'
import { commandEnvironment, createCommandRunner } from './production-release-core.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
export const patrolPriorBaseline = Object.freeze({
  filename: 'migration-ownership-2026-11-12-recovery-history-v2.json',
  sha256: 'ec9abe908618b6c77c88d5d62efd81f17a2ee1c058bb70131eb0a8f5dc447027',
  appliedCount: 462,
})
// Exact reviewed identities and normalized source/ledger evidence, not wildcards.
export const patrolBaselineAdditions = Object.freeze([
  Object.freeze({ owner: 'Sygilant', version: '20261113162436', name: 'client_recovery_delivery_fence',
    sourceHash: 'ef01e77025b52301da4a2ef9093734bd825610ef21ad005a20d0548b4a26e6cb',
    ledgerHash: '7c71bf7d031ccadf7a84c93c669d7360114e8f982e241e30ca2fbd59c2d1d612',
    arrayHash: '8d8e04e2dae414382b5db705c4cd1905b4347384e62a8f51a12180d38464e4fc', statementCount: 19 }),
  Object.freeze({ owner: 'Sygilant', version: '20261117181328', name: 'patrol_single_observations_v3',
    sourceHash: '0cbf7699d3eec78646f4d1b121f8526f0de74f4257dbac3d801fa5a376e616ba',
    ledgerHash: 'dbd23f1b8e5098541959f6e0c180d507c338a75ceb969e0d0ae0bbe97ab9b16a',
    arrayHash: 'fbfb6fa20e08c90eb2d1d0373f4a984d327b68f399946f833759b0a25a5f528f', statementCount: 19 }),
  Object.freeze({ owner: 'SygShift', version: '20261117182334', name: 'patrol_route_builder_integrity',
    sourceHash: 'a7d909fc39b588422de844185c69caaa6b01ae4f024ffc2a5c6dc8ca653e59d1',
    ledgerHash: '2f02d7c499e326f26f9b4d0571e2d3f1afdb117169536b9db3737f700fb695a1',
    arrayHash: '51e2d50ac7ff255caab7e609f59b6359656f0e3421133cf20959ada3971c36af', statementCount: 23 }),
])
const phaseVersions = Object.freeze({
  before: ['20261113162436'],
  'after-sygilant': ['20261113162436', '20261117181328'],
  'after-route': ['20261113162436', '20261117182334'],
  'after-both': ['20261113162436', '20261117181328', '20261117182334'],
})
const sourceIdentity = source => `${source.owner}/${source.filename}`
const sourceFilename = item => `${item.version}_${item.name}.sql`

export function verifyPatrolRepairBaseline(current, reviewed, phase) {
  assert(Object.hasOwn(phaseVersions, phase), 'Choose an exact reviewed patrol release phase')
  assert.equal(reviewed.formatVersion, 2, 'A reviewed v2 baseline is required')
  assert.equal(reviewed.entries.length, patrolPriorBaseline.appliedCount, 'The reviewed 462-entry predecessor is required')
  assert.equal(current.formatVersion, 2, 'The current capture must use format v2')
  assert.equal(current.entries.length, 462 + phaseVersions[phase].length, 'Unexpected applied migration count for this phase')
  const oldVersions = new Set(reviewed.entries.map(entry => entry.version))
  const oldSources = new Set(reviewed.localSources.map(sourceIdentity))
  const historical = { ...current, entries: current.entries.filter(entry => oldVersions.has(entry.version)),
    localSources: current.localSources.filter(source => oldSources.has(sourceIdentity(source))) }
  const preserved = verifyOwnershipBaseline(historical, reviewed)
  assert(preserved.accepted, `Historical evidence changed: ${preserved.driftErrors.join('; ')}`)
  const sources = current.localSources.filter(source => !oldSources.has(sourceIdentity(source)))
  assert.equal(sources.length, patrolBaselineAdditions.length, 'Exactly the three reviewed owning source additions are required')
  for (const expected of patrolBaselineAdditions) {
    const matches = sources.filter(source => source.owner === expected.owner && source.filename === sourceFilename(expected))
    assert.equal(matches.length, 1, 'A reviewed owning source is missing or duplicated')
    assert.equal(matches[0].version, expected.version, 'Owning source version changed')
    assert.equal(matches[0].name, expected.name, 'Owning source name changed')
    assert.equal(matches[0].normalizedSourceSha256, expected.sourceHash, 'Owning source checksum changed')
  }
  const added = current.entries.filter(entry => !oldVersions.has(entry.version))
  assert.deepEqual(added.map(entry => entry.version).sort(), [...phaseVersions[phase]].sort(), 'Unreviewed applied identity for this phase')
  for (const entry of added) {
    const expected = patrolBaselineAdditions.find(item => item.version === entry.version)
    assert.equal(entry.owner, expected.owner, 'Applied owner changed')
    assert.equal(entry.name, expected.name, 'Applied name changed')
    assert.equal(entry.sourceMatch, 'exact-version-and-name', 'Applied identity lacks exact owning source')
    assert.equal(entry.statementArrayState, 'array', 'Applied statements must be a non-null exact array')
    assert.equal(entry.statementCount, expected.statementCount, 'Applied statement count changed')
    assert.equal(entry.orderedStatementsSha256, expected.ledgerHash, 'Applied ordered SQL changed')
    assert.equal(entry.statementArraySha256, expected.arrayHash, 'Applied exact statement array changed')
    assert.equal(entry.sourceCandidates?.length, 1, 'Applied source ownership is ambiguous')
    assert.equal(sourceIdentity(entry.sourceCandidates[0]), `${expected.owner}/${sourceFilename(expected)}`, 'Applied source identity changed')
    assert.equal(entry.sourceCandidates[0].normalizedSourceSha256, expected.sourceHash, 'Applied source checksum changed')
  }
  return { phase, oldAppliedCount: 462, appliedCount: current.entries.length,
    historicalEntriesPreserved: true, historicalSourceChecksumsPreserved: true,
    allowedSourceAdditions: patrolBaselineAdditions.map(item => ({ owner: item.owner, version: item.version, name: item.name })),
    added: added.map(entry => ({ owner: entry.owner, version: entry.version, name: entry.name,
      orderedStatementsSha256: entry.orderedStatementsSha256, statementArraySha256: entry.statementArraySha256 })) }
}

export function buildPatrolRepairBaseline({ ledgerRows, sources, reviewed, phase, ledgerSha256, capturedAt,
  ownershipDecisions, expectedUncommittedState = false }) {
  assert(!expectedUncommittedState || phase === 'after-both', 'Expected-state capture is restricted to the complete reviewed release')
  const manifest = buildOwnershipManifest({ ledgerRows, sources, capturedAt, ledgerSha256, ownershipDecisions })
  const review = verifyPatrolRepairBaseline(manifest, reviewed, phase)
  manifest.releaseReview = patrolBaselineReview(review, expectedUncommittedState)
  return manifest
}

export function patrolBaselineReview(review, expectedUncommittedState = false) {
  assert(!expectedUncommittedState || review.phase === 'after-both', 'Expected-state capture is restricted to the complete reviewed release')
  return { priorBaseline: patrolPriorBaseline.filename, priorBaselineSha256: patrolPriorBaseline.sha256,
    ...review, observedProductionState: !expectedUncommittedState, expectedUncommittedState,
    evidenceKind: expectedUncommittedState ? 'supplied-rollback-rehearsal-ledger' : 'fresh-read-only-production-ledger',
    scope: 'Only the recorded client-recovery migration and the two exact patrol repairs. No historical replay, account, permission, mapping, schedule, time, payroll or report record changes.',
    limitation: expectedUncommittedState
      ? 'This is expected state from a supplied rehearsal ledger, not proof of production activation or successful rollback. Compare fresh production before deployment.'
      : 'Point-in-time read-only ledger/source verification, not proof of end-user workflow acceptance.' }
}

export function patrolBaselineOutputName(phase, expectedUncommittedState = false) {
  assert(Object.hasOwn(phaseVersions, phase), 'Choose an exact reviewed patrol release phase')
  assert(!expectedUncommittedState || phase === 'after-both', 'Expected-state capture is restricted to the complete reviewed release')
  return `migration-ownership-2026-11-17-patrol-${expectedUncommittedState ? 'expected-' : ''}${phase}-v2.json`
}

export async function capturePatrolRepairBaseline({ shiftRoot = resolve(import.meta.dirname, '..'),
  sygilantRoot = process.env.SYGSHIFT_RELEASE_SYGILANT_ROOT, phase, rehearsalLedgerPath, environment = process.env }, injected = {}) {
  assert(isAbsolute(shiftRoot) && typeof sygilantRoot === 'string' && isAbsolute(sygilantRoot), 'Explicit absolute owning roots are required')
  const cwd = resolve(shiftRoot), hub = resolve(sygilantRoot)
  assert.notEqual(cwd, hub, 'The two owning repositories must be separate')
  const expectedUncommittedState = rehearsalLedgerPath !== undefined
  const output = join(cwd, 'docs/reliability', patrolBaselineOutputName(phase, expectedUncommittedState))
  assert(!existsSync(output), 'Refusing to overwrite an existing baseline')
  if (expectedUncommittedState) assert(isAbsolute(rehearsalLedgerPath), 'The supplied rehearsal ledger path must be absolute')
  const run = injected.run ?? createCommandRunner()
  const options = { cwd, env: commandEnvironment(environment), timeoutMs: 45_000 }
  const priorRelative = `docs/reliability/${patrolPriorBaseline.filename}`
  await run(['exec', 'git', 'ls-files', '--error-unmatch', '--', priorRelative], options)
  await run(['exec', 'git', 'diff', '--quiet', 'HEAD', '--', priorRelative], options)
  const priorText = readFileSync(join(cwd, priorRelative), 'utf8')
  assert.equal(hash(priorText), patrolPriorBaseline.sha256, 'The immutable reviewed predecessor file changed')
  const reviewed = JSON.parse(priorText)
  const sources = [...readSourceTree(cwd, 'SygShift'), ...readSourceTree(hub, 'Sygilant')]
  const decisions = JSON.parse(readFileSync(join(cwd, 'docs/work-orders/2026-10-19-overnight/migration-source-ownership-decisions.json'), 'utf8'))
  let response
  try {
    response = expectedUncommittedState ? readFileSync(rehearsalLedgerPath, 'utf8') : (await run([
      'dlx', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', 'eqkdfrbwtioiqtjsyglg',
      'select version,name,statements from supabase_migrations.schema_migrations order by version', '-o', 'json'], options)).stdout
  } catch { throw new Error('Read-only ledger capture failed; raw database output withheld') }
  let rows
  try { assert(Buffer.byteLength(response, 'utf8') <= 32 * 1024 * 1024); rows = JSON.parse(response).rows; assert(Array.isArray(rows) && rows.length) }
  catch { throw new Error('Invalid or oversized ledger response; raw database output withheld') }
  const manifest = buildPatrolRepairBaseline({ ledgerRows: rows, sources, reviewed, phase,
    capturedAt: new Date().toISOString(), ledgerSha256: hash(response), ownershipDecisions: decisions, expectedUncommittedState })
  const payload = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(output, payload, { flag: 'wx' })
  return { output, sha256: hash(payload), ...manifest.releaseReview }
}

export function parsePatrolBaselineArguments(args) {
  const supported = new Map([['--phase', 'phase'], ['--sygshift-root', 'shiftRoot'], ['--sygilant-root', 'sygilantRoot'], ['--rehearsal-ledger', 'rehearsalLedgerPath']])
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = supported.get(args[i])
    assert(key && args[i + 1] && !args[i + 1].startsWith('--') && !Object.hasOwn(options, key), 'Use unique --phase, --sygshift-root, --sygilant-root and optional --rehearsal-ledger value pairs')
    options[key] = args[i + 1]
  }
  patrolBaselineOutputName(options.phase, options.rehearsalLedgerPath !== undefined)
  return options
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  Promise.resolve().then(() => capturePatrolRepairBaseline(parsePatrolBaselineArguments(process.argv.slice(2))))
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
