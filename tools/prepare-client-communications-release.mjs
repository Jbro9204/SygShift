import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const arguments_ = process.argv.slice(2)
const validModes = new Set(['--release', '--rehearsal'])
if (arguments_.length !== 1 || !validModes.has(arguments_[0])) {
  throw new Error('Choose exactly one mode: --rehearsal or --release')
}
const rehearsal = arguments_[0] === '--rehearsal'
const migrationName = '20261008124500_client_sygsphere_communications_workspace.sql'
const regressionName = 'client_sygsphere_communications_workspace_regression.sql'
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
  array[$client_communications_source$${migrationBody}$client_communications_source$]
);`

const output = rehearsal
  ? `begin;\nset local lock_timeout = '5s';\n${migrationBody}\n${regressionBody}\nrollback;\n`
  : `begin;\nset local lock_timeout = '5s';\n${migrationBody}\n${history}\ncommit;\n`

mkdirSync(resolve(root, 'tmp'), { recursive: true })
const outputPath = resolve(root, 'tmp', rehearsal
  ? 'client-communications-release-rehearsal.sql'
  : 'client-communications-release.sql')
writeFileSync(outputPath, output)
console.log(`Prepared exact Client Communications ${rehearsal ? 'rollback-only rehearsal' : 'release'} transaction at ${outputPath}.`)
