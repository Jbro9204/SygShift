import type { AccountabilityEvent, AttendanceReport } from '../data/accountability'
import type { XlsxSheet } from '../lib/xlsxWorkbook'
import { accountabilityDisplayState, accountabilityTypeLabels, buildEmployeeAccountabilitySummaries } from '../time/accountability'
import { formatUsDateKey } from '../time/timeRules'

export function filterAttendanceReport(events: AccountabilityEvent[], search: string, type: string, state: string) {
  const query = search.trim().toLocaleLowerCase()
  return events.filter((event) => (!query || [event.employeeName, event.username, event.locationName, event.note].some((text) => text.toLocaleLowerCase().includes(query)))
    && (!type || event.eventType === type) && (!state || accountabilityDisplayState(event) === state))
}

export function attendanceWorkbook(report: AttendanceReport, events: AccountabilityEvent[], filterDescription: string): XlsxSheet[] {
  const summary = buildEmployeeAccountabilitySummaries([], events)
  const range = `${formatUsDateKey(report.fromDate)} – ${formatUsDateKey(report.throughDate)}`
  return [{
    name: 'Employee Summary', titleRows: [0], metadataRows: [1, 2, 3], headerRows: [4], filterRowIndex: 4, freezeRows: 5,
    columnWidths: [28, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14], integerColumns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    rows: [['Attendance & Call-Offs'], ['Date range', range], ['Filters', filterDescription], ['Counting rule', 'Recorded occurrences, not absent days or discipline points. Corrected included; dismissed/voided excluded from type totals.'],
      ['Employee', 'Documented', 'Absences', 'Late arrivals', 'Early departures', 'Other', 'Time off', 'Open', 'Confirmed', 'Protected', 'Corrected', 'Dismissed'],
      ...summary.map((row) => [row.employeeName, row.total, row.absences, row.lateArrivals, row.earlyDepartures, row.other, row.timeOff, row.open, row.confirmed, row.protected, row.corrected, row.dismissed])],
  }, {
    name: 'Occurrence Detail', titleRows: [0], metadataRows: [1, 2], headerRows: [3], filterRowIndex: 3, freezeRows: 4,
    columnWidths: [16, 28, 30, 30, 18, 65, 65, 34, 40], wrapColumns: [5, 6],
    rows: [['Attendance occurrence detail'], ['Date range', range], ['Filters', filterDescription],
      ['Work date', 'Employee', 'Occurrence type', 'Location', 'Review state', 'Factual note', 'Decision note', 'Source', 'Record ID'],
      ...events.map((event) => [formatUsDateKey(event.operationalDate), event.employeeName, accountabilityTypeLabels[event.eventType], event.locationName, accountabilityDisplayState(event), event.note, event.decisionNote, event.sourceTable, event.id])],
  }]
}

export function attendanceCsv(report: AttendanceReport, events: AccountabilityEvent[], filterDescription: string): string {
  const rows = attendanceWorkbook(report, events, filterDescription)[1].rows
  return '\ufeff' + rows.map((row) => row.map((cell) => {
    const value = String(cell ?? '')
    const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value
    return `"${safe.replaceAll('"', '""')}"`
  }).join(',')).join('\r\n')
}
