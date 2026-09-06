// Isolated browser fixtures. No Supabase client, real accounts, or email transport.
import type { SupportTicketDetail, SupportTicketStatus } from '../../src/data/support'
export const isSupabaseConfigured = true
const requester = { id: '10000000-0000-4000-8000-000000000001', name: 'Alex Employee' }
const handler = { id: '10000000-0000-4000-8000-000000000002', name: 'Casey Support' }
let status: SupportTicketStatus = 'new'
let messages: SupportTicketDetail['messages'] = []
const delay = () => new Promise((resolve) => setTimeout(resolve, 180))
export async function submitSupportTicket() {
  await delay()
  if (new URLSearchParams(location.search).has('error')) throw new Error('The connection was interrupted. Please try again.')
  return { id: requester.id, ticketNumber: 'TKT-TEST', status: 'new', priority: 'normal' }
}
export async function getSupportTicket(): Promise<SupportTicketDetail> {
  await delay()
  if (new URLSearchParams(location.search).has('denied')) throw new Error('This support ticket is not available to your account.')
  return { id: requester.id, ticketNumber: 'TKT-TEST', subject: 'Help with a scheduled shift', category: 'schedule', subcategory: 'Missing shift', status, priority: 'normal', confidential: false, submittedBy: requester, assignedTo: handler, createdAt: '2026-09-06T15:00:00Z', updatedAt: '2026-09-06T16:00:00Z', description: 'Please help me review the schedule for next week.', occurredOn: null, stillHappening: true, impact: {}, relatedContext: {}, sourcePath: '/schedule', routePermission: 'schedule.manage', canManage: true, messages, events: [] }
}
export async function getSupportWorkspace() {
  return { tickets: [{ id: requester.id, ticketNumber: 'TKT-TEST', subject: 'Help with a scheduled shift', category: 'schedule', subcategory: 'Missing shift', status, priority: 'normal', confidential: false, submittedBy: requester, assignedTo: handler, createdAt: '2026-09-06T15:00:00Z', updatedAt: '2026-09-06T16:00:00Z' }], page: { number: 1, size: 10, total: 1, totalPages: 1 }, permissions: { staffAccess: true, canManage: true, isAdmin: true }, unreadNotifications: 0 }
}
export async function getSupportTicketAssignees() { return [handler] }
export async function addSupportTicketMessage(_id: string, body: string, internal: boolean) {
  await delay()
  if (new URLSearchParams(location.search).has('error')) throw new Error('Reply could not be saved. Please try again.')
  messages = [...messages, { id: messages.length + 1, body, visibility: internal ? 'internal' : 'public', createdAt: '2026-09-06T16:15:00Z', author: handler }]
  if (!internal && status === 'new') status = 'in_progress'
  return messages.length
}
export async function updateSupportTicket(_id: string, changes: { status?: SupportTicketStatus }) {
  await delay()
  if (new URLSearchParams(location.search).has('error')) throw new Error('Ticket change could not be saved. Please try again.')
  if (changes.status) status = changes.status
}
