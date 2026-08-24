/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260824233000_authoritative_time_session_and_manual_punch_workday.sql'),
  'utf8',
)

describe('authoritative time-session boundary', () => {
  it('lets every effective clock-out close the prior session', () => {
    expect(migration).toContain("private.current_effective_time_event_kind(prior_event.id) = 'clock_out'")
    expect(migration).not.toContain("and prior_event.shift_id is null")
  })

  it('can anchor a new session on any effective clock-in', () => {
    expect(migration).toContain("private.current_effective_time_event_kind(candidate.id) = 'clock_in'")
    expect(migration).not.toContain("and candidate.shift_id is null")
  })

  it('keeps source punches append-only', () => {
    expect(migration).not.toMatch(/update\s+public\.time_events/i)
    expect(migration).not.toMatch(/delete\s+from\s+public\.time_events/i)
  })
})
