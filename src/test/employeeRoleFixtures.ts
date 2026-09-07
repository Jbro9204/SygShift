import type { AccessRoleDefinition } from '../data/accessControl'
import type { AdminUser, AppRole } from '../data/adminUsers'

export const roleFixture = (id: string, name: string, baseAppRole: AppRole | null): AccessRoleDefinition => ({
  id, code: id, name, description: `${name} workspace access.`, baseAppRole, systemRole: baseAppRole !== null,
  active: true, protected: baseAppRole === 'admin', mfaRequired: baseAppRole !== 'guard', permissionCodes: [], assignedCount: 0,
})
export const employeeRoleFixtures = [
  roleFixture('guard-role', 'Guard', 'guard'), roleFixture('super-role', 'Supervisor', 'supervisor'),
  roleFixture('admin-role', 'Admin', 'admin'), roleFixture('scheduler-role', 'Scheduler', 'scheduler'),
  roleFixture('dispatch-role', 'Dispatcher', 'dispatcher'), roleFixture('licensing-role', 'Recruiting & Licensing', 'recruiting_licensing'),
  roleFixture('hr-role', 'Human Resources Employee', null), roleFixture('hr-manager-role', 'Human Resources Manager', null),
  roleFixture('ops-role', 'Operations Manager', null),
]
export const employeeRoleTestUser: AdminUser = {
  id: '10000000-0000-4000-8000-000000000001', employeeNumber: 'TEST-001', username: 'sample.employee',
  firstName: 'Sample', middleName: null, lastName: 'Employee', preferredName: null, displayName: 'Sample Employee',
  jobTitle: 'HR Manager', role: 'supervisor', employmentType: 'salary', timeZone: 'America/Denver', status: 'active',
  photoPath: null, hiredOn: null, separatedOn: null, personalEmail: null, companyEmail: null, mobilePhone: null,
  account: null, accountStatus: 'not_created', credentials: [],
}
