import type { SessionContext } from '../data/auth'

export function hasTimePermission(
  session: SessionContext | null | undefined,
  permission: string,
): boolean {
  return session?.role === 'admin' || Boolean(session?.permissions.includes(permission))
}

export function canViewOwnTime(session: SessionContext | null | undefined): boolean {
  return (
    hasTimePermission(session, 'time.self.view')
    || hasTimePermission(session, 'time.punch')
    || hasTimePermission(session, 'time.view')
    || hasTimePermission(session, 'time.manage')
    || hasTimePermission(session, 'time.export_payroll')
  )
}

export function canUseOwnTimeClock(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.punch') || hasTimePermission(session, 'time.manage')
}

export function canViewTeamTime(session: SessionContext | null | undefined): boolean {
  return (
    hasTimePermission(session, 'time.view')
    || hasTimePermission(session, 'time.manage')
    || hasTimePermission(session, 'time.export_payroll')
  )
}

export function canManageTime(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.manage')
}

export function canExportPayroll(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.export_payroll')
}
