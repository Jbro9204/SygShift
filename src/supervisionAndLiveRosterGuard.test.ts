import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260902160000_supervisor_scope_and_live_time_roster.sql'), 'utf8')
const peoplePage = readFileSync(join(root, 'src', 'pages', 'PeoplePage.tsx'), 'utf8')
const employeeFile = readFileSync(join(root, 'src', 'pages', 'HrisEmployeeFilePage.tsx'), 'utf8')
const overview = readFileSync(join(root, 'src', 'pages', 'OverviewPage.tsx'), 'utf8')
const liveRoster = readFileSync(join(root, 'src', 'time', 'TimeOnDutyPage.tsx'), 'utf8')
const myTime = readFileSync(join(root, 'src', 'time', 'MyTimePage.tsx'), 'utf8')
const appCss = readFileSync(join(root, 'src', 'App.css'), 'utf8')

describe('supervision scope and live clock roster guardrails', () => {
  it('keeps reporting scope separate from permissions and records exception access', () => {
    expect(migration).toContain('employee_supervisor_assignments')
    expect(migration).toContain('VIEW_OUTSIDE_ASSIGNED_TEAM')
    expect(migration).toContain("public.has_effective_permission('hr.people.manage')")
    expect(migration).not.toContain('insert into public.employee_access_roles')
    expect(migration).not.toContain('insert into public.employee_permission_overrides')
    expect(peoplePage).toContain('My Employees')
    expect(peoplePage).toContain('All Employees')
    expect(peoplePage).toContain('Unassigned')
    expect(peoplePage).toContain('By Supervisor')
    expect(employeeFile).toContain('Assign supervisor')
  })

  it('routes the live metric to a dedicated current-only roster', () => {
    expect(overview).toContain("path: '/time/on-duty'")
    expect(liveRoster).toContain('getLiveTimeRoster')
    expect(liveRoster).toContain('Historical punches, review queues, and payroll tools are intentionally kept out of this view.')
    expect(migration).toContain("where event.kind in ('clock_in', 'break_start', 'break_end')")
  })

  it('uses the shared readable snapshot label treatment', () => {
    expect(myTime).toContain('label="Needs Review"')
    expect(appCss).toMatch(/\.time-metric__top span\s*\{[\s\S]*?font-size: 15px;[\s\S]*?font-weight: 900;/)
  })
})
