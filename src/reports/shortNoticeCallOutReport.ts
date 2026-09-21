import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { ShortNoticeCallOutReport, ShortNoticeCallOutRow } from '../data/shortNoticeCallOutReport'
import type { XlsxSheet } from '../lib/xlsxWorkbook'
import { formatUsDateKey } from '../time/timeRules'

export interface ShortNoticeCallOutFilters {
  search: string
  noticeBucket: string
  occurrenceType: string
  reviewOutcome: string
  coverageStatus: string
}

export const occurrenceTypeLabels: Record<ShortNoticeCallOutRow['occurrenceType'], string> = {
  called_in_sick: 'Called in sick',
  call_off: 'Call-off',
  no_call_no_show: 'No-call / no-show',
}

export const reviewOutcomeLabels: Record<ShortNoticeCallOutRow['reviewOutcome'], string> = {
  pending_hr_review: 'Pending HR review',
  confirmed: 'Confirmed',
  unexcused: 'Unexcused',
  excused_protected: 'Excused / protected',
  corrected: 'Corrected',
  dismissed: 'Dismissed',
}

export const coverageStatusLabels: Record<ShortNoticeCallOutRow['coverageStatus'], string> = {
  covered: 'Coverage found',
  not_required: 'Replacement not required',
  no_replacement: 'No replacement',
  patrol_review: 'Patrol review',
  open_pool: 'Open coverage pool',
  pending: 'Coverage pending',
  canceled: 'Call-off canceled',
}

export function formatNoticeMinutes(minutes: number): string {
  if (minutes < 0) {
    const late = Math.abs(minutes)
    return `${Math.floor(late / 60)} hr ${late % 60} min after start`
  }
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
}

export function formatOperationalDateTime(value: string, timeZone = 'America/Denver'): string {
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short',
  }).format(new Date(value))
}

export function filterShortNoticeCallOutRows(rows: ShortNoticeCallOutRow[], filters: ShortNoticeCallOutFilters) {
  const query = filters.search.trim().toLocaleLowerCase()
  return rows.filter((row) => {
    const searchable = [
      row.employeeName, row.employeeNumber, row.jobTitle, row.clientName, row.siteName,
      row.siteCode, row.postName, row.eventName, row.locationName, row.reason,
      row.receivedByName, row.reportedByName, row.replacementEmployeeName,
    ].filter(Boolean).join(' ').toLocaleLowerCase()
    return (!query || searchable.includes(query))
      && (!filters.noticeBucket || row.noticeBucket === filters.noticeBucket)
      && (!filters.occurrenceType || row.occurrenceType === filters.occurrenceType)
      && (!filters.reviewOutcome || row.reviewOutcome === filters.reviewOutcome)
      && (!filters.coverageStatus || row.coverageStatus === filters.coverageStatus)
  })
}

export function summarizeShortNoticeCallOutRows(rows: ShortNoticeCallOutRow[]) {
  const employeeCounts = new Map<string, number>()
  for (const row of rows) employeeCounts.set(row.employeeId, (employeeCounts.get(row.employeeId) ?? 0) + 1)
  return {
    total: rows.length,
    afterStart: rows.filter((row) => row.noticeMinutes < 0).length,
    noShows: rows.filter((row) => row.occurrenceType === 'no_call_no_show').length,
    uncovered: rows.filter((row) => row.replacementNeeded && ['pending', 'open_pool', 'no_replacement', 'patrol_review'].includes(row.coverageStatus)).length,
    repeatEmployees: [...employeeCounts.values()].filter((count) => count > 1).length,
  }
}

function employeeSummaries(rows: ShortNoticeCallOutRow[]) {
  const summaries = new Map<string, {
    employeeName: string; employeeNumber: string | null; total: number; afterStart: number;
    noShows: number; unexcused: number; protected: number; uncovered: number; latestDate: string;
  }>()
  for (const row of rows) {
    const current = summaries.get(row.employeeId) ?? {
      employeeName: row.employeeName, employeeNumber: row.employeeNumber, total: 0,
      afterStart: 0, noShows: 0, unexcused: 0, protected: 0, uncovered: 0,
      latestDate: row.operationalDate,
    }
    current.total += 1
    current.afterStart += Number(row.noticeMinutes < 0)
    current.noShows += Number(row.occurrenceType === 'no_call_no_show')
    current.unexcused += Number(row.reviewOutcome === 'unexcused')
    current.protected += Number(row.reviewOutcome === 'excused_protected')
    current.uncovered += Number(row.replacementNeeded && ['pending', 'open_pool', 'no_replacement', 'patrol_review'].includes(row.coverageStatus))
    if (row.operationalDate > current.latestDate) current.latestDate = row.operationalDate
    summaries.set(row.employeeId, current)
  }
  return [...summaries.values()].sort((left, right) => right.total - left.total || left.employeeName.localeCompare(right.employeeName))
}

export function shortNoticeCallOutWorkbook(report: ShortNoticeCallOutReport, rows: ShortNoticeCallOutRow[], filterDescription: string): XlsxSheet[] {
  const range = `${formatUsDateKey(report.fromDate)} – ${formatUsDateKey(report.throughDate)}`
  const summaries = employeeSummaries(rows)
  return [{
    name: 'Employee Summary', titleRows: [0], metadataRows: [1, 2, 3], headerRows: [4], filterRowIndex: 4, freezeRows: 5,
    columnWidths: [28, 16, 14, 14, 14, 14, 14, 14, 16], integerColumns: [2, 3, 4, 5, 6, 7],
    rows: [
      ['Short-Notice Call-Out Report'], ['Date range', range], ['Filters', filterDescription],
      ['Counting rule', report.countingRule],
      ['Employee', 'Employee number', 'Occurrences', 'After start', 'No-shows', 'Unexcused', 'Protected', 'Uncovered', 'Latest work date'],
      ...summaries.map((row) => [row.employeeName, row.employeeNumber, row.total, row.afterStart, row.noShows, row.unexcused, row.protected, row.uncovered, formatUsDateKey(row.latestDate)]),
    ],
  }, {
    name: 'Occurrence Detail', titleRows: [0], metadataRows: [1, 2, 3], headerRows: [4], filterRowIndex: 4, freezeRows: 5,
    columnWidths: [14, 28, 16, 24, 23, 20, 23, 26, 22, 22, 22, 22, 18, 20, 42, 42, 38, 20, 18],
    wrapColumns: [6, 7, 8, 9, 14, 15, 16], integerColumns: [12],
    rows: [
      ['Short-notice occurrence detail'], ['Date range', range], ['Filters', filterDescription],
      ['Threshold', 'Less than 4 hours (240 minutes); exactly 4 hours is compliant.'],
      ['Work date', 'Employee', 'Employee number', 'Client', 'Site / post', 'Shift starts', 'Call received', 'Notice provided', 'Occurrence', 'Submission source', 'Received by', 'Coverage', 'Notice minutes', 'Replacement', 'Reason', 'Operational details', 'HR decision note', 'Review outcome', 'Overtime created'],
      ...rows.map((row) => [
        formatUsDateKey(row.operationalDate), row.employeeName, row.employeeNumber, row.clientName,
        [row.siteName, row.postName ?? row.eventName].filter(Boolean).join(' / ') || row.locationName,
        formatOperationalDateTime(row.scheduledStartAt, row.timeZone), formatOperationalDateTime(row.callReceivedAt, row.timeZone),
        formatNoticeMinutes(row.noticeMinutes), occurrenceTypeLabels[row.occurrenceType], row.submissionSource.replaceAll('_', ' '),
        row.receivedByName ?? row.reportedByName, coverageStatusLabels[row.coverageStatus], row.noticeMinutes,
        row.replacementEmployeeName, row.reason, row.operationalDetails, row.decisionNote,
        reviewOutcomeLabels[row.reviewOutcome], row.overtimeCreated ? 'Yes' : 'No',
      ]),
    ],
  }]
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.replaceAll(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (!words.length) return ['Not recorded']
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate
    else {
      if (line) lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawLines(page: PDFPage, lines: string[], x: number, y: number, font: PDFFont, size: number, color = rgb(0.18, 0.18, 0.18)) {
  lines.forEach((line, index) => page.drawText(line, { x, y: y - index * (size + 3), font, size, color }))
}

export async function shortNoticeCallOutPdf(report: ShortNoticeCallOutReport, rows: ShortNoticeCallOutRow[], filterDescription: string): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const pageWidth = 612
  const pageHeight = 792
  const margin = 42
  const ink = rgb(0.10, 0.11, 0.12)
  const muted = rgb(0.35, 0.34, 0.31)
  const gold = rgb(0.76, 0.53, 0.18)
  let page = document.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin

  const addHeader = () => {
    page.drawRectangle({ x: 0, y: pageHeight - 86, width: pageWidth, height: 86, color: ink })
    page.drawText('SYGSHIFT HR REPORTING', { x: margin, y: pageHeight - 33, font: bold, size: 9, color: gold })
    page.drawText('Short-Notice Call-Out Report', { x: margin, y: pageHeight - 57, font: bold, size: 20, color: rgb(1, 1, 1) })
    y = pageHeight - 112
  }
  const addPage = () => { page = document.addPage([pageWidth, pageHeight]); addHeader() }
  addHeader()

  drawLines(page, [`Date range: ${formatUsDateKey(report.fromDate)} - ${formatUsDateKey(report.throughDate)}`, `Filters: ${filterDescription}`], margin, y, regular, 9, muted)
  y -= 42
  const summary = summarizeShortNoticeCallOutRows(rows)
  const metrics = [
    ['Short notice', summary.total], ['After start', summary.afterStart], ['No-shows', summary.noShows],
    ['Uncovered', summary.uncovered], ['Repeat employees', summary.repeatEmployees],
  ] as const
  metrics.forEach(([label, value], index) => {
    const width = 100
    const x = margin + index * 105
    page.drawRectangle({ x, y: y - 42, width, height: 42, borderColor: gold, borderWidth: 1, color: rgb(0.98, 0.97, 0.94) })
    page.drawText(label, { x: x + 8, y: y - 15, font: bold, size: 7.5, color: muted })
    page.drawText(String(value), { x: x + 8, y: y - 34, font: bold, size: 16, color: ink })
  })
  y -= 68
  drawLines(page, wrapText(report.countingRule, regular, 8.5, pageWidth - margin * 2), margin, y, regular, 8.5, muted)
  y -= 38

  for (const row of rows) {
    const reasonLines = wrapText(row.reason ?? 'Not recorded', regular, 8.5, pageWidth - margin * 2 - 20).slice(0, 4)
    const cardHeight = 118 + Math.max(0, reasonLines.length - 1) * 11
    if (y - cardHeight < 54) addPage()
    page.drawRectangle({ x: margin, y: y - cardHeight, width: pageWidth - margin * 2, height: cardHeight, borderColor: rgb(0.79, 0.76, 0.68), borderWidth: 0.8, color: rgb(1, 1, 1) })
    page.drawRectangle({ x: margin, y: y - cardHeight, width: 4, height: cardHeight, color: row.noticeMinutes < 0 ? rgb(0.65, 0.22, 0.18) : gold })
    page.drawText(row.employeeName, { x: margin + 14, y: y - 19, font: bold, size: 11, color: ink })
    page.drawText(`${formatUsDateKey(row.operationalDate)} | ${occurrenceTypeLabels[row.occurrenceType]} | ${formatNoticeMinutes(row.noticeMinutes)}`, { x: margin + 14, y: y - 35, font: regular, size: 8.5, color: muted })
    const left = [
      `Shift: ${formatOperationalDateTime(row.scheduledStartAt, row.timeZone)}`,
      `Received: ${formatOperationalDateTime(row.callReceivedAt, row.timeZone)}`,
      `Client: ${row.clientName ?? 'Not linked'}`,
      `Site / post: ${[row.siteName, row.postName ?? row.eventName].filter(Boolean).join(' / ') || row.locationName}`,
    ]
    const right = [
      `Review: ${reviewOutcomeLabels[row.reviewOutcome]}`,
      `Coverage: ${coverageStatusLabels[row.coverageStatus]}`,
      `Received by: ${row.receivedByName ?? row.reportedByName ?? 'Not recorded'}`,
      `Replacement: ${row.replacementEmployeeName ?? 'None recorded'}`,
    ]
    drawLines(page, left, margin + 14, y - 54, regular, 8, ink)
    drawLines(page, right, 323, y - 54, regular, 8, ink)
    page.drawText('Reason / note', { x: margin + 14, y: y - 104, font: bold, size: 7.5, color: muted })
    drawLines(page, reasonLines, margin + 14, y - 116, regular, 8.5, ink)
    y -= cardHeight + 10
  }

  if (!rows.length) page.drawText('No short-notice call-outs match the selected filters.', { x: margin, y, font: bold, size: 11, color: muted })
  document.getPages().forEach((target, index) => target.drawText(`Protected HR report | Page ${index + 1} of ${document.getPageCount()}`, { x: margin, y: 24, font: regular, size: 7.5, color: muted }))
  return document.save()
}
