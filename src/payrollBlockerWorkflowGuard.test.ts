import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(process.cwd(), 'src')
const payrollSource = readFileSync(join(sourceRoot, 'time', 'TimePayrollPage.tsx'), 'utf8')
const cssSource = readFileSync(join(sourceRoot, 'App.css'), 'utf8')

describe('actionable payroll blocker workflow guardrails', () => {
  it('opens row blockers in the exact employee and date maintenance workflow', () => {
    expect(payrollSource).toContain('Fix blocker')
    expect(payrollSource).toContain('Open first blocker')
    expect(payrollSource).toContain('<TimeMaintenanceWorkbench')
    expect(payrollSource).toContain('initialEmployeeId={selectedBlockerRow.employeeId}')
    expect(payrollSource).toContain('lockEmployeeFilter')
    expect(payrollSource).toContain('defaultPeriod={{ fromDate: selectedBlockerRow.operationalDate, throughDate: selectedBlockerRow.operationalDate }}')
  })

  it('keeps pending employee corrections visible and decidable from payroll', () => {
    expect(payrollSource).toContain('pendingCorrections={review.pendingCorrections}')
    expect(payrollSource).toContain('Review request')
    expect(payrollSource).toContain('reviewTimeEventCorrection')
    expect(payrollSource).toContain('Approve correction')
    expect(payrollSource).toContain('Decline')
  })

  it('refreshes payroll and related time views after decisions', () => {
    expect(payrollSource).toContain("invalidateQueries({ queryKey: ['time-payroll-review'] })")
    expect(payrollSource).toContain("invalidateQueries({ queryKey: ['time-maintenance'] })")
    expect(payrollSource).toContain("invalidateQueries({ queryKey: ['timekeeping-dashboard'] })")
  })

  it('keeps blocker actions and modals bounded on desktop and mobile', () => {
    expect(cssSource).toContain('.payroll-exception-list__item-actions')
    expect(cssSource).toContain('.payroll-blocker-modal__summary')
    expect(cssSource).toContain('.payroll-correction-modal__actions')
    expect(cssSource).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))')
  })
})
