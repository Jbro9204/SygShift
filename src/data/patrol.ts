import { Upload } from 'tus-js-client'
import { z } from 'zod'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'
import { getSupabaseClient } from '../lib/supabase'

const requirementSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6), id: z.string().uuid(), label: z.string(),
  minimumSpacingMinutes: z.number().nullable(), requiredHits: z.number().int(), sequenceRequired: z.boolean(),
  status: z.enum(['active', 'paused']), windowEnd: z.string().nullable(), windowStart: z.string().nullable(),
})

const stopSchema = z.object({
  addressLine1: z.string().nullable(), allowPhotos: z.boolean(), allowVideos: z.boolean(), city: z.string().nullable(),
  evidenceInstructions: z.string().nullable(), geofenceRadiusMeters: z.number().nullable(), id: z.string().uuid(),
  incidentVideoLimitSeconds: z.number().int(), instructions: z.string().nullable(), latitude: z.number().nullable(),
  locationLabel: z.string(), longitude: z.number().nullable(), postalCode: z.string().nullable(),
  postId: z.string().uuid().nullable(), region: z.string().nullable(), requireEvidence: z.boolean(),
  requirements: z.array(requirementSchema), sequence: z.number().int(), siteId: z.string().uuid().nullable(),
  stableKey: z.string().uuid(), standardVideoLimitSeconds: z.number().int(),
})

const routeSchema = z.object({
  changeReason: z.string(), code: z.string(), effectiveFrom: z.string().nullable(), effectiveThrough: z.string().nullable(),
  id: z.string().uuid(), name: z.string(), requiresArmed: z.boolean(), status: z.enum(['draft', 'active', 'paused', 'archived']),
  stops: z.array(stopSchema), timeZone: z.string(), versionId: z.string().uuid(), versionNumber: z.number().int(),
})

const evidenceSchema = z.object({
  byteSize: z.number(), createdAt: z.string(), durationSeconds: z.number().nullable(), filename: z.string(),
  id: z.string().uuid(), kind: z.enum(['photo', 'video']), mimeType: z.string(),
  status: z.enum(['pending_upload', 'stored', 'failed']),
})

const hitSchema = z.object({
  classification: z.enum(['required', 'makeup', 'extra']), evidence: z.array(evidenceSchema),
  extraReason: z.string().nullable(), id: z.string().uuid(), locationLabel: z.string(),
  locationStatus: z.enum(['not_configured', 'verified', 'outside_geofence', 'unavailable', 'declined']),
  note: z.string().nullable(), obligationId: z.string().uuid().nullable(),
  outcome: z.enum(['secure', 'attention_needed', 'incident', 'unable_to_access', 'other']).nullable(),
  status: z.enum(['draft', 'submitted']), stopId: z.string().uuid(), submittedAt: z.string().nullable(),
})

const obligationSchema = z.object({
  allowPhotos: z.boolean(), allowVideos: z.boolean(), completedHitId: z.string().uuid().nullable(),
  dueEndAt: z.string(), dueStartAt: z.string(), evidenceInstructions: z.string().nullable(),
  hitNumber: z.number().int(), id: z.string().uuid(), locationConfigured: z.boolean(), locationLabel: z.string(),
  requireEvidence: z.boolean(), requirementId: z.string().uuid(), requirementLabel: z.string(),
  status: z.enum(['scheduled', 'due', 'late', 'completed', 'missed', 'waived']), stopId: z.string().uuid(),
})

const makeupObligationSchema = obligationSchema.extend({
  assignmentId: z.string().uuid(), makeupAssignmentId: z.string().uuid(), originalEmployeeName: z.string(),
  originalServiceDate: z.string(), reason: z.string(), status: z.literal('assigned'),
})

const assignmentSchema = z.object({
  employeeId: z.string().uuid(), employeeName: z.string(), endsAt: z.string(), hits: z.array(hitSchema),
  id: z.string().uuid(), makeupObligations: z.array(makeupObligationSchema).default([]), obligations: z.array(obligationSchema), requiresArmed: z.boolean(),
  routeId: z.string().uuid(), routeName: z.string(), routeVersionId: z.string().uuid(), serviceDate: z.string(),
  shiftId: z.string().uuid(), startsAt: z.string(), status: z.enum(['active', 'completed']), timeZone: z.string(),
})

const scheduleCandidateSchema = z.object({
  employeeId: z.string().uuid(), employeeName: z.string(), endsAt: z.string(), postName: z.string().nullable(),
  requiresArmed: z.boolean(), shiftId: z.string().uuid(), siteName: z.string().nullable(), startsAt: z.string(), timeZone: z.string(),
})

const makeupQueueSchema = z.object({
  assignmentId: z.string().uuid(), dueEndAt: z.string(), employeeId: z.string().uuid(), employeeName: z.string(),
  locationLabel: z.string(), obligationId: z.string().uuid(), routeName: z.string(), serviceDate: z.string(), status: z.literal('missed'),
})

const patrolLocationSchema = z.object({
  addressLine1: z.string().nullable(), city: z.string().nullable(), postId: z.string().uuid(), postName: z.string(),
  postalCode: z.string().nullable(), region: z.string().nullable(), requiresArmed: z.boolean(), siteCode: z.string().nullable(),
  siteId: z.string().uuid(), siteName: z.string(), timeZone: z.string(),
})

const workspaceSchema = z.object({
  actor: z.object({
    canExportReports: z.boolean(), canManageAssignments: z.boolean(), canManageExceptions: z.boolean(),
    canManageRoutes: z.boolean(), canViewEvidence: z.boolean(), canViewOperations: z.boolean(), employeeId: z.string().uuid(),
  }),
  assignments: z.array(assignmentSchema), locations: z.array(patrolLocationSchema), makeupQueue: z.array(makeupQueueSchema),
  routes: z.array(routeSchema), scheduleCandidates: z.array(scheduleCandidateSchema),
})

const reportRowSchema = z.object({
  armed: z.boolean(), completedAt: z.string().nullable(), dueEndAt: z.string(), dueStartAt: z.string(),
  employeeName: z.string(), employeeNumber: z.string().nullable(), evidenceCount: z.number(), hitNumber: z.number().nullable(),
  locationLabel: z.string(), locationStatus: z.string().nullable(), note: z.string().nullable(), obligationId: z.string().uuid().nullable(),
  outcome: z.string().nullable(), requirementLabel: z.string(), routeName: z.string(), serviceDate: z.string(), status: z.string(),
  classification: z.enum(['required', 'makeup', 'extra']), recordId: z.string().uuid(),
})

const patrolReportSchema = z.object({
  canExport: z.boolean(), generatedAt: z.string(), rows: z.array(reportRowSchema),
  summary: z.object({ completed: z.number(), evidence: z.number(), extra: z.number(), incidents: z.number(), makeupAssigned: z.number(), makeupCompleted: z.number(), missed: z.number(), required: z.number() }),
})

export type PatrolWorkspace = z.infer<typeof workspaceSchema>
export type PatrolRoute = z.infer<typeof routeSchema>
export type PatrolStop = z.infer<typeof stopSchema>
export type PatrolRequirement = z.infer<typeof requirementSchema>
export type PatrolAssignment = z.infer<typeof assignmentSchema>
export type PatrolObligation = z.infer<typeof obligationSchema>
export type PatrolMakeupObligation = z.infer<typeof makeupObligationSchema>
export type PatrolHit = z.infer<typeof hitSchema>
export type PatrolEvidence = z.infer<typeof evidenceSchema>
export type PatrolReport = z.infer<typeof patrolReportSchema>

export interface PatrolRouteInput {
  changeReason: string; code: string; effectiveFrom: string | null; effectiveThrough: string | null; id: string | null
  name: string; requiresArmed: boolean; status: 'draft' | 'active' | 'paused' | 'archived'; timeZone: string
  stops: Array<{
    addressLine1: string | null; allowPhotos: boolean; allowVideos: boolean; city: string | null
    evidenceInstructions: string | null; geofenceRadiusMeters: number | null; incidentVideoLimitSeconds: number
    instructions: string | null; latitude: number | null; locationLabel: string; longitude: number | null
    postalCode: string | null; postId: string | null; region: string | null; requireEvidence: boolean
    siteId: string | null; stableKey: string; standardVideoLimitSeconds: number
    requirements: Array<{
      dayOfWeek: number; label: string; minimumSpacingMinutes: number | null; requiredHits: number
      sequenceRequired: boolean; status: 'active' | 'paused'; windowEnd: string | null; windowStart: string | null
    }>
  }>
}

export interface SavePatrolHitInput {
  accuracyMeters?: number | null; assignmentId: string; classification: 'required' | 'makeup' | 'extra'
  clientRecordedAt?: string | null; extraReason?: string | null; hitId?: string | null; idempotencyKey: string
  latitude?: number | null; locationStatus: 'not_configured' | 'verified' | 'outside_geofence' | 'unavailable' | 'declined'
  longitude?: number | null; makeupAssignmentId?: string | null; note: string; obligationId?: string | null
  outcome: 'secure' | 'attention_needed' | 'incident' | 'unable_to_access' | 'other'; stopId: string; submit: boolean
}

function messageFromError(error: { message?: string } | null, fallback: string): Error {
  return new Error(error?.message || fallback)
}

export async function getPatrolWorkspace(): Promise<PatrolWorkspace> {
  const client = getSupabaseClient()
  const [workspaceResult, makeupResult] = await Promise.all([
    client.rpc('get_patrol_workspace'), client.rpc('get_patrol_makeup_work'),
  ])
  if (workspaceResult.error) throw messageFromError(workspaceResult.error, 'Patrol could not be loaded.')
  if (makeupResult.error) throw messageFromError(makeupResult.error, 'Assigned makeup patrol work could not be loaded.')
  const workspace = workspaceSchema.parse(workspaceResult.data)
  const makeupWork = z.array(makeupObligationSchema).parse(makeupResult.data)
  return {
    ...workspace,
    assignments: workspace.assignments.map((assignment) => ({
      ...assignment,
      makeupObligations: makeupWork.filter((item) => item.assignmentId === assignment.id),
    })),
  }
}

export async function savePatrolRoute(route: PatrolRouteInput): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('save_patrol_route', { target_route: route })
  if (error) throw messageFromError(error, 'The patrol route could not be saved.')
  return z.string().uuid().parse(data)
}

export async function linkPatrolRouteShift(routeId: string, shiftId: string, employeeId: string): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('link_patrol_route_shift', {
    target_employee_id: employeeId, target_route_id: routeId, target_shift_id: shiftId,
  })
  if (error) throw messageFromError(error, 'The published shift could not be linked to the patrol route.')
  return z.string().uuid().parse(data)
}

export async function savePatrolHit(input: SavePatrolHitInput): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('save_patrol_hit', {
    target_accuracy_meters: input.accuracyMeters ?? null, target_assignment_id: input.assignmentId,
    target_classification: input.classification, target_client_recorded_at: input.clientRecordedAt ?? null,
    target_extra_reason: input.extraReason ?? null, target_hit_id: input.hitId ?? null,
    target_idempotency_key: input.idempotencyKey, target_latitude: input.latitude ?? null,
    target_location_status: input.locationStatus, target_longitude: input.longitude ?? null,
    target_makeup_assignment_id: input.makeupAssignmentId ?? null, target_note: input.note,
    target_obligation_id: input.obligationId ?? null, target_outcome: input.outcome,
    target_stop_id: input.stopId, target_submit: input.submit,
  })
  if (error) throw messageFromError(error, 'The patrol hit could not be saved.')
  return z.string().uuid().parse(data)
}

export async function assignPatrolMakeup(obligationId: string, assignmentId: string, reason: string): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('assign_patrol_makeup', {
    target_assignment_id: assignmentId, target_obligation_id: obligationId, target_reason: reason,
  })
  if (error) throw messageFromError(error, 'The makeup hit could not be assigned.')
  return z.string().uuid().parse(data)
}

export async function getPatrolReport(from: string, through: string): Promise<PatrolReport> {
  const client = getSupabaseClient()
  const parameters = { target_from: from, target_through: through }
  const [baseResult, supplementResult] = await Promise.all([
    client.rpc('get_patrol_report', parameters), client.rpc('get_patrol_report_supplement', parameters),
  ])
  if (baseResult.error) throw messageFromError(baseResult.error, 'The Patrol Activity report could not be loaded.')
  if (supplementResult.error) throw messageFromError(supplementResult.error, 'Supplemental Patrol activity could not be loaded.')
  const base = z.object({
    canExport: z.boolean(), generatedAt: z.string(), rows: z.array(reportRowSchema.omit({ classification: true, recordId: true }).extend({ obligationId: z.string().uuid() })),
    summary: z.object({ completed: z.number(), evidence: z.number(), extra: z.number(), incidents: z.number(), missed: z.number(), required: z.number() }),
  }).parse(baseResult.data)
  const supplement = z.object({
    rows: z.array(reportRowSchema), summary: z.object({ makeupAssigned: z.number(), makeupCompleted: z.number() }),
  }).parse(supplementResult.data)
  return patrolReportSchema.parse({
    ...base,
    rows: [
      ...base.rows.map((row) => ({ ...row, classification: 'required' as const, recordId: row.obligationId })),
      ...supplement.rows,
    ].sort((left, right) => right.serviceDate.localeCompare(left.serviceDate)
      || left.routeName.localeCompare(right.routeName)
      || left.locationLabel.localeCompare(right.locationLabel)
      || left.classification.localeCompare(right.classification)),
    summary: { ...base.summary, ...supplement.summary },
  })
}

export async function authorizePatrolReportExport(from: string, through: string, profile: 'internal' | 'client', format: 'xlsx' | 'csv' | 'pdf'): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('authorize_patrol_report_export', {
    target_format: format, target_from: from, target_profile: profile, target_through: through,
  })
  if (error) throw messageFromError(error, 'The Patrol report export could not be authorized.')
  return z.object({ authorizedAt: z.string() }).parse(data).authorizedAt
}

async function apiHeaders(): Promise<Headers> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Your secure session is not available. Sign in again and retry.')
  return appendProtectedSessionHeaders({ authorization: `Bearer ${data.session.access_token}` })
}

async function readApiError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as { detail?: string, error?: string } | null
  return new Error(payload?.detail || payload?.error?.replaceAll('_', ' ') || fallback)
}

function videoDuration(file: File): Promise<number | null> {
  if (!file.type.startsWith('video/')) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? Math.ceil(video.duration) : null
      URL.revokeObjectURL(url)
      resolve(duration)
    }
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The selected video duration could not be verified.')) }
    video.src = url
  })
}

export async function uploadPatrolEvidence(hitId: string, file: File, onProgress: (percentage: number) => void): Promise<void> {
  const durationSeconds = await videoDuration(file)
  const mediaKind = file.type.startsWith('video/') ? 'video' : 'photo'
  const headers = await apiHeaders()
  headers.set('content-type', 'application/json')
  const authorization = await fetch(`/api/v1/patrol/hits/${hitId}/evidence/upload-url`, {
    body: JSON.stringify({ byteSize: file.size, durationSeconds, filename: file.name, idempotencyKey: crypto.randomUUID(), mediaKind, mimeType: file.type }),
    headers, method: 'POST',
  })
  if (!authorization.ok) throw await readApiError(authorization, 'The evidence upload could not be authorized.')
  const target = z.object({
    bucket: z.string(), evidenceId: z.string().uuid(), objectKey: z.string(), resumableEndpoint: z.string().url(), signedUploadToken: z.string().min(1),
  }).parse(await authorization.json())

  await new Promise<void>((resolve, reject) => {
    const upload = new Upload(file, {
      chunkSize: 6 * 1024 * 1024, endpoint: target.resumableEndpoint, headers: { 'x-signature': target.signedUploadToken },
      metadata: { bucketName: target.bucket, cacheControl: '3600', contentType: file.type, filename: file.name, objectName: target.objectKey },
      onError: (error) => reject(new Error(error.message || 'The resumable upload failed.')),
      onProgress: (uploaded, total) => onProgress(total > 0 ? Math.round((uploaded / total) * 100) : 0),
      onSuccess: () => resolve(), removeFingerprintOnSuccess: true, retryDelays: [0, 3000, 5000, 10000, 20000], uploadDataDuringCreation: true,
    })
    void upload.findPreviousUploads().then((previous) => { if (previous[0]) upload.resumeFromPreviousUpload(previous[0]); upload.start() }).catch(reject)
  })

  const completeHeaders = await apiHeaders()
  completeHeaders.set('content-type', 'application/json')
  const completed = await fetch(`/api/v1/patrol/evidence/${target.evidenceId}/complete`, {
    body: JSON.stringify({ bucket: target.bucket, objectKey: target.objectKey }), headers: completeHeaders, method: 'POST',
  })
  if (!completed.ok) throw await readApiError(completed, 'The uploaded evidence could not be finalized.')
  onProgress(100)
}

export async function openPatrolEvidence(evidenceId: string, action: 'preview' | 'download'): Promise<void> {
  const response = await fetch(`/api/v1/patrol/evidence/${evidenceId}/content?action=${action}`, { headers: await apiHeaders() })
  if (!response.ok) throw await readApiError(response, 'The protected evidence could not be opened.')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  if (action === 'download') anchor.download = 'patrol-evidence'
  else anchor.target = '_blank'
  anchor.rel = 'noopener'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function formatPatrolDateTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone, timeZoneName: 'short' }).format(new Date(value))
}
