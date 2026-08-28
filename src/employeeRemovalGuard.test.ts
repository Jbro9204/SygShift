import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const adminData = readFileSync(join(root, 'src', 'data', 'adminUsers.ts'), 'utf8')
const licensingData = readFileSync(join(root, 'src', 'data', 'licensing.ts'), 'utf8')
const licensingPage = readFileSync(join(root, 'src', 'pages', 'LicensingCenterPage.tsx'), 'utf8')
const adminPage = readFileSync(join(root, 'src', 'pages', 'UserAdminPage.tsx'), 'utf8')
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260803173000_controlled_employee_removal.sql'),
  'utf8',
)

describe('controlled employee removal', () => {
  it('preserves operational history while removing separated employees from working lists', () => {
    expect(migration).toContain('create table if not exists private.removed_employee_records')
    expect(migration).toContain("employee_record ->> 'status' <> 'separated'")
    expect(migration).toContain('You cannot remove your own employee record.')
    expect(migration).toContain('confirmation_username')
    expect(migration).toContain('where not exists (')
    expect(migration).not.toContain('delete from public.shift_assignments')
    expect(migration).not.toContain('delete from public.time_events')
  })

  it('requires an explicit UI confirmation and explains retained history', () => {
    expect(adminData).toContain("rpc('get_employee_removal_preview'")
    expect(adminData).toContain("rpc('admin_remove_separated_employee'")
    expect(adminPage).toContain(`Type <strong>{employee.username}</strong> to confirm`)
    expect(adminPage).toContain('Historical payroll and audit records will be retained.')
    expect(adminPage).toContain('Review removal')
  })

  it('targets only the approved test records in the one-time cleanup', () => {
    expect(migration).toContain("lower(btrim(employee.first_name)) = 'patrol'")
    expect(migration).toContain("lower(btrim(employee.first_name)) = 'test'")
    expect(migration).not.toContain("lower(btrim(employee.first_name)) = 'lucius'")
  })

  it('keeps separated employees out of the active licensing workload while preserving intentional historical access', () => {
    expect(licensingData).toContain("workingEmployees = employees.filter((employee) => employee.employmentStatus === 'active')")
    expect(licensingData).toContain('retainedEmployeeIds.has(record.employeeId)')
    expect(licensingPage).toContain("useState<'all' | LicensingEmployee['employmentStatus']>('active')")
    expect(licensingPage).toContain('<option value="separated">Separated</option>')
  })
})
