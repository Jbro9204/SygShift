import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdentityVerificationHost } from '../components/IdentityVerificationHost'
import { getTimekeepingReview } from '../data/timekeeping'
import {
  cancelIdentityVerification,
  clearIdentityVerificationSession,
  setIdentityVerificationSurface,
  subscribeToIdentityVerification,
} from '../lib/identityVerificationCoordinator'
import { TimeCommandCenterPage } from './TimeCommandCenterPage'
import { MyTimePage } from './MyTimePage'

// Keep both pages and their actual timekeeping data accessors. Only the
// authenticated transport is synthetic: this catches an own-time accessor
// accidentally invoking the protected team endpoint again.
const transport = vi.hoisted(() => {
  const rpc = vi.fn()
  const getSession = vi.fn()
  const onAuthStateChange = vi.fn()
  return {
    rpc,
    getSession,
    onAuthStateChange,
    permissions: ['time.self.view', 'time.punch'],
    client: { rpc, auth: { getSession, onAuthStateChange } },
  }
})
vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabaseClient: () => transport.client,
}))
vi.mock('../lib/sharedIdentitySession', () => ({ getSharedIdentitySessionScope: () => null }))
vi.mock('../data/auth', () => ({
  getSessionContext: async () => ({
    accessGeneration: 1,
    employeeId: '73000000-0000-4000-8000-000000000001',
    username: 'fixtureguard',
    displayName: 'Fixture Guard',
    role: 'guard',
    mustChangePassword: false,
    passwordChangedAt: null,
    mfaEnrolledAt: null,
    mfaRequired: false,
    hasMfa: false,
    timeZone: 'America/Denver',
    permissions: transport.permissions,
  }),
}))

const ownEmployeeId = '73000000-0000-4000-8000-000000000001'
const otherEmployeeId = '73000000-0000-4000-8000-000000000002'
const now = '2026-11-02T18:00:00.000Z'
const clients: QueryClient[] = []
let stopPromptObserver: (() => void) | undefined
let prompts: string[]

function reviewRow(employeeId: string, fromDate: string) {
  const historical = fromDate === '2026-10-11'
  const own = employeeId === ownEmployeeId
  const paidMinutes = own ? historical ? 360 : 480 : 1_200
  return {
    rowKind: 'time_event', employeeId,
    username: own ? 'fixtureguard' : 'otherguard',
    employeeName: own ? 'Fixture Guard' : 'Other Employee',
    role: 'guard', employmentType: 'hourly', shiftId: null,
    operationalDate: historical ? '2026-10-19' : '2026-11-02',
    weekStartsOn: historical ? '2026-10-18' : '2026-11-01',
    weekEndsOn: historical ? '2026-10-24' : '2026-11-07',
    siteName: own ? 'Owned Site' : 'Never show this other site',
    siteCode: own ? 'OWN' : 'OTHER', postName: null, eventName: null,
    locationName: own ? `Owned post ${fromDate}` : 'Never show this other site',
    scheduledStartsAt: null, scheduledEndsAt: null, timeZone: 'America/Denver',
    firstClockIn: null, lastClockOut: null,
    grossMinutes: paidMinutes, breakMinutes: 0, paidMinutes,
    regularMinutes: paidMinutes, overtimeMinutes: 0, salaryDefaultMinutes: 0,
    timeOffMinutes: 0, eventCount: 2, requiresArmed: false, isOvertime: false,
    payrollReady: true, exceptionCodes: [], payrollNotes: [],
    payrollCategory: 'regular', payrollCategoryLabel: 'Regular', payrollCategoryResolved: true,
  }
}

function reviewPayload(fromDate: string, throughDate: string) {
  const rows = [reviewRow(ownEmployeeId, fromDate), reviewRow(otherEmployeeId, fromDate)]
  const paidMinutes = rows.reduce((total, row) => total + row.paidMinutes, 0)
  return {
    serverTimestamp: now, fromDate, throughDate, operationalTimeZone: 'America/Denver',
    summary: {
      rowCount: 2, readyCount: 2, exceptionCount: 0, pendingCorrectionCount: 0,
      grossMinutes: paidMinutes, paidMinutes, regularMinutes: paidMinutes,
      overtimeMinutes: 0, salaryDefaultMinutes: 0, timeOffMinutes: 0,
    },
    rows, pendingCorrections: [],
  }
}

function renderPage(page: 'command' | 'my-time') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  const route = page === 'command' ? '/time' : '/time/my-time'
  setIdentityVerificationSurface(route, '')
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <IdentityVerificationHost />
        {page === 'command' ? <TimeCommandCenterPage /> : <MyTimePage />}
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

function expectNoPrivilegedRequestOrPrompt() {
  expect(transport.rpc.mock.calls.every(([name]) => [
    'get_timekeeping_dashboard', 'get_payroll_period_context',
    'get_timekeeping_review', 'get_missing_time_request_workspace',
  ].includes(name))).toBe(true)
  expect(transport.rpc.mock.calls.map(([name]) => name)).not.toContain('get_timekeeping_review_v2')
  expect(prompts).toEqual([])
  expect(screen.queryByRole('dialog', { name: 'Verify your identity' })).not.toBeInTheDocument()
}

beforeEach(() => {
  clearIdentityVerificationSession()
  window.sessionStorage.clear()
  transport.permissions = ['time.self.view', 'time.punch']
  transport.rpc.mockReset()
  transport.getSession.mockResolvedValue({ data: { session: {
    access_token: `header.${btoa(JSON.stringify({ sub: ownEmployeeId, session_id: '73000000-0000-4000-8000-000000000009', aal: 'aal1' }))}.signature`,
    user: { id: ownEmployeeId, factors: [] },
  } }, error: null })
  transport.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('External requests are forbidden in this transport fixture.')))
  prompts = []
  stopPromptObserver = subscribeToIdentityVerification((required, context, requestId) => {
    if (!required || !requestId) return
    prompts.push(context)
    // A regressed protected request must fail assertions rather than hang the
    // test forever waiting for an authenticator this guard does not possess.
    queueMicrotask(() => cancelIdentityVerification(requestId))
  })
  transport.rpc.mockImplementation(async (name: string, args: Record<string, string> = {}) => {
    if (name === 'get_timekeeping_dashboard') return { data: {
      serverTimestamp: now, operationalDate: '2026-11-02', operationalTimeZone: 'America/Denver',
      employee: { id: ownEmployeeId, username: 'fixtureguard', displayName: 'Fixture Guard', role: 'guard', employmentType: 'hourly', timeZone: 'America/Denver' },
      lastEvent: null, recentEvents: [], eligibleShifts: [], pendingCorrectionCount: 0,
    }, error: null }
    if (name === 'get_payroll_period_context') return { data: {
      serverTimestamp: now, fromDate: '2026-10-25', throughDate: '2026-11-07',
      timeZone: 'America/Denver', weekStartsOn: 0, weekStartsOnLabel: 'Sunday',
      payFrequency: 'biweekly', payrollConfigurationVersion: 2,
      availablePeriods: [
        { offset: 0, fromDate: '2026-10-25', throughDate: '2026-11-07' },
        { offset: 1, fromDate: '2026-10-11', throughDate: '2026-10-24' },
      ],
    }, error: null }
    if (name === 'get_timekeeping_review') return { data: reviewPayload(args.target_from_date, args.target_through_date), error: null }
    if (name === 'get_missing_time_request_workspace') return { data: {
      serverTimestamp: now, canReviewAdjustments: false, posts: [], requests: [],
    }, error: null }
    return { data: null, error: { code: '42501', message: 'MFA verification is required to load payroll review details.' } }
  })
})

afterEach(() => {
  cancelIdentityVerification()
  stopPromptObserver?.()
  clients.splice(0).forEach((client) => client.clear())
  clearIdentityVerificationSession()
  vi.unstubAllGlobals()
})

describe('employee own-time pages through the real data accessor', () => {
  it('loads a guard AAL1 Time Command Center without requesting team review or opening MFA', async () => {
    const client = renderPage('command')
    await waitFor(() => expect(client.getQueryData([
      'time-command-review', 'self', ownEmployeeId, '2026-10-25', '2026-11-07',
    ])).toMatchObject({ rows: [{ employeeId: ownEmployeeId }], summary: { paidMinutes: 480 } }))
    expect(screen.getByRole('heading', { name: 'Time Command Center' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Pay Period: open details' })).toHaveTextContent('8.00 hrs')
    expect(screen.queryByText('Other Employee')).not.toBeInTheDocument()
    expectNoPrivilegedRequestOrPrompt()
  })

  it('loads and refreshes historical My Time using its selected dates without an MFA challenge', async () => {
    const client = renderPage('my-time')
    await screen.findByText('Owned post 2026-10-25')
    const picker = screen.getByRole('combobox', { name: 'Pay period' })
    fireEvent.change(picker, { target: { value: '1' } })
    await screen.findByText('Owned post 2026-10-11')
    await waitFor(() => expect(client.getQueryData([
      'my-time-review', ownEmployeeId, '2026-10-11', '2026-10-24',
    ])).toMatchObject({ rows: [{ employeeId: ownEmployeeId }], summary: { paidMinutes: 360 } }))
    expect(screen.getByText('Selected Period').closest('article')).toHaveTextContent('6.00 hrs')
    expect(screen.getByText('Today').closest('article')).toHaveTextContent('8.00 hrs')
    const previousCalls = transport.rpc.mock.calls.filter(([name]) => name === 'get_timekeeping_review').length
    await client.invalidateQueries({ queryKey: ['my-time-review'] })
    await waitFor(() => expect(transport.rpc.mock.calls.filter(([name]) => name === 'get_timekeeping_review').length).toBeGreaterThan(previousCalls))
    expect(picker).toHaveValue('1')
    expect(screen.getByText('Owned post 2026-10-11')).toBeVisible()
    expect(transport.rpc).toHaveBeenCalledWith('get_timekeeping_review', { target_from_date: '2026-10-11', target_through_date: '2026-10-24' })
    expect(screen.queryByText('Never show this other site')).not.toBeInTheDocument()
    expectNoPrivilegedRequestOrPrompt()
  })

  it('does not fetch any employee time when the signed-in account lacks own-time permission', async () => {
    transport.permissions = []
    renderPage('command')
    expect(await screen.findByText('Time & Attendance is not enabled')).toBeVisible()
    expect(transport.rpc).not.toHaveBeenCalled()
    expectNoPrivilegedRequestOrPrompt()
  })

  it('still challenges and denies the protected team accessor instead of falling back to an own-time read', async () => {
    setIdentityVerificationSurface('/time/review', '')
    await expect(getTimekeepingReview({ fromDate: '2026-10-25', throughDate: '2026-11-07' })).rejects.toMatchObject({
      code: '42501', message: 'MFA verification is required to load payroll review details.',
    })
    expect(prompts).toEqual(['general'])
    expect(transport.rpc.mock.calls.map(([name]) => name)).toEqual(['get_timekeeping_review_v2'])
  })
})
