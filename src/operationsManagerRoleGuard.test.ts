/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260901120000_operations_manager_role.sql'),
  'utf8',
)
const accessPolicy = readFileSync(join(root, 'src', 'app', 'accessPolicy.ts'), 'utf8')
const navigation = readFileSync(join(root, 'src', 'app', 'navigation.ts'), 'utf8')
const userAdminPage = readFileSync(join(root, 'src', 'pages', 'UserAdminPage.tsx'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('Operations Manager role guardrails', () => {
  it('creates a protected MFA role without assigning it to an employee', () => {
    expect(migration).toContain("'operations_manager'")
    expect(migration).toContain("'Operations Manager'")
    expect(migration).toContain('false,\n  true,\n  true,\n  true')
    expect(migration).toContain('must not assign the new role to an employee')
    expect(migration).toContain('employee_role_fingerprint')
    expect(migration).toContain('override_fingerprint')
  })

  it('provides companywide operational control while excluding protected authority', () => {
    for (const permission of [
      'schedule.publish',
      'scheduler.manage',
      'time.manage',
      'time.resolve_exceptions',
      'patrol.manage',
      'sites.manage',
      'licensing.manage',
      'announcements.send',
      'reports.export',
      'hr.people.view',
      'hr.onboarding.view',
    ]) {
      expect(migration).toContain(`'${permission}'`)
    }
    for (const permission of [
      'admin.roles.manage',
      'admin.security.manage',
      'admin.users.manage',
      'licensing.configure',
      'time.export_payroll',
      'time.override_payroll_assignment',
    ]) {
      expect(migration).toContain(`'${permission}'`)
    }
    expect(migration).toContain("permission_code like 'hr.%'")
    expect(migration).toContain("not in ('hr.people.view', 'hr.onboarding.view')")
  })

  it('separates password recovery from MFA and security-key administration', () => {
    expect(migration).toContain("'admin.users.password_reset'")
    expect(accessPolicy).toContain("'admin.users.password_reset'")
    expect(navigation).toContain("'admin.users.password_reset'")
    expect(userAdminPage).toContain("hasPermission('admin.users.password_reset')")
    expect(userAdminPage).toContain('canManageLogin || canResetPassword')
    expect(worker).toContain("? 'admin.users.password_reset'")
    expect(worker).toContain('password_reset_permission_required')
  })
})
