import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
const dialog = readFileSync(join(root, 'src', 'components', 'VacancyPatrolRecoveryDialog.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'vacancyPatrolRecovery.ts'), 'utf8')

describe('Schedule vacancy Patrol recovery integration', () => {
  it('limits the action to regular published, fully unassigned open shifts', () => {
    expect(schedulePage).toContain("scheduleStatus === 'published'")
    expect(schedulePage).toContain('operationalAssignmentCount(shift) === 0')
    expect(schedulePage).toContain('!shift.coverage')
    expect(schedulePage).toContain("(shift.assignment_type ?? 'standard') === 'standard'")
    expect(schedulePage).toContain("(shift.work_type ?? 'post') === 'post'")
    expect(schedulePage).toContain('Resolve vacancy')
    expect(schedulePage).toContain('Send to Patrol')
  })

  it('loads focused week markers and exposes each durable workflow stage on shift cards', () => {
    expect(schedulePage).toContain("const hasVacancyPatrolRequestPermission = sessionHasAnyPermission(sessionQuery.data, ['patrol.recovery.request'])")
    expect(schedulePage).toContain('isSchedulerHome && hasVacancyPatrolRequestPermission')
    expect(schedulePage).toContain('{canInitiateVacancyPatrolRecovery && vacancyPatrolShiftId ? (')
    expect(schedulePage).toContain("queryKey: ['vacancy-patrol-recovery-map', weekKey]")
    expect(schedulePage).toContain("return 'Patrol review'")
    expect(schedulePage).toContain("return 'Patrol planned'")
    expect(schedulePage).toContain("return 'Patrol partial'")
    expect(schedulePage).toContain("return 'Patrol reconciled'")
    expect(schedulePage).toContain("return 'Finance reviewed'")
    expect(schedulePage).toContain('Planned {vacancyRecovery.plannedHits} hit')
  })

  it('uses focused RPCs and never exposes the broad Patrol workspace to Schedule', () => {
    expect(data).toContain("rpc('get_vacancy_patrol_recovery_bootstrap'")
    expect(data).toContain("rpc('get_vacancy_patrol_recovery_map'")
    expect(data).toContain("rpc('create_vacancy_patrol_recovery'")
    expect(data).not.toContain('get_patrol_workspace')
    expect(dialog).not.toContain('getPatrolWorkspace')
  })

  it('keeps vacancy recovery distinct from absence, attendance, assignment, and final billing', () => {
    expect(dialog).toContain('It does not create a call-off, attendance event, time entry, patrol assignment, or final billing decision.')
    expect(dialog).toContain('It does not assign a Patrol officer, report a call-off, change attendance, or approve billing.')
    expect(dialog).toContain('Patrol management will review this route preference')
  })
})
