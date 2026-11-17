import type { PatrolRouteInput, PatrolWorkspace } from '../../src/data/patrol'

export const isSupabaseConfigured = true
export class PatrolRouteSaveError extends Error {
  constructor(message: string, readonly kind: 'conflict' | 'rejected' | 'uncertain') { super(message) }
}
export const postlessSite = '10000000-0000-4000-8000-000000000010'
export const postedSite = '10000000-0000-4000-8000-000000000011'
let saved: PatrolRouteInput | null = null
const fixture: PatrolWorkspace = {
  actor: { employeeId: '10000000-0000-4000-8000-000000000001', canExportReports: false, canManageAssignments: true, canManageExceptions: false, canManageRoutes: true, canViewEvidence: true, canViewOperations: true },
  assignments: [], makeupQueue: [], scheduleCandidates: [], routes: [],
  locations: [
    { siteId: postlessSite, siteName: 'Sample Court', clientId: '10000000-0000-4000-8000-000000000050', clientName: 'Sample Client', postId: null, postName: null, siteCode: 'SC', timeZone: 'America/Denver', addressLine1: '10 Example Road', city: 'Denver', region: 'CO', postalCode: '80000', requiresArmed: false },
    { siteId: postedSite, siteName: 'Sample Gardens', clientId: '10000000-0000-4000-8000-000000000050', clientName: 'Sample Client', postId: '10000000-0000-4000-8000-000000000021', postName: 'Main post', siteCode: 'SG', timeZone: 'America/Denver', addressLine1: '20 Example Road', city: 'Denver', region: 'CO', postalCode: '80000', requiresArmed: false },
  ],
}
export async function getPatrolWorkspace() {
  return structuredClone({ ...fixture, routes: saved ? [{ ...saved, id: '10000000-0000-4000-8000-000000000030', versionId: '10000000-0000-4000-8000-000000000031', versionNumber: 1 }] : [] })
}
export async function getPatrolReleaseReadiness() {
  return { generatedAt: '2026-11-17T18:00:00Z', readyForBroadRelease: false, summary: { activeSites: 2, sitesMissingClient: 0, sitesMissingAddress: 0, activeRoutes: 0, activeAssignments: 0, storedPhotos: 0, storedVideos: 0, longestVideoSeconds: null }, routes: [], checks: [] }
}
export async function savePatrolRoute(input: PatrolRouteInput) {
  saved = structuredClone(input)
  document.body.dataset.savedRoute = JSON.stringify(saved)
  return '10000000-0000-4000-8000-000000000030'
}
function forbidden(): never { throw new Error('This local route fixture does not support operational actions.') }
export const getSupabaseClient = forbidden
export const assignPatrolMakeup = forbidden
export const linkPatrolRouteShift = forbidden
export const openPatrolEvidence = forbidden
export const savePatrolHit = forbidden
export const uploadPatrolEvidence = forbidden
export function formatPatrolDateTime(value: string) { return value }
