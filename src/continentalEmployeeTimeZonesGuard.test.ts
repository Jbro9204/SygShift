import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260901190000_continental_employee_time_zones.sql'),
  'utf8',
)
const timeZoneRepairMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260925175035_explicit_employee_time_zone_and_misty_repair.sql'),
  'utf8',
)
const scheduleData = readFileSync(join(root, 'src', 'data', 'schedule.ts'), 'utf8')
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
const overviewPage = readFileSync(join(root, 'src', 'pages', 'OverviewPage.tsx'), 'utf8')
const timePage = readFileSync(join(root, 'src', 'pages', 'TimePage.tsx'), 'utf8')

describe('continental employee time-zone release guard', () => {
  it('supports the approved employee profile zones, including non-DST Arizona time', () => {
    for (const timeZone of [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Phoenix',
      'America/Los_Angeles',
    ]) {
      expect(`${migration}\n${timeZoneRepairMigration}`).toContain(timeZone)
    }
    expect(migration).toContain('employees_continental_us_time_zone')
    expect(timeZoneRepairMigration).toContain('employees_continental_us_time_zone')
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

  it('fails closed unless the exact production repair target and identity match', () => {
    expect(timeZoneRepairMigration).toMatch(/^begin;\r?\nset local lock_timeout = '5s';/)
    expect(timeZoneRepairMigration).toContain("raise check_violation using message = 'Misty Kimbal time-zone repair target was not found.'")
    expect(timeZoneRepairMigration).toContain('Keep the deployed seven-argument service contract')
    expect(timeZoneRepairMigration).toContain('Refresh SygShift and choose the employee time zone before requesting candidate conversion.')
    expect(timeZoneRepairMigration).toContain("target_employee.employee_number is distinct from 'SYG-1131'")
    expect(timeZoneRepairMigration).toContain("target_employee.username is distinct from 'mkimbal'")
    expect(timeZoneRepairMigration).toContain('lock table public.schedules in share row exclusive mode')
    expect(timeZoneRepairMigration).toContain('lock table public.shift_assignments in share row exclusive mode')
    expect(timeZoneRepairMigration).not.toContain('if found then')
  })

  it('creates future one-person assignments from employee-local wall-clock time', () => {
    expect(migration).toContain('scheduler_create_employee_local_coverage_plan')
    expect(migration).toContain('localized_starts_at')
    expect(migration).toContain('localized_ends_at')
    expect(migration).toContain('time_zone_source = \'employee\'')
    expect(migration).toContain('case when shift_end_time <= shift_start_time then 1 else 0 end')
    expect(scheduleData).toContain("'scheduler_create_employee_local_coverage_plan_v3'")
    expect(schedulePage).toContain('useEmployeeTimeZone: useEmployeeLocalTime')
  })

  it('uses the employee profile zone for personal presentation while server time remains authoritative', () => {
    expect(schedulePage).toContain('personalDisplayTimeZone(sessionQuery.data?.timeZone')
    expect(overviewPage).toContain('personalDisplayTimeZone(session?.timeZone')
    expect(overviewPage).toContain('greetingPeriod(now, displayTimeZone)')
    expect(timePage).toContain('personalDisplayTimeZone(dashboard.employee.timeZone)')
    expect(timePage).toContain('queryFn: () => getTimekeepingDashboard()')
    expect(timePage).toContain('defaultDate={dashboard.operationalDate}')
    expect(timePage).toContain('Official server time')
  })
})
