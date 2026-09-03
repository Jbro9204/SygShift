/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260903132400_concurrent_dispatch_phone_duty.sql'),
  'utf8',
)
const scheduleData = readFileSync(join(root, 'src', 'data', 'schedule.ts'), 'utf8')
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
const acknowledgementMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260903202000_scheduler_dispatch_overlap_acknowledgement.sql'),
  'utf8',
)

describe('concurrent Dispatch phone-duty boundary', () => {
  it('models Dispatch as an explicit duty and permits only Dispatch plus standard Post Time', () => {
    expect(migration).toContain("assignment_type in ('standard', 'dispatch_phone_duty')")
    expect(migration).toContain("private.shift_assignment_type(target_shift.id) = 'dispatch_phone_duty'")
    expect(migration).toContain("private.shift_assignment_type(shift.id) = 'standard' and shift.work_type = 'post'")
    expect(migration).not.toContain("or private.shift_assignment_type(target_shift.id) = 'dispatch_phone_duty'\n    )")
  })

  it('keeps concurrent duty out of punches, missing-clock alerts, and duplicate scheduled minutes', () => {
    expect(migration).toContain("private.shift_assignment_type(shift.id) = 'standard'")
    expect(migration).toContain('Dispatch phone duty is a concurrent responsibility and does not create a separate time-clock session.')
    expect(migration).toContain('prevent_dispatch_phone_missing_clock_exception')
    expect(migration).toContain("then 0 else greatest(0")
    expect(migration).toContain("'payableMinutesAdded', 0")
  })

  it('shows the duty explicitly in schedule data and management views', () => {
    expect(scheduleData).toContain("assignment_type: z.enum(['standard', 'dispatch_phone_duty']).optional()")
    expect(scheduleData).toContain("rpc('get_shift_assignment_type_map'")
    expect(schedulePage).toContain('Dispatch phone duty')
  })

  it('preserves the protected employee, schedule, assignment, and time-event history', () => {
    expect(migration).toContain('concurrent_dispatch_release_baseline')
    expect(migration).toContain("Concurrent Dispatch release altered protected employee, shift, assignment, or time-event history.")
  })

  it('requires an audited Scheduler acknowledgement without weakening ordinary overlap protection', () => {
    expect(acknowledgementMigration).toContain('private.can_manage_schedule_drafts()')
    expect(acknowledgementMigration).toContain('target_dispatch_overlap_acknowledged boolean default false')
    expect(acknowledgementMigration).toContain('ACKNOWLEDGE_CONCURRENT_DISPATCH_PHONE_DUTY')
    expect(acknowledgementMigration).toContain("target_assignment_type = 'dispatch_phone_duty'")
    expect(acknowledgementMigration).toContain("target_assignment_type = 'standard'")
    expect(acknowledgementMigration).not.toContain("target_assignment_type = 'training'")
    expect(schedulePage).toContain('Concurrent Dispatch duty acknowledgement')
    expect(schedulePage).toContain('I acknowledge this concurrent Dispatch responsibility.')
  })
})
