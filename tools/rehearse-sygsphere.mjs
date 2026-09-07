import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const installed = process.argv.includes('--installed')
const names = ['20260907023825_sygsphere_messaging_foundation.sql', '20260907025451_sygsphere_private_attachments.sql']
const body = names.map((name) => {
  const migration = readFileSync(resolve(root, `supabase/migrations/${name}`), 'utf8').trim()
  if (!/^begin;/i.test(migration) || !/commit;$/i.test(migration)) throw new Error('Unexpected migration transaction shape')
  const sql = migration.replace(/^begin;/i, '').replace(/commit;$/i, '')
  if (/\b(?:begin|commit|rollback)\s*;/i.test(sql)) throw new Error('Unexpected nested transaction')
  return sql
}).join('\n')
const tests = ['sygsphere-foundation.sql', 'sygsphere-files.sql'].map((name) => readFileSync(resolve(root, `tests/database/${name}`), 'utf8')).join('\n')
mkdirSync(resolve(root, 'tmp'), { recursive: true })
writeFileSync(resolve(root, installed ? 'tmp/sygsphere-installed-check.sql' : 'tmp/sygsphere-rehearsal.sql'), `begin;\n${installed ? '' : body}\n${tests}\nrollback;\n`)
console.log(`Prepared one rollback-only SygSphere ${installed ? 'installed-function check' : 'rehearsal'}; no COMMIT is present.`)
