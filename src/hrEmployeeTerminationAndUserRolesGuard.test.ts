/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260902222001_hr_employee_termination_and_user_role_assignment.sql', 'utf8')
const lifecycleMigration = readFileSync('supabase/migrations/20260912110000_guided_offboarding_workflow.sql', 'utf8')
const employeeFile = readFileSync('src/pages/HrisEmployeeFilePage.tsx', 'utf8')
const lifecycleDialog = readFileSync('src/components/HrLifecycleCaseDialog.tsx', 'utf8')
const userAccounts = readFileSync('src/pages/UserAdminPage.tsx', 'utf8')
const adminUsers = readFileSync('src/data/adminUsers.ts', 'utf8')

describe('HR termination and complete User Accounts role controls', () => {
  it('reuses the canonical separation workflow behind exact HR permissions and MFA', () => {
    expect(migration).toContain('private.require_hris_stage2_manager()')
    expect(migration).toContain("public.has_effective_permission('hr.offboarding.approve')")
    expect(migration).toContain('private.separate_employee_account_and_future_work(')
    expect(migration).toContain('You cannot terminate your own employment record.')
    expect(migration).toContain('Only an Admin can terminate an Admin employee.')
    expect(migration).toContain('Enter the employee username exactly to confirm termination.')
    expect(migration).toContain('Use the Offboarding workflow to plan a future termination.')
    expect(migration).toContain('private.hr_stage2_effective_date_authorizations')
  })

  it('routes Employee File lifecycle actions into the guarded, auditable workflow', () => {
    expect(employeeFile).toContain('Start lifecycle case')
    expect(employeeFile).toContain('Start rehire case')
    expect(employeeFile).toContain('editorContext?.canTerminate')
    expect(employeeFile).toContain('/hr/offboarding?employee=')
    expect(employeeFile).not.toContain('EmployeeTerminationDialog')
    expect(lifecycleDialog).toContain('Independent approval required')
    expect(lifecycleDialog).toContain('Final human-confirmed action')
    expect(lifecycleDialog).toContain('after all checklist items are complete or waived')
    expect(lifecycleDialog).toContain('Permanent case timeline')
    expect(lifecycleMigration).toContain('private.separate_employee_account_and_future_work(')
    expect(lifecycleMigration).toContain('Only an Admin can complete an Admin separation.')
  })

  it('loads the central role library and atomically saves selected memberships', () => {
    expect(userAccounts).toContain('getAccessControlCenter')
    expect(userAccounts).toContain('EmployeeRolesField')
    expect(userAccounts).toContain('Review role changes')
    expect(userAccounts).not.toContain('Add specialized access')
    expect(userAccounts).not.toContain('Workforce role')
    expect(userAccounts).not.toContain('Additional access roles')
    expect(userAccounts).toContain('accessRoleId')
    expect(userAccounts).toContain('roleFilterOptions')
    expect(adminUsers).toContain('admin_create_employee_with_time_zone_and_access_roles')
    expect(adminUsers).toContain('admin_update_employee_with_time_zone_and_access_roles')
    expect(migration).toContain('private.require_access_control_admin()')
    expect(migration).toContain('private.replace_employee_additional_access_roles(')
    expect(migration).toContain("'UPDATE_FROM_USER_ACCOUNTS'")
  })

  it('keeps the release installation data-preserving and browser grants narrow', () => {
    expect(migration).toContain('hr_termination_role_release_baseline')
    expect(migration).toContain('employee_fingerprint')
    expect(migration).toContain('account_fingerprint')
    expect(migration).toContain('access_assignment_fingerprint')
    expect(migration).toContain('the migration was rolled back')
    expect(migration).toContain('from public, anon')
    expect(migration).toContain('to authenticated')
    expect(migration).toContain('set search_path = \'\'')
  })
})
