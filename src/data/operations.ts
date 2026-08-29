import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const notificationCenterSchema = z.object({
  permissions: z.object({
    canManage: z.boolean(),
  }).optional().default({ canManage: false }),
  summary: z.object({
    pending: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  page: z.object({
    number: z.number().int().positive(),
    size: z.number().int().min(5).max(20),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().positive(),
  }),
  batches: z.array(z.object({
    id: z.string().uuid(),
    messageType: z.string(),
    aggregateType: z.string(),
    aggregateId: z.string().uuid().nullable(),
    subject: z.string(),
    status: z.enum(['queued', 'delivered', 'failed']),
    recipientCount: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
    availableAt: z.string(),
    createdAt: z.string(),
    deliveredAt: z.string().nullable(),
    failedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    channels: z.array(z.string()),
  })),
})

const operationsReportSchema = z.object({
  generatedAt: z.string(),
  people: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    guards: z.number().int().nonnegative(),
    supervisors: z.number().int().nonnegative(),
    admins: z.number().int().nonnegative(),
    salary: z.number().int().nonnegative(),
    hourly: z.number().int().nonnegative(),
    flex: z.number().int().nonnegative().default(0),
  }),
  schedule: z.object({
    weeks: z.number().int().nonnegative(),
    shifts: z.number().int().nonnegative(),
    assignedSlots: z.number().int().nonnegative(),
    openShifts: z.number().int().nonnegative(),
    reviewNeeded: z.number().int().nonnegative(),
    armedOpenShifts: z.number().int().nonnegative(),
  }),
  sites: z.object({
    activeSites: z.number().int().nonnegative(),
    totalSites: z.number().int().nonnegative(),
  }),
  posts: z.object({
    activePosts: z.number().int().nonnegative(),
    totalPosts: z.number().int().nonnegative(),
  }),
  requests: z.object({
    timeOffPending: z.number().int().nonnegative(),
    shiftPending: z.number().int().nonnegative(),
    callOffsOpen: z.number().int().nonnegative(),
  }),
  timekeeping: z.object({
    timeEvents: z.number().int().nonnegative(),
    pendingCorrections: z.number().int().nonnegative(),
    lockedPayrollBatches: z.number().int().nonnegative(),
  }),
  notifications: z.object({
    pending: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  publishedWeeks: z.array(z.object({
    weekStartsOn: z.string(),
    revision: z.number().int().positive(),
    shifts: z.number().int().nonnegative(),
    openShifts: z.number().int().nonnegative(),
    assignedSlots: z.number().int().nonnegative(),
  })),
})

const notificationProcessSchema = z.object({
  delivered: z.array(z.string().uuid()),
  failed: z.array(z.object({ id: z.string().uuid(), error: z.string() })),
  processed: z.number().int().nonnegative(),
  requestId: z.string(),
  requestedBy: z.string(),
})

const retryNotificationSchema = z.object({
  retried: z.number().int().nonnegative(),
})

export type NotificationCenter = z.infer<typeof notificationCenterSchema>
export type OperationsReport = z.infer<typeof operationsReportSchema>
export type NotificationProcessResult = z.infer<typeof notificationProcessSchema>

export async function getNotificationCenter(input: {
  status?: 'all' | 'queued' | 'delivered' | 'failed'
  search?: string
  dateFrom?: string | null
  dateThrough?: string | null
  page?: number
  pageSize?: 5 | 10 | 20
} = {}): Promise<NotificationCenter> {
  const { data, error } = await getSupabaseClient().rpc('get_notification_center', {
    target_date_from: input.dateFrom || null,
    target_date_through: input.dateThrough || null,
    target_page: input.page ?? 1,
    target_page_size: input.pageSize ?? 10,
    target_search: input.search?.trim() || null,
    target_status: input.status ?? 'all',
  })
  if (error) throw new Error(error.message || 'Notification center could not be loaded.')
  return notificationCenterSchema.parse(data)
}

export async function retryNotificationJob(outboxId: string): Promise<{ retried: number }> {
  const { data, error } = await getSupabaseClient().rpc('retry_notification_job', {
    target_outbox_id: outboxId,
  })
  if (error) throw new Error(error.message || 'The notification job could not be retried.')
  return retryNotificationSchema.parse(data)
}

export async function retryAllFailedNotifications(): Promise<{ retried: number }> {
  const { data, error } = await getSupabaseClient().rpc('retry_all_failed_notifications')
  if (error) throw new Error(error.message || 'Failed notification jobs could not be retried.')
  return retryNotificationSchema.parse(data)
}

export async function getOperationsReport(): Promise<OperationsReport> {
  const { data, error } = await getSupabaseClient().rpc('get_operations_report')
  if (error) throw new Error(error.message || 'Operations report could not be loaded.')
  return operationsReportSchema.parse(data)
}

export async function processNotificationBatch(): Promise<NotificationProcessResult> {
  const { data: sessionData, error: sessionError } = await getSupabaseClient().auth.getSession()
  const token = sessionData.session?.access_token
  if (sessionError || !token) {
    throw new Error('Sign in with an MFA-verified operations account before sending queued emails.')
  }

  const response = await fetch('/api/v1/admin/notifications/process', {
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
  })
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'detail' in payload ? String(payload.detail) : null
    throw new Error(detail || 'Queued notifications could not be processed.')
  }
  return notificationProcessSchema.parse(payload)
}
