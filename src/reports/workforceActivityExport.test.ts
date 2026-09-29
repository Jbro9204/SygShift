import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it, vi } from 'vitest'
import type { WorkforceActivityExportMetadata, WorkforceActivityRow } from './workforceActivityTypes'
import {
  downloadWorkforceActivityPdf,
  summarizeWorkforceActivityRows,
  workforceActivityPdf,
  workforceActivityWorkbook,
} from './workforceActivityExport'

const metadata: WorkforceActivityExportMetadata = {
  filterDescription: 'All employees | All outcomes | Client: Acme',
  fromDate: '2026-09-01',
  generatedAt: '2026-09-29T16:30:00Z',
  throughDate: '2026-09-30',
}

function activityRow(index: number, overrides: Partial<WorkforceActivityRow> = {}): WorkforceActivityRow {
  return {
    actualEndAt: '2026-09-22T16:30:00Z',
    actualStartAt: '2026-09-22T08:02:00Z',
    assignmentId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    clientId: '30000000-0000-4000-8000-000000000001',
    clientName: 'Acme Legal Holdings',
    employeeId: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    employeeName: `Alexandra Legalname ${index}`,
    employeeNumber: `SYG-${1000 + index}`,
    employmentType: 'hourly',
    eventId: '50000000-0000-4000-8000-000000000001',
    eventName: 'Annual Shareholder Event',
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    locationDetail: 'North entrance beside the loading dock and visitor check-in desk',
    locationLabel: 'Acme Tower — North Entrance',
    notes: ['Manager verified the timecard', 'Badge reader matched'],
    operationalDate: '2026-09-22',
    outcome: 'worked_as_scheduled',
    payrollReady: true,
    postId: '60000000-0000-4000-8000-000000000001',
    postName: 'Lobby Security',
    scheduledEndAt: '2026-09-22T16:00:00Z',
    scheduledMinutes: 480,
    scheduledStartAt: '2026-09-22T08:00:00Z',
    shiftId: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    siteCode: 'ACME-N',
    siteId: '80000000-0000-4000-8000-000000000001',
    siteName: 'Acme Tower',
    timeZone: 'America/New_York',
    unpaidBreakMinutes: 30,
    workedMinutes: 478,
    ...overrides,
  }
}

async function textByPage(bytes: Uint8Array): Promise<string[][]> {
  const task = getDocument({ data: bytes.slice(), disableFontFace: true })
  const document = await task.promise
  const pages: string[][] = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const content = await (await document.getPage(pageNumber)).getTextContent()
    pages.push(content.items.flatMap((item) => 'str' in item ? [item.str] : []))
  }
  await task.destroy()
  return pages
}

describe('workforce activity exports', () => {
  it('keeps the Excel detail columns, filters, and every passed row aligned', () => {
    const rows = [activityRow(1), activityRow(2, { clientName: 'Second Client' })]
    const [sheet] = workforceActivityWorkbook(rows, metadata)
    const headerIndex = sheet.headerRows?.[0] ?? -1
    const header = sheet.rows[headerIndex]
    const detail = sheet.rows.slice(headerIndex + 1)

    expect(sheet.filterRowIndex).toBe(headerIndex)
    expect(sheet.freezeRows).toBe(headerIndex + 1)
    expect(detail).toHaveLength(rows.length)
    expect(detail.every((row) => row.length === header.length)).toBe(true)
    expect(header).toContain('Legal Employee Name')
    expect(header).toContain('Worked Minutes')
    expect(sheet.rows.flat()).toContain('Second Client')
  })

  it('exports event labels and blanks worked minutes and hours for confirmed salary rows', () => {
    const salary = activityRow(3, {
      employmentType: 'salary',
      eventName: 'Convention Center Launch',
      outcome: 'salary_worked_confirmed',
      workedMinutes: 615,
    })
    const [sheet] = workforceActivityWorkbook([salary], metadata)
    const headerIndex = sheet.headerRows?.[0] ?? -1
    const header = sheet.rows[headerIndex]
    const detail = sheet.rows[headerIndex + 1]
    const value = (label: string) => detail[header.indexOf(label)]

    expect(value('Event')).toBe('Convention Center Launch')
    expect(value('Actual Start')).toBeNull()
    expect(value('Actual End')).toBeNull()
    expect(value('Unpaid Break Minutes')).toBeNull()
    expect(value('Worked Minutes')).toBeNull()
    expect(value('Worked Hours')).toBeNull()
    expect(value('Outcome')).toBe('Salary work confirmed')
    expect(value('Payroll Ready')).toBe('Not applicable')
  })

  it('keeps salary exception outcomes and renders open and unscheduled records safely', () => {
    const salaryCallOff = activityRow(5, {
      employeeName: 'Salaried Manager',
      employmentType: 'salary',
      outcome: 'called_off',
      workedMinutes: 300,
    })
    const openUnscheduled = activityRow(6, {
      employeeId: null,
      employeeName: null,
      employeeNumber: null,
      outcome: 'worked_not_scheduled',
      scheduledEndAt: null,
      scheduledMinutes: null,
      scheduledStartAt: null,
    })
    const [sheet] = workforceActivityWorkbook([salaryCallOff, openUnscheduled], metadata)
    const headerIndex = sheet.headerRows?.[0] ?? -1
    const header = sheet.rows[headerIndex]
    const salaryDetail = sheet.rows[headerIndex + 1]
    const openDetail = sheet.rows[headerIndex + 2]

    expect(salaryDetail[header.indexOf('Outcome')]).toBe('Called off')
    expect(salaryDetail[header.indexOf('Worked Minutes')]).toBeNull()
    expect(openDetail[header.indexOf('Legal Employee Name')]).toBe('Open / unassigned')
    expect(openDetail[header.indexOf('Scheduled Start')]).toBe('')
    expect(openDetail[header.indexOf('Scheduled End')]).toBe('')
    expect(openDetail[header.indexOf('Scheduled Minutes')]).toBeNull()
  })

  it('keeps export review totals aligned with the protected report outcomes', () => {
    const rows = [
      activityRow(31, { outcome: 'called_off', payrollReady: false }),
      activityRow(32, { outcome: 'needs_time_correction', payrollReady: false }),
      activityRow(33, { outcome: 'worked_as_scheduled', payrollReady: true }),
    ]

    expect(summarizeWorkforceActivityRows(rows).needsReview).toBe(2)
  })

  it('does not count an open vacancy as an employee or a salary confirmation as payroll ready', () => {
    const rows = [
      activityRow(34, { employeeId: null, employeeName: 'Open position', employeeNumber: null, outcome: 'open_unassigned', payrollReady: false }),
      activityRow(35, { employmentType: 'salary', outcome: 'salary_worked_confirmed', payrollReady: true }),
    ]

    expect(summarizeWorkforceActivityRows(rows)).toMatchObject({
      payrollReady: 0,
      salaryConfirmedRows: 1,
      uniqueEmployees: 1,
    })
  })

  it('preserves zero-minute evidence instead of treating it as missing', () => {
    const zeroMinutes = activityRow(7, { unpaidBreakMinutes: 0, workedMinutes: 0 })
    const [sheet] = workforceActivityWorkbook([zeroMinutes], metadata)
    const headerIndex = sheet.headerRows?.[0] ?? -1
    const header = sheet.rows[headerIndex]
    const detail = sheet.rows[headerIndex + 1]

    expect(detail[header.indexOf('Unpaid Break Minutes')]).toBe(0)
    expect(detail[header.indexOf('Worked Minutes')]).toBe(0)
    expect(detail[header.indexOf('Worked Hours')]).toBe(0)
  })

  it('writes the legal identity, event, locations, times, outcome, and time zone into the PDF', async () => {
    const bytes = await workforceActivityPdf([activityRow(4)], metadata)
    const text = (await textByPage(bytes)).flat().join(' ')

    expect(text).toContain('Alexandra Legalname 4')
    expect(text).toContain('Event: Annual Shareholder Event')
    expect(text).toContain('Acme Tower')
    expect(text).toContain('Worked as scheduled')
    expect(text).toContain('America/New_York')
    expect(text).toContain('478 min')
  })

  it('does not print inconsistent worked time for a salary confirmation PDF row', async () => {
    const salary = activityRow(8, {
      actualEndAt: '2026-09-22T21:45:00Z',
      actualStartAt: '2026-09-22T10:15:00Z',
      employmentType: 'salary',
      outcome: 'salary_worked_confirmed',
      unpaidBreakMinutes: 75,
      workedMinutes: 615,
    })
    const text = (await textByPage(await workforceActivityPdf([salary], metadata))).flat().join(' ')

    expect(text).toContain('Salary work confirmed')
    expect(text).toContain('Payroll: Not applicable')
    expect(text).not.toContain('615 min')
    expect(text).not.toContain('75 min')
  })

  it('repeats the report and table headings with page numbers across a multi-page PDF', async () => {
    const rows = Array.from({ length: 36 }, (_, index) => activityRow(index + 1))
    const pages = await textByPage(await workforceActivityPdf(rows, metadata))

    expect(pages.length).toBeGreaterThan(1)
    pages.forEach((items) => {
      expect(items).toContain('Workforce Activity')
      expect(items).toContain('Work date')
      expect(items).toContain('Legal employee')
      expect(items).toContain('Client')
      expect(items).toContain('Event')
      expect(items.some((item) => /^Page \d+ of \d+$/.test(item))).toBe(true)
    })
  })

  it('creates a clear one-page PDF when no rows match', async () => {
    const pages = await textByPage(await workforceActivityPdf([], metadata))
    expect(pages).toHaveLength(1)
    expect(pages[0]).toContain('No workforce activity matched the selected filters.')
  })

  it('uses a connected download anchor so PDF downloads work on mobile browsers', async () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const createObjectURL = vi.fn(() => 'blob:workforce-activity')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    let connectedWhenClicked = false
    let downloadedName = ''
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function clickDownload(this: HTMLAnchorElement) {
      connectedWhenClicked = this.isConnected
      downloadedName = this.download
    })
    vi.useFakeTimers()

    try {
      const fileName = await downloadWorkforceActivityPdf([activityRow(9)], metadata)
      vi.runOnlyPendingTimers()
      expect(connectedWhenClicked).toBe(true)
      expect(downloadedName).toBe(fileName)
      expect(createObjectURL).toHaveBeenCalledOnce()
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:workforce-activity')
    } finally {
      click.mockRestore()
      vi.useRealTimers()
      if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor)
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })
})
