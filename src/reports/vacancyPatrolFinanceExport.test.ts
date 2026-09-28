import { describe, expect, it } from 'vitest'
import type { VacancyPatrolFinanceReport } from '../data/vacancyPatrolFinance'
import { vacancyPatrolFinanceCsv, vacancyPatrolFinancePdf, vacancyPatrolFinanceXlsxSheet } from './vacancyPatrolFinanceExport'

const report: VacancyPatrolFinanceReport = {
  from: '2026-09-27', generatedAt: '2026-09-28T02:00:00Z', through: '2026-10-03',
  permissions: { canExport: true, canReview: true, canView: true },
  summary: { totalRequests: 1, awaitingCompletion: 0, pendingReview: 1, reviewed: 0, billSeparately: 0, includedInContract: 0, nonBillable: 0, duplicateSuppressed: 0 },
  rows: [{
    acceptedAt: '2026-09-27T23:00:00Z', acceptedById: null, acceptedByName: 'Patrol Manager',
    acceptedRouteId: null, acceptedRouteName: 'Central Night Route', assignedEmployeeId: null,
    assignedEmployeeName: 'Patrol Officer', assignedEmployeeNumber: 'SYG-1001', billingDisposition: 'pending_review',
    billingReason: null, billingReference: null, canReview: true, clientId: null, clientName: 'Elevon',
    completedAt: '2026-09-28T01:30:00Z', completedHits: 3, endsAt: '2026-09-28T04:00:00Z',
    missedHits: 0, originalShiftHours: 6, patrolAssignmentId: null, plannedHits: 3, postId: null,
    postName: 'Elevon-Unarmed', remainingHits: 0, requestId: '10000000-0000-4000-8000-000000000001',
    requestNumber: 'VPR-20260927-000001', requestedAt: '2026-09-27T22:30:00Z',
    requestedById: '10000000-0000-4000-8000-000000000002', requestedByName: 'Scheduler',
    requestedRouteId: '10000000-0000-4000-8000-000000000003', requestedRouteName: 'Central Night Route',
    reviewedAt: null, reviewedById: null, reviewedByName: null, serviceDate: '2026-09-27',
    shiftId: '10000000-0000-4000-8000-000000000004', siteId: null, siteName: 'Elevon',
    startsAt: '2026-09-27T22:00:00Z', status: 'completed', timeZone: 'America/Denver',
  }],
}

describe('vacancy Patrol Finance PDF', () => {
  it('creates a stable, compatibility-safe PDF with aligned table text', async () => {
    const bytes = await vacancyPatrolFinancePdf(report)
    const text = new TextDecoder('latin1').decode(bytes)

    expect(bytes.byteLength).toBeGreaterThan(1_000)
    expect(text).toContain('%PDF-')
    expect(text).not.toContain('/ObjStm')
  })

  it('neutralizes spreadsheet formulas in CSV fields without losing the original evidence', () => {
    const csv = vacancyPatrolFinanceCsv({
      ...report,
      rows: [{ ...report.rows[0], billingReason: '=HYPERLINK("https://example.test")', clientName: '+Elevon' }],
    })

    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"')
    expect(csv).toContain('"\'+Elevon"')
    expect(csv.startsWith('\ufeff')).toBe(true)
  })

  it('keeps the Excel summary complete and the table header aligned with its filter and frozen rows', () => {
    const sheet = vacancyPatrolFinanceXlsxSheet(report)

    expect(sheet.rows.slice(3, 12)).toEqual([
      ['Exported matching rows', 1],
      ['All recovery requests in range', 1],
      ['Awaiting Patrol completion', 0],
      ['Pending Finance review', 1],
      ['Finance reviewed', 0],
      ['Bill separately', 0],
      ['Included in contract', 0],
      ['Non-billable', 0],
      ['Duplicate billing suppressed', 0],
    ])
    expect(sheet.headerRows).toEqual([13])
    expect(sheet.filterRowIndex).toBe(13)
    expect(sheet.freezeRows).toBe(14)
    expect(sheet.rows[13]).toHaveLength(21)
  })
})
