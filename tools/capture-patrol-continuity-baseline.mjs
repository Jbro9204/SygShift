import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildOwnershipManifest, readSourceTree, verifyOwnershipBaseline } from './database-migration-ownership.mjs'
import { commandEnvironment, createCommandRunner } from './production-release-core.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const identity = source => `${source.owner}/${source.filename}`
const phaseCount = { before: 0, foundation: 1, consumers: 2, complete: 3 }

export function verifyContinuityBaseline(current, previous, plan, phase) {
  assert(Object.hasOwn(phaseCount, phase), 'Unknown continuity release phase')
  assert.equal(previous.entries.length, plan.priorAppliedCount, 'Unexpected predecessor count')
  const versions = new Set(previous.entries.map(item => item.version))
  const sources = new Set(previous.localSources.map(identity))
  const preserved = verifyOwnershipBaseline({ ...current, entries: current.entries.filter(item => versions.has(item.version)), localSources: current.localSources.filter(item => sources.has(identity(item))) }, previous)
  assert(preserved.accepted, `Historical ledger/source changed: ${preserved.driftErrors.join('; ')}`)
  const additions = current.localSources.filter(item => !sources.has(identity(item)))
  assert.equal(additions.length, plan.targets.length, 'Only the three reviewed new sources are allowed')
  for (const target of plan.targets) {
    const matches = additions.filter(item => item.owner === target.owner && item.filename === target.file)
    assert.equal(matches.length, 1, 'Missing or duplicated continuity source')
    assert.equal(matches[0].normalizedSourceSha256, target.sourceHash, 'Continuity source changed after review')
  }
  const applied = current.entries.filter(item => !versions.has(item.version))
  const expected = plan.targets.slice(0, phaseCount[phase])
  assert.deepEqual(applied.map(item => item.version).sort(), expected.map(item => item.version).sort(), 'Unexpected continuity activation phase')
  for (const entry of applied) {
    const target = expected.find(item => item.version === entry.version)
    assert.equal(entry.owner, target.owner)
    assert.equal(entry.name, target.name)
    assert.equal(entry.sourceMatch, 'exact-version-and-name')
    assert.equal(entry.statementArrayState, 'array')
    assert.equal(entry.statementCount, target.statementCount)
    assert.equal(entry.orderedStatementsSha256, target.ledgerHash)
    assert.equal(entry.statementArraySha256, target.statementArrayHash)
    assert.equal(entry.sourceCandidates.length, 1)
    assert.equal(entry.sourceCandidates[0].normalizedSourceSha256, target.sourceHash)
  }
  return { phase, appliedCount: current.entries.length, historicalEntriesPreserved: true, historicalSourcesPreserved: true }
}

export async function captureContinuityBaseline({ sygilantRoot, phase, rehearsalLedger, environment = process.env }, injected = {}) {
  const root = resolve(import.meta.dirname, '..')
  assert(typeof sygilantRoot === 'string' && isAbsolute(sygilantRoot), 'Explicit Sygilant source root required')
  assert(Object.hasOwn(phaseCount, phase), 'Unknown continuity phase')
  assert(!rehearsalLedger || isAbsolute(rehearsalLedger), 'Explicit rehearsal ledger path required')
  const plan = JSON.parse(readFileSync(join(root, 'docs/reliability/patrol-continuity-release-2026-11-18.json'), 'utf8'))
  const previousText = readFileSync(join(root, 'docs/reliability', plan.priorBaseline), 'utf8')
  assert.equal(hash(previousText), plan.priorBaselineSha256, 'Immutable predecessor changed')
  const previous = JSON.parse(previousText)
  const output = join(root, `docs/reliability/migration-ownership-2026-11-18-continuity-${rehearsalLedger ? 'expected-' : ''}${phase}-v3.json`)
  assert(!existsSync(output), 'Refusing to overwrite a captured baseline')
  const run = injected.run ?? createCommandRunner()
  const raw = rehearsalLedger ? readFileSync(rehearsalLedger, 'utf8') : (await run(['dlx','supabase@2.121.0','db','query','--linked','--project-ref','eqkdfrbwtioiqtjsyglg','select version,name,statements from supabase_migrations.schema_migrations order by version','-o','json'], { cwd: root, env: commandEnvironment(environment), timeoutMs: 45000 })).stdout
  const result = JSON.parse(raw)
  const rows = result.rows ?? result.ledgerRows ?? result
  assert(Array.isArray(rows) && rows.length && Buffer.byteLength(raw, 'utf8') < 32 * 1024 * 1024, 'Invalid bounded ledger input')
  const current = buildOwnershipManifest({ ledgerRows: rows, sources: [...readSourceTree(root,'SygShift'),...readSourceTree(sygilantRoot,'Sygilant')], capturedAt: new Date().toISOString(), ledgerSha256: hash(raw), ownershipDecisions: JSON.parse(readFileSync(join(root,'docs/work-orders/2026-10-19-overnight/migration-source-ownership-decisions.json'),'utf8')) })
  const review = verifyContinuityBaseline(current, previous, plan, phase)
  current.releaseReview = { ...review, previousBaseline: plan.priorBaseline, previousSha256: plan.priorBaselineSha256, observedProductionState: !rehearsalLedger, expectedUncommittedState: Boolean(rehearsalLedger), limitation: 'Ledger/source preservation proof only; not signed-in field acceptance. No historical replay or guessed property mapping.' }
  const payload = `${JSON.stringify(current,null,2)}\n`
  writeFileSync(output,payload,{flag:'wx'})
  return { output, sha256: hash(payload), ...review, expectedUncommittedState: Boolean(rehearsalLedger) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const names = new Map([['--sygilant-root','sygilantRoot'],['--phase','phase'],['--rehearsal-ledger','rehearsalLedger']])
  const options = {}
  for(let index=2;index<process.argv.length;index+=2) {
    const name=names.get(process.argv[index]); assert(name && process.argv[index+1] && !Object.hasOwn(options,name),'Invalid or duplicate baseline argument'); options[name]=process.argv[index+1]
  }
  captureContinuityBaseline(options).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1})
}
