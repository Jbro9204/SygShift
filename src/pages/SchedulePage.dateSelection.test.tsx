import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SchedulePage } from './SchedulePage'

const mocks = vi.hoisted(() => {
  const channel: Record<string, ReturnType<typeof vi.fn>> = {}
  channel.on = vi.fn(() => channel)
  channel.subscribe = vi.fn(() => channel)
  return {
    channel,
    getScheduleBuilderOptions: vi.fn(),
    getSessionContext: vi.fn(),
    getWeeklySchedule: vi.fn(),
    removeChannel: vi.fn(),
    personalScheduleFailure: false,
    sessionEmployeeId: '11111111-1111-4111-8111-111111111111',
    sessionPermissions: [] as string[],
  }
})

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({
    channel: vi.fn(() => mocks.channel),
    removeChannel: mocks.removeChannel,
  }),
  isSupabaseConfigured: true,
}))

vi.mock('../data/auth', async (original) => ({
  ...await original<typeof import('../data/auth')>(),
  getSessionContext: mocks.getSessionContext,
}))

vi.mock('../data/maintenance', async (original) => ({
  ...await original<typeof import('../data/maintenance')>(),
  getMaintenanceStatus: async () => ({
    active: [],
    recentlyCompleted: [],
    serverTime: '2026-10-14T16:00:00.000Z',
    upcoming: [],
  }),
}))

vi.mock('../data/schedule', async (original) => ({
  ...await original<typeof import('../data/schedule')>(),
  getScheduleBuilderOptions: mocks.getScheduleBuilderOptions,
  getWeeklySchedule: mocks.getWeeklySchedule,
}))

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function sessionContext() {
  return {
    displayName: 'Test Employee',
    employeeId: mocks.sessionEmployeeId,
    hasMfa: false,
    mfaEnrolledAt: null,
    mfaRequired: false,
    mustChangePassword: false,
    passwordChangedAt: null,
    permissions: mocks.sessionPermissions,
    role: 'guard' as const,
    timeZone: 'America/New_York',
    username: 'test.employee',
  }
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('Schedule date retention', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class {
      disconnect() {}
      observe() {}
      unobserve() {}
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: vi.fn(function showModal(this: HTMLDialogElement) { this.open = true }),
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: vi.fn(function close(this: HTMLDialogElement) { this.open = false }),
    })
  })

  afterAll(() => vi.unstubAllGlobals())

  beforeEach(() => {
    window.sessionStorage.clear()
    mocks.sessionEmployeeId = '11111111-1111-4111-8111-111111111111'
    mocks.sessionPermissions = []
    mocks.personalScheduleFailure = false
    mocks.getSessionContext.mockReset()
    mocks.getSessionContext.mockImplementation(async () => sessionContext())
    mocks.getWeeklySchedule.mockReset()
    mocks.getScheduleBuilderOptions.mockReset()
    mocks.getScheduleBuilderOptions.mockResolvedValue({ employees: [], posts: [] })
    mocks.getWeeklySchedule.mockImplementation(async (weekStartsOn: string) => {
      if (mocks.personalScheduleFailure) throw new Error('personal schedule details could not be verified')
      return ({
      id: '22222222-2222-4222-8222-222222222222',
      published_at: '2026-10-01T12:00:00.000Z',
      revision: 1,
      shifts: [],
      status: 'published',
      week_starts_on: weekStartsOn,
      })
    })
    mocks.removeChannel.mockReset()
  })

  it('restores the exact personal-schedule week and range after navigation and background refresh', async () => {
    const queryClient = createQueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/schedule']}>
          <LocationProbe />
          <Routes>
            <Route path="/schedule" element={<><Link to="/other">Leave Schedule</Link><SchedulePage /></>} />
            <Route path="/other" element={<Link to="/schedule">Return to Schedule</Link>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await screen.findByText('10/11/2026 - 10/24/2026')
    fireEvent.click(screen.getByRole('button', { name: '1 week' }))
    await screen.findByText('10/11/2026 - 10/17/2026')
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))

    await screen.findByText('10/04/2026 - 10/10/2026')
    expect(screen.getByTestId('location')).toHaveTextContent('/schedule?week=2026-10-04&range=1w')
    await waitFor(() => expect(mocks.getWeeklySchedule).toHaveBeenCalledWith('2026-10-04'))

    fireEvent.click(screen.getByRole('link', { name: 'Leave Schedule' }))
    fireEvent.click(await screen.findByRole('link', { name: 'Return to Schedule' }))

    expect(await screen.findByText('10/04/2026 - 10/10/2026')).toBeVisible()
    expect(screen.getByRole('button', { name: '1 week' })).toHaveClass('is-active')
    expect(screen.getByTestId('location')).toHaveTextContent('/schedule?week=2026-10-04&range=1w')

    const historicalFetchCount = mocks.getWeeklySchedule.mock.calls
      .filter(([weekStartsOn]) => weekStartsOn === '2026-10-04').length
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await queryClient.invalidateQueries({ queryKey: ['weekly-schedule'] })
    await queryClient.invalidateQueries({ queryKey: ['personal-schedule-range'] })

    await waitFor(() => expect(mocks.getWeeklySchedule.mock.calls
      .filter(([weekStartsOn]) => weekStartsOn === '2026-10-04').length).toBeGreaterThan(historicalFetchCount))
    expect(screen.getByText('10/04/2026 - 10/10/2026')).toBeVisible()

    mocks.personalScheduleFailure = true
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['personal-schedule-range'] })
    })
    expect(await screen.findByText('Your schedule could not be loaded')).toBeVisible()
    expect(screen.queryByLabelText('Personal schedule summary')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add to calendar' })).not.toBeInTheDocument()
    mocks.personalScheduleFailure = false

    fireEvent.click(screen.getByRole('button', { name: 'This week' }))
    expect(await screen.findByText('10/11/2026 - 10/17/2026')).toBeVisible()
    expect(screen.getByTestId('location')).toHaveTextContent('/schedule?week=2026-10-11&range=1w')
    await waitFor(() => expect(mocks.getWeeklySchedule).toHaveBeenCalledWith('2026-10-11'))
  })

  it('keeps Schedule and Scheduler week selections independent across route remounts', async () => {
    mocks.sessionPermissions = ['schedule.view', 'scheduler.view']
    const queryClient = createQueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/schedule']}>
          <LocationProbe />
          <Routes>
            <Route path="/schedule" element={<><Link to="/scheduler">Go to Scheduler route</Link><SchedulePage /></>} />
            <Route path="/scheduler" element={<><Link to="/schedule">Go to Schedule route</Link><SchedulePage mode="scheduler" /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await screen.findByRole('heading', { name: '10/18/2026 – 10/24/2026' })
    await waitFor(() => expect(mocks.getWeeklySchedule).toHaveBeenCalledWith('2026-10-18'))
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    expect(await screen.findByRole('heading', { name: '10/11/2026 – 10/17/2026' })).toBeVisible()
    await waitFor(() => expect(mocks.getWeeklySchedule).toHaveBeenCalledWith('2026-10-11'))

    fireEvent.click(screen.getByRole('link', { name: 'Go to Scheduler route' }))
    expect(await screen.findByRole('heading', { name: '10/18/2026 – 10/24/2026' })).toBeVisible()
    expect(screen.getByTestId('location')).toHaveTextContent('/scheduler?week=2026-10-18')

    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    await screen.findByRole('heading', { name: '10/11/2026 – 10/17/2026' })
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    expect(await screen.findByRole('heading', { name: '10/04/2026 – 10/10/2026' })).toBeVisible()
    await waitFor(() => expect(mocks.getWeeklySchedule).toHaveBeenCalledWith('2026-10-04'))

    fireEvent.click(screen.getByRole('link', { name: 'Go to Schedule route' }))
    expect(await screen.findByRole('heading', { name: '10/11/2026 – 10/17/2026' })).toBeVisible()
    expect(screen.getByTestId('location')).toHaveTextContent('/schedule?week=2026-10-11&range=2w')
  })

  it('drops the previous employee range and falls back to the current employee-local week on account change', async () => {
    const queryClient = createQueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/schedule']}>
          <LocationProbe />
          <Routes>
            <Route path="/schedule" element={<SchedulePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await screen.findByText('10/11/2026 - 10/24/2026')
    fireEvent.click(screen.getByRole('button', { name: '1 week' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    await screen.findByText('10/04/2026 - 10/10/2026')

    mocks.sessionEmployeeId = '33333333-3333-4333-8333-333333333333'
    queryClient.setQueryData(['session-context'], sessionContext())

    expect(await screen.findByText('10/11/2026 - 10/24/2026')).toBeVisible()
    await waitFor(() => expect(screen.queryByText('10/04/2026 - 10/10/2026')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: '2 weeks' })).toHaveClass('is-active'))
    expect(screen.getByTestId('location')).toHaveTextContent('/schedule?week=2026-10-11&range=2w')
  })

  it('hides cached team coverage everywhere when a background schedule refresh fails', async () => {
    mocks.sessionPermissions = ['schedule.view']
    const queryClient = createQueryClient()
    const view = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/schedule']}>
          <Routes>
            <Route path="/schedule" element={<SchedulePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Published shifts')).toBeVisible()
    expect(view.container.querySelectorAll('.mobile-schedule-day')).toHaveLength(7)
    mocks.getWeeklySchedule.mockRejectedValue(new Error('latest schedule could not be verified'))

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['weekly-schedule'] })
    })

    expect(await screen.findAllByText('Schedule unavailable')).not.toHaveLength(0)
    expect(screen.queryByText('Published shifts')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add to calendar' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Filter by site')).not.toBeInTheDocument()
    expect(view.container.querySelectorAll('.mobile-schedule-day')).toHaveLength(0)
  })

  it('closes option-dependent schedule editors when a background options refresh fails', async () => {
    mocks.sessionPermissions = ['schedule.manage']
    const queryClient = createQueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/scheduler']}>
          <Routes>
            <Route path="/scheduler" element={<SchedulePage mode="scheduler" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const addShiftButton = await screen.findByRole('button', { name: 'Add shift or event' })
    await waitFor(() => expect(addShiftButton).toBeEnabled())
    fireEvent.click(addShiftButton)
    expect(await screen.findByRole('dialog', { name: 'Add a shift or event' })).toBeVisible()

    mocks.getScheduleBuilderOptions.mockRejectedValue(new Error('employee and post choices could not be verified'))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['schedule-builder-options'] })
    })

    expect(await screen.findByText('Schedule editing tools unavailable')).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Add a shift or event' })).not.toBeInTheDocument()
    expect(addShiftButton).toBeDisabled()
  })
})
