import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supervisorRecordTimeEvent } from './data/timekeeping'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('./lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc }),
}))

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260823170000_manual_time_event_site_post.sql'),
  'utf8',
)

const employeeId = '73000000-0000-4000-8000-000000000001'
const shiftId = '73000000-0000-4000-8000-000000000002'

function savedEvent(selectedShiftId: string | null) {
  return {
    effectiveAt: '2026-08-21T12:00:00.000Z',
    id: '73000000-0000-4000-8000-000000000003',
    kind: 'clock_out',
    recordedAt: '2026-08-21T12:00:00.000Z',
    shiftId: selectedShiftId,
    source: 'supervisor',
    voided: false,
  }
}

describe('manual time event Site/Post workflow', () => {
  beforeEach(() => rpc.mockReset())

  it('saves a scheduled Site/Post with the new punch in one RPC call', async () => {
    rpc.mockResolvedValueOnce({ data: savedEvent(shiftId), error: null })

    await supervisorRecordTimeEvent({
      effectiveAt: '2026-08-21T12:00:00.000Z',
      employeeId,
      kind: 'clock_out',
      reason: 'Verified missing clock-out.',
      shiftId,
    })

    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenCalledWith('supervisor_record_time_event_with_location', expect.objectContaining({
      target_employee_id: employeeId,
      target_location_name: null,
      target_reason: 'Verified missing clock-out.',
      target_shift_id: shiftId,
      target_time_zone: 'America/Denver',
    }))
  })

  it('saves a verified other location in the same audited transaction', async () => {
    rpc.mockResolvedValueOnce({ data: savedEvent(null), error: null })

    await supervisorRecordTimeEvent({
      effectiveAt: '2026-08-21T12:00:00.000Z',
      employeeId,
      kind: 'clock_out',
      locationName: 'Verified client location',
      reason: 'Coverage was confirmed by Dispatch.',
    })

    expect(rpc).toHaveBeenCalledWith('supervisor_record_time_event_with_location', expect.objectContaining({
      target_location_name: 'Verified client location',
      target_shift_id: null,
    }))
  })

  it('keeps permissions and both location paths enforced at the database boundary', () => {
    expect(migration).toContain("private.timekeeping_require_permission('time.manage')")
    expect(migration).toContain("Choose one Site/Post or enter one verified other location.")
    expect(migration).toContain('insert into public.time_event_location_overrides')
    expect(migration).toContain('insert into public.time_event_maintenance_notes')
    expect(migration).toContain('revoke all on function public.supervisor_record_time_event_with_location')
  })
})
