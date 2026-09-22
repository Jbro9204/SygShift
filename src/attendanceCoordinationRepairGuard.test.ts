import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260922145137_structured_late_arrival_and_coverage_markers.sql', 'utf8')
const accountabilityData = readFileSync('src/data/accountability.ts', 'utf8')
const accountabilityPage = readFileSync('src/time/AccountabilityPage.tsx', 'utf8')
const scheduleData = readFileSync('src/data/schedule.ts', 'utf8')
const schedulePage = readFileSync('src/pages/SchedulePage.tsx', 'utf8')
const timePage = readFileSync('src/pages/TimePage.tsx', 'utf8')

describe('attendance coordination repair guardrails', () => {
  it('records a structured late arrival and keeps it live until clock-in', () => {
    expect(accountabilityData).toContain("rpc('create_attendance_accountability_event_v2'")
    expect(accountabilityPage).toContain('Expected delay (minutes)')
    expect(migration).toContain("'reported_late_arrival'")
    expect(migration).toContain('create trigger resolve_reported_late_arrival')
    expect(migration).toContain("cleared_reason = 'The employee clocked in.'")
  })

  it('preserves the original schedule record without counting it as active coverage', () => {
    expect(scheduleData).toContain("marker: z.enum(['call_off', 'coverage'])")
    expect(schedulePage).toContain('operationalAssignmentCount')
    expect(schedulePage).toContain('CALL OFF')
    expect(schedulePage).toContain('COVERAGE')
    expect(migration).toContain('create trigger prevent_absent_employee_clock_in')
  })

  it('does not substitute a false zero when a protected payroll total is unavailable', () => {
    expect(timePage).toContain("selectedWorkedMinutes === undefined ? '—'")
    expect(timePage).toContain('Verified payroll total unavailable')
    expect(timePage).toContain('overviewReviewQuery.isSuccess')
  })

  it('keeps schedule updates live and provides a portable calendar download', () => {
    expect(schedulePage).toContain("table: 'shift_coverage_cases'")
    expect(schedulePage).toContain('downloadScheduleCalendar')
    expect(schedulePage).toContain('Add to calendar')
  })
})
