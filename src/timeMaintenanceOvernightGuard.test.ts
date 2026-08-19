/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatTimeOperationsPostLabel } from './data/timeOperations'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260819123000_time_maintenance_overnight_and_patrol_clarity.sql'),
  'utf8',
)

describe('Time Maintenance overnight and patrol repair', () => {
  it('groups an unlinked overnight pair into one bounded work session', () => {
    expect(migration).toContain('private.get_unscheduled_time_session_start')
    expect(migration).toContain("candidate.kind = 'clock_in'")
    expect(migration).toContain("prior_event.kind = 'clock_out'")
    expect(migration).toContain("target_effective_at - interval '24 hours'")
    expect(migration).toContain("'unscheduled-session:' || session.session_event_id::text")
  })

  it('anchors the occurrence to the shift, manual entry, or session clock-in without rewriting punches', () => {
    expect(migration).toContain('(select shift.starts_at from public.shifts shift where shift.id = target_shift_id)')
    expect(migration).toContain('manual.clock_in_at')
    expect(migration).toContain('session.session_started_at')
    expect(migration).not.toContain('update public.time_events')
    expect(migration).not.toContain('delete from public.time_events')
  })

  it('orders maintenance employees by first name and includes site codes in location choices', () => {
    expect(migration).toContain("order by coalesce(nullif(employee.preferred_name")
    expect(migration).toContain("employee.first_name), employee.last_name)")
    expect(migration).toContain("siteCode'', site.code")
    expect(formatTimeOperationsPostLabel({
      id: '73000000-0000-4000-8000-000000000001',
      siteId: '73000000-0000-4000-8000-000000000002',
      siteCode: 'PERA',
      siteName: 'PERA Westminster',
      postName: 'Armed Patrol',
      timeZone: 'America/Denver',
    })).toBe('PERA · PERA Westminster · Armed Patrol')
  })
})
