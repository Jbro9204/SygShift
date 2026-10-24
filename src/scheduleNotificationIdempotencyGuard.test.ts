/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20261024172000_durable_manual_schedule_notifications.sql'),
  'utf8',
)
const regression = readFileSync(
  join(root, 'supabase', 'tests', 'durable_manual_schedule_notifications_regression.sql'),
  'utf8',
)
const dataSource = readFileSync(join(root, 'src', 'data', 'schedule.ts'), 'utf8')
const pageSource = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
const operationSource = readFileSync(join(root, 'src', 'schedule', 'notificationOperation.ts'), 'utf8')

describe('durable manual schedule notification guardrails', () => {
  it('binds the first immutable manifest to an explicit operation UUID', () => {
    expect(migration).toContain('target_operation_id uuid')
    expect(migration).toContain("'schedule-published-manual-operation:' || target_operation_id::text")
    expect(migration).toContain("'notificationOperationId', target_operation_id")
    expect(migration).toContain("'notificationRequestedBy', actor_id")
    expect(migration).toContain("public.has_effective_permission('announcements.send')")
    expect(migration).toContain("'recipientManifestFrozen', true")
    expect(migration).toContain("'deliveryRecipients', delivery_snapshot -> 'recipients'")
    expect(migration).toContain("'deliveryMessage', delivery_snapshot -> 'message'")
    expect(migration).toContain('schedule_notification_operation_conflict')
    expect(migration).toContain("when queued_notification.delivered_at is not null then 'delivered'")
    expect(migration).toContain("when queued_notification.failed_at is not null then 'failed'")
    expect(migration).toContain("dispatch.state in ('dispatching', 'uncertain', 'retry_approved')")
    expect(migration).not.toContain("to_char(clock_timestamp(), 'YYYYMMDDHH24MI')")
  })

  it('keeps response-loss retries on the same client-persisted identity', () => {
    expect(dataSource).toContain('target_operation_id: operationId')
    expect(pageSource).toContain('acquireScheduleNotificationOperation')
    expect(pageSource).toContain('markScheduleNotificationOperationStarted')
    expect(pageSource).toContain('completeScheduleNotificationOperation')
    expect(pageSource).toContain("queued.deliveryState !== 'pending'")
    expect(pageSource).toContain('const reconciled = await queueSchedulePublishedNotification')
    expect(pageSource).toContain('notifyScheduleOperation.weekStartsOn === scheduleQuery.data.week_starts_on')
    expect(pageSource).toContain("const canQueueScheduleNotifications = sessionHasAnyPermission(sessionQuery.data, [\n    'scheduler.manage',\n    'schedule.manage',\n  ])")
    expect(pageSource).toContain('const canSendScheduleNotifications = canQueueScheduleNotifications')
    expect(pageSource).toContain("sessionHasAnyPermission(sessionQuery.data, ['announcements.send'])")
    expect(operationSource).toContain('window.sessionStorage.setItem')
    expect(operationSource).toContain('sessionStorageBackedKeys')
    expect(operationSource).toContain('current?.operationId === operationId && !current.attempted')
  })

  it('covers exact replay, immutable conflicts, and explicit resend', () => {
    expect(regression).toContain('replay_result = first_result')
    expect(regression).toContain("audit.operation = 'queue_schedule_notification'")
    expect(regression).toContain("sqlerrm = 'schedule_notification_operation_conflict'")
    expect(regression).toContain("replay_result ->> 'deliveryState' = 'delivered'")
    expect(regression).toContain("claimed_jobs -> 0 -> 'recipients' = first_payload -> 'deliveryRecipients'")
    expect(regression).toContain('send_permission_rejected')
    expect(regression).toContain('resend_operation_id')
  })
})
