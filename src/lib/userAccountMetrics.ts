import type { AccountStatus, AdminUser, AppRole, EmployeeStatus } from '../data/adminUsers'

type UserAccountMetricSource = Pick<AdminUser, 'accountStatus' | 'role' | 'status'>

export interface UserAccountMetrics {
  active: number
  activeAdmins: number
  missingLogins: number
  total: number
}

export function summarizeUserAccounts(users: readonly UserAccountMetricSource[]): UserAccountMetrics {
  const activeUsers = users.filter((user) => user.status === 'active')

  return {
    active: activeUsers.length,
    activeAdmins: activeUsers.filter((user) => user.role === 'admin').length,
    missingLogins: activeUsers.filter((user) => user.accountStatus === 'not_created').length,
    total: users.length,
  }
}

export function userAccountMetricRecord(
  status: EmployeeStatus,
  role: AppRole,
  accountStatus: AccountStatus,
): UserAccountMetricSource {
  return { accountStatus, role, status }
}
