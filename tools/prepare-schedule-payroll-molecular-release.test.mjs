import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildProductionArtifacts,
  buildRehearsalSql,
  concurrentMigrationFiles,
  migrationFiles,
  partialScheduleRecoveryFile,
  recoveryFiles,
  regressionFiles,
  transactionalMigrationFiles,
} from './prepare-schedule-payroll-molecular-release.mjs'
import {
  unwrapTransaction,
  validateGeneratedTransaction,
} from './prepare-stability-durability-release.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('release allowlists preserve exact migration order and separate online indexes', () => {
  assert.deepEqual(migrationFiles, [
    '20261026141835_schedule_draft_timeout_repair.sql',
    '20261026142017_schedule_draft_set_based_clone.sql',
    '20261026142340_payroll_review_single_pass_sources.sql',
    '20261026142700_bound_payroll_effective_event_source.sql',
    '20261026143200_canonical_timekeeping_review_contract.sql',
    '20261026151000_schedule_edit_copy_on_write.sql',
    '20261026165217_timekeeping_due_shift_index.sql',
    '20261026165218_timekeeping_employee_shift_event_index.sql',
    '20261026165219_scheduled_runtime_molecular_repair.sql',
    '20261026170133_scheduled_runtime_index_postflight.sql',
  ])
  assert.deepEqual(concurrentMigrationFiles, [migrationFiles[0], migrationFiles[6], migrationFiles[7]])
  assert.equal(transactionalMigrationFiles.length, 7)
  assert.deepEqual(recoveryFiles, [
    '20261026165219_scheduled_runtime_molecular_repair.sql',
    '20261026165218_timekeeping_employee_shift_event_index.sql',
    '20261026165217_timekeeping_due_shift_index.sql',
    '20261026151000_schedule_edit_copy_on_write.sql',
    '20261026143200_canonical_timekeeping_review_contract.sql',
    '20261026142700_bound_payroll_effective_event_source.sql',
    '20261026142340_payroll_review_single_pass_sources.sql',
    '20261026141835_schedule_draft_timeout_repair.sql',
  ])
  assert.equal(
    partialScheduleRecoveryFile,
    '20261026142017_schedule_draft_set_based_clone.sql',
  )
  for (const fileName of [...recoveryFiles, partialScheduleRecoveryFile]) {
    assert.ok(readFileSync(resolve(root, 'supabase', 'recovery', fileName), 'utf8').trim())
  }
})

test('production artifacts keep concurrent indexes outside transactions and ledger all ten exact sources', () => {
  const artifacts = buildProductionArtifacts({ root })
  assert.deepEqual([...artifacts.keys()], [
    '01-20261026141835_schedule_draft_timeout_repair.sql',
    '02-20261026141835_schedule_draft_timeout_repair-ledger.sql',
    '03-schedule-payroll-transaction.sql',
    '04-20261026165217_timekeeping_due_shift_index.sql',
    '05-20261026165217_timekeeping_due_shift_index-ledger.sql',
    '06-20261026165218_timekeeping_employee_shift_event_index.sql',
    '07-20261026165218_timekeeping_employee_shift_event_index-ledger.sql',
    '08-runtime-transaction.sql',
  ])
  for (const fileName of concurrentMigrationFiles) {
    const prefix = [...artifacts.keys()].find((name) => name.endsWith(fileName))
    const source = artifacts.get(prefix)
    assert.match(source, /create index concurrently/iu)
    assert.doesNotMatch(source, /supabase_migrations\.schema_migrations/iu)
    assert.doesNotMatch(source, /^\s*begin\s*;/iu)
  }
  const combined = [...artifacts.values()].join('\n')
  assert.equal((combined.match(/insert into supabase_migrations\.schema_migrations/giu) ?? []).length, 10)
  for (const fileName of migrationFiles) {
    const version = fileName.slice(0, 14)
    const name = fileName.slice(15, -4)
    assert.match(combined, new RegExp(`'${version}',\\s*'${name}'`, 'u'))
    const source = readFileSync(resolve(root, 'supabase', 'migrations', fileName), 'utf8')
      .replace(/^\uFEFF/u, '')
    const exactLedgerSource = concurrentMigrationFiles.includes(fileName)
      ? source.trim()
      : unwrapTransaction(source, 'commit', fileName)
    const tag = `$sygshift_molecular_${version}$`
    assert.ok(
      combined.includes(`array[${tag}${exactLedgerSource}${tag}]`),
      `${fileName} must be inserted into the migration ledger from its exact reviewed source`,
    )
  }
  for (const fileName of regressionFiles) assert.doesNotMatch(combined, new RegExp(`-- Regression: ${fileName}`, 'u'))
  for (const [fileName, sql] of artifacts) {
    if (fileName.includes('-ledger.') || fileName.includes('-transaction.')) {
      validateGeneratedTransaction(sql, 'commit', fileName)
      assert.match(sql, /pg_advisory_xact_lock/iu)
    }
  }
  assert.match(
    artifacts.get('05-20261026165217_timekeeping_due_shift_index-ledger.sql'),
    /Required migration version\(s\) are not registered/iu,
  )
  assert.match(
    artifacts.get('07-20261026165218_timekeeping_employee_shift_event_index-ledger.sql'),
    /'20261026165217'/u,
  )
})

test('rollback-only rehearsal includes transactional migrations and regressions but never ledgers or concurrent DDL', () => {
  const sql = buildRehearsalSql({ root })
  validateGeneratedTransaction(sql, 'rollback')
  for (const fileName of transactionalMigrationFiles) assert.match(sql, new RegExp(`-- Migration: ${fileName}`, 'u'))
  for (const fileName of concurrentMigrationFiles) assert.doesNotMatch(sql, new RegExp(`-- Migration: ${fileName}`, 'u'))
  for (const fileName of regressionFiles) assert.match(sql, new RegExp(`-- Regression: ${fileName}`, 'u'))
  assert.doesNotMatch(sql, /create\s+index\s+concurrently/iu)
  assert.doesNotMatch(sql, /insert into supabase_migrations\.schema_migrations/iu)
  assert.match(sql, /Online index public\.shifts_timekeeping_due_end_idx does not match/iu)
})
