import type { PatrolRouteInput, PatrolWorkspace } from '../../src/data/patrol'

export const isSupabaseConfigured = true
export class PatrolRouteSaveError extends Error {
  constructor(message: string, readonly kind: 'conflict' | 'rejected' | 'uncertain') { super(message) }
}
export const postlessSite = '10000000-0000-4000-8000-000000000010'
export const postedSite = '10000000-0000-4000-8000-000000000011'
let saved: PatrolRouteInput | null = null
const scenario = new URLSearchParams(location.search).get('scenario')
const readinessScenario = scenario === 'readiness'
const continuityScenario = scenario === 'continuity' || scenario === 'continuity-closed'
const guardReviewScenario = scenario === 'guard-review'
let mutationCount = 0
let workspaceReadCount = 0
let reconciliationCount = 0
document.body.dataset.fixtureMutationCount = '0'
document.body.dataset.fixtureWorkspaceReadCount = '0'
const fixture: PatrolWorkspace = {
  actor: { employeeId: '10000000-0000-4000-8000-000000000001', canExportReports: false, canManageAssignments: true, canManageExceptions: false, canManageRoutes: true, canViewEvidence: true, canViewOperations: true },
  assignments: [], makeupQueue: [], scheduleCandidates: [], routes: [],
  locations: [
    { siteId: postlessSite, siteName: 'Sample Court', clientId: '10000000-0000-4000-8000-000000000050', clientName: 'Sample Client', postId: null, postName: null, siteCode: 'SC', timeZone: 'America/Denver', addressLine1: '10 Example Road', city: 'Denver', region: 'CO', postalCode: '80000', requiresArmed: false },
    { siteId: postedSite, siteName: 'Sample Gardens', clientId: '10000000-0000-4000-8000-000000000050', clientName: 'Sample Client', postId: '10000000-0000-4000-8000-000000000021', postName: 'Main post', siteCode: 'SG', timeZone: 'America/Denver', addressLine1: '20 Example Road', city: 'Denver', region: 'CO', postalCode: '80000', requiresArmed: false },
  ],
}
if (readinessScenario) {
  fixture.routes = [{
    id: '10000000-0000-4000-8000-000000000030', versionId: '10000000-0000-4000-8000-000000000031',
    versionNumber: 1, code: 'sample-route', name: 'Sample route', changeReason: 'Read-only readiness fixture',
    status: 'active', requiresArmed: false, timeZone: 'America/Denver', effectiveFrom: null, effectiveThrough: null,
    stops: [{
      id: '10000000-0000-4000-8000-000000000040', stableKey: '10000000-0000-4000-8000-000000000041',
      sequence: 1, locationLabel: 'Unlinked sample property', siteId: null, postId: null,
      addressLine1: null, city: null, region: null, postalCode: null, latitude: null, longitude: null,
      geofenceRadiusMeters: null, instructions: null, allowPhotos: true, allowVideos: true,
      requireEvidence: false, evidenceInstructions: null, standardVideoLimitSeconds: 180,
      incidentVideoLimitSeconds: 900, requirements: [],
    }],
  }]
  fixture.scheduleCandidates = [{
    employeeId: '10000000-0000-4000-8000-000000000060', employeeName: 'Sample Guard',
    shiftId: '10000000-0000-4000-8000-000000000061', siteName: 'Sample schedule location',
    postName: 'Sample post', requiresArmed: false, startsAt: '2026-11-18T03:00:00.000Z',
    endsAt: '2026-11-18T11:00:00.000Z', timeZone: 'America/Denver',
  }]
}
if (continuityScenario || guardReviewScenario) {
  fixture.routes = [{
    id: '10000000-0000-4000-8000-000000000030', versionId: '10000000-0000-4000-8000-000000000031',
    versionNumber: 1, code: 'sample-route', name: 'Sample route', changeReason: 'Synthetic continuity fixture',
    status: 'active', requiresArmed: false, timeZone: 'America/Denver', effectiveFrom: null, effectiveThrough: null,
    stops: [],
  }]
  fixture.scheduleCandidates = [{
    employeeId: '10000000-0000-4000-8000-000000000060', employeeName: 'Sample Guard',
    shiftId: '10000000-0000-4000-8000-000000000061', siteName: 'Sample schedule location',
    postName: 'Sample post', requiresArmed: false, startsAt: '2026-11-19T03:00:00.000Z',
    endsAt: '2026-11-19T11:00:00.000Z', timeZone: 'America/Denver',
  }]
  fixture.continuityIssues = [{
    id: '10000000-0000-4000-8000-000000000070', assignmentId: '10000000-0000-4000-8000-000000000071',
    sourceShiftId: '10000000-0000-4000-8000-000000000072',
    targetShiftId: scenario === 'continuity-closed' ? null : '10000000-0000-4000-8000-000000000061',
    scheduleId: '10000000-0000-4000-8000-000000000073', employeeId: '10000000-0000-4000-8000-000000000060',
    employeeName: 'Sample Guard', routeId: fixture.routes[0].id, routeName: 'Sample route',
    reason: scenario === 'continuity-closed' ? 'lineage_missing' : 'shift_changed', createdAt: '2026-11-18T13:00:00Z',
  }]
}
if (guardReviewScenario) {
  fixture.actor = {
    employeeId: '10000000-0000-4000-8000-000000000060', canExportReports: false, canManageAssignments: false,
    canManageExceptions: false, canManageRoutes: false, canViewEvidence: true, canViewOperations: false,
  }
  fixture.routes = []
  fixture.scheduleCandidates = []
  fixture.continuityIssues = []
  fixture.assignments = [{
    id: '10000000-0000-4000-8000-000000000071', routeId: '10000000-0000-4000-8000-000000000030',
    routeVersionId: '10000000-0000-4000-8000-000000000031', routeName: 'Sample route',
    employeeId: fixture.actor.employeeId, employeeName: 'Sample Guard', shiftId: '10000000-0000-4000-8000-000000000072',
    serviceDate: '2026-11-18', startsAt: '2000-01-01T00:00:00Z', endsAt: '2999-01-01T00:00:00Z',
    timeZone: 'America/Denver', requiresArmed: false, status: 'active', continuityStatus: 'review_required',
    hits: [], makeupObligations: [], obligations: ['completed', 'due'].map((status, index) => ({
      id: `10000000-0000-4000-8000-00000000008${index}`, stopId: '10000000-0000-4000-8000-000000000040',
      locationLabel: index === 0 ? 'Retained completed property' : 'Property awaiting review',
      requirementId: '10000000-0000-4000-8000-000000000090', requirementLabel: 'Sample patrol requirement',
      hitNumber: index + 1, dueStartAt: '2000-01-01T00:00:00Z', dueEndAt: '2999-01-01T00:00:00Z',
      status: status as 'completed' | 'due', completedHitId: index === 0 ? '10000000-0000-4000-8000-000000000091' : null,
      allowPhotos: true, allowVideos: true, requireEvidence: false, evidenceInstructions: null, locationConfigured: false,
    })),
  }]
}
export async function getPatrolWorkspace() {
  workspaceReadCount += 1
  document.body.dataset.fixtureWorkspaceReadCount = String(workspaceReadCount)
  return structuredClone({ ...fixture, routes: saved ? [{ ...saved, id: '10000000-0000-4000-8000-000000000030', versionId: '10000000-0000-4000-8000-000000000031', versionNumber: 1 }] : fixture.routes })
}
export async function getPatrolReleaseReadiness() {
  return { generatedAt: '2026-11-17T18:00:00Z', readyForBroadRelease: false, summary: { activeSites: 2, sitesMissingClient: 0, sitesMissingAddress: 0, activeRoutes: 0, activeAssignments: 0, storedPhotos: 0, storedVideos: 0, longestVideoSeconds: null }, routes: [], checks: [] }
}
export async function savePatrolRoute(input: PatrolRouteInput) {
  mutationCount += 1
  document.body.dataset.fixtureMutationCount = String(mutationCount)
  if (readinessScenario) throw new Error('The readiness fixture is read-only.')
  saved = structuredClone(input)
  document.body.dataset.savedRoute = JSON.stringify(saved)
  return '10000000-0000-4000-8000-000000000030'
}
export async function reconcilePatrolScheduleConnection(continuityId: string, employeeId: string | null, reason: string) {
  if (!continuityScenario) return forbidden()
  mutationCount += 1
  reconciliationCount += 1
  document.body.dataset.fixtureMutationCount = String(mutationCount)
  document.body.dataset.fixtureReconcileCount = String(reconciliationCount)
  document.body.dataset.fixtureReconcileRequest = JSON.stringify({ continuityId, employeeId, reason })
  if (reconciliationCount === 1) throw new Error('The review could not be confirmed. No saved work was changed.')
  await new Promise<void>((resolve) => window.addEventListener('fixture-confirm-save', () => resolve(), { once: true }))
  fixture.continuityIssues = []
  return { status: scenario === 'continuity-closed' ? 'closed' as const : 'reconnected' as const,
    assignmentId: scenario === 'continuity-closed' ? null : '10000000-0000-4000-8000-000000000074' }
}
function forbidden(): never {
  mutationCount += 1
  document.body.dataset.fixtureMutationCount = String(mutationCount)
  throw new Error('This local route fixture does not support operational actions.')
}
export const getSupabaseClient = forbidden
export const assignPatrolMakeup = forbidden
export const linkPatrolRouteShift = forbidden
export const openPatrolEvidence = forbidden
export const savePatrolHit = forbidden
export const uploadPatrolEvidence = forbidden
export function formatPatrolDateTime(value: string) { return value }
