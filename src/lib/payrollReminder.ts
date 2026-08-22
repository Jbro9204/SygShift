export function shouldShowPayrollExportReminder(sessionContext: { permissions: string[] } | null): boolean {
  return Boolean(sessionContext?.permissions.includes('time.export_payroll'))
}
