/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260816120000_daily_attendance_reconciliation.sql'),
  'utf8',
)
const groupingMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260816170000_attendance_review_coverage_grouping.sql'),
  'utf8',
)
const page = readFileSync(join(root, 'src', 'time', 'DailyAttendanceReviewPage.tsx'), 'utf8')
const reviewHelpers = readFileSync(join(root, 'src', 'time', 'dailyAttendanceReview.ts'), 'utf8')

describe('daily attendance reconciliation guardrails', () => {
  it('compares only ended published schedule records after a grace period', () => {
    expect(migration).toContain("schedule.status = 'published'")
    expect(migration).toContain("shift.ends_at + interval '2 hours' <= server_now")
    expect(migration).toContain("'graceMinutes', 120")
    expect(migration).toContain('Attendance review decisions are available two hours after the shift ends.')
  })

  it('uses effective punches, call-offs, multiple work segments, and unpaid gaps', () => {
    expect(migration).toContain('public.time_event_corrections')
    expect(migration).toContain('public.time_event_shift_overrides')
    expect(migration).toContain('public.attendance_accountability_events')
    expect(migration).toContain('public.call_off_reports')
    expect(migration).toContain("'multiple_work_segments'")
    expect(migration).toContain("'unpaidGaps'")
    expect(reviewHelpers).toContain('Multiple work segments')
    expect(page).toContain('Unpaid gap:')
  })

  it('records append-only, occurrence-specific decisions with an audit trail', () => {
    expect(migration).toContain('private.prevent_append_only_change()')
    expect(migration).toContain('private.write_audit_event()')
    expect(migration).toContain("current_snapshot ->> 'occurrenceFingerprint' <> target_occurrence_fingerprint")
    expect(migration).toContain('Reopen the prior decision before recording a different outcome.')
  })

  it('enforces MFA and effective permissions in the database', () => {
    expect(migration).toContain('not public.has_mfa()')
    expect(migration).toContain("public.has_effective_permission('accountability.manage')")
    expect(migration).toContain("public.has_effective_permission('time.manage')")
    expect(migration).toContain("public.has_effective_permission('accountability.view')")
    expect(migration).toContain("public.has_effective_permission('time.resolve_exceptions')")
  })

  it('does not rewrite schedules or punches when an operational outcome is approved', () => {
    const resolver = migration.slice(migration.indexOf('create function public.resolve_daily_attendance_review'))
    expect(resolver).not.toContain('update public.shifts')
    expect(resolver).not.toContain('delete from public.time_events')
    expect(resolver).not.toContain('update public.time_events')
    expect(resolver).toContain('insert into public.attendance_reconciliation_decisions')
  })

  it('keeps impossible punch sequences as corrections instead of bypassing payroll controls', () => {
    expect(page).toContain('A hard payroll blocker still requires a time correction')
    expect(page).toContain('it cannot bypass an incomplete or impossible punch sequence')
    expect(page).toContain('<TimeMaintenanceWorkbench')
  })

  it('consolidates identical coverage slots without discarding people or worked time', () => {
    expect(groupingMigration).toContain('private.get_attendance_reconciliation_group_snapshot')
    expect(groupingMigration).toContain('member.post_id is not distinct from anchor.post_id')
    expect(groupingMigration).toContain('member.event_id is not distinct from anchor.event_id')
    expect(groupingMigration).toContain('member.starts_at = anchor.starts_at')
    expect(groupingMigration).toContain('member.ends_at = anchor.ends_at')
    expect(groupingMigration).toContain('greatest(member_stats.maximum_headcount_required, scheduled_rollup.employee_count)')
    expect(groupingMigration).toContain("'headcountRequired', classified.headcount_required")
    expect(groupingMigration).toContain("'scheduledEmployees', classified.scheduled_employees")
    expect(groupingMigration).toContain("'actualEmployees', classified.actual_employees")
    expect(groupingMigration).toContain("'memberShiftIds', classified.member_shift_ids")
  })

  it('resolves the consolidated occurrence through its canonical shift and current fingerprint', () => {
    expect(groupingMigration).toContain("current_snapshot := private.get_attendance_reconciliation_group_snapshot(target_shift_id)")
    expect(groupingMigration).toContain("(current_snapshot ->> 'shiftId')::uuid <> target_shift_id")
    expect(groupingMigration).toContain("current_snapshot ->> 'occurrenceFingerprint' <> target_occurrence_fingerprint")
    expect(groupingMigration).toContain('insert into public.attendance_reconciliation_decisions')
  })
})
