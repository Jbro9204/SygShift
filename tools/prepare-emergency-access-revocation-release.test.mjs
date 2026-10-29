import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildEmergencyAccessRevocationArtifact,
  expectedMigrationSha256,
  expectedPreFunctionContracts,
  migrationFile,
  migrationLedgerTag,
  migrationName,
  migrationVersion,
  regressionFiles,
} from './prepare-emergency-access-revocation-release.mjs'
import { validateGeneratedTransaction } from './sql-transaction-boundary.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrationSource = readFileSync(
  resolve(root, 'supabase', 'migrations', migrationFile),
  'utf8',
)

function assertSharedReleaseBoundary(sql) {
  assert.match(sql, /set local lock_timeout = '5s';/u)
  assert.match(sql, /set local statement_timeout = '3min';/u)
  assert.match(sql, /pg_advisory_xact_lock/iu)
  assert.match(sql, new RegExp(`applied\\.version = '${migrationVersion}'`, 'u'))
  assert.match(sql, new RegExp(`applied\\.name = '${migrationName}'`, 'u'))
  assert.match(sql, /candidate objects already exist without the reviewed ledger entry/iu)

  for (const [, md5] of expectedPreFunctionContracts) {
    assert.match(sql, new RegExp(md5, 'u'))
  }

  assert.match(sql, /Pre-release function fingerprint or security metadata drifted/iu)
  assert.match(sql, /Required pre-release column drifted/iu)
  assert.match(sql, /personal-first external recovery delivery contract drifted/iu)
  assert.match(sql, /relrowsecurity/iu)
  assert.match(sql, /relforcerowsecurity/iu)
  assert.match(sql, /Service-only RPC execution boundary drifted/iu)
  assert.match(sql, /append-only emergency evidence triggers are missing or disabled/iu)
  assert.match(sql, /auth_tokens_invalid_before_epoch/iu)
  assert.match(sql, /auth\.refresh_tokens/iu)
  assert.match(sql, /feature_not_supported/iu)

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

function withTemporaryRoot(migrationTransform, callback) {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'sygshift-emergency-release-'))
  const migrationDirectory = resolve(temporaryRoot, 'supabase', 'migrations')
  const testDirectory = resolve(temporaryRoot, 'supabase', 'tests')
  mkdirSync(migrationDirectory, { recursive: true })
  mkdirSync(testDirectory, { recursive: true })
  writeFileSync(
    resolve(migrationDirectory, migrationFile),
    migrationTransform(migrationSource),
  )
  for (const fileName of regressionFiles) {
    copyFileSync(
      resolve(root, 'supabase', 'tests', fileName),
      resolve(testDirectory, fileName),
    )
  }
  try {
    callback(temporaryRoot)
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

test('reviewed migration source digest and allowlists are exact', () => {
  assert.equal(
    createHash('sha256').update(migrationSource).digest('hex'),
    expectedMigrationSha256,
  )
  assert.deepEqual(regressionFiles, [
    'emergency_access_revocation_control_plane_regression.sql',
    'atomic_primary_role_access_profiles_regression.sql',
  ])
  assert.equal(expectedPreFunctionContracts.length, 9)
})

test('rollback-only rehearsal exercises exact ledger and both SQL regressions', () => {
  const sql = buildEmergencyAccessRevocationArtifact({ root, mode: 'rehearsal' })
  validateGeneratedTransaction(sql, 'rollback')
  assertSharedReleaseBoundary(sql)
  assert.match(sql, new RegExp(`-- Migration: ${migrationFile}`, 'u'))
  for (const fileName of regressionFiles) {
    assert.match(sql, new RegExp(`-- Regression: ${fileName}`, 'u'))
  }
  assert.match(sql, /rollback;\s*$/u)
})

test('atomic release commits exact source without executing regression fixtures', () => {
  const sql = buildEmergencyAccessRevocationArtifact({ root, mode: 'release' })
  validateGeneratedTransaction(sql, 'commit')
  assertSharedReleaseBoundary(sql)
  assert.match(sql, new RegExp(`-- Migration: ${migrationFile}`, 'u'))
  for (const fileName of regressionFiles) {
    assert.doesNotMatch(sql, new RegExp(`-- Regression: ${fileName}`, 'u'))
  }
  assert.match(sql, /commit;\s*$/u)
})

test('generator rejects an unknown mode before rendering an artifact', () => {
  assert.throws(
    () => buildEmergencyAccessRevocationArtifact({ root, mode: 'preview' }),
    /Choose exactly one mode: rehearsal or release/u,
  )
})

test('generator rejects migration source drift', () => {
  withTemporaryRoot(
    (source) => source.replace(
      '-- Emergency revocation is deliberately separate from employment status.',
      '-- Unreviewed source drift.',
    ),
    (temporaryRoot) => {
      assert.throws(
        () => buildEmergencyAccessRevocationArtifact({
          root: temporaryRoot,
          mode: 'release',
        }),
        /source SHA-256 drifted from the reviewed release candidate/u,
      )
    },
  )
})

test('generator rejects migration source that collides with its ledger tag', () => {
  withTemporaryRoot(
    (source) => source.replace('begin;', `begin;\n-- ${migrationLedgerTag}`),
    (temporaryRoot) => {
      assert.throws(
        () => buildEmergencyAccessRevocationArtifact({
          root: temporaryRoot,
          mode: 'release',
        }),
        /source collides with migration-history dollar tag/u,
      )
    },
  )
})
