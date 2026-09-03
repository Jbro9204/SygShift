/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260903012122_time_self_service_pay_period_context.sql'),
  'utf8',
)

describe('time self-service payroll-period access repair', () => {
  it('exposes only a bounded payroll-period context to active employees', () => {
    expect(migration).toContain('create or replace function public.get_payroll_period_context()')
    expect(migration).toContain('actor_id uuid := private.current_employee_id()')
    expect(migration).toContain("'fromDate', period ->> 'periodStartsOn'")
    expect(migration).toContain("'throughDate', period ->> 'periodEndsOn'")
    expect(migration).toContain('grant execute on function public.get_payroll_period_context() to authenticated')
    expect(migration).not.toContain("'dailyOvertimeMinutes'")
    expect(migration).not.toContain("'weeklyOvertimeMinutes'")
    expect(migration).not.toContain("'salaryWeeklyDefaultMinutes'")
  })

  it('does not weaken the existing privileged payroll-rules function', () => {
    expect(migration).not.toContain('create or replace function public.get_payroll_rules()')
    expect(migration).not.toContain('alter function public.get_payroll_rules')
  })
})
