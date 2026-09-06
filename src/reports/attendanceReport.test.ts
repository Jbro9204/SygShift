import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { attendanceFixture } from '../test/attendanceFixture'
import { createXlsxWorkbookBlob } from '../lib/xlsxWorkbook'
import { summarizeAccountability, buildEmployeeAccountabilitySummaries, accountabilityDisplayState } from '../time/accountability'
import { attendanceCsv, attendanceWorkbook, filterAttendanceReport } from './attendanceReport'

describe('Attendance totals and weekly exports', () => {
  const events = [attendanceFixture(), attendanceFixture({ id: 'second', eventType: 'late_arrival' }), attendanceFixture({ id: 'third', eventType: 'other' })]
  const report = { fromDate: '2026-08-30', throughDate: '2026-09-05', serverTimestamp: '2026-09-06T12:00:00Z', events }
  it('counts corrected absences and late arrivals without increasing negative reliability', () => {
    expect(summarizeAccountability(events)).toMatchObject({ total: 3, absences: 1, lateArrivals: 1, other: 1, corrected: 3, confirmedReliabilityOccurrences: 0 })
  })
  it('excludes dismissed and voided events from factual type counts and separates approved leave', () => {
    const leave = attendanceFixture({ sourceTable: 'time_off_requests', eventType: 'vacation', status: 'approved', reviewOutcome: null })
    expect(accountabilityDisplayState(leave)).toBe('protected')
    expect(summarizeAccountability([leave, attendanceFixture({ reviewOutcome: 'dismissed' }), attendanceFixture({ status: 'voided' })])).toMatchObject({ absences: 0, timeOff: 1, dismissed: 1, voided: 1, protected: 1 })
  })
  it('retains historical employees not present in the active employee chooser', () => {
    expect(buildEmployeeAccountabilitySummaries([], events)[0]).toMatchObject({ total: 3, absences: 1, corrected: 3 })
  })
  it('filters by name, event type, and review state without losing corrected records by default', () => {
    expect(filterAttendanceReport(events, '', '', '')).toHaveLength(3)
    expect(filterAttendanceReport(events, ' TEST ', 'call_off', 'corrected')).toHaveLength(1)
    expect(filterAttendanceReport(events, '', '', 'open')).toHaveLength(0)
  })
  it('exports all matching occurrences and the same employee totals', () => {
    const sheets = attendanceWorkbook(report, events, 'All records')
    expect(sheets[0].rows[5]).toEqual(['Test Employee', 3, 1, 1, 0, 1, 0, 0, 0, 0, 3, 0])
    expect(sheets[1].rows).toHaveLength(7)
    expect(sheets[1].rows[4][0]).toBe('08/31/2026')
  })
  it('neutralizes CSV formulas and quotes multiline notes safely', () => {
    const csv = attendanceCsv(report, [attendanceFixture({ employeeName: '=1+1', note: 'note "quoted"\nnext line' })], 'All')
    expect(csv).toContain("'" + '=1+1')
    expect(csv).toContain('note ""quoted""\nnext line')
  })
  it('builds a readable Excel archive with summary and detail worksheets', async () => {
    const blob = createXlsxWorkbookBlob(attendanceWorkbook(report, events, 'All'))
    const data = await new Promise<ArrayBuffer>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(blob) })
    const files = unzipSync(new Uint8Array(data))
    expect(strFromU8(files['xl/workbook.xml'])).toContain('Employee Summary')
    expect(strFromU8(files['xl/worksheets/sheet2.xml'])).toContain('Call-off reported.')
  })
})
