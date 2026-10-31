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
  for (const target of manifest.functions ?? []) {
    const row = byIdentity.get(target.identity)
    if (row?.definition_md5 !== target.afterMd5 || row?.metadata_md5 !== target.metadataMd5) {
      throw new Error(`Reviewed retry-safety function is missing or changed: ${target.identity}`)
    }
  }
  return { verifiedFunctions: manifest.functions?.length ?? 0 }
}

export const retrySafetyCatalogSql = `select n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' as identity, p.prosrc as body, md5(pg_get_functiondef(p.oid)) as definition_md5, md5((to_jsonb(p)-'prosrc')::text) as metadata_md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f' and p.prosrc ~* '(40001|40P01|PT409|serialization_failure|deadlock_detected|errcode)' order by identity`

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(import.meta.dirname, '..')
    const baseline = JSON.parse(readFileSync(resolve(root, 'docs/reliability/postgres-retry-safety.json'), 'utf8'))
    console.log(JSON.stringify(checkMigrationRetrySafety(root, baseline)))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
