import type { SessionContext } from '../data/auth'

export type PermissionCode = string

export interface RouteAccessPolicy {
  anyOf: readonly PermissionCode[]
}

export const routeAccessPolicies: Readonly<Record<string, RouteAccessPolicy>> = {
  '/': { anyOf: ['operations.view'] },
  '/account-security': { anyOf: [] },
  '/actions': { anyOf: ['actions.self.view'] },
  '/schedule': { anyOf: ['schedule.view', 'schedule.manage', 'schedule.publish', 'schedule.delete_shift', 'schedule.override_warnings'] },
  '/scheduler': { anyOf: ['scheduler.view', 'scheduler.manage', 'schedule.manage'] },
  '/events': { anyOf: ['events.view', 'events.manage', 'shift_pool.view', 'shift_pool.manage'] },
  '/time': { anyOf: ['time.self.view', 'time.punch', 'time.view', 'time.manage', 'time.export_payroll'] },
  '/time/tools': { anyOf: ['time.self.view', 'time.punch', 'time.manage'] },
  '/time/my-time': { anyOf: ['time.self.view', 'time.punch', 'time.manage'] },
  '/time/team': { anyOf: ['time.view', 'time.manage'] },
  '/time/exceptions': { anyOf: ['time.view', 'time.manage', 'time.resolve_exceptions', 'time.export_payroll'] },
  '/time/operations': { anyOf: ['time.view', 'time.manage', 'time.adjustments.review', 'accountability.view', 'accountability.manage'] },
  '/time/daily-review': { anyOf: ['time.view', 'time.manage', 'accountability.view', 'accountability.manage'] },
  '/time/accountability': { anyOf: ['accountability.view', 'accountability.manage'] },
  '/time/timecards': { anyOf: ['time.view', 'time.manage'] },
  '/time/payroll': { anyOf: ['time.view', 'time.manage', 'time.export_payroll'] },
  '/time/rules': { anyOf: ['time.manage', 'time.export_payroll'] },
  '/people': { anyOf: ['directory.view', 'directory.edit_basic', 'availability.manage'] },
  '/licensing': { anyOf: ['licensing.view', 'licensing.manage', 'licensing.configure', 'licensing.communicate'] },
  '/availability': { anyOf: ['availability.view', 'availability.manage'] },
  '/sites': { anyOf: ['sites.view', 'sites.manage'] },
  '/patrol': { anyOf: ['patrol.view', 'patrol.manage'] },
  '/requests': { anyOf: ['requests.view', 'requests.manage'] },
  '/announcements': { anyOf: ['announcements.send', 'announcements.banner.manage'] },
  '/notifications': { anyOf: ['notifications.view', 'notifications.manage'] },
  '/reports': { anyOf: ['reports.view', 'reports.export', 'time.reports.view'] },
  '/users': { anyOf: ['admin.users.view', 'admin.users.basic', 'admin.users.manage', 'admin.users.invite', 'admin.users.separate', 'admin.users.delete'] },
  '/access-control': { anyOf: ['admin.roles.view', 'admin.roles.manage'] },
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
  const policy = routeAccessPolicies[pathname]
  if (pathname === '/account-security') return Boolean(policy)
  return policy ? hasAnyEffectivePermission(session, policy.anyOf) : false
}
