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

  it('accepts an idempotent retry that returns the original event and call-off workflow', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        id: '10000000-0000-4000-8000-000000000010',
        employeeId: '10000000-0000-4000-8000-000000000001',
        shiftId: '10000000-0000-4000-8000-000000000011',
        eventType: 'call_off',
        status: 'reported',
        operationalDate: '2026-09-29',
        createdAt: '2026-09-30T00:36:15.000Z',
        callOffId: '10000000-0000-4000-8000-000000000012',
        coverageRequired: true,
        created: false,
        alreadyRecorded: true,
      },
      error: null,
    })

    await expect(createAccountabilityOccurrence({
      employeeId: '10000000-0000-4000-8000-000000000001',
      shiftId: '10000000-0000-4000-8000-000000000011',
      eventType: 'call_off',
      operationalDate: null,
      note: 'Dispatcher retry after the schedule was republished.',
    })).resolves.toMatchObject({
      id: '10000000-0000-4000-8000-000000000010',
      callOffId: '10000000-0000-4000-8000-000000000012',
      created: false,
      alreadyRecorded: true,
    })
  })

  it('gives a recoverable instruction when the selected assignment changed', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '23514',
        message: 'The selected shift changed and no single current assignment could be resolved.',
      },
    })

    const failure = await createAccountabilityOccurrence({
      employeeId: '10000000-0000-4000-8000-000000000001',
      shiftId: '10000000-0000-4000-8000-000000000011',
      eventType: 'call_off',
      operationalDate: null,
      note: 'Dispatcher retry after the schedule was republished.',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'The schedule changed while this form was open. Your entries are still here; refresh the shift list and choose the current assignment.',
    )
    expect((failure as Error).message).not.toContain('23514')
  })

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
