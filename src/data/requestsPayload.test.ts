import { beforeEach, describe, expect, it, vi } from 'vitest'

const supabaseMocks = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc: supabaseMocks.rpc }),
}))

import { cancelApprovedTimeOff, endApprovedTimeOffNow, getRequestCenter, getTimeOffRequestContext } from './requests'

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

    expect(supabaseMocks.rpc).toHaveBeenCalledWith('get_request_center_payload_v3')
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

  it('keeps cancellation evidence separate from the original approval', async () => {
    const original = await supabaseMocks.rpc()
    const request = original.data.timeOff[0]
    request.status = 'canceled'
    request.cancellation = { canceledAt: '2026-10-01T15:00:00Z', canceledByName: 'Morgan Manager', note: 'Employee no longer needs leave.' }
    supabaseMocks.rpc.mockResolvedValueOnce(original)
    const result = await getRequestCenter()
    expect(result.timeOff[0]).toMatchObject({ status: 'canceled', decision_note: 'Coverage is confirmed.', cancellation: request.cancellation })
  })

  it('maps an immutable early-return receipt and server eligibility without changing approved dates or requested hours', async () => {
    const original = await supabaseMocks.rpc()
    const request = original.data.timeOff[0]
    request.earlyReturn = {
      endedAt: '2026-11-06T20:05:00Z', recordedAt: '2026-11-06T20:05:00Z',
      endedByName: 'Morgan Manager', note: 'Returned early.', timeZone: 'America/Denver',
    }
    request.cancellationContext = {
      phase: 'ended_early', canEndNow: false, canCancel: false, blockReason: null,
      startsAt: '2026-11-06T07:00:00Z', endsAt: '2026-11-09T07:00:00Z', timeZone: 'America/Denver',
    }
    supabaseMocks.rpc.mockResolvedValueOnce(original)
    const result = await getRequestCenter()
    expect(result.timeOff[0]).toMatchObject({
      status: 'approved', starts_on: request.startsOn, ends_on: request.endsOn, requested_minutes: 960,
      decision_note: 'Coverage is confirmed.', earlyReturn: request.earlyReturn, cancellationContext: request.cancellationContext,
    })
  })

  it('ends leave through the dedicated RPC with no client-provided cutoff and requires an explicit receipt', async () => {
    supabaseMocks.rpc.mockResolvedValueOnce({ data: true, error: null })
    await endApprovedTimeOffNow('20000000-0000-4000-8000-000000000001', '  Returned early.  ')
    expect(supabaseMocks.rpc).toHaveBeenCalledExactlyOnceWith('end_approved_time_off_now', {
      target_request_id: '20000000-0000-4000-8000-000000000001', target_note: 'Returned early.',
    })
    supabaseMocks.rpc.mockResolvedValueOnce({ data: null, error: null })
    await expect(endApprovedTimeOffNow('20000000-0000-4000-8000-000000000001', 'Returned early.')).rejects.toThrow('Ending leave could not be confirmed.')
  })

  it('keeps early-return authorization and unexpected server details out of the interface', async () => {
    supabaseMocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'private permission internals' } })
    await expect(endApprovedTimeOffNow('20000000-0000-4000-8000-000000000001', 'Returned early.')).rejects.toThrow('Another authorized time-off reviewer with MFA must end this leave.')
    supabaseMocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'private.payroll_secret SQL failed' } })
    await expect(endApprovedTimeOffNow('20000000-0000-4000-8000-000000000001', 'Returned early.')).rejects.toThrow('Ending leave could not be confirmed.')
    const message = 'A locked payroll export covers this employee and date range. Payroll must reconcile it before changing leave.'
    supabaseMocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message } })
    await expect(endApprovedTimeOffNow('20000000-0000-4000-8000-000000000001', 'Returned early.')).rejects.toThrow(message)
    const missingZone = 'This leave has no saved time zone. HR must review it before ending leave early.'
    supabaseMocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: missingZone } })
    await expect(endApprovedTimeOffNow('20000000-0000-4000-8000-000000000001', 'Returned early.')).rejects.toThrow(missingZone)
  })

  it('uses the narrow cancellation RPC and requires an explicit success receipt', async () => {
    supabaseMocks.rpc.mockResolvedValueOnce({ data: true, error: null })
    await cancelApprovedTimeOff('20000000-0000-4000-8000-000000000001', '  Employee changed plans.  ')
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('cancel_approved_time_off_request', {
      target_request_id: '20000000-0000-4000-8000-000000000001', target_note: 'Employee changed plans.',
    })
    supabaseMocks.rpc.mockResolvedValueOnce({ data: null, error: null })
    await expect(cancelApprovedTimeOff('20000000-0000-4000-8000-000000000001', 'Employee changed plans.')).rejects.toThrow('Cancellation could not be confirmed.')
  })

  it('preserves actionable reconciliation errors without exposing arbitrary database text', async () => {
    const message = 'This request is linked to an HR leave case. HR must reconcile the case and any authorized treatment before cancellation.'
    supabaseMocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message } })
    await expect(cancelApprovedTimeOff('20000000-0000-4000-8000-000000000001', 'Changed plans.')).rejects.toThrow(message)
    supabaseMocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'private.payroll_secret SQL failed' } })
    await expect(cancelApprovedTimeOff('20000000-0000-4000-8000-000000000001', 'Changed plans.')).rejects.toThrow('Cancellation could not be confirmed.')
    supabaseMocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'private permission internals' } })
    await expect(cancelApprovedTimeOff('20000000-0000-4000-8000-000000000001', 'Changed plans.')).rejects.toThrow('Another authorized time-off reviewer with MFA')
  })
})
