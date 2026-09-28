import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeVacancyPatrolFinanceExport,
  getVacancyPatrolFinanceReport,
  reviewVacancyPatrolBilling,
} from './vacancyPatrolFinance'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))

const requestId = '10000000-0000-4000-8000-000000000001'
const shiftId = '10000000-0000-4000-8000-000000000002'
const routeId = '10000000-0000-4000-8000-000000000003'
const employeeId = '10000000-0000-4000-8000-000000000004'
const auditId = 105
const idempotencyKey = '10000000-0000-4000-8000-000000000006'

describe('vacancy Patrol Finance contracts', () => {
  beforeEach(() => rpc.mockReset())

  it('loads the protected Finance report and preserves billing evidence', async () => {
    rpc.mockResolvedValue({ data: {
      from: '2026-09-27', generatedAt: '2026-09-28T02:00:00Z', through: '2026-10-03',
      permissions: { canExport: true, canReview: true, canView: true },
      summary: { totalRequests: 1, awaitingCompletion: 0, pendingReview: 1, reviewed: 0, billSeparately: 0, includedInContract: 0, nonBillable: 0, duplicateSuppressed: 0 },
      rows: [{
        acceptedAt: '2026-09-27T23:00:00Z', acceptedById: employeeId, acceptedByName: 'Patrol Manager',
        acceptedRouteId: routeId, acceptedRouteName: 'Central Night', assignedEmployeeId: employeeId,
        assignedEmployeeName: 'Patrol Officer', assignedEmployeeNumber: 'SYG-1001', billingDisposition: 'pending_review',
        billingReason: null, billingReference: null, canReview: true, clientId: null, clientName: 'Elevon',
        completedAt: '2026-09-28T01:30:00Z', completedHits: 3, endsAt: '2026-09-28T04:00:00Z',
        missedHits: 0, originalShiftHours: 6, patrolAssignmentId: null, plannedHits: 3, postId: null,
        postName: 'Elevon-Unarmed', remainingHits: 0, requestId, requestNumber: 'VPR-20260927-000001',
        requestedAt: '2026-09-27T22:30:00Z', requestedById: employeeId, requestedByName: 'Scheduler',
        requestedRouteId: routeId, requestedRouteName: 'Central Night', reviewedAt: null, reviewedById: null,
        reviewedByName: null, serviceDate: '2026-09-27', shiftId, siteId: null, siteName: 'Elevon',
        startsAt: '2026-09-27T22:00:00Z', status: 'completed', timeZone: 'America/Denver',
      }],
    }, error: null })

    const report = await getVacancyPatrolFinanceReport({ from: '2026-09-27', through: '2026-10-03' })

    expect(report.rows[0]).toMatchObject({ requestNumber: 'VPR-20260927-000001', plannedHits: 3, completedHits: 3 })
    expect(rpc).toHaveBeenCalledWith('get_vacancy_patrol_finance_report', {
      target_billing_disposition: null, target_from: '2026-09-27', target_through: '2026-10-03',
    })
  })

  it('records a separately billable decision with a stable retry key', async () => {
    rpc.mockResolvedValue({ data: {
      auditId, billingDisposition: 'bill_separately', billingReason: 'Approved as three replacement patrol visits.',
      billingReference: 'ELEVON-2026-09-27', idempotentReplay: false, requestId, requestNumber: 'VPR-20260927-000001',
      reviewedAt: '2026-09-28T02:10:00Z', reviewedBy: { employeeId, name: 'Finance Reviewer' },
    }, error: null })

    const receipt = await reviewVacancyPatrolBilling({
      billingReference: ' ELEVON-2026-09-27 ', disposition: 'bill_separately', idempotencyKey,
      reason: ' Approved as three replacement patrol visits. ', requestId,
    })

    expect(receipt.billingDisposition).toBe('bill_separately')
    expect(rpc).toHaveBeenCalledWith('review_vacancy_patrol_billing', {
      target_disposition: 'bill_separately', target_idempotency_key: idempotencyKey,
      target_reason: 'Approved as three replacement patrol visits.', target_reference: 'ELEVON-2026-09-27',
      target_request_id: requestId,
    })
  })

  it('authorizes every protected export before browser generation', async () => {
    rpc.mockResolvedValue({ data: {
      auditId, authorizedAt: '2026-09-28T02:15:00Z', format: 'pdf', from: '2026-09-27', through: '2026-10-03',
    }, error: null })

    await authorizeVacancyPatrolFinanceExport({ format: 'pdf', from: '2026-09-27', through: '2026-10-03' })

    expect(rpc).toHaveBeenCalledWith('authorize_vacancy_patrol_finance_export', {
      target_format: 'pdf', target_from: '2026-09-27', target_through: '2026-10-03',
    })
  })
})
