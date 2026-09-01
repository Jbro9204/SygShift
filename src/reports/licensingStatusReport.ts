import type { LicensingCredential, LicensingEmployee } from '../data/licensing'

export const STANDARD_GUARD_LICENSE_CODE = 'denver_security_guard_license'
export const ARMED_GUARD_LICENSE_CODE = 'armed_security_guard_credential'

export type GuardLicenseStatus = 'current' | 'expiring' | 'expired' | 'not_licensed' | 'pending' | 'restricted'
export type LicensingEmployeeScope = 'guards' | 'all'
export type LicensingEmploymentScope = LicensingEmployee['employmentStatus'] | 'all'

export interface LicensingReportFilters {
  credentialTypeId: string
  employeeScope: LicensingEmployeeScope
  employmentStatus: LicensingEmploymentScope
  licenseStatus: GuardLicenseStatus | 'all'
  search: string
}

export interface LicensingReportSummary {
  current: number
  expired: number
  expiring: number
  notLicensed: number
  pending: number
  restricted: number
  total: number
}

export const guardLicenseStatusLabels: Record<GuardLicenseStatus, string> = {
  current: 'Current',
  expired: 'Expired',
  expiring: 'Expiring Soon',
  not_licensed: 'Not Licensed',
  pending: 'Pending Review',
  restricted: 'Restricted',
}

export function legalLicensingEmployeeName(employee: LicensingEmployee): string {
  return [employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(' ')
}

export function guardLicenseCredential(employee: LicensingEmployee): LicensingCredential | null {
  return employee.credentials.find((credential) => credential.credentialTypeCode === STANDARD_GUARD_LICENSE_CODE) ?? null
}

export function armedLicenseCredential(employee: LicensingEmployee): LicensingCredential | null {
  return employee.credentials.find((credential) => credential.credentialTypeCode === ARMED_GUARD_LICENSE_CODE) ?? null
}

function normalized(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase()
}

export function guardLicenseStatus(employee: LicensingEmployee): GuardLicenseStatus {
  const credential = guardLicenseCredential(employee)
  if (!credential?.credentialId) return 'not_licensed'

  const status = normalized(credential.status)
  const statusLabel = normalized(credential.statusLabel)
  if (status === 'revoked' || status === 'suspended' || status === 'rejected' || statusLabel === 'revoked' || statusLabel === 'suspended' || statusLabel === 'rejected') return 'restricted'
  if (status === 'expired' || statusLabel === 'expired' || (credential.daysRemaining !== null && credential.daysRemaining < 0)) return 'expired'
  if (status.includes('review') || status === 'pending' || statusLabel.includes('awaiting review')) return 'pending'
  if ((credential.daysRemaining !== null && credential.daysRemaining >= 0 && credential.daysRemaining <= 90)
    || status === 'expiring'
    || status === 'renewal needed'
    || statusLabel.includes('warning')
    || statusLabel.startsWith('expires in')) return 'expiring'
  return 'current'
}

export function filterLicensingReportEmployees(
  employees: LicensingEmployee[],
  filters: LicensingReportFilters,
): LicensingEmployee[] {
  const search = normalized(filters.search)
  const statusPriority: Record<GuardLicenseStatus, number> = {
    expired: 0,
    not_licensed: 1,
    restricted: 2,
    pending: 3,
    expiring: 4,
    current: 5,
  }

  return employees.filter((employee) => {
    const licenseStatus = guardLicenseStatus(employee)
    const searchable = [
      legalLicensingEmployeeName(employee),
      employee.employeeNumber,
      employee.username,
      employee.jobTitle,
      employee.primaryLocation,
      ...employee.credentials.flatMap((credential) => [
        credential.credentialName,
        credential.credentialNumber,
        credential.issuingAuthority,
        credential.status,
        credential.statusLabel,
      ]),
    ].map(normalized).join(' ')

    return (filters.employeeScope === 'all' || employee.role === 'guard')
      && (filters.employmentStatus === 'all' || employee.employmentStatus === filters.employmentStatus)
      && (filters.licenseStatus === 'all' || licenseStatus === filters.licenseStatus)
      && (filters.credentialTypeId === 'all' || employee.credentials.some((credential) => credential.credentialTypeId === filters.credentialTypeId))
      && (!search || searchable.includes(search))
  }).sort((left, right) => {
    const statusDifference = statusPriority[guardLicenseStatus(left)] - statusPriority[guardLicenseStatus(right)]
    return statusDifference || legalLicensingEmployeeName(left).localeCompare(legalLicensingEmployeeName(right), 'en-US', { sensitivity: 'base' })
  })
}

export function summarizeLicensingReport(employees: LicensingEmployee[]): LicensingReportSummary {
  const summary: LicensingReportSummary = {
    current: 0,
    expired: 0,
    expiring: 0,
    notLicensed: 0,
    pending: 0,
    restricted: 0,
    total: employees.length,
  }
  for (const employee of employees) {
    const status = guardLicenseStatus(employee)
    if (status === 'not_licensed') summary.notLicensed += 1
    else summary[status] += 1
  }
  return summary
}

export function formatLicensingDate(value: string | null | undefined): string {
  if (!value) return 'Not recorded'
  const [year, month, day] = value.slice(0, 10).split('-')
  return year && month && day ? `${month}/${day}/${year}` : value
}

export function formatLicensingRole(value: LicensingEmployee['role']): string {
  const labels: Record<LicensingEmployee['role'], string> = {
    admin: 'Admin',
    dispatcher: 'Dispatcher',
    guard: 'Guard',
    recruiting_licensing: 'Recruiting & Licensing',
    scheduler: 'Scheduler',
    supervisor: 'Supervisor',
  }
  return labels[value]
}

export function formatLicensingEmploymentStatus(value: LicensingEmployee['employmentStatus']): string {
  const labels: Record<LicensingEmployee['employmentStatus'], string> = {
    active: 'Active',
    inactive: 'Inactive',
    leave: 'On Leave',
    onboarding: 'Onboarding',
    separated: 'Separated',
  }
  return labels[value]
}

export function formatWorkEligibility(value: LicensingEmployee['workEligibility']): string {
  return value.split('_').map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1)).join(' ')
}
