import type { SessionContext } from '../data/auth'

export type PermissionCode = string

export interface RouteAccessPolicy {
  anyOf: readonly PermissionCode[]
}

export const scheduleTeamViewPermissions = [
  'schedule.view',
  'scheduler.view',
  'scheduler.manage',
  'schedule.manage',
  'schedule.publish',
  'schedule.delete_shift',
  'schedule.override_warnings',
] as const

export const scheduleRoutePermissions = [
  'schedule.self.view',
  ...scheduleTeamViewPermissions,
] as const

export const routeAccessPolicies: Readonly<Record<string, RouteAccessPolicy>> = {
  '/': { anyOf: ['operations.view'] },
  '/account': { anyOf: [] },
  '/account-security': { anyOf: [] },
  '/actions': { anyOf: ['actions.self.view'] },
  '/schedule': { anyOf: scheduleRoutePermissions },
  '/scheduler': { anyOf: ['scheduler.view', 'scheduler.manage', 'schedule.manage'] },
  '/events': { anyOf: ['events.view', 'events.manage', 'shift_pool.view', 'shift_pool.manage'] },
  '/time': { anyOf: ['time.self.view', 'time.punch', 'time.view', 'time.manage', 'time.export_payroll'] },
  '/time/tools': { anyOf: ['time.self.view', 'time.punch', 'time.manage'] },
  '/time/my-time': { anyOf: ['time.self.view', 'time.punch', 'time.manage'] },
  '/time/team': { anyOf: ['time.view', 'time.manage'] },
  '/time/on-duty': { anyOf: ['time.view', 'time.manage'] },
  '/time/review': { anyOf: ['time.view', 'time.manage', 'time.resolve_exceptions', 'time.export_payroll'] },
  '/time/exceptions': { anyOf: ['time.view', 'time.manage', 'time.resolve_exceptions', 'time.export_payroll'] },
  '/time/operations': { anyOf: ['time.view', 'time.manage', 'time.adjustments.review', 'accountability.view', 'accountability.manage'] },
  '/time/daily-review': { anyOf: ['time.view', 'time.manage', 'accountability.view', 'accountability.manage'] },
  '/time/accountability': { anyOf: ['accountability.view', 'accountability.manage'] },
  '/time/timecards': { anyOf: ['time.view', 'time.manage'] },
  '/time/payroll': { anyOf: ['time.view', 'time.manage', 'time.export_payroll'] },
  '/time/rules': { anyOf: ['time.manage', 'time.export_payroll'] },
  '/payroll': { anyOf: ['time.view', 'time.manage', 'time.export_payroll'] },
  '/payroll/review': { anyOf: ['time.view', 'time.manage', 'time.export_payroll'] },
  '/payroll/employees': { anyOf: ['time.view', 'time.manage', 'time.export_payroll'] },
  '/payroll/export': { anyOf: ['time.export_payroll'] },
  '/payroll/rules': { anyOf: ['time.manage', 'time.export_payroll'] },
  '/hr': { anyOf: ['hr.people.view', 'hr.people.manage'] },
  '/hr/people': { anyOf: ['hr.people.view', 'hr.people.manage'] },
  '/hr/people/:employeeId': { anyOf: ['hr.people.view', 'hr.people.manage'] },
  '/hr/documents': { anyOf: ['hr.documents.view', 'hr.documents.manage'] },
  '/hr/documents/workflows': { anyOf: ['hr.documents.view', 'hr.documents.manage'] },
  '/hr/automation': { anyOf: ['hr.automation.view'] },
  '/hr/recruiting': { anyOf: ['hr.recruiting.view'] },
  '/hr/onboarding': { anyOf: ['hr.onboarding.view'] },
  '/hr/leave': { anyOf: ['hr.leave.view'] },
  '/hr/benefits': { anyOf: ['hr.benefits.view'] },
  '/hr/compensation': { anyOf: ['hr.compensation.view'] },
  '/hr/talent-learning': { anyOf: ['hr.talent.view', 'hr.learning.view'] },
  '/hr/cases-compliance': { anyOf: ['hr.cases.view', 'hr.safety.view', 'hr.assets.view'] },
  '/hr/offboarding': { anyOf: ['hr.offboarding.view'] },
  '/hr/self-service': { anyOf: ['hr.self_service.view'] },
  '/hr/reporting': { anyOf: ['hr.reporting.view'] },
  '/hr/payroll-integration': { anyOf: ['hr.payroll_integration.view'] },
  '/my-documents': { anyOf: [] },
  '/hr/identity-readiness': { anyOf: ['hr.people.manage'] },
  '/people': { anyOf: ['directory.view', 'directory.edit_basic', 'availability.manage'] },
  '/licensing': { anyOf: ['licensing.view', 'licensing.manage', 'licensing.configure', 'licensing.communicate', 'directory.edit_credentials'] },
  '/availability': { anyOf: ['availability.view', 'availability.manage'] },
  '/sites': { anyOf: ['sites.view', 'sites.manage'] },
  '/clients': { anyOf: ['clients.view', 'clients.manage'] },
  '/clients/:clientId': { anyOf: ['clients.view', 'clients.manage'] },
  '/patrol': { anyOf: ['patrol.self.view', 'patrol.view', 'patrol.manage', 'patrol.operations.view', 'patrol.routes.manage'] },
  '/requests': { anyOf: ['requests.view', 'requests.manage'] },
  '/announcements': { anyOf: ['announcements.send', 'announcements.banner.manage'] },
  '/notifications': { anyOf: ['notifications.view', 'notifications.manage'] },
  '/reports': { anyOf: ['reports.view', 'time.reports.view', 'clients.activity.view'] },
  '/reports/:reportKey': { anyOf: ['reports.view', 'time.reports.view', 'clients.activity.view'] },
  '/users': { anyOf: ['admin.users.view', 'admin.users.basic', 'admin.users.manage', 'admin.users.invite', 'admin.users.password_reset', 'admin.users.separate', 'admin.users.delete'] },
  '/access-control': { anyOf: ['admin.roles.view', 'admin.roles.manage'] },
  '/system-operations': { anyOf: ['admin.maintenance.manage'] },
}

export function hasEffectivePermission(
  session: Pick<SessionContext, 'permissions'> | null | undefined,
  permission: PermissionCode,
): boolean {
  return Boolean(session?.permissions.includes(permission))
}

export function hasAnyEffectivePermission(
  session: Pick<SessionContext, 'permissions'> | null | undefined,
  permissions: readonly PermissionCode[],
): boolean {
  return permissions.some((permission) => hasEffectivePermission(session, permission))
}

export function canAccessRoute(
  pathname: string,
  session: Pick<SessionContext, 'permissions'> | null | undefined,
): boolean {
  const policyKey = pathname.startsWith('/reports/')
    ? '/reports/:reportKey'
    : pathname.startsWith('/clients/')
      ? '/clients/:clientId'
    : pathname.startsWith('/hr/people/')
      ? '/hr/people/:employeeId'
      : pathname
  const policy = routeAccessPolicies[policyKey]
  if (pathname === '/account' || pathname === '/account-security' || pathname === '/requests' || pathname === '/my-documents') return Boolean(policy)
  return policy ? hasAnyEffectivePermission(session, policy.anyOf) : false
}
