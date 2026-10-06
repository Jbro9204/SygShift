import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkforceActivityReportPage, WorkforceActivityReportExport } from '../data/workforceActivity'
import type { WorkforceActivityRow } from './workforceActivityTypes'
import { WorkforceActivityReportWorkspace } from './WorkforceActivityReportWorkspace'
import { dateKeyInTimeZone } from '../lib/time'

const dataMocks = vi.hoisted(() => ({
  exportReport: vi.fn(),
  getEmployeeOptions: vi.fn(),
  getPage: vi.fn(),
}))
const downloadMocks = vi.hoisted(() => ({
  pdf: vi.fn(),
  xlsx: vi.fn(),
}))

vi.mock('../data/workforceActivity', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../data/workforceActivity')>()
  return {
    ...original,
    exportWorkforceActivityReport: dataMocks.exportReport,
    getWorkforceActivityReportEmployeeOptions: dataMocks.getEmployeeOptions,
    getWorkforceActivityReportPage: dataMocks.getPage,
  }
})

vi.mock('./workforceActivityExport', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('./workforceActivityExport')>()
  return {
    ...original,
    downloadWorkforceActivityPdf: downloadMocks.pdf,
    downloadWorkforceActivityXlsx: downloadMocks.xlsx,
  }
})

const employeeId = '10000000-0000-4000-8000-000000000001'
const zeroWorkEmployeeId = '10000000-0000-4000-8000-000000000002'
const eventId = '20000000-0000-4000-8000-000000000001'

function employeeOptions() {
  return [
    { id: employeeId, label: 'Alex Morgan', employeeNumber: 'SYG-1001' },
    { id: zeroWorkEmployeeId, label: 'Bailey Scheduled Only', employeeNumber: 'SYG-1002' },
  ]
}

function row(overrides: Partial<WorkforceActivityRow> = {}): WorkforceActivityRow {
  return {
    id: 'assignment:30000000-0000-4000-8000-000000000001',
    operationalDate: '2026-09-28',
    employeeId,
    employeeName: 'Alex Morgan',
    employeeNumber: 'SYG-1001',
    employmentType: 'hourly',
    shiftId: '40000000-0000-4000-8000-000000000001',
    assignmentId: '30000000-0000-4000-8000-000000000001',
    clientId: '50000000-0000-4000-8000-000000000001',
    clientName: 'Crow Events',
    eventId,
    eventName: 'Jason Crow Event',
    siteId: '60000000-0000-4000-8000-000000000001',
    siteCode: 'JC-01',
    siteName: 'Convention Hall',
    postId: '70000000-0000-4000-8000-000000000001',
    postName: 'Main Entrance',
    locationLabel: 'Jason Crow Event',
    locationDetail: 'Convention Hall · Main Entrance',
    timeZone: 'America/Denver',
    scheduledStartAt: '2026-09-28T15:00:00Z',
    scheduledEndAt: '2026-09-28T23:00:00Z',
    scheduledMinutes: 480,
    actualStartAt: '2026-09-28T15:03:00Z',
    actualEndAt: '2026-09-28T23:01:00Z',
    workedMinutes: 478,
    unpaidBreakMinutes: 30,
    outcome: 'worked_as_scheduled',
    payrollReady: true,
    notes: [],
    ...overrides,
  }
}

function page(rows = [row()], overrides: Partial<WorkforceActivityReportPage> = {}): WorkforceActivityReportPage {
  return {
    reportKey: 'workforceActivity',
    generatedAt: '2026-09-29T14:30:00Z',
    fromDate: '2026-09-28',
    throughDate: '2026-09-28',
    view: 'worked',
    groupBy: 'location',
    page: 1,
    pageSize: 25,
    totalCount: rows.length,
    totalPages: rows.length ? 1 : 0,
    summary: {
      scheduledAssignments: rows.length,
      actualWorkers: rows.length,
      scheduledMinutes: rows.reduce((total, item) => total + (item.scheduledMinutes ?? 0), 0),
      workedMinutes: rows.filter((item) => item.employmentType?.toLocaleLowerCase() !== 'salary').reduce((total, item) => total + (item.workedMinutes ?? 0), 0),
      callOffs: 0,
      replacements: 0,
      openPositions: 0,
      salaryConfirmed: rows.filter((item) => item.outcome === 'salary_worked_confirmed').length,
      needsReview: 0,
    },
    filterOptions: {
      views: [{ value: 'all', label: 'All activity' }, { value: 'worked', label: 'Worked' }],
      groupings: [{ value: 'location', label: 'Location' }, { value: 'employee', label: 'Employee' }, { value: 'day', label: 'Day' }],
      employees: [{ id: employeeId, label: 'Alex Morgan', employeeNumber: 'SYG-1001' }],
      clients: [{ id: '50000000-0000-4000-8000-000000000001', label: 'Crow Events' }],
      sites: [{ id: '60000000-0000-4000-8000-000000000001', label: 'Convention Hall' }],
      events: [{ id: eventId, label: 'Jason Crow Event' }],
      outcomes: [{ value: 'worked_as_scheduled', label: 'Worked as scheduled', count: rows.length }],
    },
    rows,
    ...overrides,
  }
}

function exportPage(rows: WorkforceActivityRow[], overrides: Partial<WorkforceActivityReportPage> = {}): WorkforceActivityReportExport {
  return {
    ...page(rows, { pageSize: rows.length, ...overrides }),
    exportId: '80000000-0000-4000-8000-000000000001',
    mode: 'export',
  }
}

function renderWorkspace(props: Partial<ComponentProps<typeof WorkforceActivityReportWorkspace>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  const onRangeChange = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkforceActivityReportWorkspace
          canExport
          from="2026-09-01"
          onRangeChange={onRangeChange}
          through="2026-09-28"
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onRangeChange }
}

describe('Workforce Activity report workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.setAttribute('open', '') })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.removeAttribute('open') })
    dataMocks.getPage.mockResolvedValue(page())
    dataMocks.getEmployeeOptions.mockResolvedValue(employeeOptions())
    dataMocks.exportReport.mockResolvedValue(exportPage([row()]))
    downloadMocks.xlsx.mockReturnValue('sygshift-workforce-activity.xlsx')
    downloadMocks.pdf.mockResolvedValue('sygshift-workforce-activity.pdf')
  })

  it('opens on one selected day in Who Worked and supports server-side people, event, outcome, search, and page filters', async () => {
    const user = userEvent.setup()
    dataMocks.getPage.mockResolvedValue(page([row()], { totalCount: 60, totalPages: 3 }))
    renderWorkspace()

    expect(await screen.findByRole('heading', { name: 'Jason Crow Event' })).toBeInTheDocument()
    expect(dataMocks.getPage).toHaveBeenCalledWith(expect.objectContaining({
      fromDate: '2026-09-28',
      throughDate: '2026-09-28',
      view: 'worked',
      groupBy: 'location',
      page: 1,
      pageSize: 25,
    }))
    expect(dataMocks.getEmployeeOptions).toHaveBeenCalled()
    expect(screen.getByRole('option', { name: 'Called off' })).toBeInTheDocument()
    expect(screen.getByText('Each record uses its assigned time zone')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'One day' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('tab', { name: 'Schedule Comparison' }))
    await user.selectOptions(screen.getByLabelText('Employee'), employeeId)
    await user.selectOptions(screen.getByLabelText('Location or event'), `event:${eventId}`)
    await user.selectOptions(screen.getByLabelText('Outcome'), 'worked_as_scheduled')
    await user.type(screen.getByRole('searchbox'), 'Jason Crow')
    await waitFor(() => expect(dataMocks.getPage).toHaveBeenCalledWith(expect.objectContaining({
      view: 'all',
      employeeId,
      eventId,
      outcome: 'worked_as_scheduled',
      search: 'Jason Crow',
      page: 1,
    })))

    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(dataMocks.getPage).toHaveBeenCalledWith(expect.objectContaining({ page: 2 })))
  })

  it('lets an authorized user choose an employee with no worked row and does not show another employee\'s previous result', async () => {
    const user = userEvent.setup()
    let resolveZeroWorkReport: ((value: WorkforceActivityReportPage) => void) | undefined
    dataMocks.getPage.mockImplementation((input: { employeeId?: string }) => {
      if (input.employeeId === zeroWorkEmployeeId) {
        return new Promise<WorkforceActivityReportPage>((resolve) => { resolveZeroWorkReport = resolve })
      }
      return Promise.resolve(page([row()]))
    })
    renderWorkspace()

    expect(await screen.findByRole('heading', { name: 'Jason Crow Event' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Bailey Scheduled Only · SYG-1002' })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Employee'), zeroWorkEmployeeId)

    await waitFor(() => expect(dataMocks.getPage).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: zeroWorkEmployeeId,
      page: 1,
      view: 'worked',
    })))
    expect(await screen.findByText('Loading workforce activity…')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Jason Crow Event' })).not.toBeInTheDocument()
    expect(screen.getByText('Showing work for')).toHaveTextContent('Bailey Scheduled Only')

    resolveZeroWorkReport?.(page([]))
    expect(await screen.findByText('No workforce activity was found for Bailey Scheduled Only.')).toBeInTheDocument()
    expect(screen.getByText('No recorded or confirmed work was found for Bailey Scheduled Only on this day. Open Schedule Comparison to review planned coverage.')).toBeInTheDocument()
  })

  it('keeps a validated, URL-persisted date-range mode for multi-day reporting', async () => {
    const user = userEvent.setup()
    const { onRangeChange } = renderWorkspace()
    await screen.findByRole('heading', { name: '1 record' })

    await user.click(screen.getByRole('button', { name: 'Date range' }))
    await waitFor(() => expect(dataMocks.getPage).toHaveBeenCalledWith(expect.objectContaining({
      fromDate: '2026-09-01',
      throughDate: '2026-09-28',
    })))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-10' } })
    expect(onRangeChange).toHaveBeenCalledWith('2026-09-10', '2026-09-28')
    const validCallCount = onRangeChange.mock.calls.length
    fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-08-31' } })
    expect(onRangeChange).toHaveBeenCalledTimes(validCallCount)
  })

  it('uses the signed-in user time zone for Today without changing each row time basis', async () => {
    const { onRangeChange } = renderWorkspace({ viewerTimeZone: 'America/Los_Angeles' })

    await screen.findByRole('heading', { name: '1 record' })
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))

    const expectedDay = dateKeyInTimeZone(new Date(), 'America/Los_Angeles')
    expect(onRangeChange).toHaveBeenCalledWith(expectedDay, expectedDay)
    expect(screen.getByText('America/Denver')).toBeInTheDocument()
  })

  it('downloads every filtered row through the audited export RPC instead of exporting only the visible page', async () => {
    const user = userEvent.setup()
    const allRows = [row(), row({ id: 'row:2', employeeName: 'Jamie Rivera', employeeId: '10000000-0000-4000-8000-000000000002' })]
    dataMocks.exportReport.mockResolvedValue(exportPage(allRows, { fromDate: '2026-09-01' }))
    renderWorkspace()

    await screen.findByRole('heading', { name: '1 record' })
    await user.click(screen.getByRole('button', { name: 'Date range' }))
    await user.selectOptions(screen.getByLabelText('Location or event'), `event:${eventId}`)
    await user.click(screen.getByRole('button', { name: 'Export Excel' }))

    await waitFor(() => expect(dataMocks.exportReport).toHaveBeenCalledWith(expect.objectContaining({
      fromDate: '2026-09-01',
      throughDate: '2026-09-28',
      eventId,
      view: 'worked',
    })))
    expect(downloadMocks.xlsx).toHaveBeenCalledWith(allRows, expect.objectContaining({
      fromDate: '2026-09-01',
      throughDate: '2026-09-28',
      filterDescription: expect.stringContaining('Jason Crow Event'),
    }))
    expect(await screen.findByText('sygshift-workforce-activity.xlsx downloaded.')).toBeInTheDocument()
  })

  it('never renders actual times or hours for salary work, even when a legacy payload supplies them', async () => {
    const user = userEvent.setup()
    const salaryRow = row({
      actualEndAt: '2026-09-28T23:00:00Z',
      actualStartAt: '2026-09-28T15:00:00Z',
      employmentType: 'Salary',
      outcome: 'salary_worked_confirmed',
      scheduledEndAt: null,
      scheduledMinutes: null,
      scheduledStartAt: null,
      unpaidBreakMinutes: 60,
      workedMinutes: 480,
    })
    dataMocks.getPage.mockResolvedValue(page([salaryRow]))
    renderWorkspace()

    expect(await screen.findByText('Work confirmed')).toBeInTheDocument()
    expect(screen.getByText('Confirmed — hours not calculated')).toBeInTheDocument()
    expect(screen.queryByText('8 hr')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View details' }))
    const dialog = screen.getByRole('dialog', { name: 'Alex Morgan' })
    expect(within(dialog).getAllByText('Confirmed without a punch time')).toHaveLength(2)
    expect(within(dialog).getByText('Not calculated for salary work')).toBeInTheDocument()
    expect(within(dialog).getByText('Not applicable for salary work')).toBeInTheDocument()
    expect(within(dialog).queryByText('8 hr')).not.toBeInTheDocument()
  })

  it('offers a retry after an error and explains a successful empty result', async () => {
    const user = userEvent.setup()
    dataMocks.getPage.mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce(page([]))
    renderWorkspace()

    expect(await screen.findByText('Workforce activity is unavailable')).toBeInTheDocument()
    expect(screen.getByText('Network unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No recorded or confirmed work was found for this day. Open Schedule Comparison to review planned coverage.')).toBeInTheDocument()
  })
})
