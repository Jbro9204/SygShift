import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const modes = new Set([
  '--migration-rehearsal',
  '--migration-release',
  '--recovery-rehearsal',
  '--recovery-release',
])
const arguments_ = process.argv.slice(2)

if (arguments_.length !== 1 || !modes.has(arguments_[0])) {
  throw new Error(
    'Choose exactly one mode: --migration-rehearsal, --migration-release, --recovery-rehearsal, or --recovery-release',
  )
}

const mode = arguments_[0]
const migrationName = '20261019130405_sygsphere_message_acknowledgment.sql'
const recoveryName = '20261019130406_sygsphere_message_acknowledgment_recovery.sql'
const regressionName = 'sygsphere_message_acknowledgment_regression.sql'
const recoveryRegressionName = 'sygsphere_message_acknowledgment_recovery_regression.sql'

const paths = {
  migration: resolve(root, 'supabase', 'migrations', migrationName),
  recovery: resolve(root, 'supabase', 'recovery', recoveryName),
  regression: resolve(root, 'supabase', 'tests', regressionName),
  recoveryRegression: resolve(root, 'supabase', 'tests', recoveryRegressionName),
}

function commentsOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\r\n]*/g, '')
    .trim() === ''
}

function transactionBody(source, ending, label) {
  const normalized = source.replace(/^\uFEFF/, '').trim()
  const beginMatch = /^\s*begin\s*;\s*$/im.exec(normalized)
  const endingMatch = new RegExp(`^\\s*${ending}\\s*;\\s*$`, 'im')
  const endingMatches = [...normalized.matchAll(new RegExp(endingMatch.source, 'gim'))]

  if (!beginMatch || !commentsOnly(normalized.slice(0, beginMatch.index))) {
    throw new Error(`${label}: expected only comments before the outer BEGIN`)
  }
  if (endingMatches.length === 0) {
    throw new Error(`${label}: expected final ${ending.toUpperCase()}`)
  }

  const finalEnding = endingMatches.at(-1)
  if (!finalEnding || !commentsOnly(normalized.slice(finalEnding.index + finalEnding[0].length))) {
    throw new Error(`${label}: expected ${ending.toUpperCase()} to be the final statement`)
  }

  const bodyStart = beginMatch.index + beginMatch[0].length
  const body = normalized.slice(bodyStart, finalEnding.index).trim()
  if (!body) {
    throw new Error(`${label}: transaction body must not be empty`)
  }
  if (/^\s*(?:begin|commit|rollback)\s*;\s*$/im.test(body)) {
    throw new Error(`${label}: unexpected nested transaction boundary`)
  }

  return body
}

function readTransaction(path, ending, label) {
  return transactionBody(readFileSync(path, 'utf8'), ending, label)
}

function migrationIdentity(fileName) {
  const match = /^(\d{14})_(.+)\.sql$/.exec(fileName)
  if (!match) {
    throw new Error(`Unexpected migration filename: ${fileName}`)
  }
  return { version: match[1], name: match[2] }
}

function historyStatement(fileName, body, dollarTag) {
  const { version, name } = migrationIdentity(fileName)
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

function assertContains(source, expected, label) {
  if (!source.includes(expected)) {
    throw new Error(`${label}: required contract fragment is missing: ${expected}`)
  }
}

function validateGeneratedTransaction(sql, ending, label) {
  const boundaries = [...sql.matchAll(/^\s*(begin|commit|rollback)\s*;\s*$/gim)]
    .map((match) => match[1].toLowerCase())
  if (boundaries.length !== 2 || boundaries[0] !== 'begin' || boundaries[1] !== ending) {
    throw new Error(`${label}: generated SQL must contain one outer BEGIN and one final ${ending.toUpperCase()}`)
  }
  if (!new RegExp(`^\\s*${ending}\\s*;\\s*$`, 'i').test(sql.trim().split(/\r?\n/).at(-1) ?? '')) {
    throw new Error(`${label}: generated SQL has an unexpected final statement`)
  }
}

const migrationBody = readTransaction(paths.migration, 'commit', migrationName)
const regressionBody = readTransaction(paths.regression, 'rollback', regressionName)

assertContains(migrationBody, 'private.sygsphere_acknowledgments', migrationName)
assertContains(migrationBody, 'private.sygsphere_acknowledge_message', migrationName)
assertContains(migrationBody, "if action = 'acknowledge'", migrationName)
assertContains(regressionBody, 'private.sygsphere_acknowledgments', regressionName)
assertContains(regressionBody, "'acknowledge'", regressionName)

let output
let outputName
let ending
let description

if (mode === '--migration-rehearsal') {
  output = `begin;\n${migrationBody}\n\n${regressionBody}\nrollback;\n`
  outputName = 'sygsphere-message-acknowledgment-release-rehearsal.sql'
  ending = 'rollback'
  description = 'migration rollback-only rehearsal'
} else if (mode === '--migration-release') {
  const history = historyStatement(
    migrationName,
    migrationBody,
    '$sygsphere_acknowledgment_migration_source$',
  )
  output = `begin;\n${migrationBody}\n\n${history}\ncommit;\n`
  outputName = 'sygsphere-message-acknowledgment-release.sql'
  ending = 'commit'
  description = 'migration release'
} else {
  const recoveryBody = readTransaction(paths.recovery, 'commit', recoveryName)
  const recoveryRegressionBody = readTransaction(
    paths.recoveryRegression,
    'rollback',
    recoveryRegressionName,
  )

  assertContains(recoveryBody, 'drop function private.sygsphere_acknowledge_message', recoveryName)
  assertContains(recoveryBody, 'private.sygsphere_acknowledgments', recoveryName)
  assertContains(recoveryRegressionBody, 'private.sygsphere_acknowledgments', recoveryRegressionName)
  assertContains(recoveryRegressionBody, 'private.sygsphere_acknowledge_message', recoveryRegressionName)

  if (mode === '--recovery-rehearsal') {
    output = `begin;\n${migrationBody}\n\n${regressionBody}\n\n${recoveryBody}\n\n${recoveryRegressionBody}\nrollback;\n`
    outputName = 'sygsphere-message-acknowledgment-recovery-rehearsal.sql'
    ending = 'rollback'
    description = 'install-and-recovery rollback-only rehearsal'
  } else {
    const history = historyStatement(
      recoveryName,
      recoveryBody,
      '$sygsphere_acknowledgment_recovery_source$',
    )
    output = `begin;\n${recoveryBody}\n\n${history}\ncommit;\n`
    outputName = 'sygsphere-message-acknowledgment-recovery.sql'
    ending = 'commit'
    description = 'forward recovery release'
  }
}

validateGeneratedTransaction(output, ending, description)

const outputDirectory = resolve(root, 'tmp')
const outputPath = resolve(outputDirectory, outputName)
mkdirSync(outputDirectory, { recursive: true })
writeFileSync(outputPath, output)
console.log(`Prepared exact SygSphere message acknowledgment ${description} at ${outputPath}.`)
