/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canAccessRoute,
  hasAnyEffectivePermission,
  scheduleRoutePermissions,
  scheduleTeamViewPermissions,
} from './app/accessPolicy'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260824113000_schedule_self_view_permission.sql'),
  'utf8',
)

const session = (permissions: string[]) => ({ permissions })

describe('personal and company-wide schedule access', () => {
  it('allows personal schedule navigation without granting company-wide visibility', () => {
    const personalViewer = session(['schedule.self.view'])

    expect(canAccessRoute('/schedule', personalViewer)).toBe(true)
    expect(hasAnyEffectivePermission(personalViewer, scheduleTeamViewPermissions)).toBe(false)
    expect(scheduleRoutePermissions).toContain('schedule.self.view')
  })

  it('keeps the existing schedule.view permission company-wide', () => {
    const companyViewer = session(['schedule.view'])

    expect(canAccessRoute('/schedule', companyViewer)).toBe(true)
    expect(hasAnyEffectivePermission(companyViewer, scheduleTeamViewPermissions)).toBe(true)
    expect(scheduleTeamViewPermissions).not.toContain('schedule.self.view')
  })

  it('enforces the same separation in the database and system-role grants', () => {
    expect(migration).toContain("'schedule.self.view'")
    expect(migration).toContain("name = 'View all schedules'")
    expect(migration).toContain("role.code in ('system_guard', 'system_recruiting_licensing')")
    expect(migration).toContain("if not can_view_own_schedule and not can_view_all_schedule")
    expect(migration).toContain('viewer_assignment.employee_id = viewer_employee_id')
    expect(migration).toContain("schedule.status = 'draft' and can_view_all_schedule")
  })
})
