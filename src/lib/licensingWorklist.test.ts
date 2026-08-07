import { describe, expect, it } from 'vitest'
import { activeCredentialRenewalCount, groupLicensingRecordsByEmployee } from './licensingWorklist'

describe('licensing worklist grouping', () => {
  it('shows each employee once while preserving every matching credential record', () => {
    const employees = [
      { displayName: 'Randy Hurst', employeeId: 'employee-randy' },
      { displayName: 'Jade Baptist', employeeId: 'employee-jade' },
    ]
    const records = [
      { credential: 'Armed endorsement', employeeId: 'employee-randy' },
      { credential: 'Standard guard license', employeeId: 'employee-randy' },
      { credential: 'Driver license', employeeId: 'employee-randy' },
      { credential: 'Standard guard license', employeeId: 'employee-jade' },
    ]

    const groups = groupLicensingRecordsByEmployee(employees, records)

    expect(groups.map((group) => group.employee.displayName)).toEqual(['Jade Baptist', 'Randy Hurst'])
    expect(groups.find((group) => group.employee.employeeId === 'employee-randy')?.records).toHaveLength(3)
  })

  it('counts only active renewal workflows', () => {
    expect(activeCredentialRenewalCount([
      { renewalStatus: 'not_started' },
      { renewalStatus: 'started' },
      { renewalStatus: 'awaiting_issuing_authority' },
      { renewalStatus: 'completed' },
      { renewalStatus: null },
    ])).toBe(2)
  })
})
