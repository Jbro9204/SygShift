/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260901150000_human_resources_role.sql'),
  'utf8',
)

describe('Human Resources role guardrails', () => {
  it('creates a protected MFA role without assigning an employee', () => {
    expect(migration).toContain("'human_resources'")
    expect(migration).toContain("'Human Resources'")
    expect(migration).toContain('false,\n  true,\n  true,\n  true')
    expect(migration).toContain('must not assign the new role to an employee')
    expect(migration).toContain('employee_role_fingerprint')
    expect(migration).toContain('override_fingerprint')
  })

  it('includes the complete ordinary employee-lifecycle workflow', () => {
    for (const permission of [
      'hr.people.manage',
      'hr.recruiting.approve',
      'hr.onboarding.approve',
      'hr.documents.manage',
      'hr.leave.approve',
      'hr.benefits.approve',
      'hr.talent.restricted',
      'hr.learning.assign',
      'hr.cases.restricted',
      'hr.safety.manage',
      'hr.assets.approve',
      'hr.offboarding.approve',
      'hr.reporting.export',
      'admin.users.password_reset',
    ]) {
      expect(migration).toContain(`'${permission}'`)
    }
  })

  it('excludes compensation, payroll, security administration, and highly restricted vaults', () => {
    for (const permission of [
      'admin.roles.manage',
      'admin.security.manage',
      'admin.users.manage',
      'hr.documents.financial',
      'hr.documents.identity',
      'hr.documents.medical',
      'hr.leave.protected.view',
      'hr.safety.restricted',
      'time.export_payroll',
      'time.manage',
      'time.override_payroll_assignment',
    ]) {
      expect(migration).toContain(`'${permission}'`)
    }
    expect(migration).toContain("permission_code like 'hr.compensation.%'")
    expect(migration).toContain("permission_code like 'hr.payroll_integration.%'")
    expect(migration).toContain("permission_code like 'hr.total_rewards.%'")
  })
})
