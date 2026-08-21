import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const page = readFileSync(join(root, 'src', 'time', 'TimeTeamAttendancePage.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'timekeeping.ts'), 'utf8')
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260821142000_team_attendance_fast_totals.sql'),
  'utf8',
)

describe('Team Attendance performance guard', () => {
  it('does not block the employee list on the payroll-grade review pipeline', () => {
    expect(page).not.toContain('getTimekeepingReview')
    expect(page).not.toContain('time-team-review')
    expect(page).toContain('getTeamAttendanceSummary')
  })

  it('loads set-based worked totals and preserves protected access', () => {
    expect(data).toContain("rpc('get_team_attendance_totals'")
    expect(migration).toContain('create or replace function public.get_team_attendance_totals')
    expect(migration).toContain('if not public.has_mfa()')
    expect(migration).toContain('work_segments as (')
    expect(migration).toContain('break_segments as (')
    expect(migration).toContain("grant execute on function public.get_team_attendance_totals(date, date) to authenticated")
  })

  it('reports the database error instead of relabeling every failure as MFA', () => {
    expect(data).toContain("error.message || 'Supervisor time review could not be loaded.'")
    expect(data).not.toContain("throw new Error('Supervisor time review could not be loaded. MFA is required.')")
  })
})
