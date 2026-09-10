/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260912020000_attendance_alert_schedule_refresh.sql'),
  'utf8',
)
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('attendance alert schedule refresh', () => {
  it('uses the current published schedule as the authoritative clock requirement', () => {
    expect(migration).toContain('private.attendance_exception_has_current_required_assignment')
    expect(migration).toContain("current_schedule.status = 'published'")
    expect(migration).toContain('private.same_scheduled_occurrence(source_shift.id, current_shift.id)')
    expect(migration).toContain("assignment.status in ('assigned', 'confirmed')")
    expect(migration).toContain('assignment.canceled_at is null')
  })

  it('covers revision changes, assignment removal and restoration, salary, and supplemental Dispatch', () => {
    expect(migration).toContain("then 'schedule_revised'")
    expect(migration).toContain("then 'assignment_changed'")
    expect(migration).toContain("then 'employment_exempt'")
    expect(migration).toContain("then 'dispatch_phone_duty'")
    expect(migration).toContain("reopened.id,\n      'reopened'")
    expect(migration).toContain('private.same_scheduled_occurrence(report.shift_id, exception.shift_id)')
    expect(migration).toContain('private.same_scheduled_occurrence(event.shift_id, exception.shift_id)')
  })

  it('refreshes after authoritative schedule mutations using deferred triggers', () => {
    expect(migration).toContain('create constraint trigger refresh_attendance_alerts_after_schedule_change')
    expect(migration).toContain('create constraint trigger refresh_attendance_alerts_after_assignment_change')
    expect(migration).toContain('create constraint trigger refresh_attendance_alerts_after_shift_change')
    expect(migration.match(/deferrable initially deferred/g)).toHaveLength(3)
  })

  it('preserves protected source and audit history while closing only stale lifecycle state', () => {
    expect(migration).toContain('insert into public.timekeeping_operational_exception_actions')
    expect(migration).toContain("lifecycle_state = 'resolved'")
    expect(migration).not.toMatch(/delete\s+from\s+public\./i)
    expect(migration).not.toMatch(/update\s+public\.(time_events|shifts|schedules|shift_assignments|employees|payroll)/i)
  })

  it('keeps the scheduled safety net service-role only and failure-isolated', () => {
    expect(migration).toContain('public.service_refresh_attendance_alert_schedule_state')
    expect(migration).toContain("coalesce((select auth.role()), '') <> 'service_role'")
    expect(migration).toContain('grant execute on function public.service_refresh_attendance_alert_schedule_state(boolean)')
    expect(worker).toContain("'service_refresh_attendance_alert_schedule_state'")
    expect(worker).toContain("event: 'attendance_alert_schedule_refresh_failed'")
  })
})
