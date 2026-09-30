/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const accessControlPage = readFileSync(join(root, 'src', 'pages', 'AccessControlPage.tsx'), 'utf8')
const workspace = readFileSync(join(root, 'src', 'components', 'EmployeeAccessWorkspace.tsx'), 'utf8')
const sensitiveReview = readFileSync(join(root, 'src', 'components', 'SensitivePermissionReview.tsx'), 'utf8')
const accessData = readFileSync(join(root, 'src', 'data', 'accessControl.ts'), 'utf8')
const appCss = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const accessProfileMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260930160000_atomic_primary_role_access_profiles.sql'),
  'utf8',
)

describe('employee access workspace guardrails', () => {
  it('keeps employee access editing in one focused workspace', () => {
    expect(accessControlPage).toContain('<EmployeeAccessWorkspace')
    expect(accessControlPage).not.toContain('EmployeeAccessLauncher')
    expect(accessControlPage).not.toContain('employeeAccessEditorOpen')
    expect(workspace).toContain('aria-label="Employees"')
    expect(workspace).toContain('Workforce roles')
    expect(workspace).toContain('Primary workforce role')
    expect(workspace).toContain('Individual permission additions')
    expect(workspace).toContain('Effective access')
    expect(accessControlPage).toContain('Role & Group Permissions')
    expect(accessControlPage).toContain('Employee Permissions')
  })

  it('keeps the employee directory bounded, searchable, and independently scrollable', () => {
    expect(workspace).toContain('Showing {filteredUsers.length} of {users.length}')
    expect(workspace).toContain('aria-label="Employee search results"')
    expect(appCss).toContain('.access-employee-list {')
    expect(appCss).toContain('max-height: min(56vh, 520px)')
    expect(appCss).toContain('overflow-y: auto')
    expect(appCss).toContain('.access-employee-list::-webkit-scrollbar-thumb')
  })

  it('keeps sensitive confirmation and the role directory compact and cushioned', () => {
    expect(workspace).toContain('<SensitivePermissionReview')
    expect(accessControlPage).toContain('<SensitivePermissionReview')
    expect(sensitiveReview).toContain('Grouped into {categories.length}')
    expect(sensitiveReview).toContain('className="access-confirmation-group"')
    expect(appCss).toContain('.access-confirmation-review {')
    expect(appCss).toContain('max-height: min(44vh, 410px)')
    expect(appCss).toContain('.access-role-directory {')
    expect(appCss).toContain('grid-template-rows: auto minmax(0, 1fr) auto')
    expect(appCss).toContain('.access-role-list::-webkit-scrollbar-thumb')
  })

  it('saves employee role memberships and permission additions atomically on the server', () => {
    expect(workspace).toContain('mutationFn: setEmployeeAccessProfileWithPrimaryRole')
    expect(workspace).toContain("queryClient.setQueryData(['access-control-center'], center)")
    expect(workspace).toContain("queryKey: ['admin-user-directory'], refetchType: 'active'")
    expect(workspace).toContain('busy={mutation.isPending}')
    expect(accessData).toContain("getSupabaseClient().rpc('set_employee_access_profile_with_primary_role'")
    expect(accessProfileMigration).toContain('create or replace function public.set_employee_access_profile_with_primary_role')
    expect(accessProfileMigration).toContain('private.require_access_control_admin()')
    expect(accessProfileMigration).toContain('for update;')
    expect(accessProfileMigration).toContain("permission_override.effect = 'grant'")
    expect(accessProfileMigration).not.toContain("permission_override.effect = 'deny'\n    and not")
  })

  it('keeps roles.view genuinely useful while every mutation remains manage-only', () => {
    expect(accessControlPage).toContain("permissions.includes('admin.roles.manage')")
    expect(accessControlPage).toContain('canManage={canManageSelectedRole}')
    expect(accessControlPage).toContain('canManageAccess={canManageRoles}')
    expect(accessControlPage).toContain('createRoleOpen && canManageRoles')
    expect(accessControlPage).toContain('readOnly={!canManage}')
    expect(accessControlPage).toContain("selectedRole?.code !== 'system_admin'")
    expect(accessControlPage).toContain('Only an employee whose primary workforce role is Admin can change the protected Admin role definition.')
    expect(workspace).toContain('You have view-only access.')
  })

  it('requires a documented audit reason and protects inherited and legacy access', () => {
    expect(workspace).toContain('Required audit reason')
    expect(workspace).toContain('Why is this access changing?')
    expect(workspace).toContain('Save employee permissions')
    expect(workspace).toContain('protected legacy restriction')
    expect(workspace).toContain('Only permissions not already inherited from a role are available.')
    expect(accessProfileMigration).toContain('A new individual addition cannot duplicate permission inherited from a role.')
    expect(accessProfileMigration).toContain('A protected individual restriction must be reviewed separately')
    expect(accessProfileMigration).toContain("'assignedCount', coalesce(assignments.assigned_count, 0)")
    expect(accessProfileMigration).toContain('count(distinct role_employee.employee_id)')
    expect(accessProfileMigration).toContain("'employee_access_profile'")
  })
})
