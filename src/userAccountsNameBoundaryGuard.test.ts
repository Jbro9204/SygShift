/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260826220000_user_accounts_legal_name_boundary.sql'),
  'utf8',
)
const page = readFileSync(join(process.cwd(), 'src', 'pages', 'UserAdminPage.tsx'), 'utf8')

describe('user account and payroll name boundary', () => {
  it('preserves preferred names while keeping the field out of User Accounts', () => {
    expect(page).not.toContain('<span>Preferred name</span>')
    expect(page).toContain('employee?.preferredName')
    expect(page).toContain('<h1>User Accounts</h1>')
  })

  it('replaces payroll-facing employee names with legal employee names', () => {
    expect(migration).toContain('private.legalize_timekeeping_employee_array')
    expect(migration).toContain("'employeeName'")
    expect(migration).toContain('employee.first_name')
    expect(migration).toContain('employee.middle_name')
    expect(migration).toContain('employee.last_name')
    expect(migration).toContain("'{pendingCorrections}'")
    expect(migration).toContain("'{exceptionResolutionHistory}'")
  })

  it('keeps the public payroll review boundary protected', () => {
    expect(migration).toContain('security definer')
    expect(migration).toContain('set search_path =')
    expect(migration).toContain('revoke all on function public.get_timekeeping_review(date, date) from public, anon')
    expect(migration).toContain('grant execute on function public.get_timekeeping_review(date, date) to authenticated')
  })
})
