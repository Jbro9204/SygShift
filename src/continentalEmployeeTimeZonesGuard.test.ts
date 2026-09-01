import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260901190000_continental_employee_time_zones.sql'),
  'utf8',
)
const scheduleData = readFileSync(join(root, 'src', 'data', 'schedule.ts'), 'utf8')
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
const overviewPage = readFileSync(join(root, 'src', 'pages', 'OverviewPage.tsx'), 'utf8')
const timePage = readFileSync(join(root, 'src', 'pages', 'TimePage.tsx'), 'utf8')

describe('continental employee time-zone release guard', () => {
  it('supports only the four approved continental US zones on employee profiles', () => {
    for (const timeZone of [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
    ]) {
      expect(migration).toContain(timeZone)
    }
    expect(migration).toContain('employees_continental_us_time_zone')
    expect(migration).toContain("where employee.username = 'zward'")
  })

  it('proves the release does not rewrite existing shifts or time events', () => {
    expect(migration).toContain('remote_time_zone_release_baseline')
    expect(migration).toContain('shift_fingerprint')
    expect(migration).toContain('time_event_fingerprint')
    expect(migration).toContain('the migration was rolled back')
    expect(migration).toContain("'existingShiftsChanged', false")
    expect(migration).toContain("'existingTimeEventsChanged', false")
  })

  it('creates future one-person assignments from employee-local wall-clock time', () => {
    expect(migration).toContain('scheduler_create_employee_local_coverage_plan')
    expect(migration).toContain('localized_starts_at')
    expect(migration).toContain('localized_ends_at')
    expect(migration).toContain('time_zone_source = \'employee\'')
    expect(migration).toContain('case when shift_end_time <= shift_start_time then 1 else 0 end')
    expect(scheduleData).toContain("'scheduler_create_employee_local_coverage_plan_v2'")
    expect(schedulePage).toContain('useEmployeeTimeZone: useEmployeeLocalTime')
  })

  it('uses the employee or supported browser zone only for personal presentation', () => {
    expect(schedulePage).toContain('personalDisplayTimeZone(sessionQuery.data?.timeZone')
    expect(overviewPage).toContain('personalDisplayTimeZone(session?.timeZone')
    expect(timePage).toContain('personalDisplayTimeZone(dashboard.employee.timeZone)')
    expect(timePage).toContain('Official server time')
  })
})
