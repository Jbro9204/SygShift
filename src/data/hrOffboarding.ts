import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

export const lifecycleTypeSchema = z.enum([
  'voluntary_resignation',
  'involuntary_termination',
  'job_abandonment',
  'end_of_assignment',
  'rehire',
])

const lifecycleResultSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  requestId: z.string().optional(),
}).passthrough()

const offboardingOptionsSchema = z.object({
  enabled: z.boolean(),
  employees: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    username: z.string(),
    employeeNumber: z.string().nullable(),
    status: z.string(),
  })),
  owners: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  requestId: z.string().optional(),
})

const lifecycleCaseDetailSchema = z.object({
  case: z.object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    username: z.string(),
    employeeRole: z.string(),
    caseType: z.enum(['separation', 'rehire']),
    lifecycleType: lifecycleTypeSchema,
    status: z.string(),
    storedStatus: z.string(),
    effectiveOn: z.string(),
    requestReason: z.string(),
    requestedById: z.string().uuid(),
    requestedByName: z.string(),
    requestedAt: z.string(),
    approvedByName: z.string().nullable(),
    approvedAt: z.string().nullable(),
    decisionReason: z.string().nullable(),
    completedByName: z.string().nullable(),
    completedAt: z.string().nullable(),
    executionResult: z.record(z.string(), z.unknown()).nullable(),
    canManage: z.boolean(),
    canReview: z.boolean(),
    canExecute: z.boolean(),
    canCancel: z.boolean(),
  }),
  progress: z.object({ total: z.number().int().nonnegative(), done: z.number().int().nonnegative() }),
  tasks: z.array(z.object({
    id: z.string().uuid(),
    workstream: z.string(),
    label: z.string(),
    status: z.string(),
    assignedTo: z.string().uuid().nullable(),
    assignedToName: z.string().nullable(),
    dueOn: z.string().nullable(),
    completionNote: z.string().nullable(),
    evidenceNote: z.string().nullable(),
    completedByName: z.string().nullable(),
    completedAt: z.string().nullable(),
  })),
  events: z.array(z.object({
    id: z.string().uuid(),
    action: z.string(),
    actorName: z.string(),
    reason: z.string(),
    details: z.record(z.string(), z.unknown()),
    occurredAt: z.string(),
  })),
  documents: z.array(z.object({
    id: z.string().uuid(),
    formCode: z.string(),
    title: z.string(),
    sensitivity: z.string(),
    status: z.string(),
    sourceDocumentId: z.string().uuid().nullable(),
    available: z.boolean(),
  })),
  conditions: z.object({
    futureAssignments: z.number().int().nonnegative(),
    pendingCorrections: z.number().int().nonnegative(),
    assignedAssets: z.number().int().nonnegative(),
    activeEmployeeCases: z.number().int().nonnegative(),
    onLeave: z.boolean(),
  }),
  requestId: z.string().optional(),
})

export type LifecycleType = z.infer<typeof lifecycleTypeSchema>
export type HrOffboardingOptions = z.infer<typeof offboardingOptionsSchema>
export type HrLifecycleCaseDetail = z.infer<typeof lifecycleCaseDetailSchema>
export type HrLifecycleTask = HrLifecycleCaseDetail['tasks'][number]

async function requestResult(path: string, body: Record<string, unknown>) {
  const response = await documentApiRequest(path, { method: 'POST', body: JSON.stringify(body) })
  if (!response.ok) throw await parseApiError(response, 'The employee lifecycle action could not be completed.')
  return lifecycleResultSchema.parse(await response.json())
}

export async function getHrOffboardingOptions(): Promise<HrOffboardingOptions> {
  const response = await documentApiRequest('/api/v1/hr/offboarding/options')
  if (!response.ok) throw await parseApiError(response, 'Employee Lifecycle options could not be loaded.')
  return offboardingOptionsSchema.parse(await response.json())
}

export async function createHrLifecycleCase(input: {
  employeeId: string
  lifecycleType: LifecycleType
  effectiveOn: string
  reason: string
}) {
  return requestResult('/api/v1/hr/offboarding/cases', input)
}

export async function getHrLifecycleCase(caseId: string): Promise<HrLifecycleCaseDetail> {
  const response = await documentApiRequest(`/api/v1/hr/offboarding/cases/${encodeURIComponent(caseId)}`)
  if (!response.ok) throw await parseApiError(response, 'The employee lifecycle case could not be loaded.')
  return lifecycleCaseDetailSchema.parse(await response.json())
}

export async function reviewHrLifecycleCase(input: { caseId: string; decision: 'approved' | 'denied'; reason: string }) {
  return requestResult(`/api/v1/hr/offboarding/cases/${encodeURIComponent(input.caseId)}/review`, input)
}

export async function updateHrLifecycleTask(input: {
  taskId: string
  status: 'ready' | 'in_progress' | 'blocked' | 'completed' | 'waived'
  assignedTo: string | null
  dueOn: string | null
  note: string | null
}) {
  return requestResult(`/api/v1/hr/offboarding/tasks/${encodeURIComponent(input.taskId)}`, input)
}

export async function cancelHrLifecycleCase(input: { caseId: string; reason: string }) {
  return requestResult(`/api/v1/hr/offboarding/cases/${encodeURIComponent(input.caseId)}/cancel`, input)
}

export async function executeHrLifecycleCase(input: { caseId: string; confirmationUsername: string; reason: string }) {
  return requestResult(`/api/v1/hr/offboarding/cases/${encodeURIComponent(input.caseId)}/execute`, input)
}
