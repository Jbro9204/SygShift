import { beforeEach, describe, expect, it, vi } from 'vitest'
import { correctTimeRecordPayrollCategory, getTimekeepingReview, getTimeMaintenance } from './timekeeping'

const rpc = vi.fn()

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc }),
}))

describe('time maintenance payroll category correction', () => {
  beforeEach(() => {
    rpc.mockReset()
  })

  it('sends the canonical category and required reason to the append-only correction RPC', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        correctionCount: 2,
        correctionIds: [
          '73000000-0000-4000-8000-000000000041',
          '73000000-0000-4000-8000-000000000042',
        ],
        eventIds: [
          '73000000-0000-4000-8000-000000000031',
          '73000000-0000-4000-8000-000000000032',
        ],
        payrollCategory: 'truep',
        reason: 'Finance confirmed TRUEP assignment.',
        correctedAt: '2026-10-06T13:00:00.000Z',
        correctedBy: '73000000-0000-4000-8000-000000000001',
      },
      error: null,
    })

    await expect(correctTimeRecordPayrollCategory({
      payrollCategory: 'truep',
      reason: 'Finance confirmed TRUEP assignment.',
      timeEventId: '73000000-0000-4000-8000-000000000031',
    })).resolves.toMatchObject({
      correctionCount: 2,
      payrollCategory: 'truep',
    })

    expect(rpc).toHaveBeenCalledWith('correct_time_event_payroll_category', {
      target_payroll_category: 'truep',
      target_reason: 'Finance confirmed TRUEP assignment.',
      target_time_event_id: '73000000-0000-4000-8000-000000000031',
    })
  })

  it('loads the current payroll category into each maintenance event', async () => {
    rpc
      .mockResolvedValueOnce({
        data: {
          serverTimestamp: '2026-10-06T13:00:00.000Z',
          fromDate: '2026-10-04',
          throughDate: '2026-10-10',
          operationalTimeZone: 'America/Denver',
          employees: [{
            id: '73000000-0000-4000-8000-000000000001',
            username: 'jbrown',
            displayName: 'Jordan Brown',
            role: 'admin',
            employmentType: 'salary',
            status: 'active',
          }],
          events: [{
            id: '73000000-0000-4000-8000-000000000031',
            employeeId: '73000000-0000-4000-8000-000000000001',
            username: 'jbrown',
            employeeName: 'Jordan Brown',
            role: 'admin',
            employmentType: 'salary',
            shiftId: null,
            occurrenceKey: 'unscheduled-session:73000000-0000-4000-8000-000000000031:employee:73000000-0000-4000-8000-000000000001',
            assignmentAnchor: '2026-10-06T12:00:00.000Z',
            operationalDate: '2026-10-06',
            kind: 'clock_in',
            recordedAt: '2026-10-06T12:00:00.000Z',
            effectiveAt: '2026-10-06T12:00:00.000Z',
            clientRecordedAt: null,
            source: 'supervisor',
            createdBy: '73000000-0000-4000-8000-000000000001',
            createdByName: 'Jordan Brown',
            voided: false,
            pendingCorrectionCount: 0,
            maintenanceNoteCount: 0,
            latestNote: null,
            latestAction: null,
            siteName: null,
            siteCode: null,
            postName: null,
            eventName: null,
            locationName: 'Executive protection assignment',
            timeZone: 'America/Denver',
          }],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: [{
          employeeId: '73000000-0000-4000-8000-000000000001',
          shiftId: '73000000-0000-4000-8000-000000000099',
          operationalDate: '2026-10-05',
          payrollOccurrenceKey: 'shift:73000000-0000-4000-8000-000000000099:employee:73000000-0000-4000-8000-000000000001',
          eventIds: ['73000000-0000-4000-8000-000000000031'],
          payrollCategory: 'ep',
          payrollCategoryLabel: 'EP',
          mixedPayrollCategories: false,
        }],
        error: null,
      })

    await expect(getTimeMaintenance({
      employeeId: '73000000-0000-4000-8000-000000000001',
      fromDate: '2026-10-04',
      throughDate: '2026-10-10',
    })).resolves.toMatchObject({
      events: [{ payrollCategory: 'ep', payrollCategoryLabel: 'EP' }],
    })

    expect(rpc).toHaveBeenCalledWith('get_time_payroll_category_map', {
      target_from_date: '2026-10-04',
      target_through_date: '2026-10-10',
    })
  })

  it('keeps salary defaults outside actual-worked payroll categories', async () => {
    rpc
      .mockResolvedValueOnce({
        data: {
          serverTimestamp: '2026-10-06T13:00:00.000Z',
          fromDate: '2026-10-04',
          throughDate: '2026-10-10',
          operationalTimeZone: 'America/Denver',
          summary: {
            rowCount: 1,
            readyCount: 1,
            exceptionCount: 0,
            pendingCorrectionCount: 0,
            grossMinutes: 2400,
            paidMinutes: 2400,
            regularMinutes: 2400,
            overtimeMinutes: 0,
            regularCategoryMinutes: 0,
            epMinutes: 0,
            truepMinutes: 0,
            unclassifiedCategoryMinutes: 0,
            timeOffMinutes: 0,
            salaryDefaultMinutes: 2400,
          },
          rows: [{
            rowKind: 'salary_default',
            employeeId: '73000000-0000-4000-8000-000000000001',
            username: 'jbrown',
            employeeName: 'Jordan Brown',
            role: 'admin',
            employmentType: 'salary',
            shiftId: null,
            operationalDate: '2026-10-04',
            siteName: null,
            siteCode: null,
            postName: null,
            eventName: null,
            locationName: 'Salary default',
            scheduledStartsAt: null,
            scheduledEndsAt: null,
            timeZone: 'America/Denver',
            firstClockIn: null,
            lastClockOut: null,
            grossMinutes: 2400,
            breakMinutes: 0,
            paidMinutes: 2400,
            regularMinutes: 2400,
            overtimeMinutes: 0,
            salaryDefaultMinutes: 2400,
            timeOffMinutes: 0,
            eventCount: 0,
            requiresArmed: false,
            isOvertime: false,
            payrollReady: true,
            exceptionCodes: [],
            payrollNotes: ['Salary payroll default.'],
            payrollCategory: null,
            payrollCategoryLabel: 'Not applicable',
            payrollCategoryResolved: true,
            mixedPayrollCategories: false,
          }],
          pendingCorrections: [],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [], error: null })

    const review = await getTimekeepingReview({
      fromDate: '2026-10-04',
      throughDate: '2026-10-10',
    })

    expect(review.rows[0]).toMatchObject({
      rowKind: 'salary_default',
      payrollCategory: null,
      payrollCategoryLabel: 'Not applicable',
      payrollCategoryResolved: true,
    })
    expect(review.summary).toMatchObject({
      regularCategoryMinutes: 0,
      epMinutes: 0,
      truepMinutes: 0,
      unclassifiedCategoryMinutes: 0,
    })
  })
})
