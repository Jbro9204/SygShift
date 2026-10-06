import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PayrollEmployeeSummary, TimekeepingReviewRow } from '../data/timekeeping'
import { PayrollEmployeeSummaryTable, PayrollRowsTable } from './TimePayrollPage'
import type { PayrollWeeklyEmployeeSummary, PayrollWorkbookWeek } from './payrollWorkbook'

const week: PayrollWorkbookWeek = {
  label: 'Week 1',
  weekEndsOn: '2026-10-10',
  weekStartsOn: '2026-10-04',
}

const weeklySummary: PayrollWeeklyEmployeeSummary = {
  accountabilityCount: 0,
  breakMinutes: 30,
  employeeId: '73000000-0000-4000-8000-000000000001',
  employeeName: 'Jordan Brown',
  employmentType: 'hourly',
  epMinutes: 120,
  exceptionCount: 0,
  hasActivity: true,
  hasWorkedDetail: true,
  unclassifiedCategoryMinutes: 0,
  locationCount: 1,
  needsReview: false,
  otherPaidMinutes: 0,
  overtimeMinutes: 60,
  paidMinutes: 480,
  regularCategoryMinutes: 240,
  regularMinutes: 420,
  scheduledMinutes: 480,
  sickPayMinutes: 0,
  trainingMinutes: 0,
  truepMinutes: 120,
  username: 'jbrown',
  vacationPayMinutes: 0,
  workedShiftCount: 1,
}

describe('payroll category presentation', () => {
  it('shows category partitions separately from non-overtime and overtime totals', () => {
    render(
      <PayrollEmployeeSummaryTable
        groups={[{ summaries: [weeklySummary], week }]}
        onSelectSummary={vi.fn()}
        selectedSummary={null}
      />,
    )

    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Total worked' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Regular' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'EP' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'TRUEP' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Non-OT' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: /OT included in category totals/ })).toBeInTheDocument()
    expect(screen.getByText(/overtime is already included in one category/i)).toBeInTheDocument()
  })

  it('labels an old locked row without a category as legacy and unclassified', () => {
    const row = {
      breakMinutes: 0,
      crossesPayrollBoundary: false,
      employeeId: weeklySummary.employeeId,
      employeeName: weeklySummary.employeeName,
      employmentType: 'hourly',
      exceptionCodes: [],
      firstClockIn: '2026-10-05T13:00:00.000Z',
      grossMinutes: 480,
      lastClockOut: '2026-10-05T21:00:00.000Z',
      locationName: 'Executive Protection',
      manualAdjustment: false,
      mixedPayrollCategories: false,
      mixedWorkTypes: false,
      operationalDate: '2026-10-05',
      overtimeMinutes: 0,
      paidMinutes: 480,
      payrollAssignmentSource: 'scheduled_shift',
      payrollBatchWeekEndsOn: week.weekEndsOn,
      payrollBatchWeekStartsOn: week.weekStartsOn,
      payrollNotes: [],
      payrollReady: true,
      postName: 'Protection Detail',
      regularMinutes: 480,
      rowKind: 'time_event',
      scheduledStartsAt: '2026-10-05T13:00:00.000Z',
      shiftId: '73000000-0000-4000-8000-000000000002',
      siteCode: 'EP',
      siteName: 'Executive Protection',
      timeOffMinutes: 0,
      timeZone: 'America/Denver',
      username: weeklySummary.username,
      workType: 'post',
    } as unknown as TimekeepingReviewRow
    const summary: PayrollEmployeeSummary = {
      breakMinutes: 0,
      employeeId: weeklySummary.employeeId,
      employeeName: weeklySummary.employeeName,
      employmentType: 'hourly',
      epMinutes: 0,
      exceptionCount: 0,
      firstDate: row.operationalDate,
      grossMinutes: 480,
      lastDate: row.operationalDate,
      locationCount: 1,
      notes: ['Legacy locked row has no payroll category.'],
      overtimeMinutes: 0,
      paidMinutes: 480,
      payrollReady: true,
      postMinutes: 480,
      readyCount: 1,
      regularCategoryMinutes: 0,
      regularMinutes: 480,
      role: 'admin',
      trainingMinutes: 0,
      truepMinutes: 0,
      unclassifiedCategoryMinutes: 480,
      username: weeklySummary.username,
      workedShiftCount: 1,
    }

    render(<PayrollRowsTable rows={[row]} summary={summary} week={week} />)

    expect(screen.getByText('Legacy / unclassified')).toBeInTheDocument()
    expect(screen.getByText('Historical locked row; not reassigned.')).toBeInTheDocument()
  })
})
