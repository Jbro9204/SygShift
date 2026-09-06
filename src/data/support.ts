import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

export const supportCategories = [
  'schedule', 'timekeeping', 'payroll', 'human_resources', 'benefits_leave',
  'training_compliance', 'site_post', 'equipment', 'safety', 'account_access',
  'technical', 'client_request', 'other',
] as const

export type SupportCategory = (typeof supportCategories)[number]

const personSchema = z.object({ id: z.string().uuid(), name: z.string() })
const ticketListSchema = z.object({
  id: z.string().uuid(), ticketNumber: z.string(), subject: z.string(),
  category: z.enum(supportCategories), subcategory: z.string(),
  status: z.enum(['new', 'assigned', 'in_progress', 'waiting_on_employee', 'resolved', 'closed', 'reopened']).transform((status) => status === 'closed' ? 'resolved' as const : status),
  priority: z.enum(['low', 'normal', 'high', 'urgent']), confidential: z.boolean(),
  submittedBy: personSchema, assignedTo: personSchema.nullable(), createdAt: z.string(), updatedAt: z.string(),
})
const messageSchema = z.object({
  id: z.number(), body: z.string(), visibility: z.enum(['public', 'internal']), createdAt: z.string(), author: personSchema,
})
const eventSchema = z.object({ id: z.number(), type: z.string(), detail: z.record(z.string(), z.unknown()), createdAt: z.string(), actorName: z.string() })
const ticketDetailSchema = ticketListSchema.extend({
  description: z.string(), occurredOn: z.string().nullable(), stillHappening: z.boolean(),
  impact: z.record(z.string(), z.unknown()), relatedContext: z.record(z.string(), z.unknown()),
  sourcePath: z.string().nullable(), routePermission: z.string(), canManage: z.boolean(),
  messages: z.array(messageSchema), events: z.array(eventSchema),
})
const workspaceSchema = z.object({
  tickets: z.array(ticketListSchema),
  page: z.object({ number: z.number(), size: z.number(), total: z.number(), totalPages: z.number() }),
  permissions: z.object({ staffAccess: z.boolean(), canManage: z.boolean(), isAdmin: z.boolean() }),
  unreadNotifications: z.number(),
})
const submissionSchema = z.object({ id: z.string().uuid(), ticketNumber: z.string(), status: z.string(), priority: z.string() })

export type SupportTicketListItem = z.infer<typeof ticketListSchema>
export type SupportTicketDetail = z.infer<typeof ticketDetailSchema>
export type SupportWorkspace = z.infer<typeof workspaceSchema>
export type SupportTicketStatus = SupportTicketListItem['status']
export type SupportTicketPriority = SupportTicketListItem['priority']

function supportError(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback)
}

export async function submitSupportTicket(input: {
  requestId: string
  category: SupportCategory
  subcategory: string
  subject: string
  description: string
  occurredOn: string | null
  stillHappening: boolean
  confidential: boolean
  impact: Record<string, unknown>
  relatedContext: Record<string, unknown>
  sourcePath: string
  technicalContext: Record<string, unknown>
}) {
  const { data, error } = await getSupabaseClient().rpc('submit_support_ticket', { target_input: input })
  if (error) supportError(error, 'Your support ticket could not be submitted.')
  return submissionSchema.parse(data)
}

export async function getSupportWorkspace(input: { page: number; pageSize: 5 | 10 | 20; search: string; status: string }) {
  const { data, error } = await getSupabaseClient().rpc('get_support_workspace', { target_input: input })
  if (error) supportError(error, 'Support tickets could not be loaded.')
  return workspaceSchema.parse(data)
}

export async function getSupportTicket(ticketId: string) {
  const { data, error } = await getSupabaseClient().rpc('get_support_ticket', { target_ticket_id: ticketId })
  if (error) supportError(error, 'This support ticket could not be loaded.')
  return ticketDetailSchema.parse(data)
}

export async function addSupportTicketMessage(ticketId: string, body: string, internal: boolean) {
  const { data, error } = await getSupabaseClient().rpc('add_support_ticket_message', { target_ticket_id: ticketId, target_body: body, target_internal: internal })
  if (error) supportError(error, 'Your message could not be added.')
  return z.number().parse(data)
}

export async function updateSupportTicket(ticketId: string, changes: { status?: SupportTicketStatus; priority?: SupportTicketPriority; assignedTo?: string | null }) {
  const { error } = await getSupabaseClient().rpc('update_support_ticket', { target_ticket_id: ticketId, target_changes: changes })
  if (error) supportError(error, 'The support ticket could not be updated.')
}

export async function getSupportTicketAssignees(ticketId: string) {
  const { data, error } = await getSupabaseClient().rpc('get_support_ticket_assignees', { target_ticket_id: ticketId })
  if (error) supportError(error, 'Authorized ticket handlers could not be loaded.')
  return z.array(personSchema).parse(data)
}
