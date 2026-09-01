import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

const nullableText = z.string().nullable()
const requestStatusSchema = z.enum(['requested', 'submitted', 'accepted', 'rejected', 'cancelled'])
const assignmentStatusSchema = z.enum(['pending', 'completed', 'declined', 'cancelled'])

const requestSchema = z.object({
  id: z.string().uuid(), employeeId: z.string().uuid().optional(), employeeLegalName: z.string().optional(),
  vaultCode: z.string().optional(), title: z.string(), category: z.string(), instructions: z.string(),
  dueDate: nullableText, status: requestStatusSchema, linkedDocumentId: nullableText.optional(),
  createdAt: z.string(), reviewedAt: nullableText, reviewNote: nullableText,
})

const assignmentSchema = z.object({
  id: z.string().uuid(), employeeId: z.string().uuid().optional(), employeeLegalName: z.string().optional(),
  documentId: z.string().uuid(), versionId: z.string().uuid(), documentTitle: z.string(), category: z.string().optional(),
  requirementType: z.enum(['acknowledgment', 'electronic_signature']), statement: z.string(),
  dueDate: nullableText, status: assignmentStatusSchema, createdAt: z.string(), completedAt: nullableText,
  scanState: z.enum(['quarantined', 'scan_pending', 'clean', 'rejected', 'scan_error']).optional(),
})

const managerWorkspaceSchema = z.object({
  releaseState: z.literal('released'), requests: z.array(requestSchema), assignments: z.array(assignmentSchema),
  pagination: z.object({ page: z.number().int().positive(), pageSize: z.union([z.literal(5), z.literal(10), z.literal(20)]), requestTotal: z.number().nonnegative(), assignmentTotal: z.number().nonnegative() }),
  requestId: z.string().optional(),
})
const myWorkspaceSchema = z.object({ releaseState: z.literal('released'), requests: z.array(requestSchema), assignments: z.array(assignmentSchema), requestId: z.string().optional() })
const mutationResultSchema = z.object({ id: z.string().uuid(), status: z.string(), requestId: z.string().optional() }).passthrough()
const accessGrantSchema = z.object({ accessPath: z.string().startsWith('/api/v1/hr/documents/access/'), expiresAt: z.string(), requestId: z.string() })

export type HrDocumentRequest = z.infer<typeof requestSchema>
export type HrDocumentAssignment = z.infer<typeof assignmentSchema>
export type HrDocumentWorkflowWorkspace = z.infer<typeof managerWorkspaceSchema>
export type MyHrDocumentWorkspace = z.infer<typeof myWorkspaceSchema>

async function api(path: string, init?: RequestInit): Promise<Response> {
  return documentApiRequest(path, init)
}

export async function getHrDocumentWorkflowWorkspace(filters: { page?: number; pageSize?: 5 | 10 | 20; status?: string } = {}) {
  const query = new URLSearchParams()
  if (filters.page) query.set('page', String(filters.page))
  if (filters.pageSize) query.set('pageSize', String(filters.pageSize))
  if (filters.status) query.set('status', filters.status)
  const response = await api(`/api/v1/hr/documents/workflows?${query}`)
  if (!response.ok) throw await parseApiError(response, 'Document workflows could not be loaded.')
  return managerWorkspaceSchema.parse(await response.json())
}

export async function getMyHrDocumentWorkspace() {
  const response = await api('/api/v1/hr/documents/mine')
  if (!response.ok) throw await parseApiError(response, 'Your assigned documents could not be loaded.')
  return myWorkspaceSchema.parse(await response.json())
}

async function mutate(path: string, body: Record<string, unknown>) {
  const response = await api(path, { body: JSON.stringify(body), method: 'POST' })
  if (!response.ok) throw await parseApiError(response, 'The document workflow could not be updated.')
  return mutationResultSchema.parse(await response.json())
}

export const createHrDocumentRequest = (body: Record<string, unknown>) => mutate('/api/v1/hr/documents/requests', body)
export const reviewHrDocumentRequest = (id: string, body: Record<string, unknown>) => mutate(`/api/v1/hr/documents/requests/${id}/review`, body)
export const createHrDocumentAssignment = (body: Record<string, unknown>) => mutate('/api/v1/hr/documents/assignments', body)
export const cancelHrDocumentAssignment = (id: string, reason: string) => mutate(`/api/v1/hr/documents/assignments/${id}/cancel`, { reason })
export const completeMyHrDocumentAssignment = (id: string, body: Record<string, unknown>) => mutate(`/api/v1/hr/documents/assignments/${id}/complete`, body)

export async function getMyAssignedDocumentBlob(assignmentId: string, action: 'preview' | 'download', reason: string) {
  const grantResponse = await api(`/api/v1/hr/documents/assignments/${assignmentId}/access`, { body: JSON.stringify({ action, reason }), method: 'POST' })
  if (!grantResponse.ok) throw await parseApiError(grantResponse, 'Assigned document access could not be granted.')
  const grant = accessGrantSchema.parse(await grantResponse.json())
  const response = await api(grant.accessPath)
  if (!response.ok) throw await parseApiError(response, 'The assigned document could not be loaded.')
  const disposition = response.headers.get('content-disposition') ?? ''
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  return { blob: await response.blob(), filename: encodedFilename ? decodeURIComponent(encodedFilename) : 'SygShift-document' }
}
