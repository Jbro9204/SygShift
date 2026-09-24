import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import type { UserAccountActivityReport, UserAccountActivityRow } from '../data/userAccountActivityReport'
import type { PatrolReport } from '../data/patrol'
import type { ShortNoticeCallOutReport, ShortNoticeCallOutRow } from '../data/shortNoticeCallOutReport'
import { patrolReportPdf } from './patrolReportExport'
import { shortNoticeCallOutPdf } from './shortNoticeCallOutReport'
import { userAccountActivityPdf } from './userAccountActivityReport'

async function textByPage(bytes: Uint8Array): Promise<string[][]> {
  const loadingTask = getDocument({ data: bytes.slice(), disableFontFace: true })
  const document = await loadingTask.promise
  const result: string[][] = []
  for (let index = 1; index <= document.numPages; index += 1) {
    const content = await (await document.getPage(index)).getTextContent()
    result.push(content.items.flatMap((item) => 'str' in item ? [item.str] : []))
  }
  await loadingTask.destroy()
  return result
}

async function fontResourcesPerPage(bytes: Uint8Array): Promise<number[]> {
  const document = await PDFDocument.load(bytes)
  return document.getPages().map((page) => page.node.normalizedEntries().Font.keys().length)
}

function accountRow(index: number): UserAccountActivityRow {
  return {
    employeeId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    employeeNumber: `SYG-${String(1000 + index)}`,
    employeeName: `Employee ${String(index).padStart(2, '0')} With A Long Name`,
    username: `employee${index}`,
    companyEmail: `employee${index}@example.com`,
    employmentStatus: 'active',
    employmentType: 'hourly',
    jobTitle: 'Security Officer',
    primaryRole: 'guard',
    accessRoles: ['Guard'],
    accountState: 'active',
    loginState: 'recent',
    invitedAt: '2026-09-01T12:00:00Z',
    activatedAt: '2026-09-01T12:05:00Z',
    passwordChangedAt: '2026-09-01T12:10:00Z',
    firstCompletedSignInAt: '2026-09-01T12:15:00Z',
    lastCompletedSignInAt: '2026-09-24T14:15:00Z',
    completedSignInCount: index,
    completedSources: ['native'],
    requiresMfa: true,
    mfaEnrolled: true,
    mfaEnrolledAt: '2026-09-01T12:20:00Z',
    activeSessionCount: index % 4,
    trustedDeviceCount: index % 3,
    securityException: 'none',
    nextAction: 'No action required',
  }
}

function accountReport(count: number): UserAccountActivityReport {
  return {
    serverTimestamp: '2026-09-24T16:00:00Z', staleDays: 30, pageSize: 5000, offset: 0, totalCount: count,
    summary: { total: count, activeAccounts: count, neverSignedIn: 0, pendingSetup: 0, mfaAttention: 0, disabled: 0, securityExceptions: 0 },
    rows: Array.from({ length: count }, (_, index) => accountRow(index + 1)),
  }
}

function shortNoticeRow(index: number): ShortNoticeCallOutRow {
  return {
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    employeeId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    employeeName: `Employee ${index}`, employeeNumber: `SYG-${1000 + index}`, jobTitle: 'Security Officer', employmentType: 'hourly',
    operationalDate: '2026-09-24', scheduledStartAt: '2026-09-24T14:00:00Z', scheduledEndAt: '2026-09-24T22:00:00Z',
    timeZone: 'America/Denver', callReceivedAt: '2026-09-24T12:30:00Z', noticeMinutes: 90, noticeBucket: '1_to_2_hours',
    occurrenceType: 'call_off', reason: 'Unexpected family emergency requiring immediate attention', operationalDetails: 'Dispatch recorded the call.',
    replacementNeeded: true, recordStatus: 'recorded', canceledAt: null, reviewOutcome: 'pending_hr_review', reviewedAt: null,
    reviewedByName: null, decisionNote: null, clientName: 'Example Client', siteName: 'Main Campus', siteCode: 'MAIN', postName: 'Front Desk',
    eventName: null, locationName: 'Main Campus', submissionSource: 'management_entry', receivedByName: 'Dispatcher', reportedByName: `Employee ${index}`,
    coverageStatus: 'pending', replacementEmployeeName: null, overtimeCreated: false, attendanceEventId: null,
    actionPath: `/requests?callOff=${index}`,
  }
}

const shortNoticeReport: ShortNoticeCallOutReport = {
  serverTimestamp: '2026-09-24T16:00:00Z', fromDate: '2026-09-01', throughDate: '2026-09-24', noticeThresholdMinutes: 240,
  countingRule: 'Call received less than four hours before scheduled start. Exactly four hours is compliant.',
  summary: { shortNoticeCount: 20, afterStartCount: 0, noShowCount: 0, uncoveredCount: 20, repeatEmployeeCount: 0 }, rows: [],
}

function patrolReport(count: number): PatrolReport {
  return {
    canExport: true, generatedAt: '2026-09-24T16:00:00Z',
    summary: { completed: count, evidence: count, extra: 0, incidents: 0, makeupAssigned: 0, makeupCompleted: 0, missed: 0, required: count },
    rows: Array.from({ length: count }, (_, index) => ({
      armed: false, completedAt: '2026-09-24T16:00:00Z', dueEndAt: '2026-09-24T17:00:00Z', dueStartAt: '2026-09-24T16:00:00Z',
      employeeName: `Guard ${index + 1}`, employeeNumber: `SYG-${1100 + index}`, evidenceCount: 1, hitNumber: index + 1,
      locationLabel: 'Main Campus North Entrance', locationStatus: 'verified', note: 'All secure',
      obligationId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, outcome: 'secure', requirementLabel: 'Perimeter patrol',
      routeName: 'Main Campus Overnight Patrol', serviceDate: '2026-09-24', status: 'completed', classification: 'required',
      recordId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    })),
  }
}

describe('shared report PDF layout', () => {
  it('repeats the complete account report banner and table heading on every page', async () => {
    const bytes = await userAccountActivityPdf(accountReport(83), 'All employees | All account states | 30-day threshold')
    if (process.env.PDF_LAYOUT_QA_OUTPUT) await writeFile(process.env.PDF_LAYOUT_QA_OUTPUT, bytes)
    const pages = await textByPage(bytes)
    expect(await fontResourcesPerPage(bytes)).toEqual(Array.from({ length: pages.length }, () => 2))
    expect(pages.length).toBeGreaterThanOrEqual(6)
    pages.forEach((items) => {
      expect(items).toContain('User Account & Sign-In Activity')
      expect(items).toContain('Employee')
      expect(items).toContain('Last completed sign-in')
      expect(items).toContain('Next action')
      expect(items.some((item) => /^Page \d+ of \d+$/.test(item))).toBe(true)
    })
  })

  it('uses the same complete repeated page chrome for attendance and patrol PDFs', async () => {
    const attendanceBytes = await shortNoticeCallOutPdf(shortNoticeReport, Array.from({ length: 20 }, (_, index) => shortNoticeRow(index + 1)), 'All records')
    const patrolBytes = await patrolReportPdf(patrolReport(60), 'internal')
    if (process.env.PDF_LAYOUT_QA_DIRECTORY) {
      await mkdir(process.env.PDF_LAYOUT_QA_DIRECTORY, { recursive: true })
      await Promise.all([
        writeFile(join(process.env.PDF_LAYOUT_QA_DIRECTORY, 'short-notice-call-out-layout-qa.pdf'), attendanceBytes),
        writeFile(join(process.env.PDF_LAYOUT_QA_DIRECTORY, 'patrol-activity-layout-qa.pdf'), patrolBytes),
      ])
    }
    const attendancePages = await textByPage(attendanceBytes)
    const patrolPages = await textByPage(patrolBytes)
    expect(await fontResourcesPerPage(attendanceBytes)).toEqual(Array.from({ length: attendancePages.length }, () => 2))
    expect(await fontResourcesPerPage(patrolBytes)).toEqual(Array.from({ length: patrolPages.length }, () => 2))
    expect(attendancePages.length).toBeGreaterThan(1)
    expect(patrolPages.length).toBeGreaterThan(1)
    attendancePages.forEach((items) => {
      expect(items).toContain('Short-Notice Call-Out Report')
      expect(items.some((item) => /^Page \d+ of \d+$/.test(item))).toBe(true)
    })
    patrolPages.forEach((items) => {
      expect(items).toContain('Patrol Activity')
      expect(items).toContain('Service Date')
      expect(items.some((item) => /^Page \d+ of \d+$/.test(item))).toBe(true)
    })
  })
})
