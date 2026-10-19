import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MyTimePage } from './MyTimePage'

const mocks = vi.hoisted(() => ({
  dashboardOperationalDate: '2026-09-06',
  employeeTimeZone: 'America/Denver',
  sessionEmployeeId: 'employee-a',
  payrollFromDate: '2026-09-06',
  payrollThroughDate: '2026-09-19',
  recentEvents: [] as Array<Record<string, unknown>>,
  requestCorrection: vi.fn(),
  review: vi.fn(),
  serverTimestamp: '2026-09-06T16:00:00Z',
}))
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({ getSessionContext: async () => ({ employeeId: mocks.sessionEmployeeId, permissions: ['time.self.view'] }) }))
vi.mock('../data/timekeeping', async (original) => ({ ...await original<typeof import('../data/timekeeping')>(),
  getTimekeepingDashboard: async () => ({
    employee: { id: mocks.sessionEmployeeId, displayName: 'Test Employee', timeZone: mocks.employeeTimeZone, username: 'test.employee' },
    operationalDate: mocks.dashboardOperationalDate,
    serverTimestamp: mocks.serverTimestamp,
    recentEvents: mocks.recentEvents,
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
  ] }), getOwnTimekeepingReview: mocks.review, requestTimeEventCorrection: mocks.requestCorrection,
}))
vi.mock('../data/timeOperations', async (original) => ({ ...await original<typeof import('../data/timeOperations')>(), getMissingTimeRequestWorkspace: async () => ({ requests: [], posts: [] }) }))

describe('My Time pay-period history', () => {
  beforeEach(() => {
    mocks.dashboardOperationalDate = '2026-09-06'
    mocks.employeeTimeZone = 'America/Denver'
    mocks.sessionEmployeeId = 'employee-a'
    mocks.payrollFromDate = '2026-09-06'
    mocks.payrollThroughDate = '2026-09-19'
    mocks.recentEvents = []
    mocks.requestCorrection.mockReset()
    mocks.requestCorrection.mockResolvedValue({})
    mocks.serverTimestamp = '2026-09-06T16:00:00Z'
    window.sessionStorage.clear()
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
    await waitFor(() => expect(mocks.review).toHaveBeenCalledWith({ employeeId: 'employee-a', fromDate: '2026-08-09', throughDate: '2026-08-22' }))
    expect(todayMetric).toHaveTextContent('1.00 hrs')
    fireEvent.change(picker, { target: { value: '0' } })
    await screen.findByText('Post 2026-09-06')
  })

  it('restores the exact historical period after app navigation remounts My Time', async () => {
    mocks.review.mockImplementation(async ({ employeeId, fromDate, throughDate }) => ({
      fromDate,
      throughDate,
      pendingCorrections: [],
      serverTimestamp: mocks.serverTimestamp,
      rows: [{ breakMinutes: 0, employeeId, exceptionCodes: [], locationName: `Post ${fromDate}`, operationalDate: fromDate, overtimeMinutes: 0, paidMinutes: 60, payrollReady: true, regularMinutes: 60, rowKind: 'time_event', shiftId: null, unpaidGapMinutes: 0 }],
    }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/time/my-time']}>
          <Routes>
            <Route path="/time/my-time" element={<><Link to="/other">Leave My Time</Link><MyTimePage /></>} />
            <Route path="/other" element={<Link to="/time/my-time">Return to My Time</Link>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const picker = await screen.findByRole('combobox', { name: 'Pay period' })
    fireEvent.change(picker, { target: { value: '2' } })
    await screen.findByText('Post 2026-08-09')
    fireEvent.click(screen.getByRole('link', { name: 'Leave My Time' }))
    fireEvent.click(await screen.findByRole('link', { name: 'Return to My Time' }))

    expect(await screen.findByRole('combobox', { name: 'Pay period' })).toHaveValue('2')
    expect(await screen.findByText('Post 2026-08-09')).toBeVisible()
    expect(screen.getByText('08/09/2026 - 08/22/2026')).toBeVisible()
    await waitFor(() => expect(mocks.review).toHaveBeenLastCalledWith({ employeeId: 'employee-a', fromDate: '2026-08-09', throughDate: '2026-08-22' }))
  })

  it('refreshes data on focus and visibility changes without replacing the selected period', async () => {
    mocks.review.mockImplementation(async ({ employeeId, fromDate, throughDate }) => ({
      fromDate,
      throughDate,
      pendingCorrections: [],
      serverTimestamp: mocks.serverTimestamp,
      rows: [{ breakMinutes: 0, employeeId, exceptionCodes: [], locationName: `Post ${fromDate}`, operationalDate: fromDate, overtimeMinutes: 0, paidMinutes: 60, payrollReady: true, regularMinutes: 60, rowKind: 'time_event', shiftId: null, unpaidGapMinutes: 0 }],
    }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><MemoryRouter><MyTimePage /></MemoryRouter></QueryClientProvider>)
    const picker = await screen.findByRole('combobox', { name: 'Pay period' })
    fireEvent.change(picker, { target: { value: '1' } })
    await screen.findByText('Post 2026-08-23')

    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await queryClient.invalidateQueries({ queryKey: ['my-time-payroll-period'] })
    await queryClient.invalidateQueries({ queryKey: ['my-time-review'] })

    expect(screen.getByRole('combobox', { name: 'Pay period' })).toHaveValue('1')
    expect(await screen.findByText('Post 2026-08-23')).toBeVisible()
    await waitFor(() => expect(mocks.review).toHaveBeenLastCalledWith({ employeeId: 'employee-a', fromDate: '2026-08-23', throughDate: '2026-09-05' }))
  })

  it('clears the prior range when the authenticated employee changes', async () => {
    mocks.review.mockImplementation(async ({ employeeId, fromDate, throughDate }) => ({
      fromDate,
      throughDate,
      pendingCorrections: [],
      serverTimestamp: mocks.serverTimestamp,
      rows: [{ breakMinutes: 0, employeeId, exceptionCodes: [], locationName: `${employeeId} ${fromDate}`, operationalDate: fromDate, overtimeMinutes: 0, paidMinutes: 60, payrollReady: true, regularMinutes: 60, rowKind: 'time_event', shiftId: null, unpaidGapMinutes: 0 }],
    }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><MemoryRouter><MyTimePage /></MemoryRouter></QueryClientProvider>)
    const picker = await screen.findByRole('combobox', { name: 'Pay period' })
    fireEvent.change(picker, { target: { value: '2' } })
    await screen.findByText('employee-a 2026-08-09')

    mocks.sessionEmployeeId = 'employee-b'
    queryClient.setQueryData(['session-context'], { employeeId: 'employee-b', permissions: ['time.self.view'] })

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Pay period' })).toHaveValue('0'))
    expect(await screen.findByText('employee-b 2026-09-06')).toBeVisible()
    expect(screen.queryByText('employee-a 2026-08-09')).not.toBeInTheDocument()
    await waitFor(() => expect(mocks.review).toHaveBeenLastCalledWith({ employeeId: 'employee-b', fromDate: '2026-09-06', throughDate: '2026-09-19' }))
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

  it('renders, groups, and round-trips punches in the employee profile time zone', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    mocks.dashboardOperationalDate = '2026-10-12'
    mocks.employeeTimeZone = 'America/New_York'
    mocks.payrollFromDate = '2026-10-04'
    mocks.payrollThroughDate = '2026-10-17'
    mocks.serverTimestamp = '2026-10-12T17:00:00.000Z'
    mocks.recentEvents = [{
      effectiveAt: '2026-10-12T13:00:00.000Z',
      id: '30000000-0000-4000-8000-000000000001',
      kind: 'clock_in',
      recordedAt: '2026-10-12T13:00:00.000Z',
      shiftId: '20000000-0000-4000-8000-000000000001',
      source: 'web',
      voided: false,
      workType: 'post',
    }, {
      effectiveAt: '2026-10-12T04:30:00.000Z',
      id: '30000000-0000-4000-8000-000000000002',
      kind: 'clock_out',
      recordedAt: '2026-10-12T04:30:00.000Z',
      shiftId: '20000000-0000-4000-8000-000000000002',
      source: 'web',
      voided: false,
      workType: 'post',
    }]
    mocks.review.mockResolvedValue({
      fromDate: mocks.payrollFromDate,
      pendingCorrections: [],
      rows: [],
      serverTimestamp: mocks.serverTimestamp,
      throughDate: mocks.payrollThroughDate,
    })

    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MyTimePage /></MemoryRouter></QueryClientProvider>)

    const nineAmPunch = await screen.findByText('10/12/2026, 9:00 AM (09:00) EDT')
    expect(screen.getByText('10/12/2026, 12:30 AM (00:30) EDT')).toBeVisible()
    expect(screen.getByRole('tab', { name: /Today.*2 punches/ })).toBeVisible()

    fireEvent.click(within(nineAmPunch.closest('li')!).getByRole('button', { name: 'Request correction' }))
    const dialog = screen.getByRole('dialog', { name: 'Request a time-card correction' })
    expect(within(dialog).getByLabelText('Correct date')).toHaveValue('2026-10-12')
    expect(within(dialog).getByLabelText('Correct time / Eastern Time')).toHaveValue('09:00')
    fireEvent.change(within(dialog).getByLabelText(/Explain the request/), { target: { value: 'Confirm the profile-zone punch time.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send correction request' }))

    await waitFor(() => expect(mocks.requestCorrection).toHaveBeenCalledWith({
      reason: 'Employee requested time correction: Confirm the profile-zone punch time.',
      replacementTime: '2026-10-12T13:00:00.000Z',
      timeEventId: '30000000-0000-4000-8000-000000000001',
      voided: false,
    }))
  })

  it('matches a near-midnight punch to its timecard by shift identity before comparing local dates', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    mocks.dashboardOperationalDate = '2026-10-12'
    mocks.employeeTimeZone = 'America/New_York'
    mocks.payrollFromDate = '2026-10-04'
    mocks.payrollThroughDate = '2026-10-17'
    mocks.serverTimestamp = '2026-10-12T17:00:00.000Z'
    mocks.recentEvents = [{
      effectiveAt: '2026-10-12T04:30:00.000Z',
      id: '30000000-0000-4000-8000-000000000002',
      kind: 'clock_out',
      recordedAt: '2026-10-12T04:30:00.000Z',
      shiftId: '20000000-0000-4000-8000-000000000002',
      source: 'web',
      voided: false,
      workType: 'post',
    }]
    mocks.review.mockResolvedValue({
      fromDate: mocks.payrollFromDate,
      pendingCorrections: [],
      rows: [{
        breakMinutes: 0,
        employeeId: 'employee',
        exceptionCodes: [],
        firstClockIn: '2026-10-12T03:30:00.000Z',
        lastClockOut: '2026-10-12T04:30:00.000Z',
        locationName: 'Cross-zone overnight shift',
        operationalDate: '2026-10-11',
        overtimeMinutes: 0,
        paidMinutes: 60,
        payrollReady: true,
        regularMinutes: 60,
        rowKind: 'time_event',
        shiftId: '20000000-0000-4000-8000-000000000002',
        unpaidGapMinutes: 0,
      }],
      serverTimestamp: mocks.serverTimestamp,
      throughDate: mocks.payrollThroughDate,
    })

    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MyTimePage /></MemoryRouter></QueryClientProvider>)

    const timecard = (await screen.findByText('Cross-zone overnight shift')).closest('article')!
    expect(timecard).toHaveTextContent('10/11/2026, 11:30 PM (23:30) EDT - 10/12/2026, 12:30 AM (00:30) EDT')
    fireEvent.click(within(timecard).getByRole('button', { name: 'Request correction' }))
    const dialog = screen.getByRole('dialog', { name: 'Request a time-card correction' })
    expect(within(dialog).getByText('10/12/2026, 12:30 AM (00:30) EDT')).toBeVisible()
    expect(within(dialog).getByLabelText('Correct date')).toHaveValue('2026-10-12')
    expect(within(dialog).getByLabelText('Correct time / Eastern Time')).toHaveValue('00:30')
  })

  it('keeps an invalid Eastern daylight-saving correction in the modal with clear guidance', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    mocks.dashboardOperationalDate = '2026-03-08'
    mocks.employeeTimeZone = 'America/New_York'
    mocks.payrollFromDate = '2026-03-01'
    mocks.payrollThroughDate = '2026-03-14'
    mocks.serverTimestamp = '2026-03-08T12:00:00.000Z'
    mocks.recentEvents = [{
      effectiveAt: '2026-03-08T06:30:00.000Z',
      id: '30000000-0000-4000-8000-000000000003',
      kind: 'clock_in',
      recordedAt: '2026-03-08T06:30:00.000Z',
      shiftId: '20000000-0000-4000-8000-000000000003',
      source: 'web',
      voided: false,
      workType: 'post',
    }]
    mocks.review.mockResolvedValue({
      fromDate: mocks.payrollFromDate,
      pendingCorrections: [],
      rows: [],
      serverTimestamp: mocks.serverTimestamp,
      throughDate: mocks.payrollThroughDate,
    })

    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MyTimePage /></MemoryRouter></QueryClientProvider>)

    fireEvent.click(await screen.findByRole('button', { name: 'Request correction' }))
    const dialog = screen.getByRole('dialog', { name: 'Request a time-card correction' })
    fireEvent.change(within(dialog).getByLabelText('Correct time / Eastern Time'), { target: { value: '02:30' } })
    fireEvent.change(within(dialog).getByLabelText(/Explain the request/), { target: { value: 'Correct this daylight-saving punch.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send correction request' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That local time does not exist in the selected time zone because of daylight-saving time.')
    expect(mocks.requestCorrection).not.toHaveBeenCalled()
    expect(dialog).toBeVisible()
  })
})
