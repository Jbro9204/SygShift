import { z } from 'zod'
import { documentApiHeaders, parseApiError } from './hrDocuments'

const nullableText = z.string().nullable()

const onboardingWorkspaceSchema = z.object({
  enabled: z.boolean(),
  pageSize: z.union([z.literal(5), z.literal(10), z.literal(20)]),
  offset: z.number().int().nonnegative(),
  counts: z.object({
    activeCases: z.number().int().nonnegative(),
    readyCases: z.number().int().nonnegative(),
    overdueTasks: z.number().int().nonnegative(),
  }),
  cases: z.array(z.object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeNumber: z.string(),
    employeeName: z.string(),
    status: z.string(),
    targetStartDate: z.string(),
    templateName: z.string(),
    taskCounts: z.object({
      total: z.number().int().nonnegative(),
      complete: z.number().int().nonnegative(),
      overdue: z.number().int().nonnegative(),
    }),
  })).max(20),
  templates: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    status: z.string(),
    version: z.number().int().positive(),
  })),
  requestId: z.string().optional(),
})

const onboardingCaseSchema = z.object({
  case: z.object({
    id: z.string().uuid(), employeeId: z.string().uuid(), employeeNumber: z.string(), employeeName: z.string(),
    status: z.string(), targetStartDate: z.string(), templateId: z.string().uuid(), templateVersion: z.number().int().positive(),
  }),
  tasks: z.array(z.object({
    id: z.string().uuid(), stepCode: z.string(), title: z.string(), taskType: z.string(), responsibleGroup: z.string(),
    required: z.boolean(), dueAt: nullableText, status: z.string(), sourceStatus: z.record(z.string(), z.unknown()),
    evidence: z.record(z.string(), z.unknown()), resolutionReason: nullableText,
  })),
  events: z.array(z.object({ action: z.string(), actorId: z.string().uuid(), reason: z.string(), occurredAt: z.string(), details: z.record(z.string(), z.unknown()) })),
  requestId: z.string().optional(),
})

const onboardingActionResultSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  caseId: z.string().uuid().nullable().optional(),
  action: z.string(),
  caseStatus: z.string().nullable().optional(),
  requestId: z.string().optional(),
}).passthrough()

export type HrOnboardingWorkspace = z.infer<typeof onboardingWorkspaceSchema>
export type HrOnboardingCase = z.infer<typeof onboardingCaseSchema>
export type HrOnboardingAction =
  | 'create_template' | 'add_template_step' | 'add_step_dependency' | 'activate_template'
  | 'launch_case' | 'start_task' | 'complete_task' | 'waive_task' | 'finalize_case' | 'cancel_case'

async function onboardingApi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    cache: 'no-store',
    ...init,
    headers: await documentApiHeaders(init?.body ? 'application/json' : undefined),
  })
}

export async function getHrOnboardingWorkspace(pageSize: 5 | 10 | 20 = 10, offset = 0) {
  const parameters = new URLSearchParams({ pageSize: String(pageSize), offset: String(Math.max(0, offset)) })
  const response = await onboardingApi(`/api/v1/hr/onboarding/workspace?${parameters}`)
  if (!response.ok) throw await parseApiError(response, 'Onboarding could not be loaded.')
  return onboardingWorkspaceSchema.parse(await response.json())
}

export async function getHrOnboardingCase(caseId: string) {
  const response = await onboardingApi(`/api/v1/hr/onboarding/cases/${caseId}`)
  if (!response.ok) throw await parseApiError(response, 'The onboarding case could not be loaded.')
  return onboardingCaseSchema.parse(await response.json())
}

export async function runHrOnboardingAction(action: HrOnboardingAction, payload: Record<string, unknown>, reason: string) {
  const response = await onboardingApi('/api/v1/hr/onboarding/actions', {
    method: 'POST',
    body: JSON.stringify({ action, payload, reason }),
  })
  if (!response.ok) throw await parseApiError(response, 'The onboarding action could not be completed.')
  return onboardingActionResultSchema.parse(await response.json())
}
