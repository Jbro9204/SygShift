import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const rehearsal = process.argv.includes('--rehearsal')
const migrationName = '20260928021235_vacancy_patrol_service_recovery.sql'
const regressionName = 'vacancy_patrol_service_recovery_regression.sql'
const migrationPath = resolve(root, 'supabase', 'migrations', migrationName)
const regressionPath = resolve(root, 'supabase', 'tests', regressionName)

function transactionBody(source, ending) {
  const trimmed = source.trim()
  if (!/^begin;\s*/i.test(trimmed) || !new RegExp(`${ending};\\s*$`, 'i').test(trimmed)) {
    throw new Error(`Unexpected transaction shape; expected BEGIN and final ${ending.toUpperCase()}`)
  }
  const body = trimmed
    .replace(/^begin;\s*/i, '')
    .replace(new RegExp(`${ending};\\s*$`, 'i'), '')
  if (/^\s*(?:begin|commit|rollback)\s*;/im.test(body)) {
    throw new Error('Unexpected nested transaction boundary')
  }
  return body
}

const migrationSource = readFileSync(migrationPath, 'utf8')
const migrationBody = transactionBody(migrationSource, 'commit')
const regressionBody = transactionBody(readFileSync(regressionPath, 'utf8'), 'rollback')
const version = migrationName.slice(0, 14)
const name = migrationName.slice(15, -4)
const history = `insert into supabase_migrations.schema_migrations(version, name, statements)
values (
  '${version}',
  '${name}',
  array[$vacancy_patrol_source$${migrationBody}$vacancy_patrol_source$]
);`

const output = rehearsal
  ? `begin;\nset local lock_timeout = '5s';\n${migrationBody}\n${regressionBody}\nrollback;\n`
  : `begin;\nset local lock_timeout = '5s';\n${migrationBody}\n${history}\ncommit;\n`

mkdirSync(resolve(root, 'tmp'), { recursive: true })
const outputPath = resolve(root, 'tmp', rehearsal
  ? 'vacancy-patrol-release-rehearsal.sql'
  : 'vacancy-patrol-release.sql')
writeFileSync(outputPath, output)
console.log(`Prepared exact Vacancy Patrol ${rehearsal ? 'rollback-only rehearsal' : 'release'} transaction at ${outputPath}.`)
