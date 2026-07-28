import { describe, expect, it } from 'vitest'
import { shouldShowPayrollExportReminder } from './payrollReminder'

describe('payroll export reminders', () => {
  it('shows payroll export reminders only to Admins and Supervisors', () => {
    expect(shouldShowPayrollExportReminder({ role: 'admin' })).toBe(true)
    expect(shouldShowPayrollExportReminder({ role: 'supervisor' })).toBe(true)
    expect(shouldShowPayrollExportReminder({ role: 'scheduler' })).toBe(false)
    expect(shouldShowPayrollExportReminder({ role: 'dispatcher' })).toBe(false)
    expect(shouldShowPayrollExportReminder({ role: 'recruiting_licensing' })).toBe(false)
    expect(shouldShowPayrollExportReminder({ role: 'guard' })).toBe(false)
    expect(shouldShowPayrollExportReminder(null)).toBe(false)
  })
})
