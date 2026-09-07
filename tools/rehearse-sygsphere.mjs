import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const migration = readFileSync(resolve(root, 'supabase/migrations/20260907023825_sygsphere_messaging_foundation.sql'), 'utf8')
if (!/^begin;/i.test(migration.trim()) || !/commit;$/i.test(migration.trim())) throw new Error('Unexpected migration transaction shape')
const body = migration.trim().replace(/^begin;/i, '').replace(/commit;$/i, '')
if (/\b(?:begin|commit|rollback)\s*;/i.test(body)) throw new Error('Unexpected nested transaction')
const tests = readFileSync(resolve(root, 'tests/database/sygsphere-foundation.sql'), 'utf8')
mkdirSync(resolve(root, 'tmp'), { recursive: true })
writeFileSync(resolve(root, 'tmp/sygsphere-rehearsal.sql'), `begin;\n${body}\n${tests}\nrollback;\n`)
console.log('Prepared one rollback-only SygSphere rehearsal; no COMMIT is present.')
