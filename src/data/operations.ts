import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const notificationCenterSchema = z.object({
  summary: z.object({
    pending: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  recent: z.array(z.object({
    id: z.string().uuid(),
    messageType: z.string(),
    aggregateType: z.string(),
    aggregateId: z.string().uuid().nullable(),
    attemptCount: z.number().int().nonnegative(),
    availableAt: z.string(),
    createdAt: z.string(),
    deliveredAt: z.string().nullable(),
    failedAt: z.string().nullable(),
    lastError: z.string().nullable(),
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

export type NotificationCenter = z.infer<typeof notificationCenterSchema>
export type OperationsReport = z.infer<typeof operationsReportSchema>
export type NotificationProcessResult = z.infer<typeof notificationProcessSchema>

export async function getNotificationCenter(): Promise<NotificationCenter> {
  const { data, error } = await getSupabaseClient().rpc('get_notification_center')
  if (error) throw new Error(error.message || 'Notification center could not be loaded.')
  return notificationCenterSchema.parse(data)
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
