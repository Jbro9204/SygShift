/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAccountabilityWorkspacePayload } from './data/accountability'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260912180000_connected_reliability_repair.sql'),
  'utf8',
)
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('connected reliability repair', () => {
  it('evaluates the required-actions checkpoint once per permission projection', () => {
    expect(migration).toContain('checkpoint_blocks_access := private.employee_has_blocking_required_actions(target_employee_id)')
    expect(migration).toContain('if not private.employee_required_action_checkpoint_enrolled(target_employee_id) then')
    expect(migration).not.toContain('not private.employee_has_blocking_required_actions(target_employee_id)')
    expect(migration).toContain("('time.punch'::text)")
    expect(migration).toContain("('accountability.report_call_off'::text)")
  })

  it('keeps live reconciliation published-only while providing historical Accountability context', () => {
    expect(migration).toContain('private.get_accountability_reconciliation_snapshot')
    expect(migration).toContain('private.get_accountability_reconciliation_group_snapshot_historical')
    expect(migration).toContain("schedule.status in (''published'', ''superseded'', ''archived'')")
    expect(migration).toContain('private.get_accountability_reconciliation_group_snapshot(coalesce(native_event.shift_id, legacy_call_off.shift_id))')
    expect(migration).not.toMatch(/update\s+public\.(attendance_accountability_events|shifts|schedules|time_events)/i)
    expect(migration).not.toMatch(/delete\s+from\s+public\./i)
  })

  it('coalesces trigger work and reduces the global safety scan cadence without delaying other cron jobs', () => {
    expect(migration).toContain('attendance_alert_schedule_refresh_queue')
    expect(migration).toContain('private.queue_attendance_alert_schedule_refresh(')
    expect(migration).toContain('run_queued_attendance_alert_schedule_refresh')
    expect(migration).toContain('operational_alerts_related_exception_idx')
    expect(worker).toContain('Number(denverMinute) % 5 === 0')
    expect(worker).toContain("reason: 'five_minute_safety_interval'")
    expect(worker.indexOf("'service_run_timekeeping_automation'")).toBeLessThan(worker.indexOf('attendanceSafetyRefreshDue'))
  })

  it('retains an Accountability event when only its nested reconciliation is malformed', () => {
    const workspace = parseAccountabilityWorkspacePayload({
      serverTimestamp: '2026-09-11T16:00:00.000Z',
      fromDate: '2026-09-01',
      throughDate: '2026-09-11',
      operationalTimeZone: 'America/Denver',
      capabilities: { canCreate: true, canManage: true },
      employees: [],
      shiftOptions: [],
      exceptionSummaries: [],
      events: [{
        id: '10000000-0000-4000-8000-000000000001',
        sourceTable: 'attendance_accountability_events',
        eventType: 'late_arrival',
        status: 'reported',
        employeeId: '10000000-0000-4000-8000-000000000002',
        employeeName: 'Test Employee',
        username: 'test.employee',
        role: 'guard',
        employmentType: 'hourly',
        operationalDate: '2026-09-05',
        startsAt: '2026-09-05T14:00:00.000Z',
        endsAt: '2026-09-05T22:00:00.000Z',
        timeZone: 'America/Denver',
        siteName: 'Test Site',
        siteCode: 'TEST',
        postName: 'Test Post',
        eventName: null,
        locationName: 'Test Site',
        note: 'Test occurrence',
        createdAt: '2026-09-05T14:10:00.000Z',
        shiftId: '10000000-0000-4000-8000-000000000003',
        reviewOutcome: null,
        reviewedAt: null,
        reviewedByName: null,
        decisionNote: null,
        reviewable: true,
        actionHistory: [],
        reconciliation: {
          startsAt: null,
          endsAt: null,
          locationName: 'Test Site',
          scheduledCoverageMinutes: 480,
          actualPaidMinutes: 0,
          scheduledEmployees: [],
          actualEmployees: [],
          discrepancyCodes: [],
        },
      }],
    })

    expect(workspace.events).toHaveLength(1)
    expect(workspace.events[0]?.reconciliation).toBeNull()
  })

  it('uses a controlled public message if the top-level payload is unusable', () => {
    expect(() => parseAccountabilityWorkspacePayload({ events: [] }))
      .toThrow('Accountability information could not be loaded. Refresh the page and try again.')
  })
})
