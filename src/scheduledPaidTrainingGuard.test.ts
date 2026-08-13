import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(process.cwd())

function source(file: string) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

describe('scheduled paid training guardrails', () => {
  it('keeps training selection in scheduling and removes global payroll configuration', () => {
    const schedulePage = source('src/pages/SchedulePage.tsx')
    const payrollPage = source('src/time/TimePayrollPage.tsx')

    expect(schedulePage).toContain('Paid training time')
    expect(schedulePage).toContain("event.target.checked ? 'training' : 'post'")
    expect(payrollPage).not.toContain('confirmWorkTypeConfiguration')
    expect(payrollPage).not.toContain('Post Time pay code')
    expect(payrollPage).not.toContain('Training Time pay code')
  })

  it('keeps ordinary worked time out of payroll export categories', () => {
    const workbook = source('src/time/payrollWorkbook.ts')

    expect(workbook).not.toContain("'Post Hours'")
    expect(workbook).not.toContain("'Pay Code'")
    expect(workbook).toContain("row.workType === 'training' ? 'Paid training' : 'Worked time'")
  })

  it('uses a forward-only migration and removes authenticated global confirmation', () => {
    const migration = source('supabase/migrations/20260813120000_scheduled_paid_training.sql')

    expect(migration).toContain("when 'post' then 'Worked Time'")
    expect(migration).toContain("when 'training' then 'Paid Training'")
    expect(migration).toContain('revoke execute on function public.get_work_type_configuration() from authenticated')
    expect(migration).toContain('revoke execute on function public.confirm_work_type_configuration(text, text) from authenticated')
    expect(migration).toContain('paid training requires an explicitly marked schedule block')
  })
})
