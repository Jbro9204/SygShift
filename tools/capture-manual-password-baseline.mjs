import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildOwnershipManifest, readSourceTree, verifyOwnershipBaseline } from './database-migration-ownership.mjs'
import { commandEnvironment, createCommandRunner } from './production-release-core.mjs'

const project = 'eqkdfrbwtioiqtjsyglg'
const previousName = 'migration-ownership-2026-11-06-routine-reinstatement-v2.json'
const outputName = 'migration-ownership-2026-11-09-manual-password-v2.json'
const digest = value => createHash('sha256').update(value).digest('hex')
export const approvedManualPasswordAdditions = Object.freeze([
  { owner: 'SygShift', version: '20261106172037', name: 'approved_time_off_early_return' },
  { owner: 'SygShift', version: '20261109154616', name: 'password_change_requirements_and_verified_completion' },
  { owner: 'Sygilant', version: '20261109155422', name: 'password_change_session_projection' },
  { owner: 'SygShift', version: '20261109182242', name: 'admin_chosen_password_next_login' },
  { owner: 'Sygilant', version: '20261109182407', name: 'individual_password_change_access_boundary' },
  { owner: 'SygShift', version: '20261109203718', name: 'published_coverage_retirement_immutability' },
])
export const approvedManualPasswordNormalizerAdditions = Object.freeze([
  { owner: 'SygShift', version: '20261109204156', name: 'retired_generated_coverage_open_state' },
])

/** Preserve all old applied/source checksums; admit only the six reviewed additions. */
export function verifyManualPasswordBaselineAddition(current, reviewed, fingerprints) {
  return verifyAllowedBaselineAddition(current, reviewed, fingerprints, {
    priorCount: 450, finalCount: 456, additions: approvedManualPasswordAdditions,
    countMessage: 'All six authorized additions must be applied before capture',
  })
}

/** Preserve the reviewed 456-entry release and admit only its one normalizer repair. */
export function verifyManualPasswordNormalizerBaselineAddition(current, reviewed, fingerprints) {
  return verifyAllowedBaselineAddition(current, reviewed, fingerprints, {
    priorCount: 456, finalCount: 457, additions: approvedManualPasswordNormalizerAdditions,
    countMessage: 'Only the authorized normalizer addition may follow the reviewed 456-entry baseline',
  })
}

function verifyAllowedBaselineAddition(current, reviewed, fingerprints, { priorCount, finalCount, additions, countMessage }) {
  assert.equal(reviewed.formatVersion, 2, 'A reviewed v2 baseline is required')
  assert.equal(reviewed.entries.length, priorCount, 'Unexpected prior baseline count')
  assert.equal(current.entries.length, finalCount, countMessage)
  const oldVersions = new Set(reviewed.entries.map(entry => entry.version))
  const sourceIdentity = source => `${source.owner}/${source.filename}`
  const oldSources = new Set(reviewed.localSources.map(sourceIdentity))
  const preserved = { ...current,
    entries: current.entries.filter(entry => oldVersions.has(entry.version)),
    localSources: current.localSources.filter(source => oldSources.has(sourceIdentity(source))),
  }
  const verification = verifyOwnershipBaseline(preserved, reviewed)
  assert(verification.accepted, `Historical baseline changed: ${verification.driftErrors.join('; ')}`)
  const allowedVersions = new Map(additions.map(item => [item.version, item]))
  const added = current.entries.filter(entry => !oldVersions.has(entry.version))
  assert.equal(added.length, additions.length, 'Unexpected added migration count')
  for (const entry of added) {
    const expected = allowedVersions.get(entry.version)
    assert(expected && entry.name === expected.name && entry.owner === expected.owner, `Unapproved applied migration: ${entry.version}`)
    assert.equal(entry.sourceMatch, 'exact-version-and-name', `Applied source identity is not exact: ${entry.version}`)
    assert.equal(entry.statementArrayState, 'array', `Missing statement array: ${entry.version}`)
    const fingerprint = fingerprints.get(entry.version)
    assert(fingerprint, `Missing reviewed owning source: ${entry.version}`)
    assert.equal(entry.statementCount, fingerprint.statementCount, `Applied statement count mismatch: ${entry.version}`)
    assert.equal(entry.orderedStatementsSha256, fingerprint.ledgerHash, `Applied SQL differs from owning source: ${entry.version}`)
    const source = entry.sourceCandidates.find(candidate => candidate.owner === expected.owner
      && candidate.filename === `${entry.version}_${entry.name}.sql`)
    assert(source && source.normalizedSourceSha256 === fingerprint.sourceHash, `Owning source checksum mismatch: ${entry.version}`)
  }
  const addedSources = current.localSources.filter(source => !oldSources.has(sourceIdentity(source)))
  for (const source of addedSources) {
    const expected = allowedVersions.get(source.version)
    assert(expected && source.owner === expected.owner && source.name === expected.name
      && source.filename === `${expected.version}_${expected.name}.sql`, `Unreviewed owning source addition: ${sourceIdentity(source)}`)
  }
  return {
    oldAppliedCount: reviewed.entries.length, appliedCount: current.entries.length,
    historicalEntriesPreserved: true, historicalSourceChecksumsPreserved: true,
    added: added.map(entry => ({ version: entry.version, name: entry.name, owner: entry.owner,
      statementArraySha256: entry.statementArraySha256, orderedStatementsSha256: entry.orderedStatementsSha256,
      sourceSha256: fingerprints.get(entry.version).sourceHash })),
    addedSources: addedSources.map(source => ({ owner: source.owner, filename: source.filename, sourceSha256: source.normalizedSourceSha256 })),
  }
}

/** Fixed read-only SELECT; no ledger SQL or credentials are printed or saved. */
export async function captureManualPasswordBaseline({ shiftRoot, sygilantRoot, environment = process.env, mode = 'manual-password' }, injected = {}) {
  assert(['manual-password', 'normalizer'].includes(mode), 'Unknown baseline capture mode')
  const normalizer = mode === 'normalizer'
  const priorName = normalizer ? outputName : previousName
  const nextName = normalizer ? 'migration-ownership-2026-11-09-manual-password-normalizer-v2.json' : outputName
  const additions = normalizer ? approvedManualPasswordNormalizerAdditions : approvedManualPasswordAdditions
  assert(isAbsolute(shiftRoot) && isAbsolute(sygilantRoot), 'Both owning roots must be explicit absolute paths')
  const cwd = resolve(shiftRoot)
  const hub = resolve(sygilantRoot)
  assert.notEqual(cwd, hub, 'Use separate owning repositories')
  const priorPath = join(cwd, 'docs/reliability', priorName)
  const output = join(cwd, 'docs/reliability', nextName)
  assert(!existsSync(output), 'Refusing to overwrite an existing release baseline')
  const run = injected.run ?? createCommandRunner()
  const commandOptions = { cwd, env: commandEnvironment(environment), timeoutMs: 45_000 }
  try {
    await run(['exec', 'git', 'ls-files', '--error-unmatch', '--', `docs/reliability/${priorName}`], commandOptions)
    await run(['exec', 'git', 'diff', '--quiet', 'HEAD', '--', `docs/reliability/${priorName}`], commandOptions)
  } catch { throw new Error('The previous reviewed baseline must remain tracked and unchanged from HEAD') }
  const priorText = readFileSync(priorPath, 'utf8')
  const reviewed = JSON.parse(priorText)
  const ownershipDecisions = JSON.parse(readFileSync(join(cwd, 'docs/work-orders/2026-10-19-overnight/migration-source-ownership-decisions.json'), 'utf8'))
  const sources = [...readSourceTree(cwd, 'SygShift'), ...readSourceTree(hub, 'Sygilant')]
  const { fingerprintMigration } = await import(pathToFileURL(join(hub, 'scripts/render-supabase-migration-activation.mjs')).href)
  const fingerprints = new Map()
  for (const item of additions) {
    const path = join(item.owner === 'SygShift' ? cwd : hub, 'supabase/migrations', `${item.version}_${item.name}.sql`)
    fingerprints.set(item.version, fingerprintMigration(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')))
  }
  let ledgerText
  try {
    ledgerText = (await run(['dlx', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', project,
      'select version,name,statements from supabase_migrations.schema_migrations order by version', '-o', 'json'],
    commandOptions)).stdout
  } catch {
    throw new Error('Read-only production ledger capture failed; command output withheld')
  }
  let ledgerRows
  try {
    ledgerRows = JSON.parse(ledgerText).rows
    assert(Array.isArray(ledgerRows))
  } catch { throw new Error('Invalid production ledger response; SQL output withheld') }
  const current = buildOwnershipManifest({ ledgerRows, sources, capturedAt: new Date().toISOString(), ledgerSha256: digest(ledgerText), ownershipDecisions })
  const review = normalizer ? verifyManualPasswordNormalizerBaselineAddition(current, reviewed, fingerprints)
    : verifyManualPasswordBaselineAddition(current, reviewed, fingerprints)
  current.releaseReview = { priorBaseline: priorName, priorBaselineSha256: digest(priorText), ...review,
    scope: normalizer
      ? 'Records only the authorized retired-generated-coverage normalizer repair. No SQL replay, credentials, enrollment or email is authorized.'
      : 'Records only the authorized leave, manual-password and alert-retirement additions. No SQL replay, credentials, enrollment or email is authorized.' }
  const payload = `${JSON.stringify(current, null, 2)}\n`
  writeFileSync(output, payload, { flag: 'wx' })
  return { output, sha256: digest(payload), ...review, readOnlyProductionCapture: true }
}

export function captureManualPasswordNormalizerBaseline(options, injected = {}) {
  return captureManualPasswordBaseline({ ...options, mode: 'normalizer' }, injected)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [shiftRoot, sygilantRoot, option] = process.argv.slice(2)
  assert(option === undefined || option === '--normalizer', 'Only --normalizer is supported as an optional capture mode')
  assert(process.argv.length <= 5, 'Unexpected baseline capture arguments')
  captureManualPasswordBaseline({ shiftRoot, sygilantRoot, mode: option ? 'normalizer' : 'manual-password' })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
