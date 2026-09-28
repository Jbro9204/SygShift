import { beforeEach, describe, expect, it, vi } from 'vitest'

const supabaseMocks = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc: supabaseMocks.rpc }),
}))

import { getRequestCenter, getTimeOffRequestContext } from './requests'

describe('request-center payload mapping', () => {
  beforeEach(() => {
    supabaseMocks.rpc.mockReset().mockResolvedValue({
      error: null,
      data: {
        employeeId: '10000000-0000-4000-8000-000000000001',
        employeeTimeZone: 'America/New_York',
        role: 'supervisor',
        permissions: { canManage: true },
        timeOffHistory: { managerHistoryLimit: 100, truncated: true },
        timeOff: [{
          id: '20000000-0000-4000-8000-000000000001',
          employeeId: '30000000-0000-4000-8000-000000000001',
          employeeName: 'Alex Guard',
          employeeNumber: 'SYG-1041',
          startsOn: '2099-10-12',
          endsOn: '2099-10-14',
          partialDayStart: null,
          partialDayEnd: null,
          requestType: 'sick_time',
          employmentType: 'hourly',
          payTreatment: 'sick_policy',
          requestedMinutes: 960,
          returnOn: '2099-10-15',
          affectedShiftCount: 1,
          affectedShifts: [{
            shiftId: '40000000-0000-4000-8000-000000000001',
            assignmentId: '50000000-0000-4000-8000-000000000001',
            workday: '2099-10-12',
            startsAt: '2099-10-12T14:00:00.000Z',
            endsAt: '2099-10-12T22:00:00.000Z',
            timeZone: 'America/Denver',
            siteCode: 'CENTRAL',
            siteName: 'Central Campus',
            postName: 'Front Desk',
            eventName: null,
            location: 'Central Campus',
            estimatedMinutes: 480,
          }],
          reason: 'Medical appointment and recovery time.',
          status: 'approved',
          decisionNote: 'Coverage is confirmed.',
          decidedAt: '2026-09-29T16:00:00.000Z',
          decidedByName: 'Taylor Supervisor',
          updatedAt: '2026-09-29T16:00:00.000Z',
          createdAt: '2026-09-28T15:00:00.000Z',
        }],
        shiftRequests: [],
        callOffs: [],
        upcomingAssignments: [],
      },
    })
  })

  it('maps every rich time-off and bounded-history field into the page record model', async () => {
    const result = await getRequestCenter()

    expect(supabaseMocks.rpc).toHaveBeenCalledWith('get_request_center_payload')
    expect(result.employeeTimeZone).toBe('America/New_York')
    expect(result.timeOffHistory).toEqual({ managerHistoryLimit: 100, truncated: true })
    expect(result.timeOff[0]).toMatchObject({
      employee_number: 'SYG-1041',
      request_type: 'sick_time',
      employment_type_snapshot: 'hourly',
      pay_treatment: 'sick_policy',
      requested_minutes: 960,
      return_on: '2099-10-15',
      affected_shift_count: 1,
      decision_note: 'Coverage is confirmed.',
      decided_at: '2026-09-29T16:00:00.000Z',
      decided_by_name: 'Taylor Supervisor',
      updated_at: '2026-09-29T16:00:00.000Z',
    })
    expect(result.timeOff[0].affected_shifts).toEqual([
      expect.objectContaining({ postName: 'Front Desk', estimatedMinutes: 480 }),
    ])
  })

  it('maps the authoritative DST-aware preview minutes and keeps older contexts compatible', async () => {
    const context = {
      employee: {
        id: '10000000-0000-4000-8000-000000000001',
        employeeNumber: 'SYG-1000',
        name: 'Morgan Manager',
        employmentType: 'salary',
        timeZone: 'America/New_York',
        status: 'active',
      },
      allowedTypes: ['paid_vacation', 'sick_time', 'unpaid_time_off'],
      affectedShifts: [],
      recentRequests: [],
    }
    supabaseMocks.rpc
      .mockResolvedValueOnce({ data: { ...context, requestedMinutes: 180 }, error: null })
      .mockResolvedValueOnce({ data: context, error: null })

    const current = await getTimeOffRequestContext('2026-03-08', '2026-03-08', '00:30', '04:30')
    const legacy = await getTimeOffRequestContext('2026-03-08', '2026-03-08', '00:30', '04:30')

    expect(supabaseMocks.rpc).toHaveBeenNthCalledWith(1, 'get_time_off_request_context_v2', {
      request_starts_on: '2026-03-08',
      request_ends_on: '2026-03-08',
      request_partial_start: '00:30',
      request_partial_end: '04:30',
    })
    expect(current.requestedMinutes).toBe(180)
    expect(legacy.requestedMinutes).toBeNull()
  })
})
