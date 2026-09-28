import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createVacancyPatrolRecovery,
  getVacancyPatrolRecoveryBootstrap,
  getVacancyPatrolRecoveryMap,
} from './vacancyPatrolRecovery'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc }),
}))

const shiftId = '10000000-0000-4000-8000-000000000001'
const scheduleId = '10000000-0000-4000-8000-000000000002'
const routeId = '10000000-0000-4000-8000-000000000003'
const routeVersionId = '10000000-0000-4000-8000-000000000004'
const requestId = '10000000-0000-4000-8000-000000000005'
const idempotencyKey = '10000000-0000-4000-8000-000000000006'

describe('vacancy Patrol recovery data contracts', () => {
  beforeEach(() => rpc.mockReset())

  it('loads only the focused shift and route choices needed by Schedule', async () => {
    rpc.mockResolvedValue({
      data: {
        defaults: {
          hitWindows: [{
            plannedHits: 2,
            windowEndAt: '2026-10-02T04:00:00.000Z',
            windowStartAt: '2026-10-02T00:00:00.000Z',
          }],
          maxHitWindows: 6,
          reasonMinLength: 10,
        },
        existingRequest: null,
        permissions: { canInitiate: true },
        routeChoices: [{
          code: 'CENTRAL',
          name: 'Central Night Route',
          requiresArmed: false,
          routeId,
          routeVersionId,
          timeZone: 'America/Denver',
        }],
        shift: {
          endsAt: '2026-10-02T06:00:00.000Z',
          isPublished: true,
          isUnassigned: true,
          postId: null,
          postName: null,
          requiresArmed: false,
          scheduleId,
          scheduleName: 'Week of 09/27/2026',
          shiftId,
          siteId: null,
          siteName: 'Vacant property',
          startsAt: '2026-10-01T22:00:00.000Z',
          timeZone: 'America/Denver',
        },
      },
      error: null,
    })

    const result = await getVacancyPatrolRecoveryBootstrap(shiftId)

    expect(result.routeChoices[0]).toMatchObject({ name: 'Central Night Route', routeId })
    expect(result.defaults.hitWindows[0].plannedHits).toBe(2)
    expect(rpc).toHaveBeenCalledWith('get_vacancy_patrol_recovery_bootstrap', { target_shift_id: shiftId })
  })

  it('submits the preferred route, operational note, windows, and stable retry key', async () => {
    rpc.mockResolvedValue({
      data: {
        createdAt: '2026-09-27T23:00:00.000Z',
        idempotentReplay: false,
        requestId,
        requestNumber: 'VPR-20260927-000001',
        status: 'requested',
      },
      error: null,
    })

    const result = await createVacancyPatrolRecovery({
      hitWindows: [{
        plannedHits: 3,
        windowEndAt: '2026-10-02T04:00:00.000Z',
        windowStartAt: '2026-10-02T00:00:00.000Z',
      }],
      idempotencyKey,
      reason: '  Bill three documented visits to vacancy recovery.  ',
      requestedRouteId: routeId,
      shiftId,
    })

    expect(result.status).toBe('requested')
    expect(rpc).toHaveBeenCalledWith('create_vacancy_patrol_recovery', {
      target_hit_windows: [{
        plannedHits: 3,
        windowEndAt: '2026-10-02T04:00:00.000Z',
        windowStartAt: '2026-10-02T00:00:00.000Z',
      }],
      target_idempotency_key: idempotencyKey,
      target_reason: 'Bill three documented visits to vacancy recovery.',
      target_requested_route_id: routeId,
      target_shift_id: shiftId,
    })
  })

  it('loads persistent week markers without requesting the broad Patrol workspace', async () => {
    rpc.mockResolvedValue({
      data: {
        permissions: { canInitiate: true },
        recoveries: [{
          acceptedRouteId: routeId,
          billingDisposition: 'approved',
          completedHits: 2,
          displayStage: 'finance_reviewed',
          patrolAssignmentId: '10000000-0000-4000-8000-000000000007',
          plannedHits: 2,
          requestId,
          requestNumber: 'VPR-20260927-000001',
          requestedRouteId: routeId,
          shiftId,
          status: 'completed',
          updatedAt: '2026-10-02T07:00:00.000Z',
        }],
        weekEndsOn: '2026-10-03',
        weekStartsOn: '2026-09-27',
      },
      error: null,
    })

    const result = await getVacancyPatrolRecoveryMap('2026-09-27')

    expect(result.recoveries[0]).toMatchObject({ displayStage: 'finance_reviewed', plannedHits: 2 })
    expect(rpc).toHaveBeenCalledWith('get_vacancy_patrol_recovery_map', { target_week_starts_on: '2026-09-27' })
    expect(rpc).not.toHaveBeenCalledWith('get_patrol_workspace')
  })

  it('rejects malformed route/bootstrap payloads at the browser boundary', async () => {
    rpc.mockResolvedValue({ data: { routeChoices: [{ routeId: 'not-a-uuid' }] }, error: null })

    await expect(getVacancyPatrolRecoveryBootstrap(shiftId)).rejects.toThrow()
  })
})
