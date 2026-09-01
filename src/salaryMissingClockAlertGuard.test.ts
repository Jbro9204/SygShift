/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260901170000_salary_missing_clock_alert_exclusion.sql'),
  'utf8',
)

describe('salaried missing-clock alert exclusion', () => {
  it('blocks salaried missing-clock records at both authoritative database boundaries', () => {
    expect(migration).toContain('prevent_salaried_missing_clock_in_exception')
    expect(migration).toContain('prevent_salaried_missing_clock_in_alert')
    expect(migration).toContain("employee.employment_type = 'salary'::public.employment_type")
    expect(migration).toContain("new.exception_code = 'missing_clock_in'")
    expect(migration).toContain("new.alert_type = 'missing_clock_in'")
  })

  it('resolves existing and reclassified salaried records with an audit reason', () => {
    expect(migration).toContain('private.resolve_salaried_missing_clock_in_records')
    expect(migration).toContain("resolution_method = 'employment_exempt'")
    expect(migration).toContain("'resolved_employment_exempt'")
    expect(migration).toContain('after update of employment_type on public.employees')
    expect(migration).toContain("lifecycle_state = 'resolved'")
    expect(migration).toContain("clear_source = 'automatic_resolution'")
  })

  it('preserves source schedules, punches, payroll, employees, and audit history', () => {
    expect(migration).not.toMatch(/delete\s+from\s+public\./i)
    expect(migration).not.toMatch(/update\s+public\.(time_events|shifts|schedules|employees|payroll)/i)
    expect(migration).toContain('insert into public.timekeeping_operational_exception_actions')
  })
})
