/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const timekeepingMigration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260831050000_timekeeping_release_guardrails.sql'),
  'utf8',
)

const overtimeMigration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260831051000_schedule_overtime_guardrail.sql'),
  'utf8',
)

describe('timekeeping and schedule release guardrails', () => {
  it('enforces the employee clock-in window and assigned published shift on the server', () => {
    expect(timekeepingMigration).toContain("interval '5 minutes'")
    expect(timekeepingMigration).toContain("schedule.status = 'published'")
    expect(timekeepingMigration).toContain('assignment.employee_id = actor_employee_id')
    expect(timekeepingMigration).toContain("shift.starts_at <= server_now + interval '5 minutes'")
    expect(timekeepingMigration).toContain('shift.ends_at >= server_now')
  })

  it('resolves routine automatic clock-out review noise without deleting event history', () => {
    expect(timekeepingMigration).toContain('resolve_routine_automatic_clock_out')
    expect(timekeepingMigration).toContain("exception_code = 'automatic_clock_out'")
    expect(timekeepingMigration).toContain("status = 'resolved'")
    expect(timekeepingMigration).toContain('timekeeping_operational_exception_actions')
    expect(timekeepingMigration).not.toContain("delete from private.timekeeping_events")
  })

  it('requires a documented authorized override when a proposal exceeds forty hours', () => {
    expect(overtimeMigration).toContain("'scheduled_overtime'")
    expect(overtimeMigration).toContain("'requiresOverride', resulting_minutes > 2400")
    expect(overtimeMigration).toContain('target_overtime_override_note')
    expect(overtimeMigration).toContain('private.audit_events')
    expect(overtimeMigration).toContain('scheduler_update_typed_draft_shift_v2')
  })

  it('uses Sunday as the scheduled-work week boundary', () => {
    expect(overtimeMigration).toContain('extract(dow from local_shift_date)::integer')
    expect(overtimeMigration).toContain('week_start + 6')
  })
})
