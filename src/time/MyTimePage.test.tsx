import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MyTimePage } from './MyTimePage'

const mocks = vi.hoisted(() => ({
  dashboardOperationalDate: '2026-09-06',
  payrollFromDate: '2026-09-06',
  payrollThroughDate: '2026-09-19',
  review: vi.fn(),
  serverTimestamp: '2026-09-06T16:00:00Z',
}))
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({ getSessionContext: async () => ({ permissions: ['time.self.view'] }) }))
vi.mock('../data/timekeeping', async (original) => ({ ...await original<typeof import('../data/timekeeping')>(),
  getTimekeepingDashboard: async () => ({
    employee: { id: 'employee', displayName: 'Test Employee' },
    operationalDate: mocks.dashboardOperationalDate,
    serverTimestamp: mocks.serverTimestamp,
    recentEvents: [],
    eligibleShifts: [{
      assignmentId: '10000000-0000-4000-8000-000000000001',
      shiftId: '20000000-0000-4000-8000-000000000001',
      status: 'assigned',
      startsAt: '2026-09-07T16:00:00.000Z',
      endsAt: '2026-09-08T00:00:00.000Z',
      timeZone: 'America/Denver',
      requiresArmed: false,
      isOvertime: false,
      assignmentType: 'standard',
      postName: 'Market post',
      siteName: 'Market',
      siteCode: 'MKT',
      eventName: null,
      locationName: 'Market',
      workType: 'post',
    }, {
      assignmentId: '10000000-0000-4000-8000-000000000002',
      shiftId: '20000000-0000-4000-8000-000000000002',
      status: 'assigned',
      startsAt: '2026-09-08T05:00:00.000Z',
      endsAt: '2026-09-08T11:00:00.000Z',
      timeZone: 'America/Denver',
      requiresArmed: false,
      isOvertime: false,
      assignmentType: 'standard',
      postName: 'Night post',
      siteName: 'Night site',
      siteCode: 'NGT',
      eventName: null,
      locationName: 'Night site',
      workType: 'post',
    }],
    pendingCorrectionCount: 0,
  }),
  getPayrollPeriodContext: async () => ({ serverTimestamp: mocks.serverTimestamp, fromDate: mocks.payrollFromDate, throughDate: mocks.payrollThroughDate, timeZone: 'America/Denver', weekStartsOn: 0, availablePeriods: [
    { offset: 0, fromDate: mocks.payrollFromDate, throughDate: mocks.payrollThroughDate }, { offset: 1, fromDate: '2026-08-23', throughDate: '2026-09-05' }, { offset: 2, fromDate: '2026-08-09', throughDate: '2026-08-22' },
  ] }), getOwnTimekeepingReview: mocks.review,
}))
vi.mock('../data/timeOperations', async (original) => ({ ...await original<typeof import('../data/timeOperations')>(), getMissingTimeRequestWorkspace: async () => ({ requests: [], posts: [] }) }))

describe('My Time pay-period history', () => {
  beforeEach(() => {
    mocks.dashboardOperationalDate = '2026-09-06'
    mocks.payrollFromDate = '2026-09-06'
    mocks.payrollThroughDate = '2026-09-19'
    mocks.serverTimestamp = '2026-09-06T16:00:00Z'
  })

  it('offers the next-day assigned shift in the call-off form', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    mocks.review.mockResolvedValue({
      fromDate: '2026-09-20',
      throughDate: '2026-10-03',
      pendingCorrections: [],
      serverTimestamp: '2026-09-06T16:00:00Z',
      rows: [],
    })
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MyTimePage /></MemoryRouter></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Report sick / call-off' }))
    const dialog = screen.getByRole('dialog', { name: 'Report sick or call-off' })
    expect(within(dialog).getByRole('option', { name: /09\/07\/2026.*Market/ })).toBeVisible()
    expect(within(dialog).getByRole('option', { name: /09\/07\/2026.*Night site/ })).toBeVisible()
    expect(within(dialog).queryByRole('option', { name: /09\/08\/2026.*Night site/ })).not.toBeInTheDocument()
  })

  it('loads all three server-defined periods while keeping Today on the current period', async () => {
    mocks.review.mockImplementation(async ({ fromDate, throughDate }) => ({ fromDate, throughDate, pendingCorrections: [], serverTimestamp: '2026-09-06T16:00:00Z', rows: [{ employeeId: 'employee', operationalDate: fromDate, weekStartsOn: fromDate, paidMinutes: fromDate === '2026-09-06' ? 60 : fromDate === '2026-08-23' ? 120 : 180, locationName: `Post ${fromDate}`, rowKind: 'time_event', shiftId: null, exceptionCodes: [], payrollReady: true, breakMinutes: 0 }] }))
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MyTimePage /></MemoryRouter></QueryClientProvider>)
    const picker = await screen.findByRole('combobox', { name: 'Pay period' })
    expect(within(picker).getAllByRole('option')).toHaveLength(3)
    await screen.findByText('Post 2026-09-06')
    const todayMetric = screen.getByText('Today').closest('article')!
    expect(todayMetric).toHaveTextContent('1.00 hrs')
    fireEvent.change(picker, { target: { value: '1' } })
    await screen.findByText('Post 2026-08-23')
    expect(todayMetric).toHaveTextContent('1.00 hrs')
    expect(screen.queryByText('Post 2026-09-06')).not.toBeInTheDocument()
    fireEvent.change(picker, { target: { value: '2' } })
    await screen.findByText('Post 2026-08-09')
    await waitFor(() => expect(mocks.review).toHaveBeenCalledWith({ employeeId: 'employee', fromDate: '2026-08-09', throughDate: '2026-08-22' }))
    expect(todayMetric).toHaveTextContent('1.00 hrs')
    fireEvent.change(picker, { target: { value: '0' } })
    await screen.findByText('Post 2026-09-06')
  })

  it('keeps one crossing timecard while using payroll-week allocations for employee totals', async () => {
    mocks.review.mockResolvedValue({
      fromDate: '2026-09-06',
      throughDate: '2026-09-19',
      pendingCorrections: [],
      serverTimestamp: '2026-09-06T16:00:00Z',
      rows: [{
        breakMinutes: 0,
        crossesPayrollBoundary: true,
        employeeId: 'employee',
        exceptionCodes: [],
        grossMinutes: 360,
        locationName: 'Boundary Post',
        occurrenceBreakMinutes: 0,
        occurrenceGrossMinutes: 480,
        occurrenceOvertimeMinutes: 0,
        occurrencePaidMinutes: 480,
        occurrenceRegularMinutes: 480,
        occurrenceUnpaidGapMinutes: 0,
        operationalDate: '2026-09-05',
        overtimeMinutes: 0,
        paidMinutes: 360,
        payrollOccurrenceKey: 'shift:boundary:employee:employee',
        payrollReady: true,
        payrollWeekAllocations: [{
          allocationKey: 'shift:boundary:employee:employee|2026-09-06',
          breakMinutes: 0,
          epMinutes: 0,
          grossMinutes: 360,
          overtimeMinutes: 0,
          paidMinutes: 360,
          regularCategoryMinutes: 360,
          regularMinutes: 360,
          truepMinutes: 0,
          unclassifiedCategoryMinutes: 0,
          unpaidGapMinutes: 0,
          weekEndsOn: '2026-09-12',
          weekStartsOn: '2026-09-06',
        }],
        regularMinutes: 360,
        rowKind: 'time_event',
        shiftId: '20000000-0000-4000-8000-000000000099',
        unpaidGapMinutes: 0,
      }],
    })

    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MyTimePage /></MemoryRouter></QueryClientProvider>)

    await screen.findByText('Boundary Post')
    expect(screen.getAllByRole('article').filter((article) => article.classList.contains('my-time-row'))).toHaveLength(1)
    expect(screen.getByText('This Week').closest('article')).toHaveTextContent('6.00 hrs')
    expect(screen.getByText('Selected Period').closest('article')).toHaveTextContent('6.00 hrs')
    expect(screen.getByText('8.00 hrs')).toBeVisible()
    expect(screen.getByText(/This remains one 8.00-hour timecard/)).toHaveTextContent('6.00 hrs to 09/06/2026–09/12/2026')
    expect(screen.getByText(/This remains one 8.00-hour timecard/)).toHaveTextContent('2.00 hrs to an adjacent pay period')
  })

  it('includes a salary default in the matching My Time weekly total', async () => {
    mocks.review.mockResolvedValue({
      fromDate: '2026-09-06',
      throughDate: '2026-09-19',
      pendingCorrections: [],
      serverTimestamp: '2026-09-06T16:00:00Z',
      rows: [{
        breakMinutes: 0,
        employeeId: 'employee',
        exceptionCodes: [],
        grossMinutes: 2_400,
        locationName: 'Salary default',
        operationalDate: '2026-09-06',
        overtimeMinutes: 0,
        paidMinutes: 2_400,
        payrollReady: true,
        regularMinutes: 2_400,
        rowKind: 'salary_default',
        shiftId: null,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-09-12',
        weekStartsOn: '2026-09-06',
      }],
    })

    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MyTimePage /></MemoryRouter></QueryClientProvider>)

    await screen.findAllByText('Salary default')
    expect(screen.getByText('This Week').closest('article')).toHaveTextContent('40.00 hrs')
    expect(screen.getByText('Selected Period').closest('article')).toHaveTextContent('40.00 hrs')
    expect(screen.queryByText(/adjacent pay period/)).not.toBeInTheDocument()
  })

  it('keeps This Week on the Denver payroll week before Denver Sunday midnight', async () => {
    mocks.dashboardOperationalDate = '2026-09-06'
    mocks.payrollFromDate = '2026-08-23'
    mocks.payrollThroughDate = '2026-09-05'
    mocks.serverTimestamp = '2026-09-06T05:30:00.000Z'
    mocks.review.mockResolvedValue({
      fromDate: '2026-08-23',
      throughDate: '2026-09-05',
      pendingCorrections: [],
      serverTimestamp: mocks.serverTimestamp,
      rows: [{
        breakMinutes: 0,
        employeeId: 'employee',
        exceptionCodes: [],
        grossMinutes: 60,
        locationName: 'Eastern employee shift',
        operationalDate: '2026-09-05',
        overtimeMinutes: 0,
        paidMinutes: 60,
        payrollOccurrenceKey: 'shift:eastern-boundary:employee:employee',
        payrollReady: true,
        payrollWeekAllocations: [{
          allocationKey: 'shift:eastern-boundary:employee:employee|2026-08-30',
          breakMinutes: 0,
          epMinutes: 0,
          grossMinutes: 60,
          overtimeMinutes: 0,
          paidMinutes: 60,
          regularCategoryMinutes: 60,
          regularMinutes: 60,
          truepMinutes: 0,
          unclassifiedCategoryMinutes: 0,
          unpaidGapMinutes: 0,
          weekEndsOn: '2026-09-05',
          weekStartsOn: '2026-08-30',
        }],
        regularMinutes: 60,
        rowKind: 'time_event',
        shiftId: null,
        timeZone: 'America/New_York',
        unpaidGapMinutes: 0,
      }],
    })

    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MyTimePage /></MemoryRouter></QueryClientProvider>)

    await screen.findByText('Eastern employee shift')
    expect(screen.getByText('This Week').closest('article')).toHaveTextContent('1.00 hrs')
  })
})
