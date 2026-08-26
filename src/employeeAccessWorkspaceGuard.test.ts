/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const accessControlPage = readFileSync(join(root, 'src', 'pages', 'AccessControlPage.tsx'), 'utf8')
const workspace = readFileSync(join(root, 'src', 'components', 'EmployeeAccessWorkspace.tsx'), 'utf8')
const accessData = readFileSync(join(root, 'src', 'data', 'accessControl.ts'), 'utf8')

describe('employee access workspace guardrails', () => {
  it('keeps employee access editing in one focused workspace', () => {
    expect(accessControlPage).toContain('<EmployeeAccessWorkspace')
    expect(accessControlPage).not.toContain('EmployeeAccessLauncher')
    expect(accessControlPage).not.toContain('employeeAccessEditorOpen')
    expect(workspace).toContain("type EmployeeAccessTab = 'roles' | 'exceptions' | 'effective'")
    expect(workspace).toContain('aria-label="Active employees"')
    expect(workspace).toContain('role="tablist"')
  })

  it('preserves server-enforced mutations and refreshes returned access immediately', () => {
    expect(workspace).toContain('setEmployeeAccessRoles(employeeId, roleIds)')
    expect(workspace).toContain('mutationFn: setEmployeePermissionOverride')
    expect(workspace).toContain('mutationFn: clearEmployeePermissionOverride')
    expect(workspace).toContain("queryClient.setQueryData(['access-control-center'], center)")
    expect(workspace).toContain('busy={modalBusy}')
    expect(accessData).toContain("getSupabaseClient().rpc('set_employee_access_roles'")
    expect(accessData).toContain("getSupabaseClient().rpc('set_employee_permission_override'")
    expect(accessData).toContain("getSupabaseClient().rpc('clear_employee_permission_override'")
  })

  it('requires documented individual exceptions and exposes effective access read-only', () => {
    expect(workspace).toContain('Required audit reason')
    expect(workspace).toContain('required rows={4}')
    expect(workspace).toContain('Save individual exception')
    expect(workspace).toContain('Final effective access')
    expect(workspace).toContain('Changes are protected by MFA, applied by the server, and recorded in the audit history.')
  })
})
