import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

const nullableText = z.string().nullable()

const automationTaskSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  title: z.string(),
  instructions: nullableText,
  status: z.string(),
  dueAt: nullableText,
  escalatedAt: nullableText,
})

const myAutomationTasksSchema = z.object({
  enabled: z.boolean(),
  total: z.number().int().nonnegative(),
  tasks: z.array(automationTaskSchema).max(10),
  requestId: z.string().optional(),
})

const workflowDefinitionSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: nullableText,
  status: z.string(),
  activeVersionId: z.string().uuid().nullable(),
  updatedAt: z.string(),
})

const workflowInstanceSchema = z.object({
  id: z.string().uuid(),
  workflowName: z.string(),
  subjectEmployeeId: z.string().uuid().nullable(),
  subjectName: nullableText,
  state: z.string(),
  currentStepKey: nullableText,
  dueAt: nullableText,
  createdAt: z.string(),
  failureCode: nullableText,
  failureMessage: nullableText,
})

const workflowTaskSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  title: z.string(),
  instructions: nullableText,
  status: z.string(),
  assignedEmployeeId: z.string().uuid().nullable(),
  assignedName: nullableText,
  requiredPermission: nullableText,
  dueAt: nullableText,
  escalatedAt: nullableText,
  escalationCount: z.number().int().nonnegative(),
})

const deadLetterSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  instanceId: z.string().uuid(),
  errorCode: z.string(),
  errorMessage: z.string(),
  failedAt: z.string(),
  replayedAt: nullableText,
})

const automationWorkspaceSchema = z.object({
  enabled: z.boolean(),
  pageSize: z.union([z.literal(5), z.literal(10), z.literal(20)]),
  offset: z.number().int().nonnegative(),
  definitions: z.array(workflowDefinitionSchema).max(20),
  instances: z.array(workflowInstanceSchema).max(20),
  tasks: z.array(workflowTaskSchema).max(20),
  deadLetters: z.array(deadLetterSchema).max(20),
  counts: z.object({
    definitions: z.number().int().nonnegative(),
    activeInstances: z.number().int().nonnegative(),
    openTasks: z.number().int().nonnegative(),
    deadLetters: z.number().int().nonnegative(),
  }),
  requestId: z.string().optional(),
})

export type HrAutomationTask = z.infer<typeof automationTaskSchema>
export type HrAutomationWorkspace = z.infer<typeof automationWorkspaceSchema>

async function automationApi(path: string, init?: RequestInit): Promise<Response> {
  return documentApiRequest(path, init)
}

export async function getMyHrAutomationTasks() {
  const response = await automationApi('/api/v1/hr/automation/mine')
  if (!response.ok) throw await parseApiError(response, 'HR actions could not be loaded.')
  return myAutomationTasksSchema.parse(await response.json())
}

export async function getHrAutomationWorkspace(pageSize: 5 | 10 | 20 = 10, offset = 0) {
  const parameters = new URLSearchParams({ pageSize: String(pageSize), offset: String(Math.max(0, offset)) })
  const response = await automationApi(`/api/v1/hr/automation/workspace?${parameters}`)
  if (!response.ok) throw await parseApiError(response, 'HR automation could not be loaded.')
  return automationWorkspaceSchema.parse(await response.json())
}

export async function markHrAutomationTaskViewed(taskId: string) {
  const response = await automationApi(`/api/v1/hr/automation/tasks/${taskId}/viewed`, { method: 'POST' })
  if (!response.ok) throw await parseApiError(response, 'The HR action could not be opened.')
  return z.object({ taskId: z.string().uuid(), status: z.string() }).passthrough().parse(await response.json())
}

export async function completeHrAutomationTask(taskId: string, note: string) {
  const response = await automationApi(`/api/v1/hr/automation/tasks/${taskId}/complete`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  })
  if (!response.ok) throw await parseApiError(response, 'The HR action could not be completed.')
  return z.object({ taskId: z.string().uuid(), status: z.string() }).passthrough().parse(await response.json())
}
