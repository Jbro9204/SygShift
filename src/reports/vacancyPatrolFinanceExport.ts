import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { VacancyPatrolFinanceReport, VacancyPatrolFinanceRow } from '../data/vacancyPatrolFinance'
import { downloadXlsxWorkbook, type XlsxSheet } from '../lib/xlsxWorkbook'
import { addReportPdfFooters, addReportPdfPage, drawReportPdfText, reportPdfColors } from './pdfReportLayout'

const dispositionLabels = {
  pending_review: 'Pending Finance review',
  bill_separately: 'Bill Patrol separately',
  included_in_contract: 'Included in contract',
  non_billable: 'Non-billable',
  duplicate_suppressed: 'Duplicate billing suppressed',
} as const

export function vacancyPatrolDispositionLabel(value: VacancyPatrolFinanceRow['billingDisposition']): string {
  return dispositionLabels[value]
}

export function vacancyPatrolStatusLabel(value: VacancyPatrolFinanceRow['status']): string {
  if (value === 'completed') return 'Reconciled'
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function dateTime(value: string | null, timeZone?: string): string {
  if (!value) return 'Not recorded'
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'short', timeStyle: 'short', ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value))
}

function location(row: VacancyPatrolFinanceRow): string {
  return [row.siteName, row.postName].filter(Boolean).join(' / ') || 'Location not linked'
}

function hitProgress(row: VacancyPatrolFinanceRow): string {
  return `${row.completedHits} completed · ${row.missedHits} missed · ${row.remainingHits} remaining`
}

function columns() {
  return [
    { label: 'Request', value: (row: VacancyPatrolFinanceRow) => row.requestNumber },
    { label: 'Service Date', value: (row: VacancyPatrolFinanceRow) => row.serviceDate },
    { label: 'Client', value: (row: VacancyPatrolFinanceRow) => row.clientName ?? 'Not linked' },
    { label: 'Site / Post', value: location },
    { label: 'Original Shift Start', value: (row: VacancyPatrolFinanceRow) => dateTime(row.startsAt, row.timeZone) },
    { label: 'Original Shift End', value: (row: VacancyPatrolFinanceRow) => dateTime(row.endsAt, row.timeZone) },
    { label: 'Original Hours', value: (row: VacancyPatrolFinanceRow) => row.originalShiftHours },
    { label: 'Recovery Status', value: (row: VacancyPatrolFinanceRow) => vacancyPatrolStatusLabel(row.status) },
    { label: 'Planned Hits', value: (row: VacancyPatrolFinanceRow) => row.plannedHits },
    { label: 'Completed Hits', value: (row: VacancyPatrolFinanceRow) => row.completedHits },
    { label: 'Missed Hits', value: (row: VacancyPatrolFinanceRow) => row.missedHits },
    { label: 'Patrol Route', value: (row: VacancyPatrolFinanceRow) => row.acceptedRouteName ?? row.requestedRouteName ?? 'Pending' },
    { label: 'Patrol Employee', value: (row: VacancyPatrolFinanceRow) => row.assignedEmployeeName ?? 'Pending' },
    { label: 'Billing Disposition', value: (row: VacancyPatrolFinanceRow) => vacancyPatrolDispositionLabel(row.billingDisposition) },
    { label: 'Billing Reference', value: (row: VacancyPatrolFinanceRow) => row.billingReference ?? '' },
    { label: 'Billing Reason', value: (row: VacancyPatrolFinanceRow) => row.billingReason ?? '' },
    { label: 'Requested By', value: (row: VacancyPatrolFinanceRow) => row.requestedByName },
    { label: 'Requested At', value: (row: VacancyPatrolFinanceRow) => dateTime(row.requestedAt, row.timeZone) },
    { label: 'Accepted By', value: (row: VacancyPatrolFinanceRow) => row.acceptedByName ?? '' },
    { label: 'Finance Reviewer', value: (row: VacancyPatrolFinanceRow) => row.reviewedByName ?? '' },
    { label: 'Reviewed At', value: (row: VacancyPatrolFinanceRow) => dateTime(row.reviewedAt, row.timeZone) },
  ]
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function filename(extension: string, report: VacancyPatrolFinanceReport): string {
  return `SygShift_Vacancy_Patrol_Billing_${report.from}_through_${report.through}.${extension}`
}

export function downloadVacancyPatrolFinanceCsv(report: VacancyPatrolFinanceReport): string {
  const name = filename('csv', report)
  downloadBlob(new Blob([vacancyPatrolFinanceCsv(report)], { type: 'text/csv;charset=utf-8' }), name)
  return name
}

export function vacancyPatrolFinanceCsv(report: VacancyPatrolFinanceReport): string {
  const fields = columns()
  const escape = (value: unknown) => {
    const raw = String(value ?? '')
    const safe = /^\s*[=+\-@]/u.test(raw) ? `'${raw}` : raw
    return `"${safe.replaceAll('"', '""')}"`
  }
  const rows = [fields.map((column) => escape(column.label)).join(',')]
  for (const row of report.rows) rows.push(fields.map((column) => escape(column.value(row))).join(','))
  return `\ufeff${rows.join('\r\n')}`
}

export function vacancyPatrolFinanceXlsxSheet(report: VacancyPatrolFinanceReport): XlsxSheet {
  const fields = columns()
  return {
    centerColumns: [1, 6, 8, 9, 10],
    columnWidths: fields.map((column) => {
      if (column.label.includes('Reason')) return 48
      if (column.label.includes('Site') || column.label.includes('Client') || column.label.includes('Route')) return 26
      if (column.label.includes('At') || column.label.includes('Shift')) return 23
      return 19
    }),
    filterRowIndex: 13,
    freezeRows: 14,
    headerRows: [13],
    mergedCells: ['A1:U1'],
    metadataRows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    name: 'Vacancy Patrol Billing',
    rows: [
      ['SygShift Vacancy Patrol Coverage & Billing'],
      ['Generated', dateTime(report.generatedAt)],
      ['Reporting period', `${report.from} through ${report.through}`],
      ['Exported matching rows', report.rows.length],
      ['All recovery requests in range', report.summary.totalRequests],
      ['Awaiting Patrol completion', report.summary.awaitingCompletion],
      ['Pending Finance review', report.summary.pendingReview],
      ['Finance reviewed', report.summary.reviewed],
      ['Bill separately', report.summary.billSeparately],
      ['Included in contract', report.summary.includedInContract],
      ['Non-billable', report.summary.nonBillable],
      ['Duplicate billing suppressed', report.summary.duplicateSuppressed],
      [],
      fields.map((column) => column.label),
      ...report.rows.map((row) => fields.map((column) => column.value(row))),
    ],
    statusColumns: [7, 13],
    titleRows: [0],
    wrapColumns: fields.map((column, index) => /Client|Site|Route|Employee|Reason/.test(column.label) ? index : -1).filter((index) => index >= 0),
  }
}

export function downloadVacancyPatrolFinanceXlsx(report: VacancyPatrolFinanceReport): string {
  const name = filename('xlsx', report)
  downloadXlsxWorkbook([vacancyPatrolFinanceXlsxSheet(report)], name)
  return name
}

export async function vacancyPatrolFinancePdf(report: VacancyPatrolFinanceReport): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pageWidth = 792
  const pageHeight = 612
  const margin = 34
  const usableWidth = pageWidth - margin * 2
  const rowHeight = 36
  const table = [
    { label: 'Date / Request', width: 82 },
    { label: 'Client / Site', width: 120 },
    { label: 'Original Shift', width: 104 },
    { label: 'Hours', width: 43 },
    { label: 'Patrol Hits', width: 70 },
    { label: 'Recovery', width: 78 },
    { label: 'Billing', width: 112 },
    { label: 'Reference', width: usableWidth - 609 },
  ]

  const beginPage = () => {
    const state = addReportPdfPage({
      bold, document: pdf, height: pageHeight, kicker: 'SygShift Finance Reporting', margin, regular,
      subtitle: `${report.from} through ${report.through} | Generated ${dateTime(report.generatedAt)}`,
      title: 'Vacancy Patrol Coverage & Billing', width: pageWidth,
    })
    const headerTop = state.bodyTop
    state.page.drawRectangle({ x: margin, y: headerTop - 23, width: usableWidth, height: 23, color: reportPdfColors.gold })
    let x = margin
    table.forEach((column) => {
      drawReportPdfText(state.page, column.label, {
        x: x + 4, y: headerTop - 15, font: bold, size: 7.2, color: reportPdfColors.ink, maximumWidth: column.width - 8,
      })
      x += column.width
    })
    return { ...state, y: headerTop - 27 }
  }

  let current = beginPage()
  report.rows.forEach((row, rowIndex) => {
    if (current.y - rowHeight < current.bottom) current = beginPage()
    const rowTop = current.y
    const rowBottom = rowTop - rowHeight
    if (rowIndex % 2 === 1) current.page.drawRectangle({ x: margin, y: rowBottom, width: usableWidth, height: rowHeight, color: reportPdfColors.soft })
    const cells = [
      [row.serviceDate, row.requestNumber],
      [row.clientName ?? 'Not linked', location(row)],
      [dateTime(row.startsAt, row.timeZone), dateTime(row.endsAt, row.timeZone)],
      [`${row.originalShiftHours.toFixed(2)}`, 'scheduled'],
      [hitProgress(row), row.remainingHits ? `${row.remainingHits} remaining` : 'complete'],
      [vacancyPatrolStatusLabel(row.status), row.acceptedRouteName ?? row.requestedRouteName ?? 'Route pending'],
      [vacancyPatrolDispositionLabel(row.billingDisposition), row.reviewedByName ?? 'Awaiting reviewer'],
      [row.billingReference ?? '-', row.billingReason ?? ''],
    ]
    let x = margin
    table.forEach((column, index) => {
      drawReportPdfText(current.page, cells[index][0], {
        x: x + 4, y: rowTop - 13, font: bold, size: 6.8, color: reportPdfColors.ink, maximumWidth: column.width - 8,
      })
      drawReportPdfText(current.page, cells[index][1], {
        x: x + 4, y: rowTop - 26, font: regular, size: 6.4, color: reportPdfColors.muted, maximumWidth: column.width - 8,
      })
      x += column.width
    })
    current.page.drawLine({
      start: { x: margin, y: rowBottom }, end: { x: pageWidth - margin, y: rowBottom },
      thickness: 0.45, color: reportPdfColors.rule,
    })
    current.y = rowBottom
  })
  addReportPdfFooters(pdf, regular, 'Protected vacancy Patrol billing report')
  return pdf.save({ useObjectStreams: false })
}

export async function downloadVacancyPatrolFinancePdf(report: VacancyPatrolFinanceReport): Promise<string> {
  const bytes = await vacancyPatrolFinancePdf(report)
  const name = filename('pdf', report)
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/pdf' }), name)
  return name
}
