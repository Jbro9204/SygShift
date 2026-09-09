import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const accessPolicySource = readFileSync(join(root, 'src', 'app', 'accessPolicy.ts'), 'utf8')
const accessControlSource = readFileSync(join(root, 'src', 'pages', 'AccessControlPage.tsx'), 'utf8')
const homeModelSource = readFileSync(join(root, 'src', 'pages', 'homeModel.ts'), 'utf8')
const navigationSource = readFileSync(join(root, 'src', 'app', 'navigation.ts'), 'utf8')
const cssSource = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const migrationSource = readFileSync(
  join(root, 'supabase', 'migrations', '20260909190000_role_home_experience_selection.sql'),
  'utf8',
)

describe('role-controlled Home experience guardrails', () => {
  it('keeps Home available to every authenticated employee with Basic Home as the safe default', () => {
    expect(accessPolicySource).toContain("'/': { anyOf: [] }")
    expect(navigationSource).toContain("label: 'Home'")
    expect(navigationSource).toContain('permissions: []')
    expect(homeModelSource).toContain("? 'operations'")
    expect(homeModelSource).toContain(": 'basic'")
    expect(homeModelSource).toContain("permissions.includes('operations.view')")
  })

  it('provides one explicit Home experience selector without duplicating it in permission categories', () => {
    expect(accessControlSource).toContain('<strong>Basic Home</strong>')
    expect(accessControlSource).toContain('<strong>Operations Home</strong>')
    expect(accessControlSource).toContain('applyHomeExperienceSelection')
    expect(accessControlSource).toContain('permission.code !== operationsHomePermission')
    expect(accessControlSource).toContain("next.add(operationsDashboardPermission)")
    expect(cssSource).toContain('.access-home-experience__options')
    expect(cssSource).toContain('.access-home-experience__option--selected')
  })

  it('ships the centralized permission with preserved leadership defaults and migration assertions', () => {
    expect(migrationSource).toContain("'home.operations.view'")
    expect(migrationSource).toContain("'system_admin'")
    expect(migrationSource).toContain("'system_supervisor'")
    expect(migrationSource).toContain("'custom_chief'")
    expect(migrationSource).toContain("'human_resources'")
    expect(migrationSource).toContain("'operations_manager'")
    expect(migrationSource).toContain('Home experience release changed protected employee, assignment, override, or role records.')
    expect(migrationSource).toContain('The protected Admin role does not retain every active permission.')
  })
})
