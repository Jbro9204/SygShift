import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { UserAccountActivityReport, UserAccountActivityRow } from '../data/userAccountActivityReport'
import type { XlsxSheet } from '../lib/xlsxWorkbook'
import { addReportPdfFooters, addReportPdfPage, drawReportPdfText, reportPdfColors, type ReportPdfPage } from './pdfReportLayout'

export const accountStateLabels: Record<UserAccountActivityRow['accountState'], string> = {
  not_created: 'No account',
  active: 'Active',
  disabled: 'Disabled',
  setup_incomplete: 'Setup incomplete',
}

export const loginStateLabels: Record<UserAccountActivityRow['loginState'], string> = {
  never_signed_in: 'Never signed in',
  recent: 'Recently active',
  stale: 'Inactive',
}

export const securityExceptionLabels: Record<UserAccountActivityRow['securityException'], string> = {
  none: 'None',
  enabled_noncurrent_employee: 'Enabled account for non-current employee',
  disabled_current_employee: 'Disabled account for current employee',
  mfa_missing: 'Required MFA not enrolled',
}

export function formatAccountActivityDate(value: string | null): string {
  if (!value) return 'Never'
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver', timeZoneName: 'short',
  }).format(new Date(value))
}

export function userAccountActivityWorkbook(report: UserAccountActivityReport, filterDescription: string): XlsxSheet[] {
  return [{
    name: 'Account Activity',
    titleRows: [0], metadataRows: [1, 2, 3], headerRows: [4], filterRowIndex: 4, freezeRows: 5,
    columnWidths: [28, 16, 20, 26, 18, 18, 24, 18, 22, 22, 18, 16, 17, 17, 30, 34],
    statusColumns: [7, 8, 11, 14], wrapColumns: [5, 6, 15], integerColumns: [10, 12, 13],
    rows: [
      ['SygShift User Account & Sign-In Activity'],
      ['Generated', formatAccountActivityDate(report.serverTimestamp)],
      ['Filters', filterDescription],
      ['Activity standard', `Completed SygShift sign-ins; inactive threshold ${report.staleDays} days`],
      ['Employee', 'Employee number', 'Username', 'Company email', 'Employment', 'Job title', 'Assigned roles', 'Account', 'Login activity', 'Last completed sign-in', 'Completed sign-ins', 'MFA', 'Active sessions', 'Remembered devices', 'Security exception', 'Next action'],
      ...report.rows.map((row) => [
        row.employeeName, row.employeeNumber, row.username, row.companyEmail,
        row.employmentStatus.replaceAll('_', ' '), row.jobTitle,
        row.accessRoles.join(', '), accountStateLabels[row.accountState], loginStateLabels[row.loginState],
        formatAccountActivityDate(row.lastCompletedSignInAt), row.completedSignInCount,
        row.requiresMfa ? (row.mfaEnrolled ? 'Enrolled' : 'Required — missing') : 'Not required',
        row.activeSessionCount, row.trustedDeviceCount, securityExceptionLabels[row.securityException], row.nextAction,
      ]),
    ],
  }]
}

export async function userAccountActivityPdf(report: UserAccountActivityReport, filterDescription: string): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const pageWidth = 792
  const pageHeight = 612
  const margin = 34
  const ink = reportPdfColors.ink
  const muted = reportPdfColors.muted
  const columnWidths = [135, 92, 86, 125, 96, 190]
  const labels = ['Employee', 'Username', 'Account', 'Last completed sign-in', 'MFA / Sessions', 'Next action']
  const columns = columnWidths.map((width, index) => ({
    label: labels[index],
    width,
    x: margin + columnWidths.slice(0, index).reduce((total, value) => total + value, 0),
  }))
  const rowHeight = 28

  const drawTableHeader = (state: ReportPdfPage, top: number): number => {
    state.page.drawRectangle({ x: margin, y: top - 22, width: pageWidth - margin * 2, height: 22, color: reportPdfColors.gold })
    for (const column of columns) {
      drawReportPdfText(state.page, column.label, {
        x: column.x + 4, y: top - 14, font: bold, size: 7.4, color: ink,
        maximumWidth: column.width - 8,
      })
    }
    return top - 26
  }

  const beginPage = (firstPage: boolean): { state: ReportPdfPage; y: number } => {
    const state = addReportPdfPage({
      bold, document, height: pageHeight, kicker: 'SygShift HR & Security Reporting', margin,
      regular, subtitle: 'Protected user-access readiness and completed sign-in activity',
      title: 'User Account & Sign-In Activity', width: pageWidth,
    })
    let top = state.bodyTop
    if (firstPage) {
      drawReportPdfText(state.page, `Generated ${formatAccountActivityDate(report.serverTimestamp)} | ${report.totalCount} matching employees`, {
        x: margin, y: top, font: regular, size: 9, color: muted,
        maximumWidth: pageWidth - margin * 2,
      })
      top -= 17
      drawReportPdfText(state.page, filterDescription, {
        x: margin, y: top, font: regular, size: 8, color: muted,
        maximumWidth: pageWidth - margin * 2,
      })
      top -= 18
    } else {
      drawReportPdfText(state.page, `${report.totalCount} matching employees | Continued`, {
        x: margin, y: top, font: regular, size: 8, color: muted,
      })
      top -= 18
    }
    return { state, y: drawTableHeader(state, top) }
  }

  let current = beginPage(true)

  report.rows.forEach((row, rowIndex) => {
    if (current.y - rowHeight < current.state.bottom) current = beginPage(false)
    const { page } = current.state
    const rowTop = current.y
    const rowBottom = rowTop - rowHeight
    if (rowIndex % 2 === 1) {
      page.drawRectangle({ x: margin, y: rowBottom, width: pageWidth - margin * 2, height: rowHeight, color: reportPdfColors.soft })
    }
    const mfa = row.requiresMfa ? (row.mfaEnrolled ? 'Enrolled' : 'Missing') : 'Not required'
    const values = [
      `${row.employeeName}\n${row.employeeNumber ?? 'No number'}`,
      row.username,
      accountStateLabels[row.accountState],
      formatAccountActivityDate(row.lastCompletedSignInAt),
      `${mfa} | ${row.activeSessionCount} active`,
      row.securityException === 'none' ? row.nextAction : securityExceptionLabels[row.securityException],
    ]
    values.forEach((value, index) => {
      const lines = value.split('\n')
      const font = index === 0 ? bold : regular
      const size = index === 3 ? 6.9 : 7.3
      drawReportPdfText(page, lines[0], {
        x: columns[index].x + 4, y: rowTop - 12, font, size, color: ink,
        maximumWidth: columns[index].width - 8,
      })
      if (lines[1]) {
        drawReportPdfText(page, lines[1], {
          x: columns[index].x + 4, y: rowTop - 22, font: regular, size: 6.7, color: muted,
          maximumWidth: columns[index].width - 8,
        })
      }
    })
    page.drawLine({
      start: { x: margin, y: rowBottom }, end: { x: pageWidth - margin, y: rowBottom },
      thickness: 0.5, color: reportPdfColors.rule,
    })
    current.y = rowBottom
  })
  addReportPdfFooters(document, regular, 'Protected HR & security report')
  return document.save({ useObjectStreams: false })
}
