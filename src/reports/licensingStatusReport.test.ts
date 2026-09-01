import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { LicensingCredential, LicensingEmployee } from '../data/licensing'
import { createXlsxWorkbookBlob } from '../lib/xlsxWorkbook'
import {
  filterLicensingReportEmployees,
  guardLicenseStatus,
  legalLicensingEmployeeName,
  summarizeLicensingReport,
  type GuardLicenseStatus,
} from './licensingStatusReport'
import { buildLicensingStatusWorkbookSheets, licensingStatusReportFileName } from './licensingStatusWorkbook'

function credential(status: GuardLicenseStatus): LicensingCredential {
  const variants: Record<GuardLicenseStatus, Partial<LicensingCredential>> = {
    current: { credentialId: '10000000-0000-4000-8000-000000000001', daysRemaining: 180, status: 'Verified', statusLabel: 'Compliant' },
    expired: { credentialId: '10000000-0000-4000-8000-000000000001', daysRemaining: -2, status: 'Expired', statusLabel: 'Expired' },
    expiring: { credentialId: '10000000-0000-4000-8000-000000000001', daysRemaining: 24, status: 'Renewal Needed', statusLabel: 'Expires in 24 Days' },
    not_licensed: { credentialId: null, daysRemaining: null, status: 'Missing', statusLabel: 'Missing Required Credential' },
    pending: { credentialId: '10000000-0000-4000-8000-000000000001', daysRemaining: 200, status: 'Under Review', statusLabel: 'Awaiting Review' },
    restricted: { credentialId: '10000000-0000-4000-8000-000000000001', daysRemaining: 200, status: 'Revoked', statusLabel: 'Revoked' },
  }
  return {
    affectsWorkEligibility: true,
    category: 'license',
    complianceColor: status === 'current' ? 'green' : status === 'expiring' || status === 'pending' ? 'yellow' : 'red',
    credentialId: null,
    credentialName: 'Denver Security Guard License',
    credentialNumber: status === 'not_licensed' ? null : `DEN-${status}`,
    credentialTypeCode: 'denver_security_guard_license',
    credentialTypeId: '20000000-0000-4000-8000-000000000001',
    daysRemaining: null,
    documentCount: status === 'not_licensed' ? 0 : 1,
    employeeNotes: 'Excluded employee note',
    expirationDate: status === 'expired' ? '2026-08-30' : '2027-03-01',
    internalNotes: 'Excluded internal note',
    issueDate: '2026-03-01',
    issuingAuthority: 'City and County of Denver',
    lastEmployeeNotification: null,
    latestDocumentAt: null,
    rejectionReason: null,
    renewalStatus: 'not_started',
    required: true,
    status: 'Missing',
    statusLabel: 'Missing Required Credential',
    ...variants[status],
  }
}

function employee(name: string, status: GuardLicenseStatus, role: LicensingEmployee['role'] = 'guard'): LicensingEmployee {
  const [firstName, lastName] = name.split(' ')
  return {
    affectedFutureShiftCount: 0,
    closestExpirationDate: status === 'not_licensed' ? null : '2027-03-01',
    companyEmail: 'excluded@company.example',
    credentials: [credential(status)],
    displayName: `Preferred ${lastName}`,
    employeeId: `30000000-0000-4000-8000-${String(name.length).padStart(12, '0')}`,
    employeeNumber: `SYG-${name.length}`,
    employmentStatus: 'active',
    employmentType: 'hourly',
    firstName,
    hiredOn: '2026-01-01',
    jobTitle: 'Security Officer',
    lastEmployeeNotification: null,
    lastName,
    middleName: null,
    missingCredentialCount: status === 'not_licensed' ? 1 : 0,
    mobilePhone: '555-0100',
    overallCompliance: status === 'current' ? 'green' : status === 'expiring' || status === 'pending' ? 'yellow' : 'red',
    personalEmail: 'excluded@personal.example',
    preferredName: 'Preferred',
    primaryLocation: 'Denver',
    requiredCredentialCount: 1,
    role,
    username: firstName.toLocaleLowerCase(),
    verifiedCredentialCount: status === 'current' ? 1 : 0,
    workEligibility: status === 'current' ? 'eligible' : 'ineligible',
  }
}

describe('Licensing Status report', () => {
  const employees = [
    employee('Current Guard', 'current'),
    employee('Expiring Guard', 'expiring'),
    employee('Expired Guard', 'expired'),
    employee('Missing Guard', 'not_licensed'),
    employee('Pending Guard', 'pending'),
    employee('Restricted Guard', 'restricted'),
    employee('Office Admin', 'not_licensed', 'admin'),
  ]

  it('classifies every guard license state and uses legal names', () => {
    expect(employees.slice(0, 6).map(guardLicenseStatus)).toEqual(['current', 'expiring', 'expired', 'not_licensed', 'pending', 'restricted'])
    expect(legalLicensingEmployeeName(employees[0])).toBe('Current Guard')
  })

  it('defaults to active guards and filters by licensing status without long lists', () => {
    const filtered = filterLicensingReportEmployees(employees, {
      credentialTypeId: 'all', employeeScope: 'guards', employmentStatus: 'active', licenseStatus: 'expired', search: '',
    })
    expect(filtered.map(legalLicensingEmployeeName)).toEqual(['Expired Guard'])
    expect(summarizeLicensingReport(employees.slice(0, 6))).toEqual({ current: 1, expired: 1, expiring: 1, notLicensed: 1, pending: 1, restricted: 1, total: 6 })
  })

  it('builds a two-sheet workbook without emails or private notes', async () => {
    const sheets = buildLicensingStatusWorkbookSheets({
      credentialTypes: [],
      employees: employees.slice(0, 6),
      filters: { credentialTypeId: 'all', employeeScope: 'guards', employmentStatus: 'active', licenseStatus: 'all', search: '' },
      generatedAt: '2026-09-01T18:00:00.000Z',
    })
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Guard Status', 'Credential Detail'])
    const archive = unzipSync(new Uint8Array(await createXlsxWorkbookBlob(sheets).arrayBuffer()))
    const workbook = strFromU8(archive['xl/workbook.xml'])
    const worksheetText = [strFromU8(archive['xl/worksheets/sheet1.xml']), strFromU8(archive['xl/worksheets/sheet2.xml'])].join(' ')
    expect(workbook).toContain('Guard Status')
    expect(workbook).toContain('Credential Detail')
    expect(worksheetText).toContain('Current Guard')
    expect(worksheetText).toContain('Not Licensed')
    expect(worksheetText).not.toContain('excluded@')
    expect(worksheetText).not.toContain('Excluded internal note')
    expect(worksheetText).not.toContain('Excluded employee note')
    expect(licensingStatusReportFileName('2026-09-01T18:00:00.000Z')).toBe('sygshift-licensing-status-2026-09-01.xlsx')
    expect(strFromU8(archive['xl/worksheets/sheet1.xml'])).toContain('r="A14" t="inlineStr" s="6"><is><t>Expiring Guard</t>')
    expect(strFromU8(archive['xl/worksheets/sheet1.xml'])).toContain('r="G14" t="inlineStr" s="9"><is><t>Expiring Soon</t>')
  })
})
