import { PDFDocument, StandardFonts, type Color, type PDFFont, type PDFPage } from 'pdf-lib'
import { downloadXlsxWorkbook, type XlsxCell, type XlsxSheet } from '../lib/xlsxWorkbook'
import {
  addReportPdfFooters,
  addReportPdfPage,
  drawReportPdfText,
  pdfSafeText,
  reportPdfColors,
} from './pdfReportLayout'
import type {
  WorkforceActivityExportMetadata,
  WorkforceActivityOutcome,
  WorkforceActivityRow,
} from './workforceActivityTypes'

const reportTitle = 'Workforce Activity'

const outcomeLabels: Record<WorkforceActivityOutcome, string> = {
  worked_as_scheduled: 'Worked as scheduled',
  replacement_worked: 'Replacement worked',
  worked_not_scheduled: 'Worked, not scheduled',
  salary_worked_confirmed: 'Salary work confirmed',
  scheduled_no_work_record: 'Scheduled, no work record',
  called_off: 'Called off',
  open_unassigned: 'Open / unassigned',
  needs_time_correction: 'Needs time correction',
}

export type WorkforceActivitySummary = {
  hourlyWorkedMinutes: number
  salaryConfirmedRows: number
  needsReview: number
  payrollReady: number
  totalRows: number
  uniqueEmployees: number
}

type DetailColumn = {
  label: string
  value: (row: WorkforceActivityRow) => XlsxCell
  width: number
}

function isSalaryRow(row: WorkforceActivityRow): boolean {
  return row.employmentType?.toLocaleLowerCase() === 'salary' || row.outcome === 'salary_worked_confirmed'
}

export function workforceActivityOutcomeLabel(row: WorkforceActivityRow): string {
  return outcomeLabels[row.outcome]
}

function workedMinutesValue(row: WorkforceActivityRow): number | null {
  return isSalaryRow(row) ? null : row.workedMinutes
}

function hours(minutes: number | null): number | null {
  return minutes === null ? null : Number((minutes / 60).toFixed(2))
}

function dateKey(value: string): string {
  const [year, month, day] = value.slice(0, 10).split('-')
  return year && month && day ? `${month}/${day}/${year}` : value
}

function dateTime(value: string | null, timeZone: string): string {
  if (!value) return ''
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return value
  try {
    return new Intl.DateTimeFormat('en-US', {
      day: '2-digit', hour: 'numeric', minute: '2-digit', month: '2-digit',
      timeZone, year: 'numeric',
    }).format(instant)
  } catch {
    return value
  }
}

function generatedAt(value: string): string {
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short',
    timeZone: 'UTC', timeZoneName: 'short', year: 'numeric',
  }).format(instant)
}

function employmentLabel(value: string | null): string {
  if (!value) return 'Not recorded'
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toLocaleUpperCase())
}

function payrollReadyLabel(value: boolean | null): string {
  if (value === true) return 'Ready'
  if (value === false) return 'Not ready'
  return 'Not applicable'
}

function notesLabel(notes: string[]): string {
  return notes.map((note) => note.trim()).filter(Boolean).join(' | ')
}

export function summarizeWorkforceActivityRows(rows: readonly WorkforceActivityRow[]): WorkforceActivitySummary {
  const identities = new Set(rows.flatMap((row) => {
    const identity = row.employeeId ?? row.employeeNumber
    return identity ? [identity] : []
  }))
  return {
    hourlyWorkedMinutes: rows.reduce((total, row) => total + (workedMinutesValue(row) ?? 0), 0),
    salaryConfirmedRows: rows.filter((row) => row.outcome === 'salary_worked_confirmed').length,
    needsReview: rows.filter((row) => ['called_off', 'scheduled_no_work_record', 'open_unassigned', 'needs_time_correction'].includes(row.outcome)).length,
    payrollReady: rows.filter((row) => !isSalaryRow(row) && row.payrollReady === true).length,
    totalRows: rows.length,
    uniqueEmployees: identities.size,
  }
}

function detailColumns(): DetailColumn[] {
  return [
    { label: 'Work Date', width: 14, value: (row) => dateKey(row.operationalDate) },
    { label: 'Legal Employee Name', width: 28, value: (row) => row.employeeName ?? 'Open / unassigned' },
    { label: 'Employee Number', width: 17, value: (row) => row.employeeNumber },
    { label: 'Employment Type', width: 18, value: (row) => employmentLabel(row.employmentType) },
    { label: 'Client', width: 26, value: (row) => row.clientName },
    { label: 'Event', width: 26, value: (row) => row.eventName },
    { label: 'Site Code', width: 14, value: (row) => row.siteCode },
    { label: 'Site', width: 27, value: (row) => row.siteName },
    { label: 'Post', width: 27, value: (row) => row.postName },
    { label: 'Location', width: 30, value: (row) => row.locationLabel },
    { label: 'Location Detail', width: 38, value: (row) => row.locationDetail },
    { label: 'Scheduled Start', width: 23, value: (row) => dateTime(row.scheduledStartAt, row.timeZone) },
    { label: 'Scheduled End', width: 23, value: (row) => dateTime(row.scheduledEndAt, row.timeZone) },
    { label: 'Scheduled Minutes', width: 19, value: (row) => row.scheduledMinutes },
    { label: 'Actual Start', width: 23, value: (row) => isSalaryRow(row) ? null : dateTime(row.actualStartAt, row.timeZone) },
    { label: 'Actual End', width: 23, value: (row) => isSalaryRow(row) ? null : dateTime(row.actualEndAt, row.timeZone) },
    { label: 'Unpaid Break Minutes', width: 21, value: (row) => isSalaryRow(row) ? null : row.unpaidBreakMinutes },
    { label: 'Worked Minutes', width: 18, value: workedMinutesValue },
    { label: 'Worked Hours', width: 16, value: (row) => hours(workedMinutesValue(row)) },
    { label: 'Outcome', width: 27, value: workforceActivityOutcomeLabel },
    { label: 'Payroll Ready', width: 17, value: (row) => isSalaryRow(row) ? 'Not applicable' : payrollReadyLabel(row.payrollReady) },
    { label: 'Time Zone', width: 25, value: (row) => row.timeZone },
    { label: 'Notes', width: 48, value: (row) => notesLabel(row.notes) },
    { label: 'Activity Record ID', width: 38, value: (row) => row.id },
    { label: 'Employee ID', width: 38, value: (row) => row.employeeId },
    { label: 'Shift ID', width: 38, value: (row) => row.shiftId },
    { label: 'Assignment ID', width: 38, value: (row) => row.assignmentId },
    { label: 'Client ID', width: 38, value: (row) => row.clientId },
    { label: 'Event ID', width: 38, value: (row) => row.eventId },
    { label: 'Site ID', width: 38, value: (row) => row.siteId },
    { label: 'Post ID', width: 38, value: (row) => row.postId },
  ]
}

export function workforceActivityWorkbook(
  rows: readonly WorkforceActivityRow[],
  metadata: WorkforceActivityExportMetadata,
): XlsxSheet[] {
  const columns = detailColumns()
  const summary = summarizeWorkforceActivityRows(rows)
  const headerRowIndex = 11
  const lastColumn = 'AE'
  return [{
    centerColumns: [0, 2, 3, 6, 13, 16, 17, 18, 19, 20, 21],
    columnWidths: columns.map((column) => column.width),
    filterRowIndex: headerRowIndex,
    freezeRows: headerRowIndex + 1,
    headerRows: [headerRowIndex],
    integerColumns: [13, 16, 17],
    mergedCells: [
      `A1:${lastColumn}1`,
      ...Array.from({ length: 9 }, (_, index) => `B${index + 2}:${lastColumn}${index + 2}`),
    ],
    metadataRows: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    name: 'Workforce Activity',
    rows: [
      [`SygShift ${reportTitle}`],
      ['Reporting period', `${dateKey(metadata.fromDate)} through ${dateKey(metadata.throughDate)}`],
      ['Generated', generatedAt(metadata.generatedAt)],
      ['Filters', metadata.filterDescription || 'All workforce activity'],
      ['Matching activity records', summary.totalRows],
      ['Unique employees', summary.uniqueEmployees],
      ['Hourly worked hours', hours(summary.hourlyWorkedMinutes)],
      ['Salary confirmations', summary.salaryConfirmedRows],
      ['Needs review', summary.needsReview],
      ['Payroll-ready records', summary.payrollReady],
      [],
      columns.map((column) => column.label),
      ...rows.map((row) => columns.map((column) => column.value(row))),
    ],
    statusColumns: [19, 20],
    titleRows: [0],
    wrapColumns: [1, 4, 5, 7, 8, 9, 10, 19, 22],
  }]
}

function wrapPdfText(value: unknown, font: PDFFont, size: number, maximumWidth: number): string[] {
  const paragraphs = String(value ?? '').split(/\r?\n/)
  const lines: string[] = []
  for (const paragraphValue of paragraphs) {
    const paragraph = pdfSafeText(paragraphValue)
    if (!paragraph) {
      lines.push('')
      continue
    }
    const words = paragraph.split(' ')
    let line = ''
    for (const originalWord of words) {
      let word = originalWord
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= maximumWidth) {
        line = candidate
        continue
      }
      if (line) {
        lines.push(line)
        line = ''
      }
      while (word && font.widthOfTextAtSize(word, size) > maximumWidth) {
        let splitAt = word.length - 1
        while (splitAt > 1 && font.widthOfTextAtSize(word.slice(0, splitAt), size) > maximumWidth) splitAt -= 1
        lines.push(word.slice(0, splitAt))
        word = word.slice(splitAt)
      }
      line = word
    }
    if (line) lines.push(line)
  }
  return lines.length ? lines : ['']
}

function drawWrappedLines(
  page: PDFPage,
  lines: string[],
  options: { color: Color; font: PDFFont; lineHeight: number; size: number; width: number; x: number; y: number },
): void {
  lines.forEach((line, index) => drawReportPdfText(page, line, {
    color: options.color,
    font: options.font,
    maximumWidth: options.width,
    size: options.size,
    x: options.x,
    y: options.y - index * options.lineHeight,
  }))
}

export async function workforceActivityPdf(
  rows: readonly WorkforceActivityRow[],
  metadata: WorkforceActivityExportMetadata,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pageWidth = 792
  const pageHeight = 612
  const margin = 26
  const usableWidth = pageWidth - margin * 2
  const lineHeight = 8.1
  const bodyFontSize = 6.35
  const columns = [
    { headings: ['Work date', 'Legal employee'], width: 118 },
    { headings: ['Client', 'Event'], width: 96 },
    { headings: ['Site / Post', 'Location'], width: 145 },
    { headings: ['Scheduled', 'Local time'], width: 93 },
    { headings: ['Actual', 'Local time'], width: 93 },
    { headings: ['Worked', 'Outcome'], width: 93 },
    { headings: ['Time zone', 'Notes'], width: usableWidth - 638 },
  ]
  const summary = summarizeWorkforceActivityRows(rows)

  const cellValues = (row: WorkforceActivityRow): string[] => {
    const site = [row.siteCode, row.siteName].filter(Boolean).join(' / ') || 'Not linked'
    const post = row.postName ?? 'Not linked'
    const workedMinutes = workedMinutesValue(row)
    return [
      [dateKey(row.operationalDate), row.employeeName ?? 'Open / unassigned', row.employeeNumber ?? 'No employee number'].join('\n'),
      [`Client: ${row.clientName ?? 'Not linked'}`, `Event: ${row.eventName ?? 'Not linked'}`].join('\n'),
      [`Site: ${site}`, `Post: ${post}`, `Location: ${row.locationLabel || 'Not recorded'}`, row.locationDetail ? `Detail: ${row.locationDetail}` : ''].filter(Boolean).join('\n'),
      [`Start: ${dateTime(row.scheduledStartAt, row.timeZone) || 'Not recorded'}`, `End: ${dateTime(row.scheduledEndAt, row.timeZone) || 'Not recorded'}`, `Scheduled: ${row.scheduledMinutes === null ? 'Not recorded' : `${row.scheduledMinutes} min`}`].join('\n'),
      isSalaryRow(row)
        ? ['Start: Not applicable', 'End: Not applicable', 'Unpaid break: Not applicable'].join('\n')
        : [`Start: ${dateTime(row.actualStartAt, row.timeZone) || 'Not recorded'}`, `End: ${dateTime(row.actualEndAt, row.timeZone) || 'Not recorded'}`, `Unpaid break: ${row.unpaidBreakMinutes === null ? 'Not recorded' : `${row.unpaidBreakMinutes} min`}`].join('\n'),
      (isSalaryRow(row)
        ? [workforceActivityOutcomeLabel(row), 'Payroll: Not applicable']
        : [`Worked: ${workedMinutes === null ? '-' : `${workedMinutes} min`}`, workforceActivityOutcomeLabel(row), `Payroll: ${payrollReadyLabel(row.payrollReady)}`]
      ).join('\n'),
      [row.timeZone, notesLabel(row.notes) ? `Notes: ${notesLabel(row.notes)}` : 'Notes: None', `Record: ${row.id}`].join('\n'),
    ]
  }

  const beginPage = (firstPage: boolean) => {
    const state = addReportPdfPage({
      bold,
      document: pdf,
      height: pageHeight,
      kicker: 'SygShift Workforce Reporting',
      margin,
      regular,
      subtitle: `${dateKey(metadata.fromDate)} through ${dateKey(metadata.throughDate)} | Generated ${generatedAt(metadata.generatedAt)}`,
      title: reportTitle,
      width: pageWidth,
    })
    let y = state.bodyTop
    const filterLines = wrapPdfText(`Filters: ${metadata.filterDescription || 'All workforce activity'}`, regular, 7.2, usableWidth)
    drawWrappedLines(state.page, filterLines, {
      color: reportPdfColors.muted, font: regular, lineHeight: 9, size: 7.2, width: usableWidth, x: margin, y,
    })
    y -= filterLines.length * 9 + 4
    if (firstPage) {
      const summaryText = `${summary.totalRows} records | ${summary.uniqueEmployees} employees | ${hours(summary.hourlyWorkedMinutes) ?? 0} hourly worked hr | ${summary.salaryConfirmedRows} salary confirmations | ${summary.needsReview} need review`
      drawReportPdfText(state.page, summaryText, {
        color: reportPdfColors.ink, font: bold, maximumWidth: usableWidth, size: 7.4, x: margin, y,
      })
      y -= 13
    } else {
      drawReportPdfText(state.page, `${rows.length} matching records | Continued`, {
        color: reportPdfColors.muted, font: regular, maximumWidth: usableWidth, size: 7.2, x: margin, y,
      })
      y -= 13
    }
    const headerHeight = 24
    state.page.drawRectangle({ x: margin, y: y - headerHeight, width: usableWidth, height: headerHeight, color: reportPdfColors.gold })
    let x = margin
    columns.forEach((column) => {
      drawReportPdfText(state.page, column.headings[0], {
        color: reportPdfColors.ink, font: bold, maximumWidth: column.width - 8, size: 6.8, x: x + 4, y: y - 9,
      })
      drawReportPdfText(state.page, column.headings[1], {
        color: reportPdfColors.ink, font: bold, maximumWidth: column.width - 8, size: 6.8, x: x + 4, y: y - 18,
      })
      x += column.width
      if (x < pageWidth - margin) state.page.drawLine({
        start: { x, y }, end: { x, y: y - headerHeight }, thickness: 0.4, color: reportPdfColors.ink,
      })
    })
    return { ...state, y: y - headerHeight - 3 }
  }

  let current = beginPage(true)
  if (rows.length === 0) {
    drawReportPdfText(current.page, 'No workforce activity matched the selected filters.', {
      color: reportPdfColors.muted,
      font: regular,
      maximumWidth: usableWidth,
      size: 9,
      x: margin + 4,
      y: current.y - 18,
    })
  }
  rows.forEach((row, rowIndex) => {
    const wrapped = cellValues(row).map((value, columnIndex) => wrapPdfText(
      value,
      columnIndex === 0 ? bold : regular,
      bodyFontSize,
      columns[columnIndex].width - 8,
    ))
    const totalLines = Math.max(...wrapped.map((lines) => lines.length), 1)
    let lineOffset = 0
    while (lineOffset < totalLines) {
      const minimumHeight = lineHeight + 8
      if (current.y - minimumHeight < current.bottom) current = beginPage(false)
      const availableLines = Math.max(1, Math.floor((current.y - current.bottom - 8) / lineHeight))
      const chunkLines = Math.min(totalLines - lineOffset, availableLines)
      const rowHeight = Math.max(32, chunkLines * lineHeight + 8)
      if (current.y - rowHeight < current.bottom) {
        current = beginPage(false)
        continue
      }
      const rowTop = current.y
      const rowBottom = rowTop - rowHeight
      if (rowIndex % 2 === 1) current.page.drawRectangle({
        x: margin, y: rowBottom, width: usableWidth, height: rowHeight, color: reportPdfColors.soft,
      })
      let x = margin
      columns.forEach((column, columnIndex) => {
        const lines = wrapped[columnIndex].slice(lineOffset, lineOffset + chunkLines)
        drawWrappedLines(current.page, lines, {
          color: columnIndex === 0 ? reportPdfColors.ink : reportPdfColors.muted,
          font: columnIndex === 0 ? bold : regular,
          lineHeight,
          size: bodyFontSize,
          width: column.width - 8,
          x: x + 4,
          y: rowTop - 10,
        })
        x += column.width
        if (x < pageWidth - margin) current.page.drawLine({
          start: { x, y: rowTop }, end: { x, y: rowBottom }, thickness: 0.35, color: reportPdfColors.rule,
        })
      })
      current.page.drawLine({
        start: { x: margin, y: rowBottom }, end: { x: pageWidth - margin, y: rowBottom },
        thickness: 0.45, color: reportPdfColors.rule,
      })
      current.y = rowBottom
      lineOffset += chunkLines
      if (lineOffset < totalLines) current = beginPage(false)
    }
  })
  addReportPdfFooters(pdf, regular, 'Protected workforce activity report')
  return pdf.save({ useObjectStreams: false })
}

export function workforceActivityExportFileName(
  format: 'xlsx' | 'pdf',
  metadata: Pick<WorkforceActivityExportMetadata, 'fromDate' | 'throughDate'>,
): string {
  return `sygshift-workforce-activity-${metadata.fromDate}-to-${metadata.throughDate}.${format}`
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function downloadWorkforceActivityXlsx(
  rows: readonly WorkforceActivityRow[],
  metadata: WorkforceActivityExportMetadata,
): string {
  const fileName = workforceActivityExportFileName('xlsx', metadata)
  downloadXlsxWorkbook(workforceActivityWorkbook(rows, metadata), fileName)
  return fileName
}

export async function downloadWorkforceActivityPdf(
  rows: readonly WorkforceActivityRow[],
  metadata: WorkforceActivityExportMetadata,
): Promise<string> {
  const fileName = workforceActivityExportFileName('pdf', metadata)
  const bytes = await workforceActivityPdf(rows, metadata)
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/pdf' }), fileName)
  return fileName
}
