import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const migrationFiles = Object.freeze([
  '20261024151000_harden_client_document_upload_completion.sql',
  '20261024153000_durable_email_recipient_dispatch.sql',
  '20261024154500_harden_licensing_document_upload_completion.sql',
  '20261024155000_signature_completion_reconciliation.sql',
  '20261024156000_durable_push_provider_outcome.sql',
  '20261024157000_licensing_availability_recovery_and_email_source_ids.sql',
  '20261024160000_profile_photo_upload_idempotency.sql',
  '20261024161000_bind_hr_document_upload_intent.sql',
  '20261024163000_protected_storage_artifact_recovery.sql',
  '20261024164000_hr_document_authority_fence.sql',
  '20261024165000_stabilize_operational_report_row_identity.sql',
  '20261024166000_licensing_document_authority_fence.sql',
  '20261024168000_durable_admin_security_operations.sql',
  '20261024169000_quarantine_protected_storage_cleanup_retries.sql',
  '20261024170000_quarantine_document_cleanup_retries.sql',
  '20261024171000_durable_admin_login_instructions.sql',
  '20261024172000_durable_manual_schedule_notifications.sql',
  '20261024172500_fence_push_subscription_ownership.sql',
  '20261024173000_durable_email_queue_claims_and_review.sql',
  '20261024174000_protected_storage_cleanup_claim_receipts.sql',
  '20261024175000_bind_admin_password_reset_identity.sql',
])

export const regressionFiles = Object.freeze([
  'client_document_upload_idempotency_regression.sql',
  'document_cleanup_quarantine_regression.sql',
  'durable_admin_login_instructions_regression.sql',
  'durable_admin_security_operations_regression.sql',
  'durable_manual_schedule_notifications_regression.sql',
  'employee_push_provider_outcome_regression.sql',
  'hr_document_authority_fence_regression.sql',
  'licensing_availability_and_email_source_regression.sql',
  'licensing_document_authority_fence_regression.sql',
  'operational_report_row_identity_regression.sql',
  'profile_signature_storage_durability_regression.sql',
  'protected_storage_cleanup_claim_receipts_regression.sql',
  'protected_storage_cleanup_retry_saturation_regression.sql',
  'push_subscription_ownership_fence_regression.sql',
])

function dollarQuoteAt(source, index) {
  if (source[index] !== '$') return null
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(source.slice(index))
  return match?.[0] ?? null
}

function scanTopLevelStatements(source) {
  const normalized = source.replace(/^\uFEFF/u, '')
  const statements = []
  let start = 0
  let index = 0
  let singleQuoted = false
  let doubleQuoted = false
  let dollarQuote = null
  let lineComment = false
  let blockCommentDepth = 0

  while (index < normalized.length) {
    const character = normalized[index]
    const next = normalized[index + 1]

    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false
      index += 1
      continue
    }
    if (blockCommentDepth > 0) {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1
        index += 2
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1
        index += 2
      } else {
        index += 1
      }
      continue
    }
    if (dollarQuote) {
      if (normalized.startsWith(dollarQuote, index)) {
        index += dollarQuote.length
        dollarQuote = null
      } else {
        index += 1
      }
      continue
    }
    if (singleQuoted) {
      if (character === "'" && next === "'") {
        index += 2
      } else if (character === "'" && !isBackslashEscaped(normalized, index)) {
        singleQuoted = false
        index += 1
      } else {
        index += 1
      }
      continue
    }
    if (doubleQuoted) {
      if (character === '"' && next === '"') {
        index += 2
      } else if (character === '"') {
        doubleQuoted = false
        index += 1
      } else {
        index += 1
      }
      continue
    }

    if (character === '-' && next === '-') {
      lineComment = true
      index += 2
      continue
    }
    if (character === '/' && next === '*') {
      blockCommentDepth = 1
      index += 2
      continue
    }
    if (character === "'") {
      singleQuoted = true
      index += 1
      continue
    }
    if (character === '"') {
      doubleQuoted = true
      index += 1
      continue
    }
    const openingDollarQuote = dollarQuoteAt(normalized, index)
    if (openingDollarQuote) {
      dollarQuote = openingDollarQuote
      index += openingDollarQuote.length
      continue
    }
    if (character === ';') {
      statements.push({ start, end: index + 1, source: normalized.slice(start, index + 1) })
      start = index + 1
    }
    index += 1
  }

  if (singleQuoted || doubleQuoted || dollarQuote || blockCommentDepth > 0) {
    throw new Error('SQL source contains an unterminated quoted value or comment')
  }
  if (start < normalized.length) {
    statements.push({ start, end: normalized.length, source: normalized.slice(start) })
  }
  return { normalized, statements }
}

function isBackslashEscaped(source, index) {
  let count = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) count += 1
  return count % 2 === 1
}

function stripComments(source) {
  let result = ''
  let index = 0
  let singleQuoted = false
  let doubleQuoted = false
  let dollarQuote = null
  let lineComment = false
  let blockCommentDepth = 0

  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false
        result += character
      } else {
        result += ' '
      }
      index += 1
      continue
    }
    if (blockCommentDepth > 0) {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1
        result += '  '
        index += 2
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1
        result += '  '
        index += 2
      } else {
        result += character === '\n' || character === '\r' ? character : ' '
        index += 1
      }
      continue
    }
    if (dollarQuote) {
      if (source.startsWith(dollarQuote, index)) {
        result += dollarQuote
        index += dollarQuote.length
        dollarQuote = null
      } else {
        result += character
        index += 1
      }
      continue
    }
    if (singleQuoted) {
      result += character
      if (character === "'" && next === "'") {
        result += next
        index += 2
      } else if (character === "'" && !isBackslashEscaped(source, index)) {
        singleQuoted = false
        index += 1
      } else {
        index += 1
      }
      continue
    }
    if (doubleQuoted) {
      result += character
      if (character === '"' && next === '"') {
        result += next
        index += 2
      } else if (character === '"') {
        doubleQuoted = false
        index += 1
      } else {
        index += 1
      }
      continue
    }
    if (character === '-' && next === '-') {
      lineComment = true
      result += '  '
      index += 2
      continue
    }
    if (character === '/' && next === '*') {
      blockCommentDepth = 1
      result += '  '
      index += 2
      continue
    }
    if (character === "'") singleQuoted = true
    else if (character === '"') doubleQuoted = true
    else {
      const openingDollarQuote = dollarQuoteAt(source, index)
      if (openingDollarQuote) {
        dollarQuote = openingDollarQuote
        result += openingDollarQuote
        index += openingDollarQuote.length
        continue
      }
    }
    result += character
    index += 1
  }
  return result
}

function boundaryKeyword(statement) {
  const significant = stripComments(statement.source).trim()
  const match = /^(begin|commit|rollback)\s*;$/iu.exec(significant)
  return match?.[1]?.toLowerCase() ?? null
}

function significantStatements(source) {
  const scanned = scanTopLevelStatements(source)
  return {
    normalized: scanned.normalized,
    statements: scanned.statements.filter((statement) => stripComments(statement.source).trim() !== ''),
  }
}

export function unwrapTransaction(source, expectedEnding, label = 'SQL source') {
  const { normalized, statements } = significantStatements(source)
  if (statements.length < 3) throw new Error(`${label}: transaction body must not be empty`)
  const boundaries = statements
    .map((statement, index) => ({ index, keyword: boundaryKeyword(statement) }))
    .filter(({ keyword }) => keyword)
  if (boundaries.length !== 2 || boundaries[0].index !== 0 || boundaries[0].keyword !== 'begin') {
    throw new Error(`${label}: expected exactly one outer BEGIN and no nested top-level transaction boundary`)
  }
  const finalBoundary = boundaries[1]
  if (finalBoundary.index !== statements.length - 1 || finalBoundary.keyword !== expectedEnding) {
    throw new Error(`${label}: expected final ${expectedEnding.toUpperCase()} and no nested top-level transaction boundary`)
  }
  const body = normalized.slice(statements[0].end, statements.at(-1).start).trim()
  if (!body) throw new Error(`${label}: transaction body must not be empty`)
  return body
}

function migrationIdentity(fileName) {
  const match = /^(\d{14})_(.+)\.sql$/u.exec(fileName)
  if (!match) throw new Error(`Unexpected migration filename: ${fileName}`)
  return { version: match[1], name: match[2] }
}

function historyStatement(fileName, body) {
  const { version, name } = migrationIdentity(fileName)
  const dollarTag = `$sygshift_stability_${version}$`
  if (body.includes(dollarTag)) {
    throw new Error(`${fileName}: source collides with migration-history dollar tag ${dollarTag}`)
  }
  return `insert into supabase_migrations.schema_migrations(version, name, statements)
values (
  '${version}',
  '${name}',
  array[${dollarTag}${body}${dollarTag}]
);`
}

function preflightSql() {
  const versions = migrationFiles.map((fileName) => `'${migrationIdentity(fileName).version}'`).join(', ')
  return `select pg_advisory_xact_lock(hashtextextended('sygshift:stability-durability:2026-10-24', 0));

do $sygshift_stability_preflight$
declare
  existing_versions text[];
begin
  select array_agg(version order by version)
    into existing_versions
    from supabase_migrations.schema_migrations
   where version = any (array[${versions}]::text[]);

  if existing_versions is not null then
    raise exception 'Candidate migration version(s) already registered: %', existing_versions;
  end if;
end
$sygshift_stability_preflight$;`
}

export function validateGeneratedTransaction(sql, expectedEnding, label = 'generated SQL') {
  const { statements } = significantStatements(sql)
  const boundaries = statements
    .map((statement, index) => ({ index, keyword: boundaryKeyword(statement) }))
    .filter(({ keyword }) => keyword)
  if (
    boundaries.length !== 2
    || boundaries[0].index !== 0
    || boundaries[0].keyword !== 'begin'
    || boundaries[1].index !== statements.length - 1
    || boundaries[1].keyword !== expectedEnding
  ) {
    throw new Error(`${label}: expected one outer BEGIN and one final ${expectedEnding.toUpperCase()}`)
  }
}

export function buildReleaseSql({ root, rehearsal }) {
  const migrationSections = migrationFiles.map((fileName) => {
    const source = readFileSync(resolve(root, 'supabase', 'migrations', fileName), 'utf8')
    const body = unwrapTransaction(source, 'commit', fileName)
    const history = rehearsal ? '' : `\n\n${historyStatement(fileName, body)}`
    return `-- Migration: ${fileName}\n${body}${history}`
  })
  const regressionSections = rehearsal
    ? regressionFiles.map((fileName) => {
        const source = readFileSync(resolve(root, 'supabase', 'tests', fileName), 'utf8')
        const body = unwrapTransaction(source, 'rollback', fileName)
        return `-- Regression: ${fileName}\n${body}`
      })
    : []
  const ending = rehearsal ? 'rollback' : 'commit'
  const sql = `begin;
set local lock_timeout = '5s';
set local statement_timeout = '15min';
${preflightSql()}

${[...migrationSections, ...regressionSections].join('\n\n')}
${ending};
`
  validateGeneratedTransaction(sql, ending, rehearsal ? 'rollback-only rehearsal' : 'production release')
  return sql
}

function main() {
  const arguments_ = process.argv.slice(2)
  if (arguments_.length !== 1 || !['--rehearsal', '--release'].includes(arguments_[0])) {
    throw new Error('Choose exactly one mode: --rehearsal or --release')
  }
  const root = resolve(import.meta.dirname, '..')
  const rehearsal = arguments_[0] === '--rehearsal'
  const outputName = rehearsal
    ? 'stability-durability-release-rehearsal.sql'
    : 'stability-durability-release.sql'
  const outputDirectory = resolve(root, 'tmp')
  const outputPath = resolve(outputDirectory, outputName)
  mkdirSync(outputDirectory, { recursive: true })
  writeFileSync(outputPath, buildReleaseSql({ root, rehearsal }))
  console.log(`Prepared exact stability and durability ${rehearsal ? 'rollback-only rehearsal' : 'production release'} at ${outputPath}.`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main()
