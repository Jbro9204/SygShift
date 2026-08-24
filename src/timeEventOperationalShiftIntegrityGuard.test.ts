/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shiftOptionsForOperationalDate, type TimeMaintenanceShiftOption } from './data/timekeeping'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260824213000_time_event_operational_shift_integrity.sql'),
  'utf8',
)

function option(shiftId: string, operationalDate: string): TimeMaintenanceShiftOption {
  return {
    assignedEmployees: [],
    endsAt: `${operationalDate}T12:00:00.000Z`,
    eventId: null,
    eventName: null,
    headcountRequired: 1,
    isOvertime: false,
    locationName: 'Cherry Tree',
    operationalDate,
    postId: '83000000-0000-4000-8000-000000000001',
    postName: 'Unarmed coverage',
    requiresArmed: false,
    scheduleRevision: 1,
    scheduleStatus: 'published',
    selectedEmployeeAssigned: true,
    shiftId,
    siteCode: 'CHERRY',
    siteId: '83000000-0000-4000-8000-000000000002',
    siteName: 'Cherry Tree',
    startsAt: `${operationalDate}T00:00:00.000Z`,
    timeZone: 'America/Denver',
    workType: 'post',
  }
}

describe('manual punch operational shift integrity', () => {
  it('shows only shifts that begin on the selected operational workday', () => {
    const previousOvernight = option('83000000-0000-4000-8000-000000000003', '2026-08-12')
    const selectedWorkday = option('83000000-0000-4000-8000-000000000004', '2026-08-13')

    expect(shiftOptionsForOperationalDate([previousOvernight, selectedWorkday], '2026-08-13'))
      .toEqual([selectedWorkday])
  })

  it('keeps occurrence corrections append-only and separate from display corrections', () => {
    expect(migration).toContain('create table if not exists public.time_event_occurrence_overrides')
    expect(migration).toContain('time_event_occurrence_overrides_append_only')
    expect(migration).toContain('latest_occurrence_override as (')
    expect(migration).toContain('coalesce(occurrence_override.replacement_shift_id, event.shift_id) as original_shift_id')
    expect(migration).not.toContain('update public.time_events')
    expect(migration).not.toContain('delete from public.time_events')
  })

  it('rejects a new punch linked to a temporally unrelated shift', () => {
    expect(migration).toContain("target_shift.starts_at - interval ''4 hours''")
    expect(migration).toContain("target_shift.ends_at + interval ''4 hours''")
    expect(migration).toContain('The selected Site/Post shift does not match this punch date and time.')
  })

  it('repairs the confirmed occurrence through audited history', () => {
    expect(migration).toContain("'system_repair'")
    expect(migration).toContain('insert into public.time_event_occurrence_overrides')
    expect(migration).toContain("replacement_schedule.status = 'published'")
  })
})
