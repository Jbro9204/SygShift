import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'
import { getSupabaseClient } from '../lib/supabase'

const statusSchema = z.enum(['pending_hr_review', 'approved', 'delivered', 'employee_responded', 'closed', 'canceled'])
const responseTypeSchema = z.enum(['acknowledged_receipt', 'employee_response', 'dispute', 'declined_acknowledgment'])

const employeeOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  employeeNumber: z.string().nullable(),
})

const responseSchema = z.object({
  type: responseTypeSchema,
  statement: z.string().nullable(),
  respondedAt: z.string(),
})

const managerItemSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  caseNumber: z.number().int().positive(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  employeeNumber: z.string().nullable(),
  actionLevel: z.enum(['coaching', 'written_warning', 'final_warning', 'performance_improvement']),
  title: z.string(),
  occurredOn: z.string(),
  factualSummary: z.string(),
  policyExpectation: z.string(),
  improvementExpectation: z.string(),
  followUpOn: z.string().nullable(),
  status: statusSchema,
  proposedById: z.string().uuid(),
  proposedByName: z.string(),
  proposedAt: z.string(),
  reviewedByName: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewReason: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  responseDueAt: z.string().nullable(),
  response: responseSchema.nullable(),
  events: z.array(z.object({
    id: z.string().uuid(),
    action: z.string(),
    actorName: z.string(),
    reason: z.string(),
    occurredAt: z.string(),
  })),
})

const managerWorkspaceSchema = z.object({
  employees: z.array(employeeOptionSchema),
  summary: z.object({
    pendingReview: z.number().int().nonnegative(),
    readyToDeliver: z.number().int().nonnegative(),
    awaitingEmployee: z.number().int().nonnegative(),
    followUpDue: z.number().int().nonnegative(),
  }),
  pageSize: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  items: z.array(managerItemSchema),
})

const employeeItemSchema = z.object({
  id: z.string().uuid(),
  caseNumber: z.number().int().positive(),
  actionLevel: managerItemSchema.shape.actionLevel,
  title: z.string(),
  occurredOn: z.string(),
  factualSummary: z.string(),
  policyExpectation: z.string(),
  improvementExpectation: z.string(),
  followUpOn: z.string().nullable(),
  status: statusSchema,
  deliveredAt: z.string(),
  responseDueAt: z.string(),
  receiptWording: z.string(),
  response: responseSchema.nullable(),
})

const employeeWorkspaceSchema = z.object({
  serverTimestamp: z.string(),
  items: z.array(employeeItemSchema),
})

export type CorrectiveActionManagerItem = z.infer<typeof managerItemSchema>
export type CorrectiveActionManagerWorkspace = z.infer<typeof managerWorkspaceSchema>
export type EmployeeCorrectiveAction = z.infer<typeof employeeItemSchema>
export type CorrectiveActionResponseType = z.infer<typeof responseTypeSchema>

async function managerRequest(path: string, init?: RequestInit) {
  const response = await documentApiRequest(path, init)
  if (!response.ok) throw await parseApiError(response, 'The corrective-action workspace could not be updated.')
  return response.json()
}

export async function getGuidedCorrectiveActions(pageSize = 10, offset = 0): Promise<CorrectiveActionManagerWorkspace> {
  const payload = await managerRequest(`/api/v1/hr/cases/corrective-actions?pageSize=${pageSize}&offset=${offset}`)
  return managerWorkspaceSchema.parse(payload)
}

export async function createGuidedCorrectiveAction(input: {
  employeeId: string
  actionLevel: CorrectiveActionManagerItem['actionLevel']
  title: string
  occurredOn: string
  factualSummary: string
  policyExpectation: string
  improvementExpectation: string
  followUpOn: string | null
  submissionReason: string
}): Promise<void> {
  await managerRequest('/api/v1/hr/cases/corrective-actions', { method: 'POST', body: JSON.stringify(input) })
}

export async function reviewGuidedCorrectiveAction(id: string, decision: 'approved' | 'canceled', reason: string): Promise<void> {
  await managerRequest(`/api/v1/hr/cases/corrective-actions/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, reason }) })
}

export async function deliverGuidedCorrectiveAction(id: string, reason: string): Promise<void> {
  await managerRequest(`/api/v1/hr/cases/corrective-actions/${id}/deliver`, { method: 'POST', body: JSON.stringify({ reason }) })
}

export async function closeGuidedCorrectiveAction(id: string, reason: string): Promise<void> {
  await managerRequest(`/api/v1/hr/cases/corrective-actions/${id}/close`, { method: 'POST', body: JSON.stringify({ reason }) })
}

export async function getMyGuidedCorrectiveActions(): Promise<z.infer<typeof employeeWorkspaceSchema>> {
  const { data, error } = await getSupabaseClient().rpc('get_my_guided_corrective_actions')
  if (error) throw new Error(error.message)
  return employeeWorkspaceSchema.parse(data)
}

export async function respondToMyGuidedCorrectiveAction(id: string, responseType: CorrectiveActionResponseType, statement: string | null): Promise<void> {
  const { error } = await getSupabaseClient().rpc('respond_to_my_guided_corrective_action', {
    target_corrective_action_id: id,
    target_response_type: responseType,
    target_statement: statement,
  })
  if (error) throw new Error(error.message)
}
