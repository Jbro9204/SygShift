import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPatrolWorkspace, PatrolRouteSaveError, reconcilePatrolScheduleConnection, savePatrolRoute, type PatrolRouteInput } from './patrol'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))

function input(): PatrolRouteInput {
  return { id: null, idempotencyKey: crypto.randomUUID(), expectedVersionId: null, changeReason: 'New patrol route', code: 'new-route', effectiveFrom: null, effectiveThrough: null, name: 'New route', requiresArmed: false, status: 'draft', stops: [], timeZone: 'America/Denver' }
}

describe('patrol route data contracts', () => {
  beforeEach(() => vi.resetAllMocks())

  it('loads a linked property without requiring a post', async () => {
    const location = { siteId: crypto.randomUUID(), siteName: 'Property', siteCode: null, clientId: crypto.randomUUID(), clientName: 'Client', postId: null, postName: null, requiresArmed: false, addressLine1: null, city: null, region: null, postalCode: null, timeZone: 'America/Denver' }
    rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'get_patrol_makeup_work' ? [] : { actor: { employeeId: crypto.randomUUID(), canExportReports: false, canManageAssignments: false, canManageExceptions: false, canManageRoutes: false, canViewEvidence: false, canViewOperations: false }, assignments: [], locations: [location], makeupQueue: [], routes: [], scheduleCandidates: [] } }))
    expect((await getPatrolWorkspace()).locations).toEqual([location])
  })

  it('passes the exact request identity and expected version to the backend', async () => {
    const route = { ...input(), id: crypto.randomUUID(), expectedVersionId: crypto.randomUUID() }
    rpc.mockResolvedValue({ error: null, data: route.id })
    await expect(savePatrolRoute(route)).resolves.toBe(route.id)
    expect(rpc).toHaveBeenCalledWith('save_patrol_route', { target_route: route })
  })

  it.each([
    { idempotencyKey: '' },
    { id: crypto.randomUUID(), expectedVersionId: null },
    { expectedVersionId: crypto.randomUUID() },
  ])('rejects missing or inconsistent concurrency metadata before making a request: %j', async (changes) => {
    await expect(savePatrolRoute({ ...input(), ...changes })).rejects.toMatchObject({ kind: 'rejected' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('preserves version conflicts as explicit conflicts', async () => {
    rpc.mockResolvedValue({ error: { code: 'PT409', message: 'Changed', details: 'patrol_route_version_conflict' }, data: null })
    await expect(savePatrolRoute(input())).rejects.toMatchObject({ kind: 'conflict' })
  })

  it.each(['42501', '22023', '23514'])('keeps definitive rejection %s distinct from an uncertain save', async (code) => {
    rpc.mockResolvedValue({ error: { code, message: 'Save rejected' }, data: null })
    await expect(savePatrolRoute(input())).rejects.toMatchObject({ kind: 'rejected', message: 'Save rejected' })
  })

  it.each([
    { error: { code: 'PGRST000', message: 'Connection lost' }, data: null },
    { error: null, data: 'not-a-route-id' },
  ])('does not claim a failed or malformed response proves no save occurred', async (response) => {
    rpc.mockResolvedValue(response)
    await expect(savePatrolRoute(input())).rejects.toBeInstanceOf(PatrolRouteSaveError)
    await expect(savePatrolRoute(input())).rejects.toMatchObject({ kind: 'uncertain' })
  })

  it('classifies a transport exception as uncertain', async () => {
    rpc.mockRejectedValue(new TypeError('Network failed'))
    await expect(savePatrolRoute(input())).rejects.toMatchObject({ kind: 'uncertain' })
  })

  it('uses the exact continuity receipt and employee for a reviewed connection', async () => {
    const continuityId = crypto.randomUUID(), employeeId = crypto.randomUUID(), assignmentId = crypto.randomUUID()
    rpc.mockResolvedValue({ error: null, data: { status: 'reconnected', assignmentId } })
    await expect(reconcilePatrolScheduleConnection(continuityId, employeeId, 'Reviewed the current assignment.')).resolves.toEqual({ status: 'reconnected', assignmentId })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('reconcile_patrol_schedule_connection_v1', { target_continuity_id: continuityId, target_employee_id: employeeId, target_reason: 'Reviewed the current assignment.' })
  })

  it('does not report success for an unconfirmed reconciliation response', async () => {
    rpc.mockResolvedValue({ error: null, data: { accepted: true } })
    await expect(reconcilePatrolScheduleConnection(crypto.randomUUID(), null, 'Reviewed removed shift.')).rejects.toThrow('result could not be confirmed')
  })
})
