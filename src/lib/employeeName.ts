export interface EmployeeNameParts {
  firstName: string
  lastName: string
  preferredName?: string | null
}

function cleanNamePart(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

export function employeeScheduleGivenName(employee: EmployeeNameParts): string {
  const firstName = cleanNamePart(employee.firstName)
  const preferredName = cleanNamePart(employee.preferredName)

  if (!preferredName) return firstName
  if (preferredName.length === 1 && firstName.length > 1) {
    return `${firstName} (${preferredName})`
  }
  return preferredName
}

export function employeeScheduleDisplayName(employee: EmployeeNameParts): string {
  return [employeeScheduleGivenName(employee), cleanNamePart(employee.lastName)]
    .filter(Boolean)
    .join(' ')
}
