import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20260925180104_repair_schedule_week_copy_time_basis.sql',
  'utf8',
)
const regression = readFileSync(
  'supabase/tests/schedule_week_copy_time_basis_regression.sql',
  'utf8',
)

describe('schedule week-copy time-basis migration', () => {
  it('rebuilds each copy from recorded wall clocks and current authority', () => {
    expect(migration).toContain('source_shift.starts_at at time zone source_shift.time_zone')
    expect(migration).toContain('source_shift.ends_at at time zone source_shift.time_zone')
    expect(migration).toContain("source_shift.time_zone_source = 'employee'")
    expect(migration).toContain('where employee.id = source_shift.time_zone_employee_id')
    expect(migration).toContain("source_shift.time_zone_source = 'site'")
    expect(migration).toContain('join public.sites site on site.id = post.site_id')
    expect(migration).toContain('from public.events event')
    expect(migration).toContain("source_shift.time_zone_source = 'explicit'")
    expect(migration).toContain('destination_local_start at time zone destination_time_zone')
    expect(migration).toContain('destination_local_end at time zone destination_time_zone')
  })

  it('rejects DST gaps and verifies copied classification before assignments', () => {
    expect(migration).toContain('shifted_start at time zone destination_time_zone is distinct from destination_local_start')
    expect(migration).toContain('shifted_end at time zone destination_time_zone is distinct from destination_local_end')
    expect(migration).toContain('does not exist in %s because of daylight-saving time')
    expect(migration).toContain('source_shift.work_type')
    expect(migration).toContain('source_shift.assignment_type')
    expect(migration.indexOf('source_shift.assignment_type')).toBeLessThan(
      migration.indexOf('insert into public.shift_assignments'),
    )
    expect(migration).toContain("'wall_clock_copy_verified', true")
    expect(migration).toContain("'refreshed_time_zone_count', refreshed_time_zone_count")
  })

  it('keeps migration and regression transaction boundaries explicit', () => {
    expect((migration.match(/^begin;$/gm) ?? [])).toHaveLength(1)
    expect((migration.match(/^commit;$/gm) ?? [])).toHaveLength(1)
    expect((regression.match(/^begin;$/gm) ?? [])).toHaveLength(1)
    expect((regression.match(/^rollback;$/gm) ?? [])).toHaveLength(1)
    expect(regression).not.toMatch(/^commit;$/m)
    expect(regression.trimEnd().endsWith('rollback;')).toBe(true)
  })

  it('covers September Eastern, seasonal DST, gaps, and profile corrections', () => {
    expect(regression).toContain("timestamp '2099-09-14 09:00:00' at time zone 'America/New_York'")
    expect(regression).toContain("timestamp '2099-11-02 09:00:00' at time zone 'America/New_York'")
    expect(regression).toContain("interval '7 days 1 hour'")
    expect(regression).toContain('A nonexistent spring-forward local time was not rejected.')
    expect(regression).toContain("set time_zone = 'America/New_York'")
    expect(regression).toContain('The historical source shift was changed when the employee profile was corrected.')
    expect(regression).toContain('The rejected spring-gap copy did not roll back the destination replacement atomically.')
  })
})
