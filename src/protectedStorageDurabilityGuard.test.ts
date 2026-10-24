import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261024163000_protected_storage_artifact_recovery.sql'),
  'utf8',
)
const regression = readFileSync(
  join(process.cwd(), 'supabase/tests/profile_signature_storage_durability_regression.sql'),
  'utf8',
)
const retrySaturationMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261024169000_quarantine_protected_storage_cleanup_retries.sql'),
  'utf8',
)
const retrySaturationRegression = readFileSync(
  join(process.cwd(), 'supabase/tests/protected_storage_cleanup_retry_saturation_regression.sql'),
  'utf8',
)
const claimReceiptMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261024174000_protected_storage_cleanup_claim_receipts.sql'),
  'utf8',
)
const claimReceiptRegression = readFileSync(
  join(process.cwd(), 'supabase/tests/protected_storage_cleanup_claim_receipts_regression.sql'),
  'utf8',
)

function migrationSection(start: string, end: string): string {
  const startIndex = migration.indexOf(start)
  const endIndex = migration.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return migration.slice(startIndex, endIndex)
}

describe('protected storage durability migration', () => {
  it('keeps cleanup identities private and reclaims leases without destructive ambiguity', () => {
    expect(migration).toContain('create table if not exists private.protected_storage_cleanup_jobs')
    expect(migration).toContain('alter table private.protected_storage_cleanup_jobs enable row level security;')
    expect(migration).toContain('revoke all on table private.protected_storage_cleanup_jobs from public, anon, authenticated;')
    expect(migration).toContain("where cleanup.status = 'processing'")
    expect(migration).toContain("cleanup.leased_at <= clock_timestamp() - interval '10 minutes'")
    expect(migration).toContain("set status = 'cancelled'")
    expect(migration).toContain("where employee.id = cleanup.employee_id and employee.photo_path = cleanup.object_key")
    expect(migration).toContain('service_defer_protected_storage_cleanup_v2')
    expect(migration).toContain('service_complete_protected_storage_cleanup_v2')
    expect(migration).toContain('service_reconcile_stale_employee_photo_uploads_v2')
  })

  it('fences signature adoption and all signature artifact cleanup in the database', () => {
    const action = migrationSection(
      'create or replace function public.service_record_signature_action_v2(',
      'create or replace function public.service_reconcile_signature_appearance_v2(',
    )
    const recipientLock = action.indexOf('from private.signature_recipients recipient')
    const operationLock = action.indexOf('from private.signature_appearance_operations operation', recipientLock)
    const recordAction = action.indexOf('public.service_record_signature_action(', operationLock)
    const authoritative = action.indexOf("set status = 'authoritative'", recordAction)

    expect(recipientLock).toBeGreaterThanOrEqual(0)
    expect(operationLock).toBeGreaterThan(recipientLock)
    expect(recordAction).toBeGreaterThan(operationLock)
    expect(authoritative).toBeGreaterThan(recordAction)
    expect(action).toContain("operation_record.status not in ('prepared', 'authoritative')")
    expect(migration).toContain("'signature_appearance'")
    expect(migration).toContain("'signature_final_pdf'")
    expect(migration).toContain("'signature_certificate'")
    expect(migration).toContain('service_schedule_signature_artifact_cleanup_v2')
    expect(migration).toContain('service_fail_signature_finalization_v2')
  })

  it('ships rollback-only service-boundary, retry, stale-CAS, and no-delete regressions', () => {
    expect(regression.trimStart()).toContain('begin;')
    expect(regression.trimEnd().endsWith('rollback;')).toBe(true)
    expect(regression).toContain("'anon'")
    expect(regression).toContain("'authenticated'")
    expect(regression).toContain("'service_role'")
    expect(regression).toContain('A valid A to B to A sequence receives a new operation identity.')
    expect(regression).toContain('A serialized stale completion cannot overwrite the newer winner.')
    expect(regression).toContain('A stale DELETE cannot clear a photo installed by a concurrent PUT.')
    expect(regression).toContain('Database-only reconciliation never claims external deletion succeeded.')
  })

  it('saturates cleanup retries without overflow or poison-row starvation', () => {
    expect(retrySaturationMigration).toContain("'quarantined'")
    expect(retrySaturationMigration).toContain('cleanup.attempt_count < 20')
    expect(retrySaturationMigration).toContain('when cleanup.attempt_count >= 20 then')
    expect(retrySaturationMigration).not.toContain('2 ^')
    expect(retrySaturationRegression.trimStart()).toContain('begin;')
    expect(retrySaturationRegression.trimEnd().endsWith('rollback;')).toBe(true)
    expect(retrySaturationRegression).toContain('2147483640')
    expect(retrySaturationRegression).toContain('A very high attempt count quarantines without overflowing')
    expect(retrySaturationRegression).toContain('Retry quarantine never falsely records protected-object deletion.')
  })

  it('counts real cleanup failures rather than claims and safely replays exact lease results', () => {
    const claimStart = claimReceiptMigration.indexOf('with candidates as (')
    const deferStart = claimReceiptMigration.indexOf(
      'create or replace function public.service_defer_protected_storage_cleanup_v2(',
    )
    expect(claimStart).toBeGreaterThanOrEqual(0)
    expect(deferStart).toBeGreaterThan(claimStart)
    const claimSection = claimReceiptMigration.slice(claimStart, deferStart)

    expect(claimSection).not.toContain('attempt_count = cleanup.attempt_count + 1')
    expect(claimSection).toContain("'attemptCount', least(2147483647::bigint, updated.attempt_count::bigint + 1)::integer")
    expect(claimSection).toContain('last_result_lease_owner = null')
    expect(claimReceiptMigration).toContain('last_result_outcome in (\'deferred\', \'completed\')')
    expect(claimReceiptMigration).toContain('next_attempt := case')
    expect(claimReceiptMigration).toContain('attempt_count = next_attempt')
    expect(claimReceiptMigration).toContain("cleanup_record.last_result_outcome = 'deferred'")
    expect(claimReceiptMigration).toContain("cleanup_record.last_result_outcome = 'completed'")
    expect(claimReceiptMigration).toContain('The cleanup lease already recorded a conflicting result.')

    expect(claimReceiptRegression.trimStart()).toContain('-- Rollback-only regression')
    expect(claimReceiptRegression.trimEnd().endsWith('rollback;')).toBe(true)
    expect(claimReceiptRegression).toContain('for index in 1..21 loop')
    expect(claimReceiptRegression).toContain('for index in 1..20 loop')
    expect(claimReceiptRegression).toContain('A claim response loss never consumes a cleanup attempt.')
    expect(claimReceiptRegression).toContain('An exact deferred-result replay records one and only one real failure.')
    expect(claimReceiptRegression).toContain('An exact completion replay is idempotent after response loss.')
    expect(claimReceiptRegression).toContain('An exact result from a superseded lease fails closed.')
  })
})
