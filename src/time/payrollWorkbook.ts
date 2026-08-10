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
  return value
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

function buildSummarySheet(input: PayrollWorkbookInput, summaries: PayrollEmployeeSummary[], events: PayrollAccountabilityEvent[]): WorkbookSheet {
  const review = input.review
  const accountabilitySummaries = summarizePayrollAccountabilityByEmployee(events)
  const summaryIds = new Set([...summaries.map((summary) => summary.employeeId), ...accountabilitySummaries.map((summary) => summary.employeeId)])
  const titleRows: WorkbookCell[][] = [
    ['SygShift Payroll Report'],
    ['Pay Period', `${formatUsDateKey(review.fromDate)} - ${formatUsDateKey(review.throughDate)}`],
    ['Report Status', input.exportType],
    ['Pay Basis', 'Completed SygShift clock-in/out records plus approved sick and PTO hours. Scheduled hours are shown only for comparison.'],
    ['Payroll Rules', input.rules ? `${input.rules.weekStartsOnLabel} week start, ${payrollHours(input.rules.dailyOvertimeMinutes)} daily OT, ${payrollHours(input.rules.weeklyOvertimeMinutes)} weekly OT` : 'Rules loaded from SygShift'],
    ['Review Note', input.exportNote ?? input.batch?.note ?? ''],
    ['Batch', input.batch ? `Locked payroll batch ${input.batch.id} / ${input.batch.digest.slice(0, 12)}` : 'Preview only — not an official payroll submission'],
    [],
  ]
  const header = [
    'Employee',
    'Employment',
    'Worked Shifts',
    'Scheduled Hours',
    'Worked Hours',
    'Sick Pay Hours',
    'PTO Hours',
    'Other Paid Hours',
    'Total Payable',
    'Regular Hours',
    'Overtime Hours',
    'Status',
  ]
  const body = [...summaryIds].map((employeeId) => {
    const summary = summaries.find((item) => item.employeeId === employeeId)
    const accountabilityPaySummary = getPayrollAccountabilitySummary(employeeId, accountabilitySummaries)
    const scheduled = summaryScheduledMinutes(employeeId, review.rows) + (accountabilityPaySummary?.scheduledMinutes ?? 0)
    const payableMinutes = payrollPayableMinutes(summary, accountabilityPaySummary)
    const needsReview = !summary?.payrollReady || (accountabilityPaySummary?.reviewCount ?? 0) > 0
    return [
      summary?.employeeName ?? accountabilityPaySummary?.employeeName ?? 'Employee',
      summary?.employmentType ?? accountabilityPaySummary?.employmentType ?? '',
      summary?.workedShiftCount ?? 0,
      hours(scheduled),
      hours(summary?.paidMinutes ?? 0),
      hours(accountabilityPaySummary?.sickPayMinutes ?? 0),
      hours(accountabilityPaySummary?.vacationPayMinutes ?? 0),
      hours(accountabilityPaySummary?.otherPaidMinutes ?? 0),
      hours(payableMinutes),
      hours(summary?.regularMinutes ?? 0),
      hours(summary?.overtimeMinutes ?? 0),
      needsReview ? 'Needs review' : 'Ready',
    ]
  })
  const totals = body.reduce((result, row) => {
    for (let column = 2; column <= 10; column += 1) result[column] = Number(result[column] ?? 0) + Number(row[column] ?? 0)
    return result
  }, ['Payroll totals', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, ''] as WorkbookCell[])
  totals[11] = body.some((row) => row[11] === 'Needs review') ? 'Needs review' : 'Ready'
  const headerRowIndex = titleRows.length
  const totalsRowIndex = headerRowIndex + body.length + 1

  return {
    centerColumns: [1, 2, 11],
    columnWidths: [26, 14, 14, 16, 15, 15, 14, 16, 16, 14, 15, 16],
    filterRowIndex: headerRowIndex,
    freezeRows: headerRowIndex + 1,
    headerRows: [headerRowIndex],
    integerColumns: [2],
    mergedCells: [
      'A1:L1',
      'B2:L2',
      'B3:L3',
      'B4:L4',
      'B5:L5',
      'B6:L6',
      'B7:L7',
    ],
    metadataRows: [1, 2, 3, 4, 5, 6],
    name: 'Payroll Summary',
    rowHeights: {
      3: 34,
      4: 30,
      5: 30,
    },
    rows: [...titleRows, header, ...body, totals],
    titleRows: [0],
    totalsRows: [totalsRowIndex],
  }
}

function buildDiscrepancySheet(rows: TimekeepingReviewRow[], events: PayrollAccountabilityEvent[]): WorkbookSheet {
  const header = ['Employee', 'Date', 'Issue', 'Location', 'Scheduled', 'Worked', 'Payable', 'Variance', 'Status', 'Review Notes']
  const rowItems = rows
    .filter((row) => !row.payrollReady || row.exceptionCodes.length > 0 || row.payrollNotes.length > 0)
    .map((row) => {
      const scheduled = scheduledMinutes(row)
      return [
        row.employeeName,
        formatUsDateKey(row.operationalDate),
        row.exceptionCodes.length > 0 ? row.exceptionCodes.map((code) => code.replaceAll('_', ' ')).join(', ') : 'Payroll review',
        locationLabel(row),
        hours(scheduled),
        hours(row.paidMinutes),
        hours(row.paidMinutes),
        hours(row.paidMinutes - scheduled),
        row.payrollReady ? 'Ready' : 'Needs review',
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
      hours(scheduled),
      '',
      hours(payable),
      hours(payable - scheduled),
      reviewNote ? 'Needs review' : event.status,
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
    centerColumns: [1, 4, 5, 6, 7, 8],
    columnWidths: [24, 14, 24, 38, 13, 13, 13, 13, 16, 48],
    filterRowIndex: headerRowIndex,
    freezeRows: headerRowIndex + 1,
    headerRows: [headerRowIndex],
    integerColumns: [],
    mergedCells: ['A1:J1', 'B2:J2'],
    metadataRows: [1],
    name: 'Payroll Review',
    rows: [
      ...titleRows,
      header,
      ...(rowItems.length + eventItems.length > 0 ? [...rowItems, ...eventItems] : [['No discrepancies or accountability events in this range.']]),
    ],
    titleRows: [0],
    wrapColumns: [2, 3, 9],
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
      vacationPayMinutes: 0,
    }
    item.breakMinutes += row.breakMinutes
    item.employees.add(row.employeeName)
    item.needsReview += row.payrollReady && row.exceptionCodes.length === 0 ? 0 : 1
    item.overtimeMinutes += row.overtimeMinutes
    item.paidMinutes += row.paidMinutes
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
    centerColumns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    columnWidths: [42, 12, 15, 16, 15, 14, 14, 16, 17, 15, 16],
    filterRowIndex: headerRowIndex,
    freezeRows: headerRowIndex + 1,
    headerRows: [headerRowIndex],
    integerColumns: [1, 2, 10],
    mergedCells: ['A1:K1', 'B2:K2'],
    metadataRows: [1],
    name: 'Site Summary',
    rows: [
      ...titleRows,
      ['Site / Post', 'Employees', 'Worked Shifts', 'Scheduled Hours', 'Worked Hours', 'Sick Pay', 'PTO Hours', 'Other Paid', 'Total Payable', 'Overtime', 'Review Items'],
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

function buildEmployeeSheets(review: TimekeepingReview, events: PayrollAccountabilityEvent[]): WorkbookSheet[] {
  const rows = review.rows
  const usedNames = new Set<string>(['payroll summary', 'payroll review', 'hours variance', 'site summary', 'exception decisions'])
  const employeeIds = new Set([...rows.map((row) => row.employeeId), ...events.map((event) => event.employeeId)])

  return [...employeeIds].map((employeeId) => {
    const employeeRows = rows.filter((row) => row.employeeId === employeeId)
    const employeeEvents = events.filter((event) => event.employeeId === employeeId)
    const employeeName = employeeRows[0]?.employeeName ?? employeeEvents[0]?.employeeName ?? 'Employee'
    const workedRows: WorkbookCell[][] = employeeRows.map((row) => {
      const scheduled = scheduledMinutes(row)
      return [
        formatUsDateKey(row.operationalDate),
        locationLabel(row),
        hours(scheduled),
        dateTimeText(row.firstClockIn, row.timeZone),
        dateTimeText(row.lastClockOut, row.timeZone),
        row.breakMinutes,
        hours(row.paidMinutes),
        hours(row.regularMinutes),
        hours(row.overtimeMinutes),
        hours(row.paidMinutes - scheduled),
        row.payrollReady ? 'Ready' : 'Needs review',
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
    const scheduledTotal = employeeRows.reduce((total, row) => total + scheduledMinutes(row), 0)
    const sickMinutes = employeeEvents.filter((event) => event.eventType === 'called_in_sick').reduce((total, event) => total + accountabilityEventPayableMinutes(event), 0)
    const ptoMinutes = employeeEvents.filter((event) => event.eventType === 'vacation').reduce((total, event) => total + accountabilityEventPayableMinutes(event), 0)
    const employeeNeedsReview = employeeRows.some((row) => !row.payrollReady) || employeeEvents.some((event) => accountabilityEventReviewNote(event) !== '')
    const titleRows: WorkbookCell[][] = [
      [`${employeeName} — Payroll Detail`],
      ['Pay Period', `${formatUsDateKey(review.fromDate)} - ${formatUsDateKey(review.throughDate)}`],
      ['Period Totals', `Scheduled ${hours(scheduledTotal)} | Worked ${hours(workedMinutes)} | Sick ${hours(sickMinutes)} | PTO ${hours(ptoMinutes)} | Total Payable ${hours(workedMinutes + sickMinutes + ptoMinutes)}`],
      ['Review Status', employeeNeedsReview ? 'Needs review' : 'Ready'],
      [],
    ]
    const workedHeaderRow = titleRows.length
    const workedSectionLength = workedRows.length > 0 ? workedRows.length : 1
    const accountabilityTitleRow = workedHeaderRow + workedSectionLength + 2
    const accountabilityHeaderRow = accountabilityTitleRow + 1

    return {
      centerColumns: [0, 2, 5, 6, 7, 8, 9, 10],
      columnWidths: [14, 38, 14, 24, 24, 14, 14, 14, 14, 15, 16, 46],
      filterRowIndex: workedHeaderRow,
      freezeRows: workedHeaderRow + 1,
      headerRows: [workedHeaderRow, accountabilityHeaderRow],
      integerColumns: [5],
      mergedCells: ['A1:L1', 'B2:L2', 'B3:L3', 'B4:L4', `A${accountabilityTitleRow + 1}:L${accountabilityTitleRow + 1}`],
      metadataRows: [1, 2, 3],
      name: sheetName(employeeName, usedNames),
      rows: [
        ...titleRows,
        ['Date', 'Site / Post', 'Scheduled', 'Clock In', 'Clock Out', 'Break Min', 'Paid Hours', 'Regular', 'Overtime', 'Variance', 'Status', 'Review Notes'],
        ...(workedRows.length > 0 ? workedRows : [['No worked time rows in this range.']]),
        [],
        ['Accountability / Sick Pay / PTO'],
        ['Date', 'Type', 'Status', 'Location', 'Scheduled Hours', 'Payable Hours', 'Pay Category', 'Start', 'End', 'Review Note', 'Employee Note', 'Created'],
        ...(eventRows.length > 0 ? eventRows : [['No accountability, sick pay, or time-off events in this range.']]),
      ],
      sectionRows: [accountabilityTitleRow],
      titleRows: [0],
      wrapColumns: [1, 3, 4, 11],
    }
  })
}

export function buildPayrollWorkbookSheets(input: PayrollWorkbookInput): WorkbookSheet[] {
  const summaries = summarizePayrollRowsByEmployee(input.review.rows)
  const events = input.accountabilityEvents ?? []
  return [
    buildSummarySheet(input, summaries, events),
    buildDiscrepancySheet(input.review.rows, events),
    buildVarianceSheet(input.review.rows),
    buildSiteSummarySheet(input.review.rows, events),
    buildExceptionDecisionSheet(input.review),
    ...buildEmployeeSheets(input.review, events),
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

function writeUInt32(output: number[], value: number) {
  output.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

function writeUInt16(output: number[], value: number) {
  output.push(value & 0xff, (value >>> 8) & 0xff)
}

function writeZipEntry(output: number[], name: string, content: Uint8Array): { crc: number; nameBytes: Uint8Array; offset: number; size: number } {
  const nameBytes = new TextEncoder().encode(name)
  const crc = crc32(content)
  const offset = output.length
  writeUInt32(output, 0x04034b50)
  writeUInt16(output, 20)
  writeUInt16(output, 0)
  writeUInt16(output, 0)
  writeUInt16(output, 0)
  writeUInt16(output, 0)
  writeUInt32(output, crc)
  writeUInt32(output, content.length)
  writeUInt32(output, content.length)
  writeUInt16(output, nameBytes.length)
  writeUInt16(output, 0)
  output.push(...nameBytes, ...content)
  return { crc, nameBytes, offset, size: content.length }
}

function createZip(files: Array<{ name: string; text: string }>): Uint8Array {
  const output: number[] = []
  const encoder = new TextEncoder()
  const entries = files.map((file) => writeZipEntry(output, file.name, encoder.encode(file.text)))
  const centralDirectoryOffset = output.length

  for (const entry of entries) {
    writeUInt32(output, 0x02014b50)
    writeUInt16(output, 20)
    writeUInt16(output, 20)
    writeUInt16(output, 0)
    writeUInt16(output, 0)
    writeUInt16(output, 0)
    writeUInt16(output, 0)
    writeUInt32(output, entry.crc)
    writeUInt32(output, entry.size)
    writeUInt32(output, entry.size)
    writeUInt16(output, entry.nameBytes.length)
    writeUInt16(output, 0)
    writeUInt16(output, 0)
    writeUInt16(output, 0)
    writeUInt16(output, 0)
    writeUInt32(output, 0)
    writeUInt32(output, entry.offset)
    output.push(...entry.nameBytes)
  }

  const centralDirectorySize = output.length - centralDirectoryOffset
  writeUInt32(output, 0x06054b50)
  writeUInt16(output, 0)
  writeUInt16(output, 0)
  writeUInt16(output, entries.length)
  writeUInt16(output, entries.length)
  writeUInt32(output, centralDirectorySize)
  writeUInt32(output, centralDirectoryOffset)
  writeUInt16(output, 0)
  return new Uint8Array(output)
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

export function downloadPayrollWorkbook(input: PayrollWorkbookInput, fileName: string) {
  const url = URL.createObjectURL(createPayrollWorkbookBlob(input))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
