// Exact browser response schema from deployed main b2028d1, retained as a compatibility regression oracle.
import { z } from 'zod'

export const legacyNotificationCenterSchema = z.object({
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
