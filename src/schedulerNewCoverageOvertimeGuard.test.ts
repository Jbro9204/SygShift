/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260901233000_scheduler_new_coverage_overtime_override.sql'),
  'utf8',
)
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
const scheduleData = readFileSync(join(root, 'src', 'data', 'schedule.ts'), 'utf8')

describe('new coverage scheduled-overtime workflow', () => {
  it('counts only active, non-canceled assignments in the authoritative week', () => {
    expect(migration).toContain('assignment.status in (\'assigned\', \'confirmed\', \'completed\')')
    expect(migration).toContain('assignment.canceled_at is null')
    expect(migration).toContain('scheduled_shift.canceled_at is null')
    expect(migration).toContain("'countedShifts', counted_shifts")
  })

  it('creates and assigns coverage atomically with the approval note', () => {
    expect(migration).toContain('public.scheduler_create_coverage_plan_v2')
    expect(migration).toContain('public.scheduler_create_employee_local_coverage_plan_v2')
    expect(migration).toContain('public.scheduler_add_draft_shift_assignment_v2(')
    expect(migration).toContain('target_overtime_override_note')
    expect(migration.indexOf("set time_zone_source = 'employee'"))
      .toBeLessThan(migration.lastIndexOf('perform public.scheduler_add_draft_shift_assignment_v2('))
  })

  it('shows the hour breakdown and requires a dedicated approval note before save', () => {
    expect(schedulePage).toContain('Scheduled overtime approval required')
    expect(schedulePage).toContain('View the {openShiftOvertimePreviewQuery.data.countedShifts.length} existing shift')
    expect(schedulePage).toContain('overtimeOverrideNote')
    expect(schedulePage).toContain('!openShiftOvertimeOverrideReady')
    expect(scheduleData).toContain("rpc('get_scheduled_overtime_create_preview'")
    expect(scheduleData).toContain("rpc('scheduler_create_employee_local_coverage_plan_v2'")
    expect(scheduleData).toContain("rpc('scheduler_create_coverage_plan_v2'")
  })
})
