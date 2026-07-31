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
  filterRowIndex?: number
  freezeRows?: number
  headerRows?: number[]
  metadataRows?: number[]
  name: string
  rows: WorkbookCell[][]
  sectionRows?: number[]
  titleRows?: number[]
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

function styleForCell(sheet: WorkbookSheet, rowIndex: number): number {
  if (sheet.titleRows?.includes(rowIndex)) return 1
  if (sheet.headerRows?.includes(rowIndex)) return 3
  if (sheet.sectionRows?.includes(rowIndex)) return 4
  if (sheet.metadataRows?.includes(rowIndex)) return 2
  return 0
}

function cellXml(sheet: WorkbookSheet, cell: WorkbookCell, rowIndex: number, columnIndex: number): string {
  const ref = `${columnName(columnIndex)}${rowIndex + 1}`
  const style = styleForCell(sheet, rowIndex)
  const styleAttribute = style > 0 ? ` s="${style}"` : ''
  if (cell === null || cell === undefined || cell === '') return `<c r="${ref}"${styleAttribute}/>`
  if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${ref}"${styleAttribute}><v>${cell}</v></c>`
  if (typeof cell === 'boolean') return `<c r="${ref}" t="b"${styleAttribute}><v>${cell ? 1 : 0}</v></c>`
  return `<c r="${ref}" t="inlineStr"${styleAttribute}><is><t>${xmlEscape(String(cell))}</t></is></c>`
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
    const width = index === 0 ? 24 : index <= 3 ? 18 : 15
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
  }).join('')
  const rows = sheet.rows.map((row, rowIndex) => (
    `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => cellXml(sheet, cell, rowIndex, columnIndex)).join('')}</row>`
  )).join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dimension}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="${freezeRows}" topLeftCell="${topLeftCell}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${columnDefinitions}</cols>
  <sheetData>${rows}</sheetData>
  ${autoFilter}
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

function employeeEventSummary(employeeId: string, events: PayrollAccountabilityEvent[]): string {
  const counts = new Map<string, number>()
  for (const event of events.filter((item) => item.employeeId === employeeId)) {
    const label = eventLabel(event.eventType)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()].map(([label, count]) => `${label}: ${count}`).join('; ')
}

function summaryScheduledMinutes(employeeId: string, rows: TimekeepingReviewRow[]): number {
  return rows
    .filter((row) => row.employeeId === employeeId)
    .reduce((total, row) => total + scheduledMinutes(row), 0)
}

function summaryNotes(summary: PayrollEmployeeSummary, accountabilitySummary: string): string {
  return [...summary.notes, accountabilitySummary].filter(Boolean).join(' | ')
}

function buildSummarySheet(input: PayrollWorkbookInput, summaries: PayrollEmployeeSummary[], events: PayrollAccountabilityEvent[]): WorkbookSheet {
  const review = input.review
  const titleRows: WorkbookCell[][] = [
    ['SygShift Payroll Report'],
    ['Pay Period', `${formatUsDateKey(review.fromDate)} - ${formatUsDateKey(review.throughDate)}`],
    ['Export Type', input.exportType],
    ['Generated From', 'SygShift clock-in/out records only'],
    ['Payroll Rules', input.rules ? `${input.rules.weekStartsOnLabel} week start, ${payrollHours(input.rules.dailyOvertimeMinutes)} daily OT, ${payrollHours(input.rules.weeklyOvertimeMinutes)} weekly OT` : 'Rules loaded from SygShift'],
    ['Export Note', input.exportNote ?? input.batch?.note ?? ''],
    ['Locked Batch', input.batch ? `${input.batch.id} / ${input.batch.digest.slice(0, 12)}` : 'Preview only'],
    [],
  ]
  const header = [
    'Employee',
    'Username',
    'Role',
    'Employment',
    'First Worked Date',
    'Last Worked Date',
    'Worked Shifts',
    'Scheduled Hours',
    'Actual Paid Hours',
    'Regular Hours',
    'Overtime Hours',
    'Break Minutes',
    'Sick / Call-Off / Vacation',
    'Discrepancy Hours',
    'Status',
    'Notes',
  ]
  const body = summaries.map((summary) => {
    const scheduled = summaryScheduledMinutes(summary.employeeId, review.rows)
    const accountabilitySummary = employeeEventSummary(summary.employeeId, events)
    return [
      summary.employeeName,
      summary.username,
      summary.role,
      summary.employmentType,
      formatUsDateKey(summary.firstDate),
      formatUsDateKey(summary.lastDate),
      summary.workedShiftCount,
      hours(scheduled),
      hours(summary.paidMinutes),
      hours(summary.regularMinutes),
      hours(summary.overtimeMinutes),
      summary.breakMinutes,
      accountabilitySummary,
      hours(summary.paidMinutes - scheduled),
      summary.payrollReady ? 'Ready' : 'Needs review',
      summaryNotes(summary, accountabilitySummary),
    ]
  })

  return {
    filterRowIndex: titleRows.length,
    freezeRows: titleRows.length + 1,
    headerRows: [titleRows.length],
    metadataRows: [1, 2, 3, 4, 5, 6],
    name: 'Payroll Summary',
    rows: [...titleRows, header, ...body],
    titleRows: [0],
  }
}

function buildDiscrepancySheet(rows: TimekeepingReviewRow[], events: PayrollAccountabilityEvent[]): WorkbookSheet {
  const header = ['Employee', 'Date', 'Type', 'Location', 'Scheduled Hours', 'Actual Paid Hours', 'Difference', 'Status', 'Notes']
  const rowItems = rows
    .filter((row) => {
      const diff = row.paidMinutes - scheduledMinutes(row)
      return !row.payrollReady || row.exceptionCodes.length > 0 || row.payrollNotes.length > 0 || Math.abs(diff) >= 1 || row.isOvertime
    })
    .map((row) => {
      const scheduled = scheduledMinutes(row)
      return [
        row.employeeName,
        formatUsDateKey(row.operationalDate),
        row.isOvertime ? 'Worked time / Overtime' : 'Worked time',
        locationLabel(row),
        hours(scheduled),
        hours(row.paidMinutes),
        hours(row.paidMinutes - scheduled),
        row.payrollReady ? 'Ready' : 'Needs review',
        [...row.exceptionCodes.map((code) => code.replaceAll('_', ' ')), ...row.payrollNotes].join(' | '),
      ]
    })
  const eventItems = events.map((event) => [
    event.employeeName,
    formatUsDateKey(event.operationalDate),
    eventLabel(event.eventType),
    accountabilityLocation(event),
    '',
    '',
    '',
    event.status,
    event.note,
  ])
  return {
    filterRowIndex: 0,
    freezeRows: 1,
    headerRows: [0],
    name: 'Discrepancies',
    rows: [
      header,
      ...(rowItems.length + eventItems.length > 0 ? [...rowItems, ...eventItems] : [['No discrepancies or accountability events in this range.']]),
    ],
  }
}

function buildSiteSummarySheet(rows: TimekeepingReviewRow[]): WorkbookSheet {
  const sites = new Map<string, {
    breakMinutes: number
    employees: Set<string>
    needsReview: number
    overtimeMinutes: number
    paidMinutes: number
    regularMinutes: number
    scheduledMinutes: number
    shifts: number
  }>()

  for (const row of rows) {
    const key = locationLabel(row)
    const item = sites.get(key) ?? {
      breakMinutes: 0,
      employees: new Set<string>(),
      needsReview: 0,
      overtimeMinutes: 0,
      paidMinutes: 0,
      regularMinutes: 0,
      scheduledMinutes: 0,
      shifts: 0,
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

  const rowsOut = [...sites.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    .map(([location, item]) => [
      location,
      item.shifts,
      item.employees.size,
      hours(item.scheduledMinutes),
      hours(item.paidMinutes),
      hours(item.regularMinutes),
      hours(item.overtimeMinutes),
      item.breakMinutes,
      item.needsReview,
    ])

  return {
    filterRowIndex: 0,
    freezeRows: 1,
    headerRows: [0],
    name: 'Site Summary',
    rows: [
      ['Site / Post', 'Worked Shifts', 'Employees', 'Scheduled Hours', 'Actual Paid Hours', 'Regular Hours', 'Overtime Hours', 'Break Minutes', 'Needs Review'],
      ...(rowsOut.length > 0 ? rowsOut : [['No worked time in this range.']]),
    ],
  }
}

function buildEmployeeSheets(rows: TimekeepingReviewRow[], events: PayrollAccountabilityEvent[]): WorkbookSheet[] {
  const usedNames = new Set<string>(['payroll summary', 'discrepancies', 'site summary'])
  const employeeIds = new Set([...rows.map((row) => row.employeeId), ...events.map((event) => event.employeeId)])

  return [...employeeIds].map((employeeId) => {
    const employeeRows = rows.filter((row) => row.employeeId === employeeId)
    const employeeEvents = events.filter((event) => event.employeeId === employeeId)
    const employeeName = employeeRows[0]?.employeeName ?? employeeEvents[0]?.employeeName ?? 'Employee'
    const workedRows: WorkbookCell[][] = employeeRows.map((row) => [
      formatUsDateKey(row.operationalDate),
      formatUsDateKey(row.weekStartsOn ?? row.operationalDate),
      formatUsDateKey(row.weekEndsOn ?? row.operationalDate),
      locationLabel(row),
      hours(scheduledMinutes(row)),
      dateTimeText(row.firstClockIn, row.timeZone),
      dateTimeText(row.lastClockOut, row.timeZone),
      hours(row.grossMinutes),
      row.breakMinutes,
      hours(row.paidMinutes),
      hours(row.regularMinutes),
      hours(row.overtimeMinutes),
      row.payrollReady ? 'Ready' : 'Needs review',
      row.exceptionCodes.map((code) => code.replaceAll('_', ' ')).join(' | '),
      row.payrollNotes.join(' | '),
    ])
    const eventRows: WorkbookCell[][] = employeeEvents.map((event) => [
      formatUsDateKey(event.operationalDate),
      eventLabel(event.eventType),
      event.status,
      accountabilityLocation(event),
      dateTimeText(event.startsAt, event.timeZone),
      dateTimeText(event.endsAt, event.timeZone),
      event.note,
      dateTimeText(event.createdAt, event.timeZone),
    ])

    const workedSectionLength = workedRows.length > 0 ? workedRows.length : 1
    const accountabilityTitleRow = workedSectionLength + 3
    const accountabilityHeaderRow = workedSectionLength + 4

    return {
      filterRowIndex: 1,
      freezeRows: 2,
      headerRows: [1, accountabilityHeaderRow],
      name: sheetName(employeeName, usedNames),
      rows: [
        ['Worked Time'],
        ['Date', 'Week Start', 'Week End', 'Location', 'Scheduled Hours', 'Clock In', 'Clock Out', 'Gross Hours', 'Break Minutes', 'Paid Hours', 'Regular Hours', 'Overtime Hours', 'Status', 'Exceptions', 'Payroll Notes'],
        ...(workedRows.length > 0 ? workedRows : [['No worked time rows in this range.']]),
        [],
        ['Accountability / Time Off'],
        ['Date', 'Type', 'Status', 'Location', 'Start', 'End', 'Note', 'Created'],
        ...(eventRows.length > 0 ? eventRows : [['No accountability or time-off events in this range.']]),
      ],
      sectionRows: [accountabilityTitleRow],
      titleRows: [0],
    }
  })
}

export function buildPayrollWorkbookSheets(input: PayrollWorkbookInput): WorkbookSheet[] {
  const summaries = summarizePayrollRowsByEmployee(input.review.rows)
  const events = input.accountabilityEvents ?? []
  return [
    buildSummarySheet(input, summaries, events),
    buildDiscrepancySheet(input.review.rows, events),
    buildSiteSummarySheet(input.review.rows),
    ...buildEmployeeSheets(input.review.rows, events),
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
  <fonts count="4">
    <font><sz val="11"/><name val="Aptos"/></font>
    <font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Aptos Display"/></font>
    <font><b/><sz val="11"/><color rgb="FF201D19"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF171511"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF9B6A17"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF7EA"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFE4D8C2"/></left><right style="thin"><color rgb="FFE4D8C2"/></right><top style="thin"><color rgb="FFE4D8C2"/></top><bottom style="thin"><color rgb="FFE4D8C2"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
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
