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
    || hasTimePermission(session, 'time.resolve_exceptions')
    || hasTimePermission(session, 'time.export_payroll')
  )
}

export function canManageTime(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.manage')
}

export function canResolveTimeExceptions(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.resolve_exceptions')
}

export function canExportPayroll(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.export_payroll')
}

export function canOverridePayrollAssignment(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.override_payroll_assignment')
}

export function canViewAttendanceReview(session: SessionContext | null | undefined): boolean {
  return (
    canViewTeamTime(session)
    || hasTimePermission(session, 'accountability.view')
    || hasTimePermission(session, 'accountability.manage')
  )
}

export function canManageAttendanceReview(session: SessionContext | null | undefined): boolean {
  return (
    hasTimePermission(session, 'time.manage')
    || hasTimePermission(session, 'accountability.manage')
  )
}

export function canCreateManualTimeEntry(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.manual_entry.create')
}

export function canEditManualTimeEntry(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.manual_entry.edit')
}

export function canReviewTimeAdjustments(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.adjustments.review')
}

export function canReportEmployeeCallOff(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'accountability.report_call_off')
}

export function canViewTimekeepingReports(session: SessionContext | null | undefined): boolean {
  return hasTimePermission(session, 'time.reports.view')
}
