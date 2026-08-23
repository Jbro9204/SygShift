import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260823200000_mfa_aware_onboarding_email_targets.sql'),
  'utf8',
)
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('MFA-aware onboarding email guardrails', () => {
  it('uses the established effective-access sources when determining MFA requirements', () => {
    expect(migration).toContain('private.employee_requires_mfa')
    expect(migration).toContain('base_role.base_app_role = employee.role')
    expect(migration).toContain('public.employee_access_roles')
    expect(migration).toContain('public.employee_permission_overrides')
    expect(migration).toContain("permission_override.effect = 'grant'")
    expect(migration).toContain("'requiresMfa', private.employee_requires_mfa(employee.id)")
  })

  it('keeps Welcome and Login Instructions separate and selects one login version', () => {
    expect(worker).toContain("subject: 'Welcome to SygShift'")
    expect(worker).toContain("subject: 'Your SygShift Login Is Ready'")
    expect(worker).toContain("subject: 'Your SygShift Login Is Ready — Authenticator Setup Required'")
    expect(worker).toContain('if (target.requiresMfa)')
    expect(worker.match(/sendLoginInstructions\(environment, target, result\.password\)/g)?.length).toBe(2)
  })

  it('explains authenticator setup without implying that codes arrive by email or SMS', () => {
    expect(worker).toContain('Microsoft Authenticator or Google Authenticator')
    expect(worker).toContain('It is not sent by email or text message.')
    expect(worker).toContain('Do not scan it with your regular phone camera.')
    expect(worker).toContain('use your phone’s app switcher')
  })
})
