import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20261007182434_restore_future_calloff_shift_visibility.sql',
  'utf8',
)
const accountabilityModel = readFileSync('src/time/accountability.ts', 'utf8')
const accountabilityPage = readFileSync('src/time/AccountabilityPage.tsx', 'utf8')

describe('future call-off shift visibility release guard', () => {
  it('restores the employee next-shift choice without weakening clock-in authority', () => {
    expect(migration).toContain("next_assignment.employee_id = viewer_employee_id")
    expect(migration).toContain("next_shift.starts_at > server_now + interval '12 hours'")
    expect(migration).toContain("private.shift_assignment_type(next_shift.id) = 'standard'")
    expect(migration).toContain('and assignment.canceled_at is null')
    expect(migration).toContain('record_time_event RPC remains the authority')
  })

  it('decouples manager occurrence choices from the historical review range', () => {
    expect(migration).toContain("shift.starts_at <= statement_timestamp() + interval '14 days'")
    expect(migration).toContain("schedule.status = 'published'")
    expect(migration).toContain('assignment.canceled_at is null')
    expect(migration).toContain("private.shift_assignment_type(shift.id) = 'standard'")
    expect(migration).toContain("private.shift_assignment_type((item.value ->> 'id')::uuid) = 'standard'")
    expect(migration).toContain("assignment.employee_id = (item.value ->> 'employeeId')::uuid")
    expect(migration).toContain("jsonb_set(payload, '{shiftOptions}', shift_payload, true)")
  })

  it('makes the dashboard source repair safe to retry', () => {
    expect(migration).toContain('if position(repair_marker in definition) > 0 then')
    expect(migration).toContain("anchor is not unique")
  })

  it('keeps unexcused decisions visible, filterable, and employee-notified', () => {
    expect(accountabilityModel).toContain("event.reviewOutcome === 'unexcused'")
    expect(accountabilityModel).toContain("'confirmed', 'unexcused'")
    expect(accountabilityPage).toContain('"unexcused"')
    expect(migration).toContain("'created', 'confirmed', 'unexcused'")
  })
})
