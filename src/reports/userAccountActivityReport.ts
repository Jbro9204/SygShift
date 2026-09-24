import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { UserAccountActivityReport, UserAccountActivityRow } from '../data/userAccountActivityReport'
import type { XlsxSheet } from '../lib/xlsxWorkbook'

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

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`
}

export async function userAccountActivityPdf(report: UserAccountActivityReport, filterDescription: string): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const pageWidth = 792
  const pageHeight = 612
  const margin = 34
  const ink = rgb(0.09, 0.09, 0.08)
  const gold = rgb(0.78, 0.55, 0.20)
  const muted = rgb(0.38, 0.36, 0.33)
  let page = document.addPage([pageWidth, pageHeight])
  let y = pageHeight - 34

  const header = () => {
    page.drawRectangle({ x: 0, y: pageHeight - 76, width: pageWidth, height: 76, color: ink })
    page.drawText('SYGSHIFT HR & SECURITY REPORTING', { x: margin, y: pageHeight - 27, font: bold, size: 8, color: gold })
    page.drawText('User Account & Sign-In Activity', { x: margin, y: pageHeight - 52, font: bold, size: 19, color: rgb(1, 1, 1) })
    y = pageHeight - 98
  }
  const nextPage = () => { page = document.addPage([pageWidth, pageHeight]); header() }
  header()
  page.drawText(`Generated ${formatAccountActivityDate(report.serverTimestamp)} · ${report.totalCount} matching employees`, { x: margin, y, font: regular, size: 9, color: muted })
  y -= 17
  page.drawText(truncate(filterDescription, 132), { x: margin, y, font: regular, size: 8, color: muted })
  y -= 24

  const columns = [
    { label: 'Employee', x: margin, width: 132 },
    { label: 'Username', x: margin + 136, width: 90 },
    { label: 'Account', x: margin + 230, width: 86 },
    { label: 'Last completed sign-in', x: margin + 320, width: 120 },
    { label: 'MFA / Sessions', x: margin + 444, width: 92 },
    { label: 'Next action', x: margin + 540, width: 170 },
  ]
  const drawTableHeader = () => {
    page.drawRectangle({ x: margin, y: y - 5, width: pageWidth - margin * 2, height: 22, color: gold })
    for (const column of columns) page.drawText(column.label, { x: column.x + 4, y: y + 2, font: bold, size: 7.5, color: ink })
    y -= 25
  }
  drawTableHeader()

  for (const row of report.rows) {
    if (y < 58) { nextPage(); drawTableHeader() }
    page.drawLine({ start: { x: margin, y: y - 4 }, end: { x: pageWidth - margin, y: y - 4 }, thickness: 0.5, color: rgb(0.84, 0.81, 0.75) })
    const mfa = row.requiresMfa ? (row.mfaEnrolled ? 'Enrolled' : 'Missing') : 'Not required'
    const values = [
      `${row.employeeName}\n${row.employeeNumber ?? 'No number'}`,
      row.username,
      accountStateLabels[row.accountState],
      formatAccountActivityDate(row.lastCompletedSignInAt),
      `${mfa} · ${row.activeSessionCount} active`,
      row.securityException === 'none' ? row.nextAction : securityExceptionLabels[row.securityException],
    ]
    values.forEach((value, index) => {
      const lines = value.split('\n')
      page.drawText(truncate(lines[0], Math.floor(columns[index].width / 5.1)), { x: columns[index].x + 4, y: y + 3, font: index === 0 ? bold : regular, size: 7.4, color: ink })
      if (lines[1]) page.drawText(truncate(lines[1], Math.floor(columns[index].width / 4.9)), { x: columns[index].x + 4, y: y - 8, font: regular, size: 6.8, color: muted })
    })
    y -= 28
  }
  return document.save()
}
