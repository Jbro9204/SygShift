import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260818170000_payroll_batch_week_assignment.sql'),
  'utf8',
)
const payrollPage = readFileSync(join(root, 'src', 'time', 'TimePayrollPage.tsx'), 'utf8')
const workbook = readFileSync(join(root, 'src', 'time', 'payrollWorkbook.ts'), 'utf8')

describe('payroll batch assignment guard', () => {
  it('keeps one configurable Sunday midnight boundary and a separate overtime policy', () => {
    expect(migration).toContain("payroll_week_start_time time without time zone not null default time '00:00:00'")
    expect(migration).toContain("cross_boundary_grouping_policy text not null default 'scheduled_shift_start'")
    expect(migration).toContain('private.get_payroll_batch_week')
    expect(migration).toContain('private.allocate_hours_to_overtime_workweek')
    expect(migration).toContain('overtime_policy_version')
    expect(migration).not.toContain("time '06:00:00'")
  })

  it('preserves one linked occurrence and supports controlled corrections', () => {
    expect(migration).toContain("when target_shift_id is not null then 'shift:'")
    expect(migration).toContain("when manual.id is not null then 'manual:'")
    expect(migration).toContain("'unscheduled:' || target_employee_id::text")
    expect(migration).toContain("'unresolved-event:' || target_event_id::text")
    expect(migration).toContain("'payrollAssignmentAnchor', assignment_anchor")
    expect(migration).toContain('time.override_payroll_assignment')
    expect(migration).toContain('Payroll batch correction permission with MFA is required.')
    expect(migration).toContain('private.payroll_assignment_is_locked')
    expect(migration).toContain('public.payroll_batch_assignment_history')
  })

  it('requires export reconciliation and records the policy on locked reports', () => {
    expect(migration).toContain("review_payload -> ''reconciliation'' ->> ''passed''")
    expect(migration).toContain("review_payload -> ''reconciliation'' ->> ''regularPlusOvertimeMatchesPaid''")
    expect(migration).toContain('payroll_calculation_policy_version')
    expect(migration).toContain('payroll_configuration_version')
    expect(migration).toContain('cross_boundary_grouping_policy')
  })

  it('exposes assignment evidence in review and payroll exports', () => {
    expect(payrollPage).toContain('Payroll batch assignment')
    expect(payrollPage).toContain('Save audited batch correction')
    expect(workbook).toContain('Payroll Batch Week')
    expect(workbook).toContain('Assignment Source')
    expect(workbook).toContain('Crosses Payroll Boundary')
    expect(workbook).toContain('Manual Adjustment')
  })
})
