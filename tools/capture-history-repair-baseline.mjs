import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildOwnershipManifest, readSourceTree, verifyOwnershipBaseline } from './database-migration-ownership.mjs'
import { commandEnvironment, createCommandRunner } from './production-release-core.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const priorName = 'migration-ownership-2026-11-12-reporting-delivery-v2.json'
const nextName = 'migration-ownership-2026-11-12-recovery-history-v2.json'
export const historyRepairAdditions = Object.freeze([
  { owner: 'Sygilant', version: '20261112205629', name: 'employee_preview_early_return_projection' },
  { owner: 'SygShift', version: '20261112210145', name: 'time_off_history_keyset_reader' },
])

export function verifyHistoryRepairBaseline(current, reviewed, fingerprints) {
  assert.equal(reviewed.formatVersion, 2, 'A reviewed v2 baseline is required')
  assert.equal(reviewed.entries.length, 460, 'The verified prior 460-entry ledger is required')
  assert.equal(current.entries.length, 462, 'Exactly the two reviewed read-only repairs must be applied')
  const oldVersions = new Set(reviewed.entries.map(entry => entry.version))
  const identity = source => `${source.owner}/${source.filename}`
  const oldSources = new Set(reviewed.localSources.map(identity))
  const preserved = { ...current, entries: current.entries.filter(entry => oldVersions.has(entry.version)),
    localSources: current.localSources.filter(source => oldSources.has(identity(source))) }
  const check = verifyOwnershipBaseline(preserved, reviewed)
  assert(check.accepted, `Historical evidence changed: ${check.driftErrors.join('; ')}`)
  const added = current.entries.filter(entry => !oldVersions.has(entry.version))
  for (const expected of historyRepairAdditions) {
    const entry = added.find(item => item.version === expected.version)
    const proof = fingerprints.get(expected.version)
    assert(entry && proof && entry.name === expected.name && entry.owner === expected.owner, 'Unreviewed repair identity')
    assert.equal(entry.sourceMatch, 'exact-version-and-name')
    assert.equal(entry.statementArrayState, 'array')
    assert.equal(entry.statementCount, proof.statementCount, 'Repair statement count changed')
    assert.equal(entry.orderedStatementsSha256, proof.ledgerHash, 'Applied repair SQL differs from reviewed source')
    const source = entry.sourceCandidates.find(item => item.owner === expected.owner
      && item.filename === `${expected.version}_${expected.name}.sql`)
    assert.equal(source?.normalizedSourceSha256, proof.sourceHash, 'Repair source checksum changed')
  }
  for (const source of current.localSources.filter(item => !oldSources.has(identity(item)))) {
    assert(historyRepairAdditions.some(item => item.owner === source.owner && item.version === source.version
      && source.filename === `${item.version}_${item.name}.sql`), `Unreviewed owning source: ${identity(source)}`)
  }
  return { oldAppliedCount: 460, appliedCount: 462, historicalEntriesPreserved: true,
    historicalSourceChecksumsPreserved: true, added: added.map(entry => ({ version: entry.version,
      owner: entry.owner, name: entry.name, orderedStatementsSha256: entry.orderedStatementsSha256 })) }
}

export async function captureHistoryRepairBaseline({ shiftRoot, sygilantRoot, environment = process.env }, injected = {}) {
  assert(isAbsolute(shiftRoot) && isAbsolute(sygilantRoot), 'Explicit absolute owning roots are required')
  const cwd = resolve(shiftRoot)
  const hub = resolve(sygilantRoot)
  assert.notEqual(cwd, hub)
  const output = join(cwd, 'docs/reliability', nextName)
  assert(!existsSync(output), 'Refusing to overwrite a reviewed baseline')
  const run = injected.run ?? createCommandRunner()
  const options = { cwd, env: commandEnvironment(environment), timeoutMs: 45_000 }
  await run(['exec', 'git', 'ls-files', '--error-unmatch', '--', `docs/reliability/${priorName}`], options)
  await run(['exec', 'git', 'diff', '--quiet', 'HEAD', '--', `docs/reliability/${priorName}`], options)
  const priorText = readFileSync(join(cwd, 'docs/reliability', priorName), 'utf8')
  const reviewed = JSON.parse(priorText)
  const sources = [...readSourceTree(cwd, 'SygShift'), ...readSourceTree(hub, 'Sygilant')]
  const decisions = JSON.parse(readFileSync(join(cwd, 'docs/work-orders/2026-10-19-overnight/migration-source-ownership-decisions.json'), 'utf8'))
  const { fingerprintMigration } = await import(pathToFileURL(join(hub, 'scripts/render-supabase-migration-activation.mjs')).href)
  const proofs = new Map(historyRepairAdditions.map(item => [item.version, fingerprintMigration(readFileSync(
    join(item.owner === 'SygShift' ? cwd : hub, 'supabase/migrations', `${item.version}_${item.name}.sql`), 'utf8').replaceAll('\r\n', '\n'))]))
  let response
  try {
    response = (await run(['dlx', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', 'eqkdfrbwtioiqtjsyglg',
      'select version,name,statements from supabase_migrations.schema_migrations order by version', '-o', 'json'], options)).stdout
  } catch { throw new Error('Read-only ledger capture failed; database output withheld') }
  let rows
  try { rows = JSON.parse(response).rows; assert(Array.isArray(rows)) }
  catch { throw new Error('Invalid ledger response; database output withheld') }
  const current = buildOwnershipManifest({ ledgerRows: rows, sources, capturedAt: new Date().toISOString(), ledgerSha256: digest(response), ownershipDecisions: decisions })
  const review = verifyHistoryRepairBaseline(current, reviewed, proofs)
  current.releaseReview = { priorBaseline: priorName, priorBaselineSha256: digest(priorText), ...review,
    scope: 'Only the two read-only early-return/history readers. No migration replay, credential, permission, leave, schedule, payroll or email actions.' }
  const payload = `${JSON.stringify(current, null, 2)}\n`
  writeFileSync(output, payload, { flag: 'wx' })
  return { output, sha256: digest(payload), ...review, readOnlyProductionCapture: true }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [shiftRoot, sygilantRoot, ...extra] = process.argv.slice(2)
  assert.equal(extra.length, 0, 'Only the two owning paths are accepted')
  captureHistoryRepairBaseline({ shiftRoot, sygilantRoot }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
