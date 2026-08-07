export interface LicensingWorklistEmployeeLike {
  displayName: string
  employeeId: string
}

export interface LicensingWorklistRecordLike {
  employeeId: string
}

export interface LicensingWorklistGroup<
  TEmployee extends LicensingWorklistEmployeeLike,
  TRecord extends LicensingWorklistRecordLike,
> {
  employee: TEmployee
  records: TRecord[]
}

const employeeNameCollator = new Intl.Collator('en-US', {
  numeric: true,
  sensitivity: 'base',
})

export function groupLicensingRecordsByEmployee<
  TEmployee extends LicensingWorklistEmployeeLike,
  TRecord extends LicensingWorklistRecordLike,
>(
  employees: TEmployee[],
  records: TRecord[],
): Array<LicensingWorklistGroup<TEmployee, TRecord>> {
  const employeeById = new Map(employees.map((employee) => [employee.employeeId, employee]))
  const recordsByEmployee = new Map<string, TRecord[]>()

  for (const record of records) {
    if (!employeeById.has(record.employeeId)) continue
    const employeeRecords = recordsByEmployee.get(record.employeeId) ?? []
    employeeRecords.push(record)
    recordsByEmployee.set(record.employeeId, employeeRecords)
  }

  return Array.from(recordsByEmployee, ([employeeId, employeeRecords]) => ({
    employee: employeeById.get(employeeId)!,
    records: employeeRecords,
  })).sort((left, right) => (
    employeeNameCollator.compare(left.employee.displayName, right.employee.displayName)
      || left.employee.employeeId.localeCompare(right.employee.employeeId)
  ))
}

export function activeCredentialRenewalCount(
  credentials: Array<{ renewalStatus: string | null }>,
): number {
  return credentials.filter((credential) => (
    credential.renewalStatus !== null
      && credential.renewalStatus !== 'not_started'
      && credential.renewalStatus !== 'completed'
  )).length
}
