/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20260912200000_accountability_notification_trigger_repair.sql',
  'utf8',
)
const regression = readFileSync(
  'supabase/tests/accountability_notification_delivery_regression.sql',
  'utf8',
)

describe('accountability notification delivery repair', () => {
  it('removes the PL/pgSQL variable-to-column collision at the trigger boundary', () => {
    expect(migration).toContain('#variable_conflict error')
    expect(migration).toContain('created_notification_id uuid')
    expect(migration).toContain('on conflict (notification_id) do nothing')
    expect(migration).not.toMatch(/\n\s*notification_id uuid;/)
    expect(migration).not.toMatch(/\n\s*notification_id :=/)
  })

  it('does not rewrite accountability, notification, or audit history', () => {
    expect(migration).not.toMatch(/delete\s+from/i)
    expect(migration).not.toMatch(/truncate/i)
    expect(migration).not.toMatch(/update\s+public\./i)
  })

  it('exercises create, review, reclassification, in-app notification, and email delivery in one rollback', () => {
    expect(regression).toContain('public.create_attendance_accountability_event(')
    expect(regression).toContain('public.review_attendance_accountability_event(')
    expect(regression).toContain('public.reclassify_attendance_accountability_event(')
    expect(regression).toContain('public.employee_notifications')
    expect(regression).toContain('public.employee_notification_email_deliveries')
    expect(regression.trimEnd().endsWith('rollback;')).toBe(true)
    expect(regression).not.toMatch(/\bcommit\s*;/i)
  })
})
