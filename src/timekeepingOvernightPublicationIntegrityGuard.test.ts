/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260820143000_overnight_occurrence_and_schedule_publication_integrity.sql'),
  'utf8',
)
const attendanceMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260820170000_attendance_overnight_session_reconciliation.sql'),
  'utf8',
)
const attendancePerformanceMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260820173000_attendance_occurrence_performance.sql'),
  'utf8',
)
const timePage = readFileSync(join(root, 'src', 'pages', 'TimePage.tsx'), 'utf8')
const timekeepingData = readFileSync(join(root, 'src', 'data', 'timekeeping.ts'), 'utf8')

describe('overnight timekeeping and publication integrity', () => {
  it('keeps an originally unlinked overnight pair in one immutable occurrence', () => {
    expect(migration).toContain('source_event.shift_id is not null')
    expect(migration).toContain('private.get_unscheduled_time_session_start')
    expect(migration).toContain("'unscheduled-session:' || session.session_event_id::text")
    expect(migration).toContain('group by event.employee_id, event.group_key')
    expect(migration).toContain('(array_remove(array_agg(event.shift_id order by event.effective_at')
  })

  it('anchors payroll assignment to the original occurrence instead of a later location correction', () => {
    expect(migration).toContain('case when source_event.shift_id is not null then source_shift.starts_at end')
    expect(migration).toContain('session.session_started_at')
    expect(migration).toContain('where source_event.shift_id is null')
  })

  it('loads exception details by occurrence identity rather than calendar date', () => {
    expect(migration).toContain('target_first_clock_in is not null')
    expect(migration).toContain('private.get_timekeeping_occurrence_key(')
    expect(migration).toContain('where anchor.kind = \'clock_in\'')
  })

  it('reconciles overnight attendance as one occurrence and rejects stale shift links', () => {
    expect(attendanceMigration).toContain('linked_occurrences as (')
    expect(attendanceMigration).toContain('private.get_payroll_assignment_anchor(')
    expect(attendanceMigration).toContain("shift_window.ends_at + interval '2 hours'")
    expect(attendanceMigration).toContain("(occurrence_context.value ->> 'eventCount')::integer > 0")
  })

  it('keeps the overnight attendance scan bounded for production ranges', () => {
    expect(attendancePerformanceMigration).toContain('sequenced_events as (')
    expect(attendancePerformanceMigration).toContain('linked_sessions as (')
    expect(attendancePerformanceMigration).toContain("sum(case when event.kind = 'clock_in' then 1 else 0 end) over")
    expect(attendancePerformanceMigration).not.toContain('private.get_unscheduled_time_session_start(')
  })

  it('preserves schedule history while enforcing one operational publication per week', () => {
    expect(migration).toContain("status = 'superseded'")
    expect(migration).toContain('schedules_one_published_week_unique')
    expect(migration).toContain("where status = 'published'")
    expect(migration).not.toContain('delete from public.schedules')
  })

  it('adds an employee running total without creating a separate payroll calculation', () => {
    expect(migration).toContain('as scheduled_minutes')
    expect(migration).toContain("'scheduledMinutes'")
    expect(timekeepingData).toContain('scheduledMinutes: z.number().int().nonnegative().optional()')
    expect(timePage).toContain('<span>Scheduled</span>')
    expect(timePage).toContain('<span>Worked</span>')
    expect(timePage).toContain('<span>Worked vs schedule</span>')
    expect(timePage).toContain('Clocked-out gaps stay unpaid.')
    expect(timePage).toContain('<span>Needs attention</span>')
    expect(timePage).toContain('View hours breakdown')
  })
})
