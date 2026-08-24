import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260824170000_time_maintenance_operational_schedule_range.sql'),
  'utf8',
)

describe('Time Maintenance scheduled-range boundary', () => {
  it('assigns an overnight shift to the date on which the shift starts', () => {
    expect(migration).toContain(
      '(shift.starts_at at time zone coalesce(shift.time_zone, operational_time_zone))::date between target_from_date and target_through_date',
    )
    expect(migration).toContain('shift.canceled_at is null')
  })

  it('rejects the previous overlap rule that leaked prior-day overnight shifts into the range', () => {
    expect(migration).toContain(
      "position(\n      '(shift.ends_at at time zone coalesce(shift.time_zone, operational_time_zone))::date >= target_from_date'",
    )
    expect(migration).toContain("raise check_violation using message = 'Time Maintenance scheduled range could not be repaired safely.'")
  })
})
