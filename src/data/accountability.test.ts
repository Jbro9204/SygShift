import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAccountabilityOccurrence,
  getAccountabilityWorkspace,
  getAttendanceReport,
  reclassifyAccountabilityOccurrence,
  reviewAccountabilityOccurrence,
} from './accountability'

const supabaseMock = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc: supabaseMock.rpc }),
}))

describe('accountability data error boundary', () => {
  beforeEach(() => supabaseMock.rpc.mockReset())

  it.each([
    {
      run: () => createAccountabilityOccurrence({
        employeeId: '10000000-0000-4000-8000-000000000001',
        shiftId: null,
        eventType: 'other',
        operationalDate: '2026-09-11',
        note: 'Regression fixture',
      }),
      message: 'The occurrence could not be recorded. Your entries are still here; please try again.',
    },
    {
      run: () => reviewAccountabilityOccurrence({
        eventId: '10000000-0000-4000-8000-000000000002',
        action: 'confirmed',
        reason: 'Regression fixture',
      }),
      message: 'The accountability decision could not be saved. Your reason is still here; please try again.',
    },
    {
      run: () => reclassifyAccountabilityOccurrence({
        eventId: '10000000-0000-4000-8000-000000000002',
        eventType: 'late_arrival',
        reason: 'Regression fixture',
      }),
      message: 'The occurrence type could not be updated. Your reason is still here; please try again.',
    },
    {
      run: () => getAccountabilityWorkspace({ fromDate: '2026-09-01', throughDate: '2026-09-11' }),
      message: 'The Accountability Tracker could not be loaded. Refresh the page and try again.',
    },
    {
      run: () => getAttendanceReport({ fromDate: '2026-09-01', throughDate: '2026-09-11' }),
      message: 'The attendance report could not be loaded. Refresh the page and try again.',
    },
  ])('keeps raw database diagnostics out of the interface', async ({ run, message }) => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42702', message: 'column reference "notification_id" is ambiguous' },
    })

    const failure = await run().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(message)
    expect((failure as Error).message).not.toContain('notification_id')
  })
})
