import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20260909164732_repair_dispatcher_role_and_landing_access.sql',
)
const migration = readFileSync(migrationPath, 'utf8')

describe('protected Dispatcher role repair', () => {
  it.each([
    'operations.view',
    'scheduler.view',
    'reports.view',
    'time.reports.view',
  ])('restores and protects %s', (permission) => {
    expect(migration).toContain(`'${permission}'`)
  })

  it('repairs the canonical role without replacing employee or access-role assignments', () => {
    expect(migration).toContain("access_role.code = 'system_dispatcher'")
    expect(migration).toContain("access_role.base_app_role = 'dispatcher'")
    expect(migration).toContain('baseline.employee_count <> (select count(*) from public.employees)')
    expect(migration).toContain('baseline.employee_access_role_count <> (select count(*) from public.employee_access_roles)')
    expect(migration).toContain('baseline.employee_override_count <> (select count(*) from public.employee_permission_overrides)')
  })

  it('prevents the audited permission editor from removing the required Dispatcher baseline again', () => {
    expect(migration).toContain("target_role.code = 'system_dispatcher'")
    expect(migration).toContain('The protected Dispatcher role must retain Home, Scheduler, Reports, and Timekeeping Reports access.')
  })
})
