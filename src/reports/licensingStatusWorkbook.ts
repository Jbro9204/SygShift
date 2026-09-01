import type { CredentialType, LicensingEmployee } from '../data/licensing'
import { downloadXlsxWorkbook, type XlsxSheet } from '../lib/xlsxWorkbook'
import {
  armedLicenseCredential,
  formatLicensingDate,
  formatLicensingEmploymentStatus,
  formatLicensingRole,
  formatWorkEligibility,
  guardLicenseCredential,
  guardLicenseStatus,
  guardLicenseStatusLabels,
  legalLicensingEmployeeName,
  summarizeLicensingReport,
  type LicensingReportFilters,
} from './licensingStatusReport'

export interface LicensingStatusWorkbookInput {
  credentialTypes: CredentialType[]
  employees: LicensingEmployee[]
  filters: LicensingReportFilters
  generatedAt: string
}

function generatedAtText(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    month: '2-digit',
    timeZone: 'America/Denver',
    timeZoneName: 'short',
    year: 'numeric',
  }).format(date)
}

function filterDescription(input: LicensingStatusWorkbookInput): string {
  const credential = input.credentialTypes.find((type) => type.id === input.filters.credentialTypeId)
  const values = [
    input.filters.employeeScope === 'guards' ? 'Guards only' : 'All employees',
    input.filters.employmentStatus === 'all' ? 'All employment statuses' : `Employment: ${input.filters.employmentStatus}`,
    input.filters.licenseStatus === 'all' ? 'All license statuses' : `License: ${guardLicenseStatusLabels[input.filters.licenseStatus]}`,
    credential ? `Credential: ${credential.name}` : 'All credential types',
    input.filters.search.trim() ? `Search: ${input.filters.search.trim()}` : '',
  ].filter(Boolean)
  return values.join(' | ')
}

export function buildLicensingStatusWorkbookSheets(input: LicensingStatusWorkbookInput): XlsxSheet[] {
  const summary = summarizeLicensingReport(input.employees)
  const guardHeader = [
    'Legal Employee Name', 'Employee ID', 'Employment Status', 'Role', 'Job Title', 'Primary Location',
    'Guard License Status', 'License Number', 'Issue Date', 'Expiration Date', 'Days Remaining',
    'Armed Credential Status', 'Work Eligibility', 'Required Credentials', 'Verified Credentials',
    'Missing Credentials', 'Documents on File', 'Renewal Status',
  ]
  const guardRows = input.employees.map((employee) => {
    const guardCredential = guardLicenseCredential(employee)
    const armedCredential = armedLicenseCredential(employee)
    return [
      legalLicensingEmployeeName(employee),
      employee.employeeNumber ?? 'Not recorded',
      formatLicensingEmploymentStatus(employee.employmentStatus),
      formatLicensingRole(employee.role),
      employee.jobTitle ?? 'Not recorded',
      employee.primaryLocation ?? 'Not recorded',
      guardLicenseStatusLabels[guardLicenseStatus(employee)],
      guardCredential?.credentialNumber ?? 'Not recorded',
      formatLicensingDate(guardCredential?.issueDate),
      formatLicensingDate(guardCredential?.expirationDate),
      guardCredential?.daysRemaining ?? null,
      armedCredential?.credentialId ? armedCredential.statusLabel : 'Not on file',
      formatWorkEligibility(employee.workEligibility),
      employee.requiredCredentialCount,
      employee.verifiedCredentialCount,
      employee.missingCredentialCount,
      employee.credentials.reduce((total, credential) => total + credential.documentCount, 0),
      guardCredential?.renewalStatus ? guardCredential.renewalStatus.replaceAll('_', ' ') : 'Not started',
    ]
  })
  const guardSheetRows = [
    ['SygShift Licensing Status Report'],
    ['Generated as of', generatedAtText(input.generatedAt)],
    ['Report scope', filterDescription(input)],
    ['Employees in report', summary.total],
    ['Current', summary.current],
    ['Expiring soon', summary.expiring],
    ['Expired', summary.expired],
    ['Not licensed', summary.notLicensed],
    ['Pending review', summary.pending],
    ['Restricted', summary.restricted],
    [],
    guardHeader,
    ...guardRows,
  ]

  const credentialHeader = [
    'Legal Employee Name', 'Employee ID', 'Employment Status', 'Role', 'Credential Type', 'Required',
    'Status', 'Credential Number', 'Issuing Authority', 'Issue Date', 'Expiration Date', 'Days Remaining',
    'Renewal Status', 'Documents on File', 'Latest Document', 'Affects Work Eligibility',
  ]
  const credentialRows = input.employees.flatMap((employee) => employee.credentials
    .filter((credential) => input.filters.credentialTypeId === 'all' || credential.credentialTypeId === input.filters.credentialTypeId)
    .map((credential) => [
      legalLicensingEmployeeName(employee),
      employee.employeeNumber ?? 'Not recorded',
      formatLicensingEmploymentStatus(employee.employmentStatus),
      formatLicensingRole(employee.role),
      credential.credentialName,
      credential.required ? 'Yes' : 'No',
      credential.credentialId ? credential.statusLabel : (credential.required ? 'Missing Required Credential' : 'Not on file'),
      credential.credentialNumber ?? 'Not recorded',
      credential.issuingAuthority ?? 'Not recorded',
      formatLicensingDate(credential.issueDate),
      formatLicensingDate(credential.expirationDate),
      credential.daysRemaining ?? null,
      credential.renewalStatus ? credential.renewalStatus.replaceAll('_', ' ') : 'Not started',
      credential.documentCount,
      credential.latestDocumentAt ? generatedAtText(credential.latestDocumentAt) : 'Not recorded',
      credential.affectsWorkEligibility ? 'Yes' : 'No',
    ]))
  const credentialSheetRows = [
    ['SygShift Credential Detail'],
    ['Generated as of', generatedAtText(input.generatedAt)],
    ['Report scope', filterDescription(input)],
    ['Credential records', credentialRows.length],
    [],
    credentialHeader,
    ...credentialRows,
  ]

  return [
    {
      centerColumns: [2, 3, 6, 10, 11, 12, 13, 14, 15, 16, 17],
      columnWidths: [28, 14, 17, 20, 24, 22, 19, 20, 14, 15, 15, 22, 20, 16, 16, 16, 16, 18],
      filterRowIndex: 11,
      freezeRows: 12,
      headerRows: [11],
      integerColumns: [10, 13, 14, 15, 16],
      metadataRows: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      mergedCells: ['A1:R1'],
      name: 'Guard Status',
      rows: guardSheetRows,
      statusColumns: [6, 12],
      titleRows: [0],
      wrapColumns: [4, 5, 11, 12, 17],
    },
    {
      centerColumns: [2, 3, 5, 6, 11, 12, 13, 15],
      columnWidths: [28, 14, 17, 20, 30, 12, 24, 20, 28, 14, 15, 15, 20, 16, 22, 18],
      filterRowIndex: 5,
      freezeRows: 6,
      headerRows: [5],
      integerColumns: [11, 13],
      metadataRows: [1, 2, 3],
      mergedCells: ['A1:P1'],
      name: 'Credential Detail',
      rows: credentialSheetRows,
      statusColumns: [6],
      titleRows: [0],
      wrapColumns: [4, 6, 8, 12, 14],
    },
  ]
}

export function licensingStatusReportFileName(generatedAt: string): string {
  const date = generatedAt.slice(0, 10) || new Date().toISOString().slice(0, 10)
  return `sygshift-licensing-status-${date}.xlsx`
}

export function downloadLicensingStatusWorkbook(input: LicensingStatusWorkbookInput): { fileName: string; size: number } {
  const fileName = licensingStatusReportFileName(input.generatedAt)
  return downloadXlsxWorkbook(buildLicensingStatusWorkbookSheets(input), fileName)
}
