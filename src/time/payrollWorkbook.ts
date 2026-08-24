import {
  payrollHours,
  summarizePayrollRowsByEmployee,
  type PayrollAccountabilityEvent,
  type PayrollEmployeeSummary,
  type PayrollExportBatch,
  type PayrollRules,
  type TimekeepingReview,
  type TimekeepingReviewRow,
} from '../data/timekeeping'
import { formatUsDateKey } from './timeRules'
import { getPayrollBatchWeek, shiftDateKey } from './payrollBoundary'

type WorkbookCell = string | number | boolean | null | undefined

interface WorkbookSheet {
  centerColumns?: number[]
  columnWidths?: number[]
  filterRowIndex?: number
  freezeRows?: number
  headerRows?: number[]
  integerColumns?: number[]
  metadataRows?: number[]
  mergedCells?: string[]
  name: string
  rowHeights?: Record<number, number>
  rows: WorkbookCell[][]
  sectionRows?: number[]
  titleRows?: number[]
  totalsRows?: number[]
  wrapColumns?: number[]
}

export interface PayrollWorkbookInput {
  accountabilityEvents?: PayrollAccountabilityEvent[]
  batch?: PayrollExportBatch | null
  exportNote?: string
  exportType: 'Preview' | 'Official Locked'
  review: TimekeepingReview
  rules?: PayrollRules
}

const workbookMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function xmlEscape(value: string): string {
  const xmlSafeValue = [...value].filter((character) => {
    const code = character.charCodeAt(0)
    return code === 9 || code === 10 || code === 13 || code >= 32
  }).join('')
  return xmlSafeValue
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function sheetName(value: string, used: Set<string>): string {
  const cleaned = value
    .replace(/[\\/?*:[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet'
  let candidate = cleaned
  let suffix = 2
  while (used.has(candidate.toLocaleLowerCase())) {
    const suffixText = ` ${suffix}`
    candidate = `${cleaned.slice(0, 31 - suffixText.length)}${suffixText}`
    suffix += 1
  }
  used.add(candidate.toLocaleLowerCase())
  return candidate
}

function columnName(index: number): string {
  let name = ''
  let value = index + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function styleForCell(sheet: WorkbookSheet, cell: WorkbookCell, rowIndex: number, columnIndex: number): number {
  if (sheet.titleRows?.includes(rowIndex)) return 1
  if (sheet.headerRows?.includes(rowIndex)) return 4
  if (sheet.sectionRows?.includes(rowIndex)) return 5
  if (sheet.metadataRows?.includes(rowIndex)) return columnIndex === 0 ? 2 : 3
  if (String(cell).trim().toLocaleLowerCase() === 'ready') return 8
  if (String(cell).trim().toLocaleLowerCase() === 'needs review') return 9
  if (sheet.totalsRows?.includes(rowIndex)) return sheet.integerColumns?.includes(columnIndex) ? 14 : 10
  if (sheet.wrapColumns?.includes(columnIndex)) return 11
  if (typeof cell === 'number' && sheet.integerColumns?.includes(columnIndex)) return 13
  if (typeof cell === 'number') return 7
  if (sheet.centerColumns?.includes(columnIndex)) return 12
  return 6
}

function cellXml(sheet: WorkbookSheet, cell: WorkbookCell, rowIndex: number, columnIndex: number): string {
  const ref = `${columnName(columnIndex)}${rowIndex + 1}`
  const style = styleForCell(sheet, cell, rowIndex, columnIndex)
  const styleAttribute = style > 0 ? ` s="${style}"` : ''
  if (cell === null || cell === undefined || cell === '') return `<c r="${ref}"${styleAttribute}/>`
  if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${ref}"${styleAttribute}><v>${cell}</v></c>`
  if (typeof cell === 'boolean') return `<c r="${ref}" t="b"${styleAttribute}><v>${cell ? 1 : 0}</v></c>`
  return `<c r="${ref}" t="inlineStr"${styleAttribute}><is><t>${xmlEscape(String(cell))}</t></is></c>`
}

function rowHeightFor(sheet: WorkbookSheet, rowIndex: number): number | undefined {
  const explicitHeight = sheet.rowHeights?.[rowIndex]
  if (explicitHeight) return explicitHeight
  if (sheet.titleRows?.includes(rowIndex)) return 38
  return undefined
}

function worksheetXml(sheet: WorkbookSheet): string {
  const columnCount = Math.max(1, ...sheet.rows.map((row) => row.length))
  const rowCount = Math.max(1, sheet.rows.length)
  const dimension = `A1:${columnName(columnCount - 1)}${rowCount}`
  const freezeRows = sheet.freezeRows ?? 1
  const topLeftCell = `A${freezeRows + 1}`
  const autoFilter = typeof sheet.filterRowIndex === 'number' && sheet.rows.length > sheet.filterRowIndex + 1
    ? `<autoFilter ref="A${sheet.filterRowIndex + 1}:${columnName(columnCount - 1)}${rowCount}"/>`
    : ''
  const columnDefinitions = Array.from({ length: columnCount }, (_, index) => {
    const width = sheet.columnWidths?.[index] ?? (index === 0 ? 24 : index <= 3 ? 18 : 15)
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
  }).join('')
  const rows = sheet.rows.map((row, rowIndex) => (
    `<row r="${rowIndex + 1}"${rowHeightFor(sheet, rowIndex) ? ` ht="${rowHeightFor(sheet, rowIndex)}" customHeight="1"` : ''}>${row.map((cell, columnIndex) => cellXml(sheet, cell, rowIndex, columnIndex)).join('')}</row>`
  )).join('')
  const mergeCells = sheet.mergedCells?.length
    ? `<mergeCells count="${sheet.mergedCells.length}">${sheet.mergedCells.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    : ''

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
  <dimension ref="${dimension}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="85" zoomScaleNormal="85"><pane ySplit="${freezeRows}" topLeftCell="${topLeftCell}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${columnDefinitions}</cols>
  <sheetData>${rows}</sheetData>
  ${autoFilter}
  ${mergeCells}
  <pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0" paperSize="9"/>
</worksheet>`
}

function dateTimeText(value: string | null | undefined, timeZone = 'America/Denver'): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const civilian = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(date)
  const military = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZone,
  }).format(date)
  return `${civilian} (${military})`
}

function locationLabel(row: TimekeepingReviewRow): string {
  return [row.siteCode, row.siteName, row.postName ?? row.eventName].filter(Boolean).join(' / ') || row.locationName
}

function accountabilityLocation(event: PayrollAccountabilityEvent): string {
  return [event.siteCode, event.siteName, event.postName ?? event.eventName].filter(Boolean).join(' / ') || event.locationName
}

function scheduledMinutes(row: TimekeepingReviewRow): number {
  if (!row.scheduledStartsAt || !row.scheduledEndsAt) return 0
  const starts = Date.parse(row.scheduledStartsAt)
  const ends = Date.parse(row.scheduledEndsAt)
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) return 0
  return Math.round((ends - starts) / 60_000)
}

function hours(minutes: number): number {
  return Number(payrollHours(minutes))
}

export interface PayrollAccountabilityPaySummary {
  employeeId: string
  employeeName: string
  username: string
  role: PayrollAccountabilityEvent['role']
  employmentType: PayrollAccountabilityEvent['employmentType']
  accountabilityCount: number
  scheduledMinutes: number
  sickPayMinutes: number
  vacationPayMinutes: number
  otherPaidMinutes: number
  reviewCount: number
  notes: string[]
}

function eventLabel(eventType: PayrollAccountabilityEvent['eventType']): string {
  const labels: Record<PayrollAccountabilityEvent['eventType'], string> = {
    call_off: 'Call-off',
    called_in_sick: 'Called in sick',
    early_departure: 'Early departure',
    late_arrival: 'Late arrival',
    no_call_no_show: 'No call / no show',
    other: 'Other',
    vacation: 'Vacation / time off',
  }
  return labels[eventType] ?? eventType
}

export function accountabilityEventScheduledMinutes(event: PayrollAccountabilityEvent): number {
  if (!event.startsAt || !event.endsAt) return 0
  const starts = Date.parse(event.startsAt)
  const ends = Date.parse(event.endsAt)
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) return 0
  return Math.round((ends - starts) / 60_000)
}

function isApprovedStatus(status: string): boolean {
  return status.trim().toLocaleLowerCase() === 'approved'
}

export function accountabilityEventPayableMinutes(event: PayrollAccountabilityEvent): number {
  const scheduled = accountabilityEventScheduledMinutes(event)
  if (event.eventType === 'called_in_sick') return scheduled
  if (event.eventType === 'vacation' && isApprovedStatus(event.status)) return scheduled
  return 0
}

export function accountabilityEventPayCategory(event: PayrollAccountabilityEvent): string {
  if (event.eventType === 'called_in_sick') return 'Sick pay'
  if (event.eventType === 'vacation') return isApprovedStatus(event.status) ? 'Vacation/PTO' : 'PTO review'
  if (event.eventType === 'call_off') return 'Unpaid call-off'
  return 'Review'
}

export function accountabilityEventReviewNote(event: PayrollAccountabilityEvent): string {
  const scheduled = accountabilityEventScheduledMinutes(event)
  if (event.eventType === 'called_in_sick' && scheduled === 0) {
    return 'Sick pay needs review: no scheduled shift window was attached.'
  }
  if (event.eventType === 'vacation') {
    if (!isApprovedStatus(event.status)) return 'Time off is not approved yet; review before payroll.'
    if (scheduled === 0) return 'PTO hours need review: no scheduled shift window was attached.'
  }
  if (event.eventType === 'call_off' && scheduled > 0) {
    return 'Call-off is not paid unless HR marks it sick/PTO.'
  }
  if (event.eventType === 'call_off') return 'Call-off is informational unless converted to sick/PTO.'
  return ''
}

export function summarizePayrollAccountabilityByEmployee(events: PayrollAccountabilityEvent[]): PayrollAccountabilityPaySummary[] {
  const summaries = new Map<string, PayrollAccountabilityPaySummary & { noteKeys: Set<string> }>()

  for (const event of events) {
    const existing = summaries.get(event.employeeId)
    const summary = existing ?? {
      accountabilityCount: 0,
      employeeId: event.employeeId,
      employeeName: event.employeeName,
      employmentType: event.employmentType,
      noteKeys: new Set<string>(),
      notes: [],
      otherPaidMinutes: 0,
      reviewCount: 0,
      role: event.role,
      scheduledMinutes: 0,
      sickPayMinutes: 0,
      username: event.username,
      vacationPayMinutes: 0,
    }
    const scheduled = accountabilityEventScheduledMinutes(event)
    const payable = accountabilityEventPayableMinutes(event)
    const reviewNote = accountabilityEventReviewNote(event)

    summary.accountabilityCount += 1
    summary.scheduledMinutes += scheduled
    if (event.eventType === 'called_in_sick') summary.sickPayMinutes += payable
    else if (event.eventType === 'vacation') summary.vacationPayMinutes += payable
    else if (payable > 0) summary.otherPaidMinutes += payable

    if (reviewNote) {
      summary.reviewCount += 1
      if (!summary.noteKeys.has(reviewNote)) {
        summary.noteKeys.add(reviewNote)
        summary.notes.push(reviewNote)
      }
    }

    summaries.set(event.employeeId, summary)
  }

  return [...summaries.values()]
    .map(({ noteKeys: _noteKeys, ...summary }) => summary)
    .sort((left, right) => left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: 'base' }))
}

export function getPayrollAccountabilitySummary(
  employeeId: string,
  summaries: PayrollAccountabilityPaySummary[],
): PayrollAccountabilityPaySummary | undefined {
  return summaries.find((summary) => summary.employeeId === employeeId)
}

export function payrollPayableMinutes(
  workedSummary: Pick<PayrollEmployeeSummary, 'paidMinutes'> | undefined,
  accountabilitySummary: PayrollAccountabilityPaySummary | undefined,
): number {
  return (workedSummary?.paidMinutes ?? 0)
    + (accountabilitySummary?.sickPayMinutes ?? 0)
    + (accountabilitySummary?.vacationPayMinutes ?? 0)
    + (accountabilitySummary?.otherPaidMinutes ?? 0)
}

function summaryScheduledMinutes(employeeId: string, rows: TimekeepingReviewRow[]): number {
  return rows
    .filter((row) => row.employeeId === employeeId)
    .reduce((total, row) => total + scheduledMinutes(row), 0)
}

export interface PayrollWorkbookWeek {
  label: string
  weekEndsOn: string
  weekStartsOn: string
}

export interface PayrollWeeklyEmployeeSummary {
  accountabilityCount: number
  breakMinutes: number
  employeeId: string
  employeeName: string
  employmentType: string
  exceptionCount: number
  hasActivity: boolean
  hasWorkedDetail: boolean
  locationCount: number
  needsReview: boolean
  otherPaidMinutes: number
  overtimeMinutes: number
  paidMinutes: number
  regularMinutes: number
  scheduledMinutes: number
  sickPayMinutes: number
  trainingMinutes: number
  username: string
  vacationPayMinutes: number
  workedShiftCount: number
}

export interface PayrollWeeklySummaryGroup {
  summaries: PayrollWeeklyEmployeeSummary[]
  week: PayrollWorkbookWeek
}

function payrollWeekStartForDate(dateKey: string, weekStartsOn: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  const daysSinceWeekStart = (date.getUTCDay() - weekStartsOn + 7) % 7
  return shiftDateKey(dateKey, -daysSinceWeekStart)
}

function payrollWeekStartMinutes(value: string | undefined): number {
  if (!value) return 0
  const [hoursText = '0', minutesText = '0'] = value.split(':')
  const hours = Number(hoursText)
  const minutes = Number(minutesText)
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : 0
}

function payrollWeekForInstant(input: PayrollWorkbookInput, instant: string): string {
  return getPayrollBatchWeek(instant, {
    timeZone: input.rules?.timeZone ?? input.review.operationalTimeZone,
    weekStartMinutes: payrollWeekStartMinutes(input.rules?.payrollWeekStartTime),
    weekStartsOn: input.rules?.weekStartsOn ?? 0,
  }).weekStartsOn!
}

export function payrollWorkbookWeekForRow(input: PayrollWorkbookInput, row: TimekeepingReviewRow): string {
  if (row.payrollBatchWeekStartsOn) return row.payrollBatchWeekStartsOn
  const anchor = row.payrollAssignmentAnchor ?? row.scheduledStartsAt ?? row.firstClockIn
  if (anchor) return payrollWeekForInstant(input, anchor)
  return payrollWeekStartForDate(row.operationalDate, input.rules?.weekStartsOn ?? 0)
}

function payrollWeekForAccountabilityEvent(input: PayrollWorkbookInput, event: PayrollAccountabilityEvent): string {
  if (event.startsAt) return payrollWeekForInstant(input, event.startsAt)
  return payrollWeekStartForDate(event.operationalDate, input.rules?.weekStartsOn ?? 0)
}

export function payrollWorkbookWeeks(input: PayrollWorkbookInput): PayrollWorkbookWeek[] {
  const weekStartsOn = input.rules?.weekStartsOn ?? 0
  const firstWeekStart = payrollWeekStartForDate(input.review.fromDate, weekStartsOn)
  const weeks: PayrollWorkbookWeek[] = []
  let weekStart = firstWeekStart
  let index = 1
  while (weekStart <= input.review.throughDate) {
    weeks.push({
      label: `Week ${index}`,
      weekEndsOn: shiftDateKey(weekStart, 6),
      weekStartsOn: weekStart,
    })
    weekStart = shiftDateKey(weekStart, 7)
    index += 1
  }
  return weeks
}

function weeklyPayrollSummary(
  input: PayrollWorkbookInput,
  employeeId: string,
  week: PayrollWorkbookWeek,
  events: PayrollAccountabilityEvent[],
): PayrollWeeklyEmployeeSummary {
  const rows = input.review.rows.filter((row) => row.employeeId === employeeId && payrollWorkbookWeekForRow(input, row) === week.weekStartsOn)
  const weekEvents = events.filter((event) => event.employeeId === employeeId && payrollWeekForAccountabilityEvent(input, event) === week.weekStartsOn)
  const worked = summarizePayrollRowsByEmployee(rows)[0]
  const accountability = summarizePayrollAccountabilityByEmployee(weekEvents)[0]
  const sampleRow = rows[0]
  const sampleEvent = weekEvents[0]
  const hasActivity = rows.length > 0 || weekEvents.length > 0
  return {
    accountabilityCount: accountability?.accountabilityCount ?? 0,
    breakMinutes: worked?.breakMinutes ?? 0,
    employeeId,
    employeeName: worked?.employeeName ?? accountability?.employeeName ?? sampleRow?.employeeName ?? sampleEvent?.employeeName ?? 'Employee',
    employmentType: worked?.employmentType ?? accountability?.employmentType ?? sampleRow?.employmentType ?? sampleEvent?.employmentType ?? '',
    exceptionCount: (worked?.exceptionCount ?? 0) + (accountability?.reviewCount ?? 0),
    hasActivity,
    hasWorkedDetail: rows.length > 0,
    locationCount: worked?.locationCount ?? 0,
    needsReview: rows.some((row) => !row.payrollReady || row.exceptionCodes.length > 0)
      || weekEvents.some((event) => accountabilityEventReviewNote(event) !== ''),
    otherPaidMinutes: accountability?.otherPaidMinutes ?? 0,
    overtimeMinutes: worked?.overtimeMinutes ?? 0,
    paidMinutes: worked?.paidMinutes ?? 0,
    regularMinutes: worked?.regularMinutes ?? 0,
    scheduledMinutes: summaryScheduledMinutes(employeeId, rows) + (accountability?.scheduledMinutes ?? 0),
    sickPayMinutes: accountability?.sickPayMinutes ?? 0,
    trainingMinutes: worked?.trainingMinutes ?? 0,
    username: worked?.username ?? accountability?.username ?? sampleRow?.username ?? sampleEvent?.username ?? 'unknown',
    vacationPayMinutes: accountability?.vacationPayMinutes ?? 0,
    workedShiftCount: worked?.workedShiftCount ?? 0,
  }
}

export function payrollWeeklyTotalPayableMinutes(summary: PayrollWeeklyEmployeeSummary): number {
  return summary.paidMinutes + summary.sickPayMinutes + summary.vacationPayMinutes + summary.otherPaidMinutes
}

export function summarizePayrollWorkbookByWeek(input: PayrollWorkbookInput): PayrollWeeklySummaryGroup[] {
  const events = input.accountabilityEvents ?? []
  const workedSummaries = summarizePayrollRowsByEmployee(input.review.rows)
  const accountabilitySummaries = summarizePayrollAccountabilityByEmployee(events)
  const employeeIds = [...new Set([
    ...workedSummaries.map((summary) => summary.employeeId),
    ...accountabilitySummaries.map((summary) => summary.employeeId),
  ])].sort((left, right) => {
    const leftName = workedSummaries.find((summary) => summary.employeeId === left)?.employeeName
      ?? accountabilitySummaries.find((summary) => summary.employeeId === left)?.employeeName
      ?? left
    const rightName = workedSummaries.find((summary) => summary.employeeId === right)?.employeeName
      ?? accountabilitySummaries.find((summary) => summary.employeeId === right)?.employeeName
      ?? right
    return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' })
  })

  return payrollWorkbookWeeks(input).map((week) => ({
    summaries: employeeIds.map((employeeId) => weeklyPayrollSummary(input, employeeId, week, events)),
    week,
  }))
}

function buildSummarySheet(input: PayrollWorkbookInput, events: PayrollAccountabilityEvent[]): WorkbookSheet {
  const review = input.review
  const weeklyGroups = summarizePayrollWorkbookByWeek({ ...input, accountabilityEvents: events })
  const weeks = weeklyGroups.map((group) => group.week)
  const titleRows: WorkbookCell[][] = [
    ['SygShift Payroll Report'],
    ['Pay Period', `${formatUsDateKey(review.fromDate)} - ${formatUsDateKey(review.throughDate)}`],
    ['Report Status', input.exportType],
    ['Pay Basis', 'Completed SygShift clock-in/out records plus approved sick and PTO hours. Scheduled hours are shown only for comparison.'],
    ['Payroll Rules', input.rules ? `${input.rules.weekStartsOnLabel} 12:00 AM payroll week; entire overnight occurrence follows scheduled start. ${payrollHours(input.rules.dailyOvertimeMinutes)} daily OT / ${payrollHours(input.rules.weeklyOvertimeMinutes)} weekly OT remain a separate calculation.` : 'Rules loaded from SygShift'],
    ['Calculation Policy', input.rules ? `${input.rules.payrollCalculationPolicyVersion} / configuration ${input.rules.payrollConfigurationVersion}` : 'Recorded with each official batch'],
    ['Review Note', input.exportNote ?? input.batch?.note ?? ''],
    ['Batch', input.batch ? `Locked payroll batch ${input.batch.id} / ${input.batch.digest.slice(0, 12)}` : 'Preview only — not an official payroll submission'],
    [],
  ]
  const header: WorkbookCell[] = [
    'Employee',
    'Employment',
    'Payroll Week',
    'Week Dates',
    'Worked Shifts',
    'Scheduled Hours',
    'Worked Hours',
    'Training Hours',
    'Regular Hours',
    'Overtime Hours',
    'Sick Pay Hours',
    'PTO Hours',
    'Other Paid Hours',
    'Total Payable',
    'Status',
  ]
  const weeklySummaries = weeklyGroups.flatMap((group) => group.summaries.map((summary) => ({
    summary,
    week: group.week,
  })))
  const body: WorkbookCell[][] = weeklySummaries.map(({ summary, week }) => [
    summary.employeeName,
    summary.employmentType,
    week.label,
    `${formatUsDateKey(week.weekStartsOn)} - ${formatUsDateKey(week.weekEndsOn)}`,
    summary.workedShiftCount,
    hours(summary.scheduledMinutes),
    hours(summary.paidMinutes),
    hours(summary.trainingMinutes),
    hours(summary.regularMinutes),
    hours(summary.overtimeMinutes),
    hours(summary.sickPayMinutes),
    hours(summary.vacationPayMinutes),
    hours(summary.otherPaidMinutes),
    hours(payrollWeeklyTotalPayableMinutes(summary)),
    summary.needsReview ? 'Needs review' : summary.hasActivity ? 'Ready' : 'No activity',
  ])
  const totalRow = (label: string, matching: Array<{ summary: PayrollWeeklyEmployeeSummary }>): WorkbookCell[] => {
    const minuteTotals = matching.reduce((result, item) => {
      result.workedShiftCount += item.summary.workedShiftCount
      result.scheduledMinutes += item.summary.scheduledMinutes
      result.paidMinutes += item.summary.paidMinutes
      result.trainingMinutes += item.summary.trainingMinutes
      result.regularMinutes += item.summary.regularMinutes
      result.overtimeMinutes += item.summary.overtimeMinutes
      result.sickPayMinutes += item.summary.sickPayMinutes
      result.vacationPayMinutes += item.summary.vacationPayMinutes
      result.otherPaidMinutes += item.summary.otherPaidMinutes
      result.totalPayableMinutes += payrollWeeklyTotalPayableMinutes(item.summary)
      return result
    }, {
      otherPaidMinutes: 0,
      overtimeMinutes: 0,
      paidMinutes: 0,
      regularMinutes: 0,
      scheduledMinutes: 0,
      sickPayMinutes: 0,
      totalPayableMinutes: 0,
      trainingMinutes: 0,
      vacationPayMinutes: 0,
      workedShiftCount: 0,
    })
    const status = matching.some((item) => item.summary.needsReview)
      ? 'Needs review'
      : matching.some((item) => item.summary.hasActivity)
        ? 'Ready'
        : 'No activity'
    return [
      label,
      '',
      '',
      '',
      minuteTotals.workedShiftCount,
      hours(minuteTotals.scheduledMinutes),
      hours(minuteTotals.paidMinutes),
      hours(minuteTotals.trainingMinutes),
      hours(minuteTotals.regularMinutes),
      hours(minuteTotals.overtimeMinutes),
      hours(minuteTotals.sickPayMinutes),
      hours(minuteTotals.vacationPayMinutes),
      hours(minuteTotals.otherPaidMinutes),
      hours(minuteTotals.totalPayableMinutes),
      status,
    ]
  }
  const weeklyTotals = weeks.map((week) => totalRow(
    `${week.label} totals`,
    weeklySummaries.filter((item) => item.week.weekStartsOn === week.weekStartsOn),
  ))
  const totals = totalRow('Pay period totals', weeklySummaries)
  const headerRowIndex = titleRows.length
  const totalsRowIndexes = weeklyTotals.map((_, index) => headerRowIndex + body.length + index + 1)
  const totalsRowIndex = headerRowIndex + body.length + weeklyTotals.length + 1

  return {
    centerColumns: [1, 2, 3, 4, 14],
    columnWidths: [26, 14, 14, 25, 14, 16, 15, 16, 14, 15, 15, 14, 16, 16, 16],
    filterRowIndex: headerRowIndex,
    freezeRows: headerRowIndex + 1,
    headerRows: [headerRowIndex],
    integerColumns: [4],
    mergedCells: [
      'A1:O1',
      'B2:O2',
      'B3:O3',
      'B4:O4',
      'B5:O5',
      'B6:O6',
      'B7:O7',
      'B8:O8',
    ],
    metadataRows: [1, 2, 3, 4, 5, 6, 7],
    name: 'Payroll Summary',
    rowHeights: {
      3: 34,
      4: 30,
      5: 30,
    },
    rows: [...titleRows, header, ...body, ...weeklyTotals, totals],
    titleRows: [0],
    totalsRows: [...totalsRowIndexes, totalsRowIndex],
  }
}

function buildWeeklyDetailSheets(input: PayrollWorkbookInput, events: PayrollAccountabilityEvent[]): WorkbookSheet[] {
  return payrollWorkbookWeeks(input).map((week) => {
    const workedRows: WorkbookCell[][] = input.review.rows
      .filter((row) => payrollWorkbookWeekForRow(input, row) === week.weekStartsOn)
      .sort((left, right) => left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: 'base' })
        || left.operationalDate.localeCompare(right.operationalDate)
        || (left.firstClockIn ?? '').localeCompare(right.firstClockIn ?? ''))
      .map((row) => {
        const payableMinutes = row.paidMinutes
        return [
          row.employeeName,
          row.employeeId,
          row.username,
          formatUsDateKey(row.operationalDate),
          row.workType === 'training' ? 'Paid training' : 'Worked time',
          locationLabel(row),
          dateTimeText(row.scheduledStartsAt, row.timeZone),
          dateTimeText(row.scheduledEndsAt, row.timeZone),
          dateTimeText(row.firstClockIn, row.timeZone),
          dateTimeText(row.lastClockOut, row.timeZone),
          hours(scheduledMinutes(row)),
          hours(row.paidMinutes),
          hours(row.regularMinutes),
          hours(row.overtimeMinutes),
          0,
          0,
          0,
          hours(payableMinutes),
          row.breakMinutes,
          row.payrollReady && row.exceptionCodes.length === 0 ? 'Ready' : 'Needs review',
          [...row.exceptionCodes.map((code) => code.replaceAll('_', ' ')), ...row.payrollNotes].join(' | '),
          `${formatUsDateKey(week.weekStartsOn)} - ${formatUsDateKey(week.weekEndsOn)}`,
          row.crossesPayrollBoundary ? 'Yes' : 'No',
        ]
      })
    const accountabilityRows: WorkbookCell[][] = events
      .filter((event) => payrollWeekForAccountabilityEvent(input, event) === week.weekStartsOn)
      .sort((left, right) => left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: 'base' })
        || left.operationalDate.localeCompare(right.operationalDate)
        || (left.startsAt ?? '').localeCompare(right.startsAt ?? ''))
      .map((event) => {
        const scheduled = accountabilityEventScheduledMinutes(event)
        const sick = event.eventType === 'called_in_sick' ? accountabilityEventPayableMinutes(event) : 0
        const pto = event.eventType === 'vacation' ? accountabilityEventPayableMinutes(event) : 0
        const other = event.eventType !== 'called_in_sick' && event.eventType !== 'vacation' ? accountabilityEventPayableMinutes(event) : 0
        const reviewNote = accountabilityEventReviewNote(event)
        return [
          event.employeeName,
          event.employeeId,
          event.username,
          formatUsDateKey(event.operationalDate),
          `${eventLabel(event.eventType)} / ${accountabilityEventPayCategory(event)}`,
          accountabilityLocation(event),
          dateTimeText(event.startsAt, event.timeZone),
          dateTimeText(event.endsAt, event.timeZone),
          '',
          '',
          hours(scheduled),
          0,
          0,
          0,
          hours(sick),
          hours(pto),
          hours(other),
          hours(sick + pto + other),
          0,
          reviewNote ? 'Needs review' : event.status,
          [reviewNote, event.note].filter(Boolean).join(' | '),
          `${formatUsDateKey(week.weekStartsOn)} - ${formatUsDateKey(week.weekEndsOn)}`,
          event.startsAt && event.endsAt && payrollWeekForInstant(input, new Date(new Date(event.endsAt).getTime() - 1).toISOString()) !== week.weekStartsOn ? 'Yes' : 'No',
        ]
      })
    const rows = [...workedRows, ...accountabilityRows].sort((left, right) => String(left[0]).localeCompare(String(right[0]), undefined, { sensitivity: 'base' })
      || String(left[3]).localeCompare(String(right[3])))
    const titleRows: WorkbookCell[][] = [
      [`${week.label} Payroll Detail`],
      ['Payroll Week', `${formatUsDateKey(week.weekStartsOn)} - ${formatUsDateKey(week.weekEndsOn)}`],
      ['Assignment Rule', 'An overnight occurrence remains entirely in the payroll week containing its scheduled start.'],
      [],
    ]
    const headerRowIndex = titleRows.length
    return {
      centerColumns: [3, 4, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22],
      columnWidths: [24, 38, 18, 14, 24, 38, 24, 24, 24, 24, 16, 15, 14, 15, 14, 14, 16, 16, 14, 16, 46, 25, 18],
      filterRowIndex: headerRowIndex,
      freezeRows: headerRowIndex + 1,
      headerRows: [headerRowIndex],
      integerColumns: [18],
      mergedCells: ['A1:W1', 'B2:W2', 'B3:W3'],
      metadataRows: [1, 2],
      name: `${week.label} Detail`,
      rows: [
        ...titleRows,
        ['Employee', 'Employee ID', 'Username', 'Work Date', 'Record Type', 'Site / Post', 'Scheduled Start', 'Scheduled End', 'Actual Clock In', 'Actual Clock Out', 'Scheduled Hours', 'Worked Hours', 'Regular Hours', 'Overtime Hours', 'Sick Hours', 'PTO Hours', 'Other Paid Hours', 'Total Payable', 'Break Minutes', 'Status', 'Notes', 'Payroll Week', 'Crosses Week Boundary'],
        ...(rows.length > 0 ? rows : [['No payroll records assigned to this week.']]),
      ],
      titleRows: [0],
      wrapColumns: [4, 5, 6, 7, 8, 9, 20, 21],
    }
  })
}

function buildDiscrepancySheet(rows: TimekeepingReviewRow[], events: PayrollAccountabilityEvent[]): WorkbookSheet {
  const header = ['Employee', 'Date', 'Issue', 'Location', 'Payroll Batch', 'Assignment Source', 'Scheduled', 'Worked', 'Payable', 'Variance', 'Status', 'Shift Notes', 'Review Notes']
  const rowItems = rows
    .filter((row) => !row.payrollReady || row.exceptionCodes.length > 0 || row.payrollNotes.length > 0)
    .map((row) => {
      const scheduled = scheduledMinutes(row)
      return [
        row.employeeName,
        formatUsDateKey(row.operationalDate),
        row.exceptionCodes.length > 0 ? row.exceptionCodes.map((code) => code.replaceAll('_', ' ')).join(', ') : 'Payroll review',
        locationLabel(row),
        row.payrollBatchWeekStartsOn && row.payrollBatchWeekEndsOn ? `${formatUsDateKey(row.payrollBatchWeekStartsOn)} - ${formatUsDateKey(row.payrollBatchWeekEndsOn)}` : 'Unresolved',
        row.payrollAssignmentSource.replaceAll('_', ' '),
        hours(scheduled),
        hours(row.paidMinutes),
        hours(row.paidMinutes),
        hours(row.paidMinutes - scheduled),
        row.payrollReady ? 'Ready' : 'Needs review',
        row.shiftNotes ?? '',
        [...row.exceptionCodes.map((code) => code.replaceAll('_', ' ')), ...row.payrollNotes].join(' | '),
      ]
    })
  const eventItems = events.filter((event) => accountabilityEventReviewNote(event) !== '').map((event) => {
    const scheduled = accountabilityEventScheduledMinutes(event)
    const payable = accountabilityEventPayableMinutes(event)
    const reviewNote = accountabilityEventReviewNote(event)
    return [
      event.employeeName,
      formatUsDateKey(event.operationalDate),
      `${eventLabel(event.eventType)} / ${accountabilityEventPayCategory(event)}`,
      accountabilityLocation(event),
      '',
      'Accountability event',
      hours(scheduled),
      '',
      hours(payable),
      hours(payable - scheduled),
      reviewNote ? 'Needs review' : event.status,
      '',
      [reviewNote, event.note].filter(Boolean).join(' | '),
    ]
  })
  const titleRows: WorkbookCell[][] = [
    ['Payroll Review Queue'],
    ['Purpose', 'Only unresolved time, punch, sick-pay, PTO, and accountability items that require attention before payroll is locked.'],
    [],
  ]
  const headerRowIndex = titleRows.length
  return {
    centerColumns: [1, 4, 6, 7, 8, 9, 10],
    columnWidths: [24, 14, 24, 38, 25, 23, 13, 13, 13, 13, 16, 42, 48],
    filterRowIndex: headerRowIndex,
    freezeRows: headerRowIndex + 1,
    headerRows: [headerRowIndex],
    integerColumns: [],
    mergedCells: ['A1:M1', 'B2:M2'],
    metadataRows: [1],
    name: 'Payroll Review',
    rows: [
      ...titleRows,
      header,
      ...(rowItems.length + eventItems.length > 0 ? [...rowItems, ...eventItems] : [['No discrepancies or accountability events in this range.']]),
    ],
    titleRows: [0],
    wrapColumns: [2, 3, 5, 11, 12],
  }
}

function buildVarianceSheet(rows: TimekeepingReviewRow[]): WorkbookSheet {
  const titleRows: WorkbookCell[][] = [
    ['Scheduled vs. Worked Hours'],
    ['Purpose', 'Comparison only. Payroll pay comes from completed SygShift time records and approved paid-leave records—not scheduled hours.'],
    [],
  ]
  const header = ['Employee', 'Date', 'Location', 'Scheduled Hours', 'Worked Hours', 'Variance Hours', 'Status']
  const body = rows
    .map((row) => {
      const scheduled = scheduledMinutes(row)
      const variance = row.paidMinutes - scheduled
      return [
        row.employeeName,
        formatUsDateKey(row.operationalDate),
        locationLabel(row),
        hours(scheduled),
        hours(row.paidMinutes),
        hours(variance),
        !row.payrollReady ? 'Needs review' : Math.abs(variance) >= 15 ? 'Variance noted' : 'Ready',
      ]
    })
    .filter((row) => Math.abs(Number(row[5])) > 0)
  const headerRowIndex = titleRows.length
  return {
    centerColumns: [1, 3, 4, 5, 6],
    columnWidths: [24, 14, 42, 18, 16, 18, 18],
    filterRowIndex: headerRowIndex,
    freezeRows: headerRowIndex + 1,
    headerRows: [headerRowIndex],
    integerColumns: [],
    mergedCells: ['A1:G1', 'B2:G2'],
    metadataRows: [1],
    name: 'Hours Variance',
    rows: [
      ...titleRows,
      header,
      ...(body.length > 0 ? body : [['No scheduled-versus-worked variances in this range.']]),
    ],
    titleRows: [0],
    wrapColumns: [2],
  }
}

function buildSiteSummarySheet(rows: TimekeepingReviewRow[], events: PayrollAccountabilityEvent[]): WorkbookSheet {
  const sites = new Map<string, {
    accountabilityItems: number
    breakMinutes: number
    employees: Set<string>
    needsReview: number
    otherPaidMinutes: number
    overtimeMinutes: number
    paidMinutes: number
    regularMinutes: number
    scheduledMinutes: number
    shifts: number
    sickPayMinutes: number
    trainingMinutes: number
    vacationPayMinutes: number
  }>()

  for (const row of rows) {
    const key = locationLabel(row)
    const item = sites.get(key) ?? {
      accountabilityItems: 0,
      breakMinutes: 0,
      employees: new Set<string>(),
      needsReview: 0,
      otherPaidMinutes: 0,
      overtimeMinutes: 0,
      paidMinutes: 0,
      regularMinutes: 0,
      scheduledMinutes: 0,
      shifts: 0,
      sickPayMinutes: 0,
      trainingMinutes: 0,
      vacationPayMinutes: 0,
    }
    item.breakMinutes += row.breakMinutes
    item.employees.add(row.employeeName)
    item.needsReview += row.payrollReady && row.exceptionCodes.length === 0 ? 0 : 1
    item.overtimeMinutes += row.overtimeMinutes
    item.paidMinutes += row.paidMinutes
    if (row.workType === 'training') item.trainingMinutes += row.paidMinutes
    item.regularMinutes += row.regularMinutes
    item.scheduledMinutes += scheduledMinutes(row)
    item.shifts += 1
    sites.set(key, item)
  }

  for (const event of events) {
    const key = accountabilityLocation(event)
    const item = sites.get(key) ?? {
      accountabilityItems: 0,
      breakMinutes: 0,
      employees: new Set<string>(),
      needsReview: 0,
      otherPaidMinutes: 0,
      overtimeMinutes: 0,
      paidMinutes: 0,
      regularMinutes: 0,
      scheduledMinutes: 0,
      shifts: 0,
      sickPayMinutes: 0,
      trainingMinutes: 0,
      vacationPayMinutes: 0,
    }
    const scheduled = accountabilityEventScheduledMinutes(event)
    const payable = accountabilityEventPayableMinutes(event)
    item.accountabilityItems += 1
    item.employees.add(event.employeeName)
    item.scheduledMinutes += scheduled
    if (event.eventType === 'called_in_sick') item.sickPayMinutes += payable
    else if (event.eventType === 'vacation') item.vacationPayMinutes += payable
    else if (payable > 0) item.otherPaidMinutes += payable
    item.needsReview += accountabilityEventReviewNote(event) ? 1 : 0
    sites.set(key, item)
  }

  const rowsOut = [...sites.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    .map(([location, item]) => [
      location,
      item.employees.size,
      item.shifts,
      hours(item.scheduledMinutes),
      hours(item.paidMinutes),
      hours(item.trainingMinutes),
      hours(item.sickPayMinutes),
      hours(item.vacationPayMinutes),
      hours(item.otherPaidMinutes),
      hours(item.paidMinutes + item.sickPayMinutes + item.vacationPayMinutes + item.otherPaidMinutes),
      hours(item.overtimeMinutes),
      item.needsReview,
    ])

  const titleRows: WorkbookCell[][] = [
    ['Site / Post Payroll Summary'],
    ['Purpose', 'Operational rollup of worked and paid hours by Site/Post for the selected payroll period.'],
    [],
  ]
  const headerRowIndex = titleRows.length
  return {
    centerColumns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    columnWidths: [42, 12, 15, 16, 15, 16, 14, 14, 16, 17, 15, 16],
    filterRowIndex: headerRowIndex,
    freezeRows: headerRowIndex + 1,
    headerRows: [headerRowIndex],
    integerColumns: [1, 2, 11],
    mergedCells: ['A1:L1', 'B2:L2'],
    metadataRows: [1],
    name: 'Site Summary',
    rows: [
      ...titleRows,
      ['Site / Post', 'Employees', 'Worked Shifts', 'Scheduled Hours', 'Worked Hours', 'Training Hours', 'Sick Pay', 'PTO Hours', 'Other Paid', 'Total Payable', 'Overtime', 'Review Items'],
      ...(rowsOut.length > 0 ? rowsOut : [['No worked time in this range.']]),
    ],
    titleRows: [0],
    wrapColumns: [0],
  }
}

function buildExceptionDecisionSheet(review: TimekeepingReview): WorkbookSheet {
  const titleRows: WorkbookCell[][] = [
    ['Payroll Exception Decisions'],
    ['Purpose', 'Audited administrator decisions for exact timekeeping occurrences. Original punches remain unchanged.'],
    [],
  ]
  const header = ['Employee', 'Date', 'Finding', 'Decision', 'Reason', 'Resolved By', 'Resolved At', 'Occurrence ID']
  const rows = review.exceptionResolutionHistory.map((resolution) => [
    resolution.employeeName ?? resolution.employeeId,
    formatUsDateKey(resolution.operationalDate),
    resolution.exceptionCode.replaceAll('_', ' '),
    resolution.action === 'approved_exception'
      ? 'Approved valid exception'
      : resolution.action === 'dismissed_false_positive'
        ? 'Dismissed false positive'
        : 'Reopened',
    resolution.reason,
    resolution.resolvedByName ?? resolution.resolvedBy,
    dateTimeText(resolution.resolvedAt),
    resolution.occurrenceFingerprint.slice(0, 16),
  ])
  const headerRowIndex = titleRows.length

  return {
    centerColumns: [1, 3, 6, 7],
    columnWidths: [25, 14, 25, 25, 52, 25, 23, 20],
    filterRowIndex: headerRowIndex,
    freezeRows: headerRowIndex + 1,
    headerRows: [headerRowIndex],
    mergedCells: ['A1:H1', 'B2:H2'],
    metadataRows: [1],
    name: 'Exception Decisions',
    rows: [
      ...titleRows,
      header,
      ...(rows.length > 0 ? rows : [['No audited exception decisions in this range.']]),
    ],
    titleRows: [0],
    wrapColumns: [2, 3, 4],
  }
}

function buildEmployeeSheets(input: PayrollWorkbookInput, events: PayrollAccountabilityEvent[]): WorkbookSheet[] {
  const review = input.review
  const rows = review.rows
  const workbookWeeks = payrollWorkbookWeeks(input)
  const usedNames = new Set<string>([
    'payroll summary',
    'payroll review',
    'hours variance',
    'site summary',
    'exception decisions',
    ...workbookWeeks.map((week) => `${week.label} detail`.toLocaleLowerCase()),
  ])
  const employeeIds = new Set([...rows.map((row) => row.employeeId), ...events.map((event) => event.employeeId)])

  return [...employeeIds].map((employeeId) => {
    const employeeRows = rows.filter((row) => row.employeeId === employeeId)
    const employeeEvents = events.filter((event) => event.employeeId === employeeId)
    const employeeName = employeeRows[0]?.employeeName ?? employeeEvents[0]?.employeeName ?? 'Employee'
    const workedRows: WorkbookCell[][] = employeeRows.map((row) => {
      return [
        row.employeeName,
        row.employeeId,
        row.username,
        formatUsDateKey(row.operationalDate),
        locationLabel(row),
        row.workType === 'training' ? 'Paid training' : 'Worked time',
        dateTimeText(row.scheduledStartsAt, row.timeZone),
        dateTimeText(row.scheduledEndsAt, row.timeZone),
        dateTimeText(row.firstClockIn, row.timeZone),
        dateTimeText(row.lastClockOut, row.timeZone),
        hours(row.paidMinutes),
        row.payrollBatchWeekStartsOn && row.payrollBatchWeekEndsOn ? `${formatUsDateKey(row.payrollBatchWeekStartsOn)} - ${formatUsDateKey(row.payrollBatchWeekEndsOn)}` : 'Unresolved',
        row.payrollPeriodStartsOn && row.payrollPeriodEndsOn ? `${formatUsDateKey(row.payrollPeriodStartsOn)} - ${formatUsDateKey(row.payrollPeriodEndsOn)}` : '',
        hours(row.regularMinutes),
        hours(row.overtimeMinutes),
        row.breakMinutes,
        row.crossesPayrollBoundary ? 'Yes' : 'No',
        row.payrollAssignmentSource.replaceAll('_', ' '),
        row.manualAdjustment ? 'Yes' : 'No',
        row.payrollReady ? 'Ready' : 'Needs review',
        row.shiftNotes ?? '',
        [...row.exceptionCodes.map((code) => code.replaceAll('_', ' ')), ...row.payrollNotes].join(' | '),
      ]
    })
    const eventRows: WorkbookCell[][] = employeeEvents.map((event) => [
      formatUsDateKey(event.operationalDate),
      eventLabel(event.eventType),
      event.status,
      accountabilityLocation(event),
      hours(accountabilityEventScheduledMinutes(event)),
      hours(accountabilityEventPayableMinutes(event)),
      accountabilityEventPayCategory(event),
      dateTimeText(event.startsAt, event.timeZone),
      dateTimeText(event.endsAt, event.timeZone),
      accountabilityEventReviewNote(event),
      event.note,
      dateTimeText(event.createdAt, event.timeZone),
    ])

    const workedMinutes = employeeRows.reduce((total, row) => total + row.paidMinutes, 0)
    const trainingMinutes = employeeRows.filter((row) => row.workType === 'training').reduce((total, row) => total + row.paidMinutes, 0)
    const scheduledTotal = employeeRows.reduce((total, row) => total + scheduledMinutes(row), 0)
    const sickMinutes = employeeEvents.filter((event) => event.eventType === 'called_in_sick').reduce((total, event) => total + accountabilityEventPayableMinutes(event), 0)
    const ptoMinutes = employeeEvents.filter((event) => event.eventType === 'vacation').reduce((total, event) => total + accountabilityEventPayableMinutes(event), 0)
    const otherPaidMinutes = employeeEvents
      .filter((event) => event.eventType !== 'called_in_sick' && event.eventType !== 'vacation')
      .reduce((total, event) => total + accountabilityEventPayableMinutes(event), 0)
    const employeeNeedsReview = employeeRows.some((row) => !row.payrollReady) || employeeEvents.some((event) => accountabilityEventReviewNote(event) !== '')
    const weeklyTotals: WorkbookCell[][] = workbookWeeks.map((week) => {
      const summary = weeklyPayrollSummary(input, employeeId, week, events)
      return [
        week.label,
        `${formatUsDateKey(week.weekStartsOn)} - ${formatUsDateKey(week.weekEndsOn)} | Scheduled ${hours(summary.scheduledMinutes)} | Worked ${hours(summary.paidMinutes)} | Regular ${hours(summary.regularMinutes)} | OT ${hours(summary.overtimeMinutes)} | Sick ${hours(summary.sickPayMinutes)} | PTO ${hours(summary.vacationPayMinutes)} | Total Payable ${hours(payrollWeeklyTotalPayableMinutes(summary))}`,
      ]
    })
    const titleRows: WorkbookCell[][] = [
      [`${employeeName} — Payroll Detail`],
      ['Pay Period', `${formatUsDateKey(review.fromDate)} - ${formatUsDateKey(review.throughDate)}`],
      ...weeklyTotals,
      ['Period Totals', `Scheduled ${hours(scheduledTotal)} | Worked ${hours(workedMinutes)} | Paid training ${hours(trainingMinutes)} | Sick ${hours(sickMinutes)} | PTO ${hours(ptoMinutes)} | Other Paid ${hours(otherPaidMinutes)} | Total Payable ${hours(workedMinutes + sickMinutes + ptoMinutes + otherPaidMinutes)}`],
      ['Review Status', employeeNeedsReview ? 'Needs review' : 'Ready'],
      [],
    ]
    const workedHeaderRow = titleRows.length
    const workedSectionLength = workedRows.length > 0 ? workedRows.length : 1
    const accountabilityTitleRow = workedHeaderRow + workedSectionLength + 2
    const accountabilityHeaderRow = accountabilityTitleRow + 1

    return {
      centerColumns: [3, 5, 10, 11, 12, 13, 14, 15, 17, 18],
      columnWidths: [24, 38, 18, 14, 38, 18, 24, 24, 24, 24, 15, 25, 25, 14, 14, 14, 18, 24, 18, 16, 42, 46],
      filterRowIndex: workedHeaderRow,
      freezeRows: workedHeaderRow + 1,
      headerRows: [workedHeaderRow, accountabilityHeaderRow],
      integerColumns: [14],
      mergedCells: [
        'A1:V1',
        ...Array.from({ length: titleRows.length - 2 }, (_, index) => `B${index + 2}:V${index + 2}`),
        `A${accountabilityTitleRow + 1}:V${accountabilityTitleRow + 1}`,
      ],
      metadataRows: Array.from({ length: titleRows.length - 2 }, (_, index) => index + 1),
      name: sheetName(employeeName, usedNames),
      rows: [
        ...titleRows,
        ['Employee', 'Employee ID', 'Username', 'Work Date', 'Site / Post', 'Time Category', 'Scheduled Start', 'Scheduled End', 'Actual Clock In', 'Actual Clock Out', 'Worked Hours', 'Payroll Batch Week', 'Payroll Period', 'Regular Hours', 'Overtime Hours', 'Break Minutes', 'Crosses Payroll Boundary', 'Assignment Source', 'Manual Adjustment', 'Exception Status', 'Shift Notes', 'Review Notes'],
        ...(workedRows.length > 0 ? workedRows : [['No worked time rows in this range.']]),
        [],
        ['Accountability / Sick Pay / PTO'],
        ['Date', 'Type', 'Status', 'Location', 'Scheduled Hours', 'Payable Hours', 'Pay Category', 'Start', 'End', 'Review Note', 'Employee Note', 'Created'],
        ...(eventRows.length > 0 ? eventRows : [['No accountability, sick pay, or time-off events in this range.']]),
      ],
      sectionRows: [accountabilityTitleRow],
      titleRows: [0],
      wrapColumns: [4, 6, 7, 8, 9, 11, 12, 17, 20, 21],
    }
  })
}

export function buildPayrollWorkbookSheets(input: PayrollWorkbookInput): WorkbookSheet[] {
  const events = input.accountabilityEvents ?? []
  return [
    buildSummarySheet(input, events),
    ...buildWeeklyDetailSheets(input, events),
    buildDiscrepancySheet(input.review.rows, events),
    buildVarianceSheet(input.review.rows),
    buildSiteSummarySheet(input.review.rows, events),
    buildExceptionDecisionSheet(input.review),
    ...buildEmployeeSheets(input, events),
  ]
}

function workbookXml(sheets: WorkbookSheet[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
</workbook>`
}

function workbookRelsXml(sheets: WorkbookSheet[]): string {
  const sheetRels = sheets.map((_, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  )).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRels}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
}

function contentTypesXml(sheets: WorkbookSheet[]): string {
  const overrides = sheets.map((_, index) => (
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${overrides}
</Types>`
}

const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="6">
    <font><sz val="11"/><name val="Aptos"/></font>
    <font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Aptos Display"/></font>
    <font><b/><sz val="11"/><color rgb="FF201D19"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FF8B352D"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FF166044"/><name val="Aptos"/></font>
  </fonts>
  <fills count="10">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF171511"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF9B6A17"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF7EA"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE7F4ED"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFEDE9"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF5E4BE"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF6F4F0"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="4">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFE4D8C2"/></left><right style="thin"><color rgb="FFE4D8C2"/></right><top style="thin"><color rgb="FFE4D8C2"/></top><bottom style="thin"><color rgb="FFE4D8C2"/></bottom><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFE7E1D7"/></bottom><diagonal/></border>
    <border><left/><right/><top style="medium"><color rgb="FF9B6A17"/></top><bottom style="thin"><color rgb="FFD2B06B"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="15">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="2" fontId="0" fillId="5" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="5" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="2" fontId="2" fillId="8" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="8" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`

function crc32(bytes: Uint8Array): number {
  let crc = -1
  for (const byte of bytes) {
    crc ^= byte
    for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ -1) >>> 0
}

class ZipByteWriter {
  private readonly chunks: Uint8Array[] = []
  private totalLength = 0

  get length(): number {
    return this.totalLength
  }

  writeUInt16(value: number) {
    this.writeBytes(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff))
  }

  writeUInt32(value: number) {
    this.writeBytes(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff))
  }

  writeBytes(bytes: Uint8Array) {
    if (bytes.byteLength === 0) return
    this.chunks.push(bytes)
    this.totalLength += bytes.byteLength
  }

  toUint8Array(): Uint8Array {
    const output = new Uint8Array(this.totalLength)
    let offset = 0
    for (const chunk of this.chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  }
}

function assertZip16(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`Payroll workbook ${label} exceeds the supported ZIP format limit.`)
  }
}

function assertZip32(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Payroll workbook ${label} exceeds the supported ZIP format limit.`)
  }
}

function writeZipEntry(output: ZipByteWriter, name: string, content: Uint8Array): { crc: number; nameBytes: Uint8Array; offset: number; size: number } {
  const nameBytes = new TextEncoder().encode(name)
  const crc = crc32(content)
  const offset = output.length
  assertZip16(nameBytes.length, 'entry name')
  assertZip32(content.length, 'entry size')
  assertZip32(offset, 'entry offset')
  output.writeUInt32(0x04034b50)
  output.writeUInt16(20)
  output.writeUInt16(0)
  output.writeUInt16(0)
  output.writeUInt16(0)
  output.writeUInt16(0)
  output.writeUInt32(crc)
  output.writeUInt32(content.length)
  output.writeUInt32(content.length)
  output.writeUInt16(nameBytes.length)
  output.writeUInt16(0)
  output.writeBytes(nameBytes)
  output.writeBytes(content)
  return { crc, nameBytes, offset, size: content.length }
}

function createZip(files: Array<{ name: string; text: string }>): Uint8Array {
  assertZip16(files.length, 'entry count')
  const output = new ZipByteWriter()
  const encoder = new TextEncoder()
  const entries = files.map((file) => writeZipEntry(output, file.name, encoder.encode(file.text)))
  const centralDirectoryOffset = output.length

  for (const entry of entries) {
    output.writeUInt32(0x02014b50)
    output.writeUInt16(20)
    output.writeUInt16(20)
    output.writeUInt16(0)
    output.writeUInt16(0)
    output.writeUInt16(0)
    output.writeUInt16(0)
    output.writeUInt32(entry.crc)
    output.writeUInt32(entry.size)
    output.writeUInt32(entry.size)
    output.writeUInt16(entry.nameBytes.length)
    output.writeUInt16(0)
    output.writeUInt16(0)
    output.writeUInt16(0)
    output.writeUInt16(0)
    output.writeUInt32(0)
    output.writeUInt32(entry.offset)
    output.writeBytes(entry.nameBytes)
  }

  const centralDirectorySize = output.length - centralDirectoryOffset
  assertZip32(centralDirectoryOffset, 'central-directory offset')
  assertZip32(centralDirectorySize, 'central-directory size')
  output.writeUInt32(0x06054b50)
  output.writeUInt16(0)
  output.writeUInt16(0)
  output.writeUInt16(entries.length)
  output.writeUInt16(entries.length)
  output.writeUInt32(centralDirectorySize)
  output.writeUInt32(centralDirectoryOffset)
  output.writeUInt16(0)
  return output.toUint8Array()
}

export function createPayrollWorkbookBlob(input: PayrollWorkbookInput): Blob {
  const sheets = buildPayrollWorkbookSheets(input)
  const files = [
    { name: '[Content_Types].xml', text: contentTypesXml(sheets) },
    { name: '_rels/.rels', text: rootRelsXml },
    { name: 'xl/workbook.xml', text: workbookXml(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', text: workbookRelsXml(sheets) },
    { name: 'xl/styles.xml', text: stylesXml },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, text: worksheetXml(sheet) })),
  ]
  const workbookBytes = createZip(files)
  const workbookBuffer = new ArrayBuffer(workbookBytes.byteLength)
  new Uint8Array(workbookBuffer).set(workbookBytes)
  return new Blob([workbookBuffer], { type: workbookMimeType })
}

export interface PayrollWorkbookDownloadResult {
  fileName: string
  size: number
}

export function downloadPayrollWorkbook(input: PayrollWorkbookInput, fileName: string): PayrollWorkbookDownloadResult {
  const workbook = createPayrollWorkbookBlob(input)
  if (workbook.size === 0) throw new Error('The payroll workbook could not be created. Please try again.')
  const url = URL.createObjectURL(workbook)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { fileName, size: workbook.size }
}
