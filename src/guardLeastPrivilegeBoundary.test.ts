/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canAccessRoute } from './app/accessPolicy'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260824183000_guard_least_privilege_and_self_service.sql'),
  'utf8',
)

const guardPermissions = [
  'actions.self.view',
  'announcements.view',
  'availability.view',
  'events.view',
  'operations.view',
  'requests.view',
  'schedule.self.view',
  'shift_pool.view',
  'time.punch',
  'time.self.view',
  'training.view',
]

const guardSession = { permissions: guardPermissions }

describe('Guard least-privilege boundary', () => {
  it('keeps the required Guard self-service workspaces available', () => {
    for (const route of [
      '/',
      '/actions',
      '/schedule',
      '/events',
      '/time',
      '/time/tools',
      '/time/my-time',
      '/availability',
      '/requests',
    ]) {
      expect(canAccessRoute(route, guardSession), route).toBe(true)
    }
  })

  it('keeps team, administrative, and sensitive operations out of Guard access', () => {
    for (const route of [
      '/scheduler',
      '/time/team',
      '/time/exceptions',
      '/time/operations',
      '/time/daily-review',
      '/time/accountability',
      '/time/timecards',
      '/time/payroll',
      '/time/rules',
      '/people',
      '/licensing',
      '/sites',
      '/patrol',
      '/announcements',
      '/notifications',
      '/reports',
      '/users',
      '/access-control',
    ]) {
      expect(canAccessRoute(route, guardSession), route).toBe(false)
    }
  })

  it('removes team-time and accountability creation from the system Guard role', () => {
    expect(migration).toContain("role.code = 'system_guard'")
    expect(migration).toContain("permission.permission_code in ('accountability.create', 'time.view')")
    expect(migration).toContain("'time.self.view'")
    expect(migration).toContain("'time.punch'")
    expect(migration).toContain("'schedule.self.view'")
  })

  it('makes employee-owned request, availability, and announcement access usable without MFA', () => {
    for (const permission of ['requests.view', 'availability.view', 'announcements.view']) {
      expect(migration).toContain(`where code = '${permission}'`)
    }
    expect(migration.match(/requires_mfa = false/g)).toHaveLength(3)
  })

  it('enforces self-only raw record visibility for Guards', () => {
    expect(migration).toContain('id = (select public.current_employee_id())')
    expect(migration).toContain('employee_id = (select public.current_employee_id())')
    expect(migration).toContain('private.current_employee_visible_schedule_ids()')
    expect(migration).toContain('private.current_employee_visible_shift_ids()')
    expect(migration).toContain('id in (select unnest(private.current_employee_visible_schedule_ids()))')
    expect(migration).toContain('id in (select unnest(private.current_employee_visible_shift_ids()))')
    expect(migration).toContain('shift_id in (select unnest(private.current_employee_visible_shift_ids()))')
    expect(migration).toContain('drop policy if exists schedules_supervisor_write on public.schedules')
    expect(migration).toContain("using ((select public.has_effective_permission('schedule.manage')))")
    expect(migration).toContain("or (select public.has_effective_permission('availability.manage'))")
    expect(migration).not.toContain("array['availability.view', 'availability.manage']")
  })

  it('keeps targeted announcements and managed site/post data permission-aware', () => {
    expect(migration).toContain('private.announcement_visible_to_current_user(announcements)')
    expect(migration).toContain("array['sites.view', 'sites.manage']")
    expect(migration).toContain("'events.view'")
    expect(migration).toContain("'shift_pool.view'")
  })

  it('keeps credential-editor Licensing Center access behind a dedicated MFA permission', () => {
    expect(canAccessRoute('/licensing', { permissions: ['directory.edit_credentials'] })).toBe(true)
    expect(canAccessRoute('/licensing', guardSession)).toBe(false)
  })
})
