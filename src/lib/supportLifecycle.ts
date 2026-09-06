import type { SupportTicketStatus } from '../data/support'

export const supportStatusLabels = {
  new: 'New', assigned: 'Assigned', in_progress: 'In progress',
  waiting_on_employee: 'Waiting on employee', resolved: 'Resolved', reopened: 'Reopened',
} as const

export function supportLifecycle(status: SupportTicketStatus) {
  const current = status === 'resolved' ? 3 : status === 'in_progress' || status === 'waiting_on_employee' ? 2 : 1
  const labels = ['Opened', 'Queue', 'In progress', 'Resolved']
  labels[current] = supportStatusLabels[status]
  const next = status === 'resolved' ? 'Completed. Reply if you still need help; your ticket will reopen.'
    : status === 'waiting_on_employee' ? 'Waiting for the employee to reply.'
    : status === 'in_progress' ? 'The support team is working on this request.'
    : status === 'reopened' ? 'Returned to the queue for another review.'
    : status === 'assigned' ? 'Assigned and ready for the handler to begin.'
    : 'Received and waiting for an authorized handler.'
  return { current, labels, next }
}
