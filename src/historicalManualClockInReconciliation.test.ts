/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supervisorRecordTimeEvent } from './data/timekeeping'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('./lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc }),
}))

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260825103000_historical_manual_clock_in_reconciliation.sql'),
  'utf8',
)

const employeeId = '75000000-0000-4000-8000-000000000001'
const shiftId = '75000000-0000-4000-8000-000000000002'
const clockInId = '75000000-0000-4000-8000-000000000003'
const clockOutId = '75000000-0000-4000-8000-000000000004'

describe('historical supervisor clock-in reconciliation', () => {
  beforeEach(() => rpc.mockReset())

  it('returns the scheduled automatic clock-out so maintenance can confirm it immediately', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        automaticClockOutAt: '2026-08-24T10:00:00.000Z',
        automaticClockOutEventId: clockOutId,
        effectiveAt: '2026-08-24T04:00:00.000Z',
        id: clockInId,
        kind: 'clock_in',
        recordedAt: '2026-08-24T04:00:00.000Z',
        shiftId,
        source: 'supervisor',
        voided: false,
      },
      error: null,
    })

    const saved = await supervisorRecordTimeEvent({
      effectiveAt: '2026-08-24T04:00:00.000Z',
      employeeId,
      kind: 'clock_in',
      reason: 'Verified historical timecard.',
      shiftId,
    })

    expect(saved.automaticClockOutEventId).toBe(clockOutId)
    expect(saved.automaticClockOutAt).toBe('2026-08-24T10:00:00.000Z')
  })

  it('reconciles the clock-out atomically and preserves the existing review workflow', () => {
    expect(migration).toContain("target_kind = 'clock_in'")
    expect(migration).toContain("'automatic_clock_out'")
    expect(migration).toContain('insert into public.timekeeping_operational_exceptions')
    expect(migration).toContain('insert into public.timekeeping_operational_exception_actions')
    expect(migration).toContain('insert into private.notification_outbox')
    expect(migration).not.toContain('update public.time_events')
    expect(migration).not.toContain('delete from public.time_events')
  })

  it('serializes maintenance and blocks duplicate clock-outs at the database boundary', () => {
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('That punch already exists for this employee and Site/Post.')
    expect(migration).toContain('This work session already has a clock-out.')
    expect(migration).toContain('Review or correct the existing clock-out instead of adding a duplicate.')
  })
})
