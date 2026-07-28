import type { AppRole } from '../data/session'

export function shouldShowPayrollExportReminder(sessionContext: { role: AppRole } | null): boolean {
  return sessionContext?.role === 'admin' || sessionContext?.role === 'supervisor'
}
