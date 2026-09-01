import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

const recruitingWorkspaceSchema = z.object({
  enabled: z.boolean(),
  pageSize: z.union([z.literal(5), z.literal(10), z.literal(20)]),
  offset: z.number().int().nonnegative(),
  requisitions: z.array(z.object({
    id: z.string().uuid(),
    number: z.string(),
    title: z.string(),
    status: z.string(),
    employmentType: z.string(),
    headcount: z.number().int().positive(),
    armedRequirement: z.string(),
    updatedAt: z.string(),
  })).max(20),
  applications: z.array(z.object({
    id: z.string().uuid(),
    applicantId: z.string().uuid(),
    candidateName: z.string(),
    requisitionTitle: z.string(),
    stage: z.string(),
    status: z.string(),
    stageChangedAt: z.string(),
    convertedEmployeeId: z.string().uuid().nullable(),
  })).max(20),
  counts: z.object({
    openRequisitions: z.number().int().nonnegative(),
    activeCandidates: z.number().int().nonnegative(),
    pendingInterviews: z.number().int().nonnegative(),
    pendingOffers: z.number().int().nonnegative(),
  }),
  requestId: z.string().optional(),
})

const recruitingActionResultSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  action: z.string().optional(),
  record: z.record(z.string(), z.unknown()).nullable().optional(),
  requestId: z.string().optional(),
}).passthrough()

const conversionResultSchema = z.object({
  conversionRequestId: z.string().uuid(),
  status: z.string(),
  duplicateMatches: z.array(z.record(z.string(), z.unknown())).optional(),
  employeeId: z.string().uuid().optional(),
  loginCreated: z.boolean().optional(),
  accessGranted: z.boolean().optional(),
  requestId: z.string().optional(),
}).passthrough()

export type HrRecruitingWorkspace = z.infer<typeof recruitingWorkspaceSchema>
export type HrRecruitingAction =
  | 'create_requisition' | 'submit_requisition' | 'approve_requisition' | 'create_application'
  | 'move_application' | 'schedule_interview' | 'assign_interview_panelist' | 'submit_scorecard'
  | 'prepare_offer' | 'submit_offer' | 'approve_offer' | 'mark_offer_sent'
  | 'record_offer_decision' | 'dispose_application'

async function recruitingApi(path: string, init?: RequestInit): Promise<Response> {
  return documentApiRequest(path, init)
}

export async function getHrRecruitingWorkspace(pageSize: 5 | 10 | 20 = 10, offset = 0) {
  const parameters = new URLSearchParams({ pageSize: String(pageSize), offset: String(Math.max(0, offset)) })
  const response = await recruitingApi(`/api/v1/hr/recruiting/workspace?${parameters}`)
  if (!response.ok) throw await parseApiError(response, 'Recruiting could not be loaded.')
  return recruitingWorkspaceSchema.parse(await response.json())
}

export async function runHrRecruitingAction(action: HrRecruitingAction, payload: Record<string, unknown>, reason: string) {
  const response = await recruitingApi('/api/v1/hr/recruiting/actions', {
    method: 'POST',
    body: JSON.stringify({ action, payload, reason }),
  })
  if (!response.ok) throw await parseApiError(response, 'The recruiting action could not be completed.')
  return recruitingActionResultSchema.parse(await response.json())
}

export async function requestCandidateConversion(input: {
  applicationId: string
  role: string
  employmentType: string
  jobTitle: string
  startDate: string
  reason: string
}) {
  const response = await recruitingApi('/api/v1/hr/recruiting/conversions', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  if (!response.ok) throw await parseApiError(response, 'The employee conversion request could not be created.')
  return conversionResultSchema.parse(await response.json())
}

export async function reviewCandidateConversion(requestId: string, decision: 'approve' | 'reject' | 'cancel', reason: string) {
  const response = await recruitingApi(`/api/v1/hr/recruiting/conversions/${requestId}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision, reason }),
  })
  if (!response.ok) throw await parseApiError(response, 'The employee conversion request could not be reviewed.')
  return conversionResultSchema.parse(await response.json())
}
