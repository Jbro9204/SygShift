import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PatrolReport } from '../data/patrol'
import { downloadXlsxWorkbook, type XlsxSheet } from '../lib/xlsxWorkbook'

export type PatrolReportProfile = 'internal' | 'client'

function dateTime(value: string | null): string {
  if (!value) return 'Not completed'
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function title(value: string | null): string {
  if (!value) return 'Not recorded'
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function reportColumns(profile: PatrolReportProfile) {
  const common = [
    { label: 'Service Date', value: (row: PatrolReport['rows'][number]) => row.serviceDate },
    { label: 'Route', value: (row: PatrolReport['rows'][number]) => row.routeName },
    { label: 'Stop', value: (row: PatrolReport['rows'][number]) => row.locationLabel },
    { label: 'Activity Type', value: (row: PatrolReport['rows'][number]) => title(row.classification) },
    { label: 'Requirement', value: (row: PatrolReport['rows'][number]) => `${row.requirementLabel}${row.hitNumber ? ` #${row.hitNumber}` : ''}` },
    { label: 'Status', value: (row: PatrolReport['rows'][number]) => title(row.status) },
    { label: 'Completed', value: (row: PatrolReport['rows'][number]) => dateTime(row.completedAt) },
    { label: 'Outcome', value: (row: PatrolReport['rows'][number]) => title(row.outcome) },
    { label: 'Evidence', value: (row: PatrolReport['rows'][number]) => row.evidenceCount },
  ]
  if (profile === 'client') return common
  return [
    common[0], common[1],
    { label: 'Employee', value: (row: PatrolReport['rows'][number]) => row.employeeName },
    { label: 'Employee ID', value: (row: PatrolReport['rows'][number]) => row.employeeNumber ?? 'Not recorded' },
    ...common.slice(2),
    { label: 'Location Verification', value: (row: PatrolReport['rows'][number]) => title(row.locationStatus) },
    { label: 'Patrol Note', value: (row: PatrolReport['rows'][number]) => row.note ?? 'Not recorded' },
  ]
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function filename(profile: PatrolReportProfile, extension: string, generatedAt: string): string {
  return `sygshift-patrol-${profile}-${generatedAt.slice(0, 10)}.${extension}`
}

export function downloadPatrolCsv(report: PatrolReport, profile: PatrolReportProfile): string {
  const columns = reportColumns(profile)
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
  const rows = [columns.map((column) => escape(column.label)).join(',')]
  for (const row of report.rows) rows.push(columns.map((column) => escape(column.value(row))).join(','))
  const name = filename(profile, 'csv', report.generatedAt)
  downloadBlob(new Blob([`\ufeff${rows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }), name)
  return name
}

export function downloadPatrolXlsx(report: PatrolReport, profile: PatrolReportProfile): string {
  const columns = reportColumns(profile)
  const sheet: XlsxSheet = {
    centerColumns: [0, 4, 5, 6, 7],
    columnWidths: columns.map((column) => column.label.includes('Note') ? 52 : column.label.includes('Route') || column.label.includes('Stop') ? 24 : 18),
    filterRowIndex: 9,
    freezeRows: 10,
    headerRows: [9],
    metadataRows: [1, 2, 3, 4, 5, 6, 7],
    mergedCells: [`A1:${String.fromCharCode(64 + Math.min(columns.length, 26))}1`],
    name: profile === 'internal' ? 'Internal Patrol Activity' : 'Client Patrol Activity',
    rows: [
      [`SygShift Patrol Activity · ${profile === 'internal' ? 'Internal' : 'Client-ready'}`],
      ['Generated', dateTime(report.generatedAt)],
      ['Required hits', report.summary.required],
      ['Completed hits', report.summary.completed],
      ['Missed hits', report.summary.missed],
      ['Extra hits', report.summary.extra],
      ['Makeup assigned', report.summary.makeupAssigned],
      ['Makeup completed', report.summary.makeupCompleted],
      ['Incidents', report.summary.incidents],
      ['Evidence files', report.summary.evidence],
      [],
      columns.map((column) => column.label),
      ...report.rows.map((row) => columns.map((column) => column.value(row))),
    ],
    statusColumns: [columns.findIndex((column) => column.label === 'Status')],
    titleRows: [0],
    wrapColumns: columns.map((column, index) => column.label.includes('Note') || column.label.includes('Route') || column.label.includes('Stop') ? index : -1).filter((index) => index >= 0),
  }
  const name = filename(profile, 'xlsx', report.generatedAt)
  downloadXlsxWorkbook([sheet], name)
  return name
}

function clipped(value: unknown, length: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

export async function downloadPatrolPdf(report: PatrolReport, profile: PatrolReportProfile): Promise<string> {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const gold = rgb(0.79, 0.56, 0.19)
  const charcoal = rgb(0.08, 0.09, 0.1)
  const cream = rgb(0.97, 0.95, 0.91)
  const columns = reportColumns(profile).filter((column) => !column.label.includes('Note') && !column.label.includes('Employee ID') && !column.label.includes('Location Verification'))
  const pageWidth = 792
  const pageHeight = 612
  const margin = 34
  const rowHeight = 24
  const usableWidth = pageWidth - margin * 2
  const columnWidth = usableWidth / columns.length
  let page = pdf.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin

  const drawHeader = () => {
    page.drawRectangle({ x: 0, y: pageHeight - 78, width: pageWidth, height: 78, color: charcoal })
    page.drawText('SygShift Patrol Activity', { x: margin, y: pageHeight - 39, font: bold, size: 19, color: cream })
    page.drawText(`${profile === 'internal' ? 'Internal operational report' : 'Client-ready report'} · ${dateTime(report.generatedAt)}`, { x: margin, y: pageHeight - 58, font: regular, size: 9, color: cream })
    y = pageHeight - 102
    page.drawRectangle({ x: margin, y: y - 5, width: usableWidth, height: 23, color: gold })
    columns.forEach((column, index) => page.drawText(clipped(column.label, 17), { x: margin + index * columnWidth + 4, y: y + 3, font: bold, size: 7.2, color: charcoal }))
    y -= rowHeight
  }

  drawHeader()
  for (const row of report.rows) {
    if (y < margin + rowHeight) { page = pdf.addPage([pageWidth, pageHeight]); drawHeader() }
    if (Math.round((pageHeight - y) / rowHeight) % 2 === 0) page.drawRectangle({ x: margin, y: y - 5, width: usableWidth, height: rowHeight, color: rgb(0.96, 0.95, 0.92) })
    columns.forEach((column, index) => page.drawText(clipped(column.value(row), 19), { x: margin + index * columnWidth + 4, y: y + 3, font: regular, size: 7, color: charcoal }))
    y -= rowHeight
  }
  const bytes = await pdf.save()
  const name = filename(profile, 'pdf', report.generatedAt)
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/pdf' }), name)
  return name
}
