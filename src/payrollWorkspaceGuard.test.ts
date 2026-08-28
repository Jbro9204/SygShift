/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const navigation = readFileSync(join(root, 'src', 'app', 'navigation.ts'), 'utf8')
const router = readFileSync(join(root, 'src', 'app', 'router.tsx'), 'utf8')
const accessPolicy = readFileSync(join(root, 'src', 'app', 'accessPolicy.ts'), 'utf8')
const payrollPage = readFileSync(join(root, 'src', 'time', 'TimePayrollPage.tsx'), 'utf8')
const teamPage = readFileSync(join(root, 'src', 'time', 'TimeTeamAttendancePage.tsx'), 'utf8')
const reviewPage = readFileSync(join(root, 'src', 'time', 'TimeExceptionsPage.tsx'), 'utf8')

describe('HR and Finance payroll workspace guardrails', () => {
  it('keeps Payroll in a dedicated HR and Finance navigation group', () => {
    expect(navigation).toContain("label: 'HR & Finance'")
    expect(navigation).toContain("label: 'Payroll'")
    expect(navigation).toContain("path: '/payroll'")
  })

  it('keeps focused payroll routes and their permission policies registered', () => {
    for (const route of ['payroll', 'payroll/review', 'payroll/employees', 'payroll/export', 'payroll/rules']) {
      expect(router).toContain(`path: '${route}'`)
      expect(accessPolicy).toContain(`'/${route}'`)
    }
  })

  it('keeps payroll rules hidden and unfetched for non-administrators', () => {
    expect(payrollPage).toContain("const rulesAllowed = sessionQuery.data?.role === 'admin'")
    expect(payrollPage).toContain("showRules={rulesAllowed}")
    expect(payrollPage).toContain("activeSection === 'rules' ? rulesAllowed : reviewAllowed")
    expect(payrollPage).toContain('Only administrators can view company-wide payroll configuration.')
  })

  it('limits overview work and paginates detailed employee and review lists', () => {
    expect(payrollPage).toContain('review.pendingCorrections.slice(0, 5)')
    expect(payrollPage).toContain('5 - review.pendingCorrections.length')
    expect(payrollPage.match(/const \[pageSize, setPageSize\] = useState\(10\)/g)).toHaveLength(2)
    expect(payrollPage).toContain('<option value={25}>25</option>')
    expect(payrollPage).toContain('<option value={50}>50</option>')
  })

  it('keeps Time and Attendance lists compact by default', () => {
    expect(teamPage).toContain('const [pageSize, setPageSize] = useState(10)')
    expect(reviewPage).toContain('const [pageSize, setPageSize] = useState(10)')
    expect(teamPage).toContain('visibleRows = filteredRows.slice')
    expect(reviewPage).toContain('visibleExceptionRows = exceptionRows.slice')
  })
})
