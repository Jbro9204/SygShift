import { describe, expect, it } from 'vitest'
import { shouldShowPayrollExportReminder } from './payrollReminder'

describe('payroll export reminders', () => {
  it('shows payroll export reminders only when the effective permission allows export', () => {
    expect(shouldShowPayrollExportReminder({ permissions: ['time.export_payroll'] })).toBe(true)
    expect(shouldShowPayrollExportReminder({ permissions: ['time.manage'] })).toBe(false)
    expect(shouldShowPayrollExportReminder({ permissions: ['time.reports.view'] })).toBe(false)
    expect(shouldShowPayrollExportReminder({ permissions: [] })).toBe(false)
    expect(shouldShowPayrollExportReminder(null)).toBe(false)
  })
})
