import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const normalized = (value) => value.replaceAll('\r\n', '\n')
const retiredSygilantVersion = '202609020003'

export function readSourceTree(root, owner) {
  const folder = join(resolve(root), 'supabase', 'migrations')
  return readdirSync(folder).filter((file) => file.endsWith('.sql')).map((file) => {
    const match = file.match(/^([0-9]+)_(.+)\.sql$/u)
    if (!match) throw new Error(`Invalid migration source filename: ${file}`)
    const path = join(folder, file)
    const source = readFileSync(path, 'utf8')
    return {
      owner, path, filename: file, version: match[1], name: match[2],
      normalizedSourceSha256: digest(normalized(source)),
      rawSourceSha256: digest(source),
      disposition: owner === 'Sygilant' && match[1] === retiredSygilantVersion
        ? 'withdrawn-cross-project-assurance-do-not-apply' : 'requires-ledger-reconciliation',
    }
  }).sort((left, right) => left.filename.localeCompare(right.filename))
}

export function buildOwnershipManifest({ ledgerRows, sources, capturedAt, ledgerSha256, ownershipDecisions = {} }) {
  const seen = new Set()
  const entries = ledgerRows.map((row) => {
    if (typeof row.version !== 'string' || !/^[0-9]+$/u.test(row.version) || seen.has(row.version)) {
      throw new Error('Production ledger contains an invalid or duplicated version')
    }
    seen.add(row.version)
    if (!Array.isArray(row.statements) && row.statements !== null) throw new Error(`Invalid statement array for ${row.version}`)
    const byVersion = sources.filter((source) => source.version === row.version)
    const exact = byVersion.filter((source) => source.name === row.name)
    const byName = sources.filter((source) => source.name === row.name)
    const candidates = exact.length ? exact : byName
    const owners = [...new Set(candidates.map((source) => source.owner))]
    const decision = ownershipDecisions[row.version]
    if (decision && (!owners.includes(decision.sourceOwner) || !Array.isArray(decision.evidence) || !decision.evidence.length)) {
      throw new Error(`Reviewed ownership decision lacks a matching owning source or evidence: ${row.version}`)
    }
    const owner = decision?.sourceOwner ?? (owners.length === 1 ? owners[0] : 'unassigned-shared-ownership-review')
    const statements = row.statements ?? []
    const matching = exact.length ? 'exact-version-and-name' : byName.length
      ? 'name-matches-different-version' : byVersion.length ? 'version-name-conflict' : 'source-not-found'
    return {
      version: row.version, name: row.name, owner, sourceMatch: matching,
      ownershipDecision: decision ?? null,
      sourceCandidates: candidates.length ? candidates : byVersion,
      statementCount: statements.length,
      statementArrayState: row.statements === null ? 'null' : 'array',
      statementArraySha256: digest(JSON.stringify(row.statements)),
      orderedStatementsSha256: digest(statements.map(normalized).join(';\n')),
      recoveryStatus: statements.length ? 'captured-exact-statement-array' : 'missing-statement-source-blocked',
      replayAuthorization: 'none-no-bulk-push',
    }
  })
  const localSources = sources.map((source) => ({
    ...source,
    disposition: source.disposition.startsWith('withdrawn') ? source.disposition
      : entries.some((entry) => entry.version === source.version && entry.name === source.name)
        ? 'applied-identity-source-checksum-review-required'
        : entries.some((entry) => entry.name === source.name)
          ? 'local-version-differs-from-applied-version-do-not-replay'
          : 'local-only-not-approved-for-production',
  }))
  return {
    formatVersion: 2, capturedAt, ledgerSha256,
    purpose: 'Read-only cross-repository ownership and source-recovery evidence; does not authorize replay or rewrite migration history.',
    identityAuthority: 'SygShift owns the shared workforce identity boundary; Sygilant owns client identities and its application objects.',
    checksumNote: 'Exact statement-array checksums preserve NULL versus empty arrays. Whole-file source and ordered ledger statements have different envelopes. A matching name or version does not prove SQL equivalence.',
    summary: {
      appliedMigrations: entries.length,
      sygshiftSources: sources.filter((source) => source.owner === 'SygShift').length,
      sygilantSources: sources.filter((source) => source.owner === 'Sygilant').length,
      nameVersionDifferences: entries.filter((entry) => entry.sourceMatch === 'name-matches-different-version').length,
      missingSources: entries.filter((entry) => entry.sourceMatch === 'source-not-found').length,
      missingStatementArrays: entries.filter((entry) => entry.statementCount === 0).length,
      ownershipReviewRequired: entries.filter((entry) => entry.owner === 'unassigned-shared-ownership-review').length,
      withdrawnCrossProjectSources: localSources.filter((source) => source.disposition.startsWith('withdrawn')).length,
    },
    entries, localSources,
  }
}

export function archiveRecoveredSources(manifest, ledgerRows, roots) {
  const archived = []
  for (const entry of manifest.entries) {
    if (entry.sourceMatch === 'exact-version-and-name' || entry.statementCount === 0) continue
    const root = roots[entry.owner]
    if (!root) throw new Error(`No explicit archive root was provided for ${entry.owner}`)
    const folder = resolve(root)
    const filename = `${entry.version}_${String(entry.name ?? 'unnamed').replaceAll(/[^a-zA-Z0-9_]/gu, '_')}.json`
    const path = join(folder, filename)
    const row = ledgerRows.find((candidate) => candidate.version === entry.version)
    const payload = `${JSON.stringify({ version: row.version, name: row.name, statements: row.statements, statementArraySha256: entry.statementArraySha256 }, null, 2)}\n`
    mkdirSync(folder, { recursive: true })
    if (existsSync(path) && readFileSync(path, 'utf8') !== payload) throw new Error(`Refusing to overwrite a different recovered source: ${path}`)
    writeFileSync(path, payload)
    archived.push({ version: entry.version, owner: entry.owner, path, fileSha256: digest(payload) })
  }
  return archived
}

export function verifyOwnershipBaseline(current, reviewed, { requireReconciled = false } = {}) {
  const driftErrors = []
  const reconciliationErrors = []
  const indexBy = (items, identity, label) => {
    if (!Array.isArray(items)) throw new Error(`The ${label} array is missing`)
    const index = new Map()
    for (const item of items) {
      const key = identity(item)
      if (index.has(key)) throw new Error(`The ${label} contains duplicate identity ${key}`)
      index.set(key, item)
    }
    return index
  }
  if (reviewed) {
    if (reviewed.formatVersion !== 2 || current.formatVersion !== 2) {
      throw new Error('Exact statement-array verification requires a reviewed format v2 baseline. Preserve v1 evidence unchanged; v1 collapsed NULL and empty arrays. Capture a separate v2 baseline from the preserved ledger for review.')
    }
    const appliedBefore = indexBy(reviewed.entries, (entry) => entry.version, 'reviewed applied ledger')
    const appliedNow = indexBy(current.entries, (entry) => entry.version, 'current applied ledger')
    for (const [version, entry] of appliedBefore) {
      const actual = appliedNow.get(version)
      if (!actual) driftErrors.push(`Applied version removed: ${version}`)
      else {
        if (actual.name !== entry.name) driftErrors.push(`Applied migration name changed: ${version}`)
        if (actual.statementArraySha256 !== entry.statementArraySha256) driftErrors.push(`Applied statement-array checksum changed: ${version}`)
        if (actual.owner !== entry.owner) driftErrors.push(`Applied source owner changed: ${version}`)
      }
    }
    for (const version of appliedNow.keys()) {
      if (!appliedBefore.has(version)) driftErrors.push(`Unreviewed applied version added: ${version}`)
    }
    const sourceIdentity = (source) => {
      if (!source.owner || !source.filename || !source.normalizedSourceSha256) throw new Error('An owning-source identity or checksum is missing')
      return `${source.owner}/${source.filename}`
    }
    const sourcesBefore = indexBy(reviewed.localSources, sourceIdentity, 'reviewed owning sources')
    const sourcesNow = indexBy(current.localSources, sourceIdentity, 'current owning sources')
    for (const [identity, source] of sourcesBefore) {
      const actual = sourcesNow.get(identity)
      if (!actual) driftErrors.push(`Owning source removed: ${identity}`)
      else if (actual.normalizedSourceSha256 !== source.normalizedSourceSha256) driftErrors.push(`Owning-source checksum changed: ${identity}`)
    }
    for (const identity of sourcesNow.keys()) {
      if (!sourcesBefore.has(identity)) driftErrors.push(`Unreviewed owning source added: ${identity}`)
    }
  }
  if (requireReconciled) {
    for (const entry of current.entries) {
      if (entry.sourceMatch === 'name-matches-different-version') reconciliationErrors.push(`Unresolved applied/local timestamp difference: ${entry.version}`)
      if (entry.statementCount === 0) reconciliationErrors.push(`Empty applied statement array: ${entry.version}`)
      if (entry.sourceMatch === 'source-not-found' || entry.sourceMatch === 'version-name-conflict') reconciliationErrors.push(`Unresolved source identity: ${entry.version}`)
      if (entry.owner === 'unassigned-shared-ownership-review') reconciliationErrors.push(`Unresolved source ownership: ${entry.version}`)
    }
  }
  return {
    accepted: driftErrors.length === 0 && reconciliationErrors.length === 0,
    reviewedBaselineCompared: Boolean(reviewed), requireReconciled,
    claimsHistoryEquivalence: false,
    bulkMigrationPushAuthorized: false,
    driftErrors, reconciliationErrors,
  }
}

function run() {
  const options = new Map()
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--') || !args[index + 1]) throw new Error('Arguments must be --name value pairs')
    const name = args[index].slice(2)
    if (options.has(name)) throw new Error(`Duplicate option: ${name}`)
    options.set(name, args[index + 1])
  }
  const knownOptions = new Set(['sygshift-root', 'sygilant-root', 'ledger', 'output', 'ownership-decisions', 'archive-unassigned-root', 'replace', 'verify-baseline', 'require-reconciled'])
  for (const option of options.keys()) if (!knownOptions.has(option)) throw new Error(`Unknown option: ${option}`)
  for (const required of ['sygshift-root', 'sygilant-root', 'ledger']) {
    if (!options.has(required)) throw new Error(`Missing --${required}`)
  }
  if (options.has('require-reconciled') && options.get('require-reconciled') !== 'yes') throw new Error('--require-reconciled only accepts yes; omission performs no reconciliation claim')
  const verificationMode = options.has('verify-baseline') || options.has('require-reconciled')
  if (verificationMode && (options.has('output') || options.has('archive-unassigned-root') || options.has('replace'))) throw new Error('Read-only verification cannot write a manifest or recovered archive')
  if (!verificationMode && !options.has('output')) throw new Error('Capture requires --output; read-only gate requires --verify-baseline or --require-reconciled yes')
  const ledgerFile = readFileSync(resolve(options.get('ledger')), 'utf8')
  const ledgerRows = JSON.parse(ledgerFile).rows
  if (!Array.isArray(ledgerRows)) throw new Error('Expected saved CLI JSON with a rows array')
  const sources = [
    ...readSourceTree(options.get('sygshift-root'), 'SygShift'),
    ...readSourceTree(options.get('sygilant-root'), 'Sygilant'),
  ]
  const ownershipDecisions = options.has('ownership-decisions')
    ? JSON.parse(readFileSync(resolve(options.get('ownership-decisions')), 'utf8')) : {}
  const manifest = buildOwnershipManifest({ ledgerRows, sources, ledgerSha256: digest(ledgerFile), capturedAt: new Date().toISOString(), ownershipDecisions })
  if (verificationMode) {
    const reviewed = options.has('verify-baseline')
      ? JSON.parse(readFileSync(resolve(options.get('verify-baseline')), 'utf8')) : null
    const verification = verifyOwnershipBaseline(manifest, reviewed, { requireReconciled: options.has('require-reconciled') })
    console.log(JSON.stringify({ verification, currentSummary: manifest.summary }))
    if (!verification.accepted) process.exitCode = 1
    return
  }
  if (options.has('archive-unassigned-root')) {
    manifest.recoveredArchives = archiveRecoveredSources(manifest, ledgerRows, {
      SygShift: join(resolve(options.get('sygshift-root')), 'backups', 'overnight-2026-10-19', 'recovered-migrations'),
      Sygilant: join(resolve(options.get('sygilant-root')), 'work', 'overnight-database-repair-20261019', 'recovered-migrations'),
      'unassigned-shared-ownership-review': resolve(options.get('archive-unassigned-root')),
    })
  }
  const output = resolve(options.get('output'))
  mkdirSync(dirname(output), { recursive: true })
  const payload = `${JSON.stringify(manifest, null, 2)}\n`
  if (existsSync(output) && options.get('replace') !== 'yes') throw new Error('Output exists; use an explicit new path or --replace yes')
  writeFileSync(output, payload)
  console.log(JSON.stringify({ output, sha256: digest(payload), summary: manifest.summary, recoveredArchives: manifest.recoveredArchives?.length ?? 0 }))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) run()
