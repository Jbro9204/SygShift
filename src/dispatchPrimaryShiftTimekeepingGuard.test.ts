/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260906154620_dispatch_primary_shift_timekeeping.sql'),
  'utf8',
)
const compositeRepairMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260906160934_repair_dispatch_scheduler_composite_loads.sql'),
  'utf8',
)
const scheduleData = readFileSync(join(root, 'src', 'data', 'schedule.ts'), 'utf8')
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')

describe('primary paid Dispatch shift boundary', () => {
  it('stops deriving all Dispatch work from the location alone', () => {
    expect(migration).toContain('select shift.assignment_type')
    expect(migration).toContain("when new.assignment_type = 'dispatch_phone_duty'")
    expect(migration).toContain("else 'standard'")
  })

  it('repairs standalone active Dispatch shifts while retaining genuine overlap duty', () => {
    expect(migration).toContain("schedule.status in ('draft', 'published')")
    expect(migration).toContain("tstzrange(other_shift.starts_at, other_shift.ends_at, '[)')")
    expect(migration).toContain('not coalesce(other_site.supports_dispatch_phone_duty, false)')
  })

  it('keeps the scheduler choice explicit through create, edit, and overtime preview', () => {
    expect(scheduleData).toContain("rpc('scheduler_create_coverage_plan_v3'")
    expect(scheduleData).toContain("rpc('scheduler_update_typed_draft_shift_v3'")
    expect(scheduleData).toContain("rpc('get_scheduled_overtime_create_preview_v2'")
    expect(schedulePage).toContain('Primary paid shift')
    expect(schedulePage).toContain('Concurrent phone duty')
  })

  it('loads complete shift and schedule rows in dispatch edit helpers', () => {
    expect(compositeRepairMigration).toContain('select shift.* into target_shift')
    expect(compositeRepairMigration).toContain('select schedule.* into target_schedule')
    expect(compositeRepairMigration).not.toMatch(/select shift into target_shift/)
    expect(compositeRepairMigration).not.toMatch(/select schedule into target_schedule/)
  })

  it('preserves the mode through schedule copies and protects time-event history', () => {
    expect(migration).toContain('source_shift.assignment_type')
    expect(migration).toContain('assignment_type = source.assignment_type')
    expect(migration).toContain('dispatch_primary_release_baseline')
    expect(migration).toContain('time_event_fingerprint')
  })

  it('keeps privileged functions least-access and auditable', () => {
    expect(migration).toContain('private.can_manage_schedule_drafts()')
    expect(migration).toContain('CHANGE_DISPATCH_COVERAGE_MODE')
    expect(migration).toContain('CREATE_DISPATCH_AWARE_COVERAGE')
    expect(migration).toContain('revoke all on function public.scheduler_create_coverage_plan_v3')
  })
})
