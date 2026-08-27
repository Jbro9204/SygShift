/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const accessControlPage = readFileSync(join(root, 'src', 'pages', 'AccessControlPage.tsx'), 'utf8')
const workspace = readFileSync(join(root, 'src', 'components', 'EmployeeAccessWorkspace.tsx'), 'utf8')
const accessData = readFileSync(join(root, 'src', 'data', 'accessControl.ts'), 'utf8')
const accessProfileMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260826230000_additive_employee_access_profile.sql'),
  'utf8',
)

describe('employee access workspace guardrails', () => {
  it('keeps employee access editing in one focused workspace', () => {
    expect(accessControlPage).toContain('<EmployeeAccessWorkspace')
    expect(accessControlPage).not.toContain('EmployeeAccessLauncher')
    expect(accessControlPage).not.toContain('employeeAccessEditorOpen')
    expect(workspace).toContain('aria-label="Active employees"')
    expect(workspace).toContain('Additional role memberships')
    expect(workspace).toContain('Individual permission additions')
    expect(workspace).toContain('Effective access')
    expect(accessControlPage).toContain('Role & Group Permissions')
    expect(accessControlPage).toContain('Employee Permissions')
  })

  it('saves employee role memberships and permission additions atomically on the server', () => {
    expect(workspace).toContain('mutationFn: setEmployeeAccessProfile')
    expect(workspace).toContain("queryClient.setQueryData(['access-control-center'], center)")
    expect(workspace).toContain('busy={mutation.isPending}')
    expect(accessData).toContain("getSupabaseClient().rpc('set_employee_access_profile'")
    expect(accessProfileMigration).toContain('create or replace function public.set_employee_access_profile')
    expect(accessProfileMigration).toContain('private.require_access_control_admin()')
    expect(accessProfileMigration).toContain('for update;')
    expect(accessProfileMigration).toContain("permission_override.effect = 'grant'")
    expect(accessProfileMigration).not.toContain("permission_override.effect = 'deny'\n    and not")
  })

  it('requires a documented audit reason and protects inherited and legacy access', () => {
    expect(workspace).toContain('Required audit reason')
    expect(workspace).toContain('Why is this access changing?')
    expect(workspace).toContain('Save employee permissions')
    expect(workspace).toContain('protected legacy restriction')
    expect(workspace).toContain('Only permissions not already inherited from a role are available.')
    expect(accessProfileMigration).toContain('Individual additions may include only permissions not already inherited from a role.')
    expect(accessProfileMigration).toContain('A protected legacy restriction must be reviewed separately')
    expect(accessProfileMigration).toContain("'assignedCount', coalesce(assignments.assigned_count, 0)")
    expect(accessProfileMigration).toContain('count(distinct role_employee.employee_id)')
    expect(accessProfileMigration).toContain("'employee_access_profile'")
  })
})
