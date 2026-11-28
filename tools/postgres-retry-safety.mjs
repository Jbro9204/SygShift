import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const retryConditions = new Set(['serialization_failure', 'deadlock_detected'])
const retryCodes = new Set(['40001', '40P01'])
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

// A deliberately small SQL lexer, not a regex over SQL text. Quoted messages,
// identifiers, comments and embedded replacement strings are not executable
// RAISE statements. Function/DO bodies are scanned with their original offsets.
export function sqlTokens(source, base = 0) {
  const result = []
  let i = 0
  while (i < source.length) {
    const start = i
    if (/\s/u.test(source[i])) { i++; continue }
    if (source.startsWith('--', i)) {
      i = source.indexOf('\n', i + 2)
      if (i < 0) break
      continue
    }
    if (source.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2 }
        else if (source.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
      if (depth) throw new Error('Unterminated SQL comment')
      continue
    }
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i++]
      const escapeString = quote === "'" && /(?:^|[^A-Za-z_0-9])e$/iu.test(source.slice(0, start))
      let value = ''
      let closed = false
      while (i < source.length) {
        if (escapeString && source[i] === '\\' && i + 1 < source.length) { value += source[i + 1]; i += 2; continue }
        if (source[i] === quote) {
          if (source[i + 1] === quote) { value += quote; i += 2; continue }
          i++; closed = true; break
        }
        value += source[i++]
      }
      if (!closed) throw new Error('Unterminated SQL quoted value')
      const previous = result.at(-1)
      if (quote === "'" && previous?.type === 'word' && ['as', 'do'].includes(previous.value)) {
        // SQL-literal bodies are uncommon; recurse for detection only. Repair
        // generation always uses pg_get_functiondef's dollar-quoted definition.
        result.push(...sqlTokens(value, base + start + 1))
      } else result.push({ type: quote === "'" ? 'string' : 'identifier', value, start: base + start, end: base + i })
      continue
    }
    const dollar = source.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u)?.[0]
    if (dollar) {
      const bodyStart = i + dollar.length
      const bodyEnd = source.indexOf(dollar, bodyStart)
      if (bodyEnd < 0) throw new Error('Unterminated SQL dollar quote')
      const previous = result.at(-1)
      if (previous?.type === 'word' && ['as', 'do'].includes(previous.value)) {
        result.push(...sqlTokens(source.slice(bodyStart, bodyEnd), base + bodyStart))
      } else {
        result.push({ type: 'string', value: source.slice(bodyStart, bodyEnd), start: base + i, end: base + bodyEnd + dollar.length })
      }
      i = bodyEnd + dollar.length
      continue
    }
    const word = source.slice(i).match(/^[A-Za-z_][A-Za-z_0-9$]*/u)?.[0]
    if (word) {
      i += word.length
      result.push({ type: 'word', value: word.toLowerCase(), start: base + start, end: base + i })
      continue
    }
    result.push({ type: 'symbol', value: source[i++], start: base + start, end: base + i })
  }
  return result
}

export function findRetryRaises(source) {
  const tokens = sqlTokens(source)
  const findings = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'word' || tokens[i].value !== 'raise') continue
    const level = tokens[i + 1]
    const conditionIndex = level?.type === 'word' && ['exception', 'warning', 'notice', 'info', 'log', 'debug'].includes(level.value) ? i + 2 : i + 1
    const next = tokens[conditionIndex]
    let end = i + 1
    while (end < tokens.length && tokens[end].value !== ';') end++
    if (retryConditions.has(next?.value) && next.type === 'word') {
      findings.push({ kind: 'condition', code: next.value, start: next.start, end: next.end, replacement: "sqlstate 'PT409'", statementStart: tokens[i].start, statementEnd: tokens[end]?.end ?? source.length })
    } else if (next?.type === 'word' && next.value === 'sqlstate') {
      const code = tokens[conditionIndex + 1]
      if (code?.type === 'string' && retryCodes.has(code.value.toUpperCase())) {
        findings.push({ kind: 'sqlstate', code: code.value, start: code.start, end: code.end, replacement: "'PT409'", statementStart: tokens[i].start, statementEnd: tokens[end]?.end ?? source.length })
      }
    }
    for (let j = i + 1; j < end; j++) {
      if (tokens[j].type !== 'word' || tokens[j].value !== 'errcode' || tokens[j + 1]?.value !== '=') continue
      const code = tokens[j + 2]
      if (code?.type === 'string' && retryCodes.has(code.value.toUpperCase())) {
        findings.push({ kind: 'errcode', code: code.value, start: code.start, end: code.end, replacement: "'PT409'", statementStart: tokens[i].start, statementEnd: tokens[end]?.end ?? source.length })
      } else if (code?.type !== 'string') {
        findings.push({ kind: 'dynamic_errcode', code: null, start: code?.start ?? tokens[j].start, end: code?.end ?? tokens[j].end, replacement: null, statementStart: tokens[i].start, statementEnd: tokens[end]?.end ?? source.length })
      }
    }
    i = end
  }
  return findings
}

export function applyReviewedRetryRepairs(source, findings) {
  let result = source
  for (const finding of [...findings].sort((a, b) => b.start - a.start)) {
    if (!finding.replacement) throw new Error('Dynamic SQLSTATE needs an explicit review, not automatic repair')
    result = result.slice(0, finding.start) + finding.replacement + result.slice(finding.end)
  }
  if (findRetryRaises(result).length) throw new Error('Reviewed repair left unsafe retry conditions')
  return result
}

// Immutable historical migrations can legitimately contain the old definition.
// Every exception is bound to the complete historical source SHA256, never to a
// filename, function prefix or substring. New/edited SQL must pass independently.
export function checkMigrationRetrySafety(root, baseline) {
  if (baseline?.formatVersion !== 1 || !Array.isArray(baseline.immutableHistoricalSources)) throw new Error('Missing retry-safety history baseline')
  const exceptions = new Map(baseline.immutableHistoricalSources.map((item) => [item.path, item.sha256]))
  const failures = []
  let immutableSources = 0
  let checkedSources = 0
  for (const file of readdirSync(resolve(root, 'supabase/migrations')).filter((value) => value.endsWith('.sql')).sort()) {
    const path = `supabase/migrations/${file}`
    const source = readFileSync(resolve(root, path), 'utf8')
    const findings = findRetryRaises(source)
    if (exceptions.has(path)) {
      if (exceptions.get(path) !== sha256(source.replaceAll('\r\n', '\n'))) failures.push(`${path}: immutable retry-bearing migration changed`)
      else immutableSources++
    } else if (findings.length) {
      failures.push(`${path}: ${findings.length} explicit or dynamic retry SQLSTATE raise(s) require review`)
    }
    checkedSources++
  }
  for (const path of exceptions.keys()) {
    try { readFileSync(resolve(root, path)) } catch { failures.push(`${path}: immutable historical migration is missing`) }
  }
  if (failures.length) throw new Error(`PostgreSQL retry-safety gate refused: ${failures.join('; ')}`)
  return { checkedSources, immutableSources }
}

export function assertRuntimeRetrySafety(rows, reviewedExceptions = []) {
  if (!Array.isArray(rows)) throw new Error('Invalid PostgreSQL retry-safety catalog')
  const exceptions = new Map(reviewedExceptions.map((item) => [item.identity, item]))
  const failures = []
  for (const row of rows) {
    const findings = findRetryRaises(row.body)
    if (!findings.length) continue
    const exception = exceptions.get(row.identity)
    if (!exception || !exception.justification || exception.definitionMd5 !== row.definition_md5) failures.push(`${row.identity}: ${findings.length} retry SQLSTATE raise(s)`)
  }
  if (failures.length) throw new Error(`Production retry-safety gate refused: ${failures.join('; ')}`)
  return { checkedFunctions: rows.length, unsafeFunctions: 0 }
}

export function assertReviewedFunctionFingerprints(rows, manifest) {
  const byIdentity = new Map(rows.map((row) => [row.identity, row]))
  if (byIdentity.size !== rows.length) throw new Error('Duplicate effective retry-safety function identity')
  for (const target of manifest.functions ?? []) {
    const row = byIdentity.get(target.identity)
    if (row?.definition_md5 !== target.afterMd5 || row?.metadata_md5 !== target.metadataMd5) {
      throw new Error(`Reviewed retry-safety function is missing or changed: ${target.identity}`)
    }
  }
  return { verifiedFunctions: manifest.functions?.length ?? 0 }
}

const functionIdentityPattern = /^(?:public|private)\.[^\u0000\r\n]+\([^\u0000\r\n]*\)$/u
const md5Pattern = /^[0-9a-f]{32}$/u
const sha256Pattern = /^[0-9a-f]{64}$/u
const reviewedMigrationPattern = /^supabase\/(migrations|guided-hr-canonical)\/([0-9]+)_([A-Za-z0-9_-]+)\.sql$/u

function indexedFingerprints(functions) {
  if (!Array.isArray(functions)) throw new Error('Reviewed retry-safety function inventory must be an array')
  const byIdentity = new Map()
  for (const target of functions) {
    if (typeof target?.identity !== 'string' || !functionIdentityPattern.test(target.identity)
      || !md5Pattern.test(target.afterMd5) || !md5Pattern.test(target.metadataMd5)
      || byIdentity.has(target.identity)) {
      throw new Error('Invalid or duplicate reviewed retry-safety function fingerprint')
    }
    byIdentity.set(target.identity, target)
  }
  return byIdentity
}

function requireAppliedSuccession(owner, root, succession, appliedByVersion) {
  const path = succession?.migrationPath
  const match = typeof path === 'string' && path.match(reviewedMigrationPattern)
  if (!match || (match[1] === 'guided-hr-canonical' && owner !== 'Sygilant')
    || !sha256Pattern.test(succession.migrationSha256) || !sha256Pattern.test(succession.orderedStatementsSha256)) {
    throw new Error('Invalid reviewed retry-safety succession migration')
  }
  const [, , version, name] = match
  const sourcePath = resolve(root, path)
  const entry = appliedByVersion.get(version)
  if (entry?.owner !== owner || entry.name !== name || entry.sourceMatch !== 'exact-version-and-name'
    || entry.statementArrayState !== 'array' || entry.statementCount < 1
    || entry.orderedStatementsSha256 !== succession.orderedStatementsSha256
    || !entry.sourceCandidates.some((source) => source.owner === owner && source.path === sourcePath
      && source.version === version && source.name === name && source.normalizedSourceSha256 === succession.migrationSha256)
    || sha256(readFileSync(sourcePath, 'utf8').replaceAll('\r\n', '\n')) !== succession.migrationSha256) {
    throw new Error('Reviewed retry-safety succession lacks matching applied ledger and source evidence')
  }
  return version
}

// The release gate supplies fresh entries only after their ledger and owning
// source inventory have matched the committed baseline.
export function resolveReviewedFunctionFingerprints(owningManifests, appliedEntries) {
  const appliedByVersion = new Map(appliedEntries.map((entry) => [entry.version, entry]))
  const current = new Map()
  const originalOwners = new Map()
  for (const { owner, manifest } of owningManifests) {
    for (const [identity, fingerprint] of indexedFingerprints(manifest.functions ?? [])) {
      if (current.has(identity)) throw new Error('Duplicate reviewed retry-safety identity across owners')
      current.set(identity, fingerprint)
      originalOwners.set(identity, owner)
    }
  }

  const usedMigrations = new Set()
  const replacedIdentities = new Set()
  for (const { owner, root, manifest } of owningManifests) {
    const successions = manifest.functionSuccessions === undefined ? [] : manifest.functionSuccessions
    if (!Array.isArray(successions)) throw new Error('Reviewed retry-safety successions must be an array')
    for (const succession of successions) {
      const version = requireAppliedSuccession(owner, root, succession, appliedByVersion)
      if (usedMigrations.has(version)) throw new Error('Duplicate reviewed retry-safety succession migration')
      usedMigrations.add(version)
      const replacements = indexedFingerprints(succession.functions)
      if (!Array.isArray(succession.supersedes) || !succession.supersedes.length) {
        throw new Error('Reviewed retry-safety succession must name a tracked identity')
      }
      const supersedes = new Set(succession.supersedes)
      if (supersedes.size !== succession.supersedes.length) throw new Error('Duplicate superseded retry-safety identity')
      for (const identity of supersedes) {
        if (typeof identity !== 'string' || !identity.startsWith('public.')
          || originalOwners.get(identity) !== owner || replacedIdentities.has(identity) || !replacements.has(identity)) {
          throw new Error('Reviewed retry-safety succession must replace each tracked identity with its exact counterpart')
        }
        replacedIdentities.add(identity)
      }
      for (const [identity, fingerprint] of replacements) {
        if (current.has(identity) && !supersedes.has(identity)) {
          throw new Error('Duplicate or undeclared replacement retry-safety identity')
        }
        current.set(identity, fingerprint)
      }
    }
  }
  return [...current.values()]
}

const retrySafetyIdentity = "n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')'"
const retrySafetyCatalogSelect = "select " + retrySafetyIdentity + " as identity, p.prosrc as body, md5(pg_get_functiondef(p.oid)) as definition_md5, md5((to_jsonb(p)-'prosrc')::text) as metadata_md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'"
const retrySafetyCatalogFilter = "p.prosrc ~* '(40001|40P01|PT409|serialization_failure|deadlock_detected|errcode)'"
export const retrySafetyCatalogSql = retrySafetyCatalogSelect + ' and ' + retrySafetyCatalogFilter + ' order by identity'

export function buildRetrySafetyCatalogSql(functions) {
  if (!functions.length) return retrySafetyCatalogSql
  // Keep the command line short on Windows. Hashes select rows only; the
  // fingerprint validator still compares their full identities and hashes.
  const digests = functions.map(({ identity }) => sha256(identity)).join(',')
  return retrySafetyCatalogSelect + ' and (' + retrySafetyCatalogFilter + ' or encode(sha256(convert_to('
    + retrySafetyIdentity + ", 'UTF8')), 'hex') = any(string_to_array('" + digests + "', ','))) order by identity"
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(import.meta.dirname, '..')
    const baseline = JSON.parse(readFileSync(resolve(root, 'docs/reliability/postgres-retry-safety.json'), 'utf8'))
    console.log(JSON.stringify(checkMigrationRetrySafety(root, baseline)))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
