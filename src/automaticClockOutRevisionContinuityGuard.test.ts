/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260826100000_auto_clock_out_revision_continuity.sql'),
  'utf8',
)

const automaticClockOutSection = migration.match(/with candidates as \([\s\S]*?select count\(\*\) into automatic_count from inserted_events;/)?.[0] ?? ''
const missingClockInSection = migration.match(/with missing_candidates as \([\s\S]*?select count\(\*\) into missing_count from inserted_exceptions;/)?.[0] ?? ''

describe('automatic clock-out schedule revision continuity', () => {
  it('follows the exact shift linked to an open punch across published schedule revisions', () => {
    expect(automaticClockOutSection).toContain("schedule.status in ('published', 'superseded')")
    expect(automaticClockOutSection).toContain('event.shift_id = shift.id')
    expect(automaticClockOutSection).toContain('existing.shift_id = candidate.shift_id')
    expect(automaticClockOutSection).toContain('candidate.ends_at,')
  })

  it('does not admit draft or archived schedules to automatic clock-out', () => {
    expect(automaticClockOutSection).not.toContain("schedule.status in ('published', 'superseded', 'draft')")
    expect(automaticClockOutSection).not.toContain("schedule.status in ('published', 'superseded', 'archived')")
  })

  it('retains duplicate protection and the scheduled shift end as authoritative', () => {
    expect(automaticClockOutSection).toContain("concat('automatic-clock-out:', candidate.assignment_id")
    expect(automaticClockOutSection).toContain('on conflict (idempotency_key) do nothing')
    expect(automaticClockOutSection).toContain('effective.effective_at >= candidate.latest_effective_at')
  })

  it('keeps missing-clock-in detection limited to the current published schedule', () => {
    expect(missingClockInSection).toContain("schedule.status = 'published'")
    expect(missingClockInSection).not.toContain("schedule.status in ('published', 'superseded')")
  })
})
