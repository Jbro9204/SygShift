import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const rehearsal = process.argv.includes('--rehearsal')
const migrationName = '20261018231406_team_attendance_overtime_canonical_parity.sql'
const migrationPath = resolve(root, 'supabase', 'migrations', migrationName)
const regressionPaths = [
  'team_attendance_overnight_summary_regression.sql',
  'team_attendance_overtime_canonical_parity_regression.sql',
].map((name) => resolve(root, 'supabase', 'tests', name))

function transactionBody(source, ending) {
  const trimmed = source.trim()
  const beginIndex = trimmed.search(/^begin;\s*/im)
  const leadingLines = beginIndex < 0
    ? []
    : trimmed.slice(0, beginIndex).split(/\r?\n/).filter((line) => line.trim())

  if (
    beginIndex < 0
    || leadingLines.some((line) => !line.trimStart().startsWith('--'))
    || !new RegExp(`${ending};\\s*$`, 'i').test(trimmed)
  ) {
    throw new Error(`Unexpected transaction shape; expected BEGIN and final ${ending.toUpperCase()}`)
  }

  const body = trimmed.slice(beginIndex)
    .replace(/^begin;\s*/i, '')
    .replace(new RegExp(`${ending};\\s*$`, 'i'), '')

  if (/^\s*(?:begin|commit|rollback)\s*;/im.test(body)) {
    throw new Error('Unexpected nested transaction boundary')
  }

  return body
}

const migrationBody = transactionBody(readFileSync(migrationPath, 'utf8'), 'commit')
const regressionBody = regressionPaths
  .map((path) => transactionBody(readFileSync(path, 'utf8'), 'rollback'))
  .join('\n')
const version = migrationName.slice(0, 14)
const name = migrationName.slice(15, -4)
const history = `insert into supabase_migrations.schema_migrations(version, name, statements)
values (
  '${version}',
  '${name}',
  array[$team_attendance_ot_source$${migrationBody}$team_attendance_ot_source$]
);`

const output = rehearsal
  ? `begin;\nset local lock_timeout = '5s';\n${migrationBody}\n${regressionBody}\nrollback;\n`
  : `begin;\nset local lock_timeout = '5s';\n${migrationBody}\n${history}\ncommit;\n`

mkdirSync(resolve(root, 'tmp'), { recursive: true })
const outputPath = resolve(
  root,
  'tmp',
  rehearsal
    ? 'team-attendance-overtime-release-rehearsal.sql'
    : 'team-attendance-overtime-release.sql',
)

writeFileSync(outputPath, output)
console.log(`Prepared Team Attendance overtime ${rehearsal ? 'rollback-only rehearsal' : 'release'} transaction at ${outputPath}.`)
