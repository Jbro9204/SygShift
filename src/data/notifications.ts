import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const badgeSchema = z.object({ unread: z.number().int().nonnegative(), requiresAction: z.number().int().nonnegative(), urgent: z.number().int().nonnegative() })
const notificationSchema = z.object({
  id: z.string().uuid(), title: z.string(), body: z.string(), priority: z.enum(['routine', 'important', 'urgent']),
  sourceType: z.string(), sourceId: z.string().uuid().nullable(), requiresAcknowledgement: z.boolean(),
  actionRequired: z.boolean(), resolvedAt: z.string().nullable(),
  readAt: z.string().nullable(), acknowledgedAt: z.string().nullable(), createdAt: z.string(), expiresAt: z.string().nullable(),
  actionPath: z.string().nullable(), actionLabel: z.string().nullable(), senderName: z.string(),
})
const inboxSchema = z.object({
  summary: badgeSchema,
  permissions: z.object({ canSend: z.boolean(), canManageDelivery: z.boolean() }),
  page: z.object({ number: z.number().int().positive(), size: z.number().int(), total: z.number().int().nonnegative(), totalPages: z.number().int().positive() }),
  notifications: z.array(notificationSchema),
})
const composerOptionsSchema = z.object({
  employees: z.array(z.object({ id: z.string().uuid(), name: z.string(), role: z.string(), title: z.string().nullable() })),
  roles: z.array(z.object({ code: z.string(), label: z.string(), count: z.number().int().nonnegative() })),
  canSendEveryone: z.boolean(),
})
const sendResultSchema = z.object({ campaignId: z.string().uuid(), recipientCount: z.number().int().positive(), emailEnabled: z.boolean() })
const clearResultSchema = z.object({
  markedRead: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
  remainingRequired: z.number().int().nonnegative(),
})

export type EmployeeNotification = z.infer<typeof notificationSchema>
export type NotificationInbox = z.infer<typeof inboxSchema>
export type NotificationComposerOptions = z.infer<typeof composerOptionsSchema>
export type NotificationClearResult = z.infer<typeof clearResultSchema>

function notificationError(error: { message?: string } | null, fallback: string): never { throw new Error(error?.message || fallback) }

export async function getMyNotificationBadge() {
  const { data, error } = await getSupabaseClient().rpc('get_my_notification_badge')
  if (error) notificationError(error, 'Notification status could not be loaded.')
  return badgeSchema.parse(data)
}

export async function getMyNotifications(input: { filter: 'all' | 'unread' | 'action'; category: string; page: number; pageSize: 5 | 10 | 20 }) {
  const { data, error } = await getSupabaseClient().rpc('get_my_notifications', {
    target_filter: input.filter, target_category: input.category, target_page: input.page, target_page_size: input.pageSize,
  })
  if (error) notificationError(error, 'Your notifications could not be loaded.')
  return inboxSchema.parse(data)
}

export async function markMyNotificationRead(notificationId: string) {
  const { error } = await getSupabaseClient().rpc('mark_my_notification_read', { target_notification_id: notificationId })
  if (error) notificationError(error, 'The notification could not be marked as read.')
}

export async function acknowledgeMyNotification(notificationId: string) {
  const { error } = await getSupabaseClient().rpc('acknowledge_my_notification', { target_notification_id: notificationId })
  if (error) notificationError(error, 'The notification could not be acknowledged.')
}

export async function dismissMyNotification(notificationId: string) {
  const { error } = await getSupabaseClient().rpc('dismiss_my_notification', { target_notification_id: notificationId })
  if (error) notificationError(error, 'The notification could not be dismissed.')
}

export async function clearMyNotifications(): Promise<NotificationClearResult> {
  const { data, error } = await getSupabaseClient().rpc('clear_my_notifications')
  if (error) notificationError(error, 'Your notifications could not be cleared.')
  return clearResultSchema.parse(data)
}

export async function getNotificationComposerOptions(search = '') {
  const { data, error } = await getSupabaseClient().rpc('get_notification_composer_options', { target_search: search.trim() || null })
  if (error) notificationError(error, 'Notification recipients could not be loaded.')
  return composerOptionsSchema.parse(data)
}

export async function sendEmployeeNotification(input: {
  title: string; body: string; priority: 'routine' | 'important' | 'urgent'; requiresAcknowledgement: boolean; emailEnabled: boolean;
  everyone: boolean; employeeIds: string[]; roles: string[]; actionPath: string | null; actionLabel: string | null;
}) {
  const { data, error } = await getSupabaseClient().rpc('send_employee_notification', { target_input: input })
  if (error) notificationError(error, 'The notification could not be sent.')
  return sendResultSchema.parse(data)
}
