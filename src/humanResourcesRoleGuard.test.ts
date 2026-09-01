/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260902050000_human_resources_manager_complete_authority.sql'),
  'utf8',
)

describe('Human Resources Manager role guardrails', () => {
  it('upgrades the existing protected MFA role without changing employee assignments', () => {
    expect(migration).toContain("'human_resources'")
    expect(migration).toContain("'Human Resources Manager'")
    expect(migration).toContain('false,\n  true,\n  true,\n  true')
    expect(migration).toContain('employee_role_fingerprint')
    expect(migration).toContain('override_fingerprint')
    expect(migration).toContain('changed an employee role assignment or individual permission override')
  })

  it('includes every active HR and Finance permission without carve-outs', () => {
    expect(migration).toContain("permission.category = 'HR & Finance'")
    expect(migration).toContain('Human Resources Manager is missing HR permission')
    expect(migration).not.toContain("permission.code like 'hr.compensation.%'")
    expect(migration).not.toContain("permission.code like 'hr.documents.%'")
    expect(migration).not.toContain("permission.code like 'hr.leave.%'")
    expect(migration).not.toContain("permission.code like 'hr.payroll_integration.%'")
    expect(migration).not.toContain("permission.code like 'hr.safety.%'")
    expect(migration).not.toContain("permission.code like 'hr.total_rewards.%'")
  })

  it('adds complete HR payroll and employee-lifecycle support without granting system administration', () => {
    for (const permission of [
      'admin.users.basic',
      'admin.users.invite',
      'admin.users.password_reset',
      'admin.users.separate',
      'licensing.configure',
      'notifications.manage',
      'time.export_payroll',
      'time.manage',
      'time.override_payroll_assignment',
    ]) {
      expect(migration).toContain(`'${permission}'`)
    }
    for (const permission of [
      'admin.maintenance.manage',
      'admin.roles.manage',
      'admin.security.manage',
      'admin.users.delete',
      'admin.users.manage',
    ]) {
      expect(migration).toContain(`'${permission}'`)
    }
    expect(migration).toContain('received Admin or Operations-only permission')
  })
})
