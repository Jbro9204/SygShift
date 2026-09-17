import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const conversationTypeSchema = z.enum([
  'employee_conversation',
  'coaching',
  'training',
  'policy_reminder',
  'performance_follow_up',
  'recognition',
  'other',
])

const conversationStatusSchema = z.enum(['open', 'completed', 'voided'])

const employeeSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  employeeNumber: z.string().nullable(),
  jobTitle: z.string().nullable(),
  status: z.string(),
  supervisorName: z.string().nullable(),
})

const eventSchema = z.object({
  id: z.string().uuid(),
  eventType: z.enum(['created', 'follow_up', 'completed', 'reopened', 'voided']),
  actorName: z.string(),
  note: z.string(),
  details: z.record(z.string(), z.unknown()),
  occurredAt: z.string(),
})

const itemSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  conversationType: conversationTypeSchema,
  occurredOn: z.string(),
  subject: z.string(),
  factualSummary: z.string(),
  expectations: z.string().nullable(),
  employeePresent: z.boolean(),
  followUpOn: z.string().nullable(),
  status: conversationStatusSchema,
  createdById: z.string().uuid(),
  createdByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canManage: z.boolean(),
  canVoid: z.boolean(),
  events: z.array(eventSchema),
})

const workspaceSchema = z.object({
  viewerEmployeeId: z.string().uuid(),
  canCreate: z.boolean(),
  canReviewAll: z.boolean(),
  employees: z.array(employeeSchema),
  selectedEmployee: employeeSchema.nullable(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    training: z.number().int().nonnegative(),
    followUpDue: z.number().int().nonnegative(),
  }),
  pageSize: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  items: z.array(itemSchema),
})

export type EmployeeConversationType = z.infer<typeof conversationTypeSchema>
export type EmployeeConversationStatus = z.infer<typeof conversationStatusSchema>
export type EmployeeConversationEmployee = z.infer<typeof employeeSchema>
export type EmployeeConversationItem = z.infer<typeof itemSchema>
export type EmployeeConversationsWorkspace = z.infer<typeof workspaceSchema>

export const employeeConversationTypeLabels: Record<EmployeeConversationType, string> = {
  employee_conversation: 'Employee conversation',
  coaching: 'Coaching',
  training: 'Training completed',
  policy_reminder: 'Policy reminder',
  performance_follow_up: 'Performance follow-up',
  recognition: 'Recognition',
  other: 'Other documented conversation',
}

const safeServerMessages = [
  'An active employee account is required.',
  'Identity verification is required to open employee conversations.',
  'Identity verification is required to record an employee conversation.',
  'Identity verification is required to update an employee conversation.',
  'Employee Conversations access is required.',
  'This employee is outside your authorized supervisory scope.',
  'You can record conversations only for employees within your authorized supervisory scope.',
  'Choose an active, onboarding, or leave employee.',
  'Choose a valid conversation type.',
  'Choose a valid record status.',
  'Conversation date cannot be in the future.',
  'Enter a subject between 3 and 180 characters.',
  'Enter a factual summary between 8 and 10,000 characters.',
  'Next steps must be between 3 and 6,000 characters when provided.',
  'Follow-up date cannot be before the conversation date.',
  'Follow-up date cannot be before the original conversation date.',
  'Employee conversation record not found.',
  'HR review access is required to void this record.',
  'Enter a clear note between 3 and 10,000 characters.',
  'Enter a void reason between 8 and 2,000 characters.',
  'Choose a valid conversation action.',
  'A voided record cannot be changed.',
  'Reopen this record before adding another follow-up.',
  'Only an open record can be completed.',
  'Only a completed record can be reopened.',
] as const

function safeError(error: { message?: string } | null, fallback: string): Error {
  const message = error?.message?.trim()
  return new Error(message && safeServerMessages.some((allowed) => message.includes(allowed)) ? message : fallback)
}

export async function getEmployeeConversationsWorkspace(input: {
  employeeId: string | null
  type?: EmployeeConversationType | 'all'
  status?: EmployeeConversationStatus | 'active' | 'all'
  pageSize?: number
  offset?: number
}): Promise<EmployeeConversationsWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_employee_conversations_workspace', {
    target_employee_id: input.employeeId,
    target_type: input.type ?? 'all',
    target_status: input.status ?? 'active',
    target_page_size: input.pageSize ?? 10,
    target_offset: input.offset ?? 0,
  })
  if (error) throw safeError(error, 'Employee Conversations could not be loaded. Please try again.')
  return workspaceSchema.parse(data)
}

export async function createEmployeeConversation(input: {
  employeeId: string
  conversationType: EmployeeConversationType
  occurredOn: string
  subject: string
  factualSummary: string
  expectations: string | null
  employeePresent: boolean
  followUpOn: string | null
}): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('create_employee_conversation', {
    target_employee_id: input.employeeId,
    target_conversation_type: input.conversationType,
    target_occurred_on: input.occurredOn,
    target_subject: input.subject,
    target_factual_summary: input.factualSummary,
    target_expectations: input.expectations,
    target_employee_present: input.employeePresent,
    target_follow_up_on: input.followUpOn,
  })
  if (error) throw safeError(error, 'The conversation was not saved. Your entries are still here; review them and try again.')
  return z.string().uuid().parse(data)
}

export async function recordEmployeeConversationAction(input: {
  conversationId: string
  action: 'follow_up' | 'complete' | 'reopen' | 'void'
  note: string
  followUpOn: string | null
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc('record_employee_conversation_action', {
    target_conversation_id: input.conversationId,
    target_action: input.action,
    target_note: input.note,
    target_follow_up_on: input.followUpOn,
  })
  if (error) throw safeError(error, 'The conversation update was not saved. Your note is still here; please try again.')
}
