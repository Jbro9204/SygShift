import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import type { ShortNoticeCallOutReport, ShortNoticeCallOutRow } from '../data/shortNoticeCallOutReport'
import {
  filterShortNoticeCallOutRows,
  formatNoticeMinutes,
  shortNoticeCallOutPdf,
  shortNoticeCallOutWorkbook,
  summarizeShortNoticeCallOutRows,
  type ShortNoticeCallOutFilters,
} from './shortNoticeCallOutReport'

const baseRow: ShortNoticeCallOutRow = {
  id: '11111111-1111-4111-8111-111111111111',
  employeeId: '22222222-2222-4222-8222-222222222222',
  employeeName: 'Alex Guard',
  employeeNumber: 'SYG-1001',
  jobTitle: 'Security Officer',
  employmentType: 'hourly',
  operationalDate: '2026-09-21',
  scheduledStartAt: '2026-09-22T00:00:00Z',
  scheduledEndAt: '2026-09-22T08:00:00Z',
  timeZone: 'America/Denver',
  callReceivedAt: '2026-09-21T22:01:00Z',
  noticeMinutes: 119,
  noticeBucket: '1_to_2_hours',
  occurrenceType: 'call_off',
  reason: 'Unexpected family emergency',
  operationalDetails: 'Dispatch recorded the call.',
  replacementNeeded: true,
  recordStatus: 'recorded',
  canceledAt: null,
  reviewOutcome: 'pending_hr_review',
  reviewedAt: null,
  reviewedByName: null,
  decisionNote: null,
  clientName: 'Example Client',
  siteName: 'Main Campus',
  siteCode: 'MAIN',
  postName: 'Front Desk',
  eventName: null,
  locationName: 'Main Campus',
  submissionSource: 'management_entry',
  receivedByName: 'Dana Dispatcher',
  reportedByName: 'Alex Guard',
  coverageStatus: 'pending',
  replacementEmployeeName: null,
  overtimeCreated: false,
  attendanceEventId: null,
  actionPath: '/requests?callOff=11111111-1111-4111-8111-111111111111',
}

const report: ShortNoticeCallOutReport = {
  serverTimestamp: '2026-09-21T18:00:00Z',
  fromDate: '2026-09-01',
  throughDate: '2026-09-21',
  noticeThresholdMinutes: 240,
  countingRule: 'Call received less than four hours before scheduled start. Exactly four hours is compliant.',
  summary: { shortNoticeCount: 3, afterStartCount: 1, noShowCount: 1, uncoveredCount: 2, repeatEmployeeCount: 1 },
  rows: [],
}

const emptyFilters: ShortNoticeCallOutFilters = {
  search: '', noticeBucket: '', occurrenceType: '', reviewOutcome: '', coverageStatus: '',
}

describe('short-notice call-out reporting', () => {
  it('formats notice windows and after-start occurrences clearly', () => {
    expect(formatNoticeMinutes(239)).toBe('3 hr 59 min')
    expect(formatNoticeMinutes(0)).toBe('0 hr 0 min')
    expect(formatNoticeMinutes(-65)).toBe('1 hr 5 min after start')
  })

  it('filters the complete HR record by employee, notice, occurrence, review, and coverage', () => {
    const noShow: ShortNoticeCallOutRow = {
      ...baseRow,
      id: '33333333-3333-4333-8333-333333333333',
      employeeName: 'Morgan Officer',
      employeeNumber: 'SYG-1002',
      noticeMinutes: -15,
      noticeBucket: 'after_start',
      occurrenceType: 'no_call_no_show',
      reviewOutcome: 'unexcused',
      coverageStatus: 'covered',
      replacementEmployeeName: 'Taylor Flex',
    }
    const rows = [baseRow, noShow]

    expect(filterShortNoticeCallOutRows(rows, { ...emptyFilters, search: 'main campus' })).toHaveLength(2)
    expect(filterShortNoticeCallOutRows(rows, { ...emptyFilters, search: 'SYG-1002' })).toEqual([noShow])
    expect(filterShortNoticeCallOutRows(rows, { ...emptyFilters, noticeBucket: 'after_start' })).toEqual([noShow])
    expect(filterShortNoticeCallOutRows(rows, { ...emptyFilters, occurrenceType: 'no_call_no_show' })).toEqual([noShow])
    expect(filterShortNoticeCallOutRows(rows, { ...emptyFilters, reviewOutcome: 'unexcused' })).toEqual([noShow])
    expect(filterShortNoticeCallOutRows(rows, { ...emptyFilters, coverageStatus: 'pending' })).toEqual([baseRow])
  })

  it('summarizes severe, unresolved, and repeat attendance patterns without assigning discipline', () => {
    const secondOccurrence = {
      ...baseRow,
      id: '44444444-4444-4444-8444-444444444444',
      occurrenceType: 'no_call_no_show' as const,
      noticeMinutes: -10,
      noticeBucket: 'after_start' as const,
      coverageStatus: 'no_replacement' as const,
    }
    const otherEmployee = {
      ...baseRow,
      id: '55555555-5555-4555-8555-555555555555',
      employeeId: '66666666-6666-4666-8666-666666666666',
      employeeName: 'Jamie Officer',
      coverageStatus: 'covered' as const,
    }

    expect(summarizeShortNoticeCallOutRows([baseRow, secondOccurrence, otherEmployee])).toEqual({
      total: 3,
      afterStart: 1,
      noShows: 1,
      uncovered: 2,
      repeatEmployees: 1,
    })
  })

  it('builds a two-sheet Excel export with summary and complete occurrence detail', () => {
    const sheets = shortNoticeCallOutWorkbook(report, [baseRow], 'All protected records')
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Employee Summary', 'Occurrence Detail'])
    expect(sheets[0].rows[4]).toContain('Occurrences')
    expect(sheets[1].rows[3]).toEqual(['Threshold', 'Less than 4 hours (240 minutes); exactly 4 hours is compliant.'])
    expect(sheets[1].rows[5]).toContain('Unexpected family emergency')
    expect(sheets[1].rows[5]).toContain('Dana Dispatcher')
  })

  it('builds a readable protected PDF export', async () => {
    const bytes = await shortNoticeCallOutPdf(report, [baseRow], 'All protected records')
    const reopened = await PDFDocument.load(bytes)
    expect(reopened.getPageCount()).toBeGreaterThanOrEqual(1)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('%PDF')
  })
})
