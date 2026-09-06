import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, 'utf8')
describe('Attendance, Dispatch, and employee-history boundaries', () => {
  it('keeps report and classification access permission-based with MFA and audit trails', () => {
    const sql = migration('20260906162426_attendance_reporting_and_classification')
    expect(sql).toContain("has_effective_permission('time.reports.view')")
    expect(sql).toContain("has_effective_permission('reports.export')")
    expect(sql).toContain("has_effective_permission('accountability.manage')")
    expect(sql).toContain('not public.has_mfa()')
    expect(sql).toContain('private.audit_events')
    expect(sql).not.toContain('update public.time_events')
    expect(sql).not.toContain("set review_outcome")
    expect(sql).toContain("upper(btrim(e.note)) in ('CALL OFF','CALL OFF ON 8/31')")
  })
  it('matches schedule revisions for duplicate prevention and missed-punch monitoring, not auto-close', () => {
    const sql = migration('20260906162428_historical_standalone_dispatch_timekeeping')
    expect(sql).toContain('private.same_scheduled_occurrence(existing.shift_id, new.shift_id)')
    expect(sql).toContain('private.same_scheduled_occurrence(event.shift_id, shift.id)')
    expect(sql).toContain('private.same_scheduled_occurrence(event.shift_id, exception.shift_id)')
    expect(sql).toContain("new.kind <> 'clock_in'")
    expect(sql).toContain('and not effective.voided')
    expect(sql).toContain('a.starts_at = b.starts_at and a.ends_at = b.ends_at')
    expect(sql).not.toContain('update public.time_events')
    expect(sql).not.toContain('delete from')
  })
  it('resolves three authoritative periods without exposing full rules or modifying payroll', () => {
    const sql = migration('20260906162427_employee_recent_pay_periods')
    expect(sql).toContain('for period_index in 0..2 loop')
    expect(sql).toContain('private.get_payroll_period_for_week')
    expect(sql).toContain("'availablePeriods', available_periods")
    expect(sql).not.toContain('public.get_payroll_rules(')
    expect(sql).not.toContain('update private.payroll_rules')
  })
})
