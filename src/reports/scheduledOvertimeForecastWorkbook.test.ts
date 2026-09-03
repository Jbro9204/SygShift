import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createXlsxWorkbookBlob } from '../lib/xlsxWorkbook'
import type { ScheduledOvertimeForecast } from '../data/scheduledOvertimeForecast'
import {
  buildScheduledOvertimeForecastWorkbookSheets,
  scheduledOvertimeForecastFileName,
} from './scheduledOvertimeForecastWorkbook'

const forecast: ScheduledOvertimeForecast = {
  armedFlexCandidates: [{
    availabilityRequiresReview: true,
    credentialValidThrough: '2026-09-12',
    employeeId: '11111111-1111-4111-8111-111111111111',
    employeeName: 'Flex Guard',
    employeeNumber: 'SYG-2000',
    employmentType: 'flex',
    jobTitle: 'Armed Guard',
    remainingMinutesBeforeOvertime: 1200,
    scheduledMinutes: 1200,
  }],
  employees: [{
    approvalNotes: 'Matt approved',
    armedMinutes: 2880,
    armedShiftCount: 6,
    employeeId: '22222222-2222-4222-8222-222222222222',
    employeeName: 'Overtime Guard',
    employeeNumber: 'SYG-2001',
    employmentType: 'hourly',
    jobTitle: 'Armed Guard',
    overtimeMinutes: 480,
    scheduledMinutes: 2880,
    shiftCount: 6,
    shifts: [{
      approvalNote: 'Matt approved',
      date: '2026-09-06',
      endsAt: '2026-09-07T14:00:00Z',
      requiresArmed: true,
      scheduledMinutes: 480,
      shiftId: '33333333-3333-4333-8333-333333333333',
      sitePost: "B'Nai · Armed coverage",
      startsAt: '2026-09-07T06:00:00Z',
      timeZone: 'America/Denver',
    }],
    sites: "B'Nai · Armed coverage",
    unarmedMinutes: 0,
    workClassification: 'full_time',
  }],
  generatedAt: '2026-09-03T15:00:00Z',
  schedule: {
    id: '44444444-4444-4444-8444-444444444444',
    publishedAt: null,
    revision: 3,
    status: 'draft',
  },
  summary: {
    armedOvertimeEmployees: 1,
    overtimeEmployees: 1,
    totalOvertimeMinutes: 480,
  },
  weekEndsOn: '2026-09-12',
  weekStartsOn: '2026-09-06',
}

describe('Scheduled overtime workbook', () => {
  it('creates separate forecast, shift, and capacity sheets with the safety note', async () => {
    const sheets = buildScheduledOvertimeForecastWorkbookSheets(forecast, '2026-09-03T15:05:00Z')
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Overtime Forecast', 'Shift Detail', 'Armed Flex Capacity'])
    expect(sheets[0].mergedCells).toContain('B8:K8')
    expect(sheets[1].mergedCells).toContain('B3:J3')
    expect(sheets[2].mergedCells).toContain('B4:G4')
    expect(sheets[0].rows.flat()).toContain('Matt approved')
    expect(sheets[1].rows.flat()).toContain("B'Nai · Armed coverage")
    expect(sheets[2].rows.flat()).toContain('This is a credential-and-capacity planning aid, not an availability confirmation.')

    const archive = unzipSync(new Uint8Array(await createXlsxWorkbookBlob(sheets).arrayBuffer()))
    const workbookXml = new TextDecoder().decode(archive['xl/workbook.xml'])
    expect(workbookXml).toContain('Overtime Forecast')
    expect(workbookXml).toContain('Shift Detail')
    expect(workbookXml).toContain('Armed Flex Capacity')
  })

  it('names the workbook for the selected schedule week', () => {
    expect(scheduledOvertimeForecastFileName('2026-09-06')).toBe('sygshift-scheduled-overtime-2026-09-06.xlsx')
  })
})
