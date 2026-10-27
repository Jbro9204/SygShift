import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildAnnouncementBannerContractArtifact,
  expectedPreFunctionMd5,
  migrationFile,
  migrationLedgerTag,
  migrationName,
  migrationVersion,
  regressionFile,
} from './prepare-announcement-banner-contract-release.mjs'
import { validateGeneratedTransaction } from './sql-transaction-boundary.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrationSource = readFileSync(
  resolve(root, 'supabase', 'migrations', migrationFile),
  'utf8',
)

function assertSharedReleaseBoundary(sql) {
  assert.match(sql, /set local lock_timeout = '5s';/u)
  assert.match(sql, /set local statement_timeout = '2min';/u)
  assert.match(sql, /pg_advisory_xact_lock/iu)
  assert.match(sql, new RegExp(`applied\\.version = '${migrationVersion}'`, 'u'))
  assert.match(sql, new RegExp(`applied\\.name = '${migrationName}'`, 'u'))
  assert.match(sql, new RegExp(expectedPreFunctionMd5, 'u'))
  assert.match(sql, /owner_name is distinct from 'postgres'/u)
  assert.match(sql, /security_definer is distinct from true/u)
  assert.match(sql, /volatility is distinct from 's'/u)
  assert.match(sql, /configuration is distinct from array\['search_path=""'\]::text\[\]/u)
  assert.match(sql, /access_control is distinct from '\{postgres=X\/postgres\}'/u)
  assert.equal(
    (sql.match(/insert into supabase_migrations\.schema_migrations/giu) ?? []).length,
    1,
  )
  assert.ok(
    sql.includes(`array[${migrationLedgerTag}${migrationSource}${migrationLedgerTag}]`),
    'the ledger must contain the exact full migration source as one array element',
  )
  assert.match(sql, /cardinality\(recorded_statements\) is distinct from 1/u)
  assert.ok(
    sql.includes(
      `recorded_statements[1] is distinct from ${migrationLedgerTag}${migrationSource}${migrationLedgerTag}`,
    ),
    'the ledger postflight must compare the exact full migration source',
  )
}

test('rollback-only rehearsal exercises the atomic ledger path and mixed-feed regression', () => {
  const sql = buildAnnouncementBannerContractArtifact({ root, mode: 'rehearsal' })
  validateGeneratedTransaction(sql, 'rollback')
  assertSharedReleaseBoundary(sql)
  assert.match(sql, new RegExp(`-- Migration: ${migrationFile}`, 'u'))
  assert.match(sql, new RegExp(`-- Regression: ${regressionFile}`, 'u'))
  assert.match(sql, /rollback;\s*$/u)
  assert.doesNotMatch(sql, /commit;\s*$/u)
})

test('release is one atomic transaction with a final commit and no fixture regression', () => {
  const sql = buildAnnouncementBannerContractArtifact({ root, mode: 'release' })
  validateGeneratedTransaction(sql, 'commit')
  assertSharedReleaseBoundary(sql)
  assert.match(sql, new RegExp(`-- Migration: ${migrationFile}`, 'u'))
  assert.doesNotMatch(sql, new RegExp(`-- Regression: ${regressionFile}`, 'u'))
  assert.match(sql, /commit;\s*$/u)
  assert.doesNotMatch(sql, /rollback;\s*$/u)
})

test('generator rejects an unrecognized mode before rendering an artifact', () => {
  assert.throws(
    () => buildAnnouncementBannerContractArtifact({ root, mode: 'preview' }),
    /Choose exactly one mode: rehearsal or release/u,
  )
})
