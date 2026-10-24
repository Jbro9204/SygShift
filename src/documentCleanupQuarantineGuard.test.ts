import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261024170000_quarantine_document_cleanup_retries.sql'),
  'utf8',
)
const regression = readFileSync(
  join(process.cwd(), 'supabase/tests/document_cleanup_quarantine_regression.sql'),
  'utf8',
)

describe('client and licensing cleanup quarantine', () => {
  it('uses bounded retry work, exact audit counters, explicit availability, and quarantine instead of a hot-looping FIFO head', () => {
    expect(migration).toContain('check (cleanup_attempt_count >= 0)')
    expect(migration).not.toContain('cleanup_attempt_count = least(document.cleanup_attempt_count, 20)')
    expect(migration).not.toContain('set cleanup_attempt_count = 20')
    expect(migration).toContain('when document_record.cleanup_attempt_count >= 20 then document_record.cleanup_attempt_count')
    expect(migration).toContain('cleanup_available_at timestamptz')
    expect(migration).toContain('cleanup_quarantined_at timestamptz')
    expect(migration).toContain('failed.cleanup_quarantined_at is null')
    expect(migration).toContain('failed.cleanup_attempt_count < 20')
    expect(migration).toContain('coalesce(failed.cleanup_available_at, failed.cleanup_pending_at) <= clock_timestamp()')
    expect(migration).not.toContain('2 ^')
  })

  it('keeps both cleanup APIs service-only and never equates quarantine with deletion', () => {
    expect(migration).toContain('service_defer_client_document_cleanup')
    expect(migration).toContain('service_defer_licensing_document_cleanup')
    expect(migration).toContain('from public, anon, authenticated;')
    expect(migration).toContain('to service_role;')
    expect(migration).toContain('cleanupQuarantined')
    expect(migration).toContain('cleaned_at = coalesce(document.cleaned_at, clock_timestamp())')
  })

  it('ships rollback-only poison-row isolation regressions for both queues', () => {
    expect(regression.trimStart()).toContain('begin;')
    expect(regression.trimEnd().endsWith('rollback;')).toBe(true)
    expect(regression).toContain('A later eligible client cleanup remains reachable')
    expect(regression).toContain('A later eligible licensing cleanup remains reachable')
    expect(regression).toContain('never claim licensing-object deletion')
  })
})
