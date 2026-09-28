import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acceptVacancyPatrolRecovery,
  getVacancyPatrolRecovery,
  getVacancyPatrolRecoveryWorklist,
  updateVacancyPatrolRecovery,
} from './vacancyPatrolOperations'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc }),
}))

const ids = Array.from({ length: 16 }, (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
const [requestId, routeId, routeVersionId, employeeId, assignmentId, shiftId, scheduleId, hitWindowId, clientId, siteId, postId, idempotencyKey] = ids

function detail() {
  return {
    acceptedRoute: null,
    assignedEmployee: null,
    billingDisposition: null,
    completedHits: 0,
    createdAt: '2026-09-27T22:00:00.000Z',
    displayStage: 'requested',
    employeeChoices: [{ armedQualified: true, employeeId, employeeNumber: 'E-100', name: 'Patrol Guard' }],
    hitWindows: [{
      completedHits: 0,
      hitWindowId,
      missedHits: 0,
      plannedHits: 2,
      remainingHits: 2,
      sequence: 1,
      status: 'planned',
      windowEndAt: '2026-10-02T04:00:00.000Z',
      windowStartAt: '2026-10-02T00:00:00.000Z',
    }],
    patrolAssignmentId: null,
    permissions: { canAccept: true, canReviewBilling: false, canUpdate: true },
    plannedHits: 2,
    reason: 'Recover the published vacancy with documented Patrol visits.',
    requestId,
    requestNumber: 'VPR-20260927-000001',
    requestedRoute: { code: 'CENTRAL', name: 'Central Night', requiresArmed: false, routeId, routeVersionId, timeZone: 'America/Denver' },
    routeChoices: [{ code: 'CENTRAL', isRequestedRoute: true, name: 'Central Night', requiresArmed: false, routeId, routeVersionId, timeZone: 'America/Denver' }],
    shift: {
      clientId,
      clientName: 'Sample Client',
      endsAt: '2026-10-02T06:00:00.000Z',
      isPublished: true,
      isUnassigned: true,
      postId,
      postName: 'Night Post',
      requiresArmed: false,
      scheduleId,
      scheduleName: 'Week of 09/27/2026',
      shiftId,
      siteId,
      siteName: 'Vacant property',
      startsAt: '2026-10-01T22:00:00.000Z',
      timeZone: 'America/Denver',
      weekStartsOn: '2026-09-27',
    },
    status: 'requested',
    statusHistory: [{
      action: 'request', actorEmployeeId: employeeId, actorName: 'Scheduler', createdAt: '2026-09-27T22:00:00.000Z',
      fromStatus: null, historyId: 1, metadata: {}, note: 'Sent to Patrol.', toStatus: 'requested',
    }],
    updatedAt: '2026-09-27T22:00:00.000Z',
  }
}

describe('vacancy Patrol manager operations data contracts', () => {
  beforeEach(() => rpc.mockReset())

  it('loads a bounded, server-filtered manager worklist', async () => {
    rpc.mockResolvedValue({
      data: {
        counts: { canceled: 0, completed: 1, declined: 0, inProgress: 1, patrolPlanned: 2, requested: 3, total: 7 },
        generatedAt: '2026-09-27T23:00:00.000Z',
        permissions: { canAccept: true, canUpdate: true },
        requests: [detail()],
      },
      error: null,
    })

    const result = await getVacancyPatrolRecoveryWorklist({ from: '2026-09-01', status: 'requested', through: '2026-10-31' })

    expect(result.counts).toMatchObject({ total: 7, requested: 3, patrolPlanned: 2 })
    expect(result.requests[0].routeChoices[0].isRequestedRoute).toBe(true)
    expect(rpc).toHaveBeenCalledWith('get_vacancy_patrol_recovery_worklist', {
      target_from: '2026-09-01', target_status: 'requested', target_through: '2026-10-31',
    })
  })

  it('sends null when the manager requests every workflow status', async () => {
    rpc.mockResolvedValue({
      data: {
        counts: { canceled: 0, completed: 0, declined: 0, inProgress: 0, patrolPlanned: 0, requested: 0, total: 0 },
        generatedAt: '2026-09-27T23:00:00.000Z',
        permissions: { canAccept: true, canUpdate: true },
        requests: [],
      },
      error: null,
    })

    await getVacancyPatrolRecoveryWorklist({ from: '2026-09-01', status: 'all', through: '2026-10-31' })

    expect(rpc).toHaveBeenCalledWith('get_vacancy_patrol_recovery_worklist', {
      target_from: '2026-09-01', target_status: null, target_through: '2026-10-31',
    })
  })

  it('loads one request with server-scoped route and employee choices', async () => {
    rpc.mockResolvedValue({ data: detail(), error: null })

    const result = await getVacancyPatrolRecovery(requestId)

    expect(result.shift).toMatchObject({ isPublished: true, isUnassigned: true, siteName: 'Vacant property' })
    expect(result.employeeChoices[0]).toMatchObject({ armedQualified: true, employeeId })
    expect(rpc).toHaveBeenCalledWith('get_vacancy_patrol_recovery', { target_request_id: requestId })
  })

  it('accepts with the exact route, employee, note, and stable retry key', async () => {
    rpc.mockResolvedValue({
      data: {
        acceptedAt: '2026-09-27T23:10:00.000Z', acceptedRouteId: routeId, assignedEmployeeId: employeeId,
        completedHits: 0, idempotentReplay: false, patrolAssignmentId: assignmentId, plannedHits: 2,
        requestId, requestNumber: 'VPR-20260927-000001', status: 'patrol_planned',
      },
      error: null,
    })

    const result = await acceptVacancyPatrolRecovery({
      employeeId, idempotencyKey, note: '  Reviewed route, windows, and armed qualification.  ', requestId, routeId,
    })

    expect(result.status).toBe('patrol_planned')
    expect(rpc).toHaveBeenCalledWith('accept_vacancy_patrol_recovery', {
      target_employee_id: employeeId,
      target_idempotency_key: idempotencyKey,
      target_note: 'Reviewed route, windows, and armed qualification.',
      target_request_id: requestId,
      target_route_id: routeId,
    })
  })

  it('uses the controlled update action and sends null windows when reconciling', async () => {
    rpc.mockResolvedValue({
      data: {
        completedHits: 2, displayStage: 'completed', idempotentReplay: false, missedHits: 0, plannedHits: 2,
        requestId, requestNumber: 'VPR-20260927-000001', status: 'completed', updatedAt: '2026-10-02T07:00:00.000Z',
      },
      error: null,
    })

    await updateVacancyPatrolRecovery({
      action: 'reconcile', idempotencyKey, note: ' Reconcile submitted Patrol hits. ', requestId,
    })

    expect(rpc).toHaveBeenCalledWith('update_vacancy_patrol_recovery', {
      target_action: 'reconcile',
      target_hit_windows: null,
      target_idempotency_key: idempotencyKey,
      target_note: 'Reconcile submitted Patrol hits.',
      target_request_id: requestId,
    })
  })

  it('rejects malformed protected payloads at the browser boundary', async () => {
    rpc.mockResolvedValue({ data: { ...detail(), requestId: 'not-a-uuid' }, error: null })

    await expect(getVacancyPatrolRecovery(requestId)).rejects.toThrow()
  })
})
