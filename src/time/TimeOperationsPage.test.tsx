import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TimeOperationsPage } from './TimeOperationsPage'

type AlertFixture = {
  id: string
  alertType: string
  priority: 'normal' | 'high' | 'urgent'
  title: string
  summary: string
  employeeId: string | null
  shiftId: string | null
  directPath: string | null
  createdAt: string
  acknowledgedAt: string | null
  active?: boolean
  lifecycleStatus?: 'active_operations' | 'payroll_review' | 'resolved'
  liveUntil?: string | null
}

type CallOffFixture = {
  id: string
  employeeId: string
  employeeName: string
  shiftId: string
  startsAt: string
  endsAt: string
  timeZone: string
  location: string
  callOffType: 'sick' | 'other'
  reason: string
  callReceivedAt: string
  receivedBy: string
  replacementNeeded: boolean
  operationalDetails: string | null
  reportedAt: string
  resolvedAt: string | null
  coverageStatus: string | null
}

const workspaceState = vi.hoisted(() => ({
  alerts: [] as AlertFixture[],
  callOffReports: [] as CallOffFixture[],
}))

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({
  getSessionContext: async () => ({ employeeId: '4c94b87b-2ac2-4abc-9d3f-46bd82e1989c' }),
}))
vi.mock('../data/timeOperations', async (original) => ({
  ...await original<typeof import('../data/timeOperations')>(),
  getMissingTimeRequestWorkspace: async () => ({ requests: [] }),
  getTimekeepingOperationsWorkspace: async () => ({
    adjustmentRequestActions: [],
    adjustmentRequests: [{
      employeeId: 'f62ca89e-66fb-4d7c-bdf3-922d3b4e04a9',
      employeeName: 'Jason Douglass',
      id: '95b19ab2-5af6-483f-89cf-106e438cf3d1',
      issueType: 'clock_out',
      reason: 'Clock-out was late after an incident.',
      status: 'submitted',
      workDate: '2026-09-08',
    }],
    alerts: workspaceState.alerts,
    callOffReports: workspaceState.callOffReports,
    canCreateManualEntry: false,
    canEditManualEntry: false,
    canReportCallOff: false,
    canResolveExceptions: false,
    canReviewAdjustments: true,
    canViewOperations: true,
    employees: [],
    exceptions: [],
    manualEntries: [],
    posts: [],
    serverTimestamp: '2026-10-05T12:00:00.000Z',
    shifts: [],
  }),
}))
vi.mock('../data/timekeeping', async (original) => ({
  ...await original<typeof import('../data/timekeeping')>(),
  getPendingTimeEventCorrections: async () => [{
    employeeId: 'f62ca89e-66fb-4d7c-bdf3-922d3b4e04a9',
    employeeName: 'Jason Douglass',
    id: '679e0c0a-f4e8-4894-b8d3-6cda8d09f1cb',
    kind: 'clock_in',
    reason: 'Clock-in needs correction.',
    recordedAt: '2026-09-07T12:10:00Z',
    replacementTime: '2026-09-07T12:00:00Z',
    requestedAt: '2026-09-07T18:00:00Z',
    requestedBy: 'f62ca89e-66fb-4d7c-bdf3-922d3b4e04a9',
    shiftId: null,
    timeEventId: '3ab90149-dd94-4ac6-912a-c1e585487ded',
    username: 'jdouglass',
    voided: false,
  }],
}))

describe('Time Operations unified request queue', () => {
  beforeEach(() => {
    workspaceState.alerts = []
    workspaceState.callOffReports = []
  })

  it('counts and displays adjustment and punch-correction requests together', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><TimeOperationsPage /></MemoryRouter>
      </QueryClientProvider>,
    )

    const waitingMetric = (await screen.findByText('Requests awaiting review')).closest('article')
    expect(waitingMetric).not.toBeNull()
    expect(within(waitingMetric!).getByText('2')).toBeVisible()
    expect(screen.getAllByText('Jason Douglass')).toHaveLength(2)

    const reviewLinks = screen.getAllByRole('link', { name: 'Review' })
    expect(reviewLinks).toHaveLength(1)
    expect(reviewLinks[0]).toHaveAttribute('href', expect.stringContaining('show=pending_correction'))
    expect(reviewLinks[0]).toHaveAttribute('href', expect.stringContaining('employee=f62ca89e-66fb-4d7c-bdf3-922d3b4e04a9'))
  })

  it('keeps urgent and call-off queues limited to the current response window', async () => {
    workspaceState.alerts = [
      operationalAlert('Current urgent alert', { liveUntil: '2026-10-05T12:30:00.000Z' }),
      operationalAlert('Expired urgent alert', { id: '10000000-0000-4000-8000-000000000002', liveUntil: '2026-10-05T12:00:00.000Z' }),
      operationalAlert('Inactive urgent alert', { id: '10000000-0000-4000-8000-000000000003', active: false }),
      operationalAlert('Resolved urgent alert', { id: '10000000-0000-4000-8000-000000000004', lifecycleStatus: 'resolved' }),
    ]
    workspaceState.callOffReports = [
      callOffReport('Current Calloff Employee', '2026-10-05T11:30:00.000Z'),
      callOffReport('Historical Calloff Employee', '2026-10-05T11:00:00.000Z', '50000000-0000-4000-8000-000000000002'),
    ]

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><TimeOperationsPage /></MemoryRouter>
      </QueryClientProvider>,
    )

    const urgentQueue = await screen.findByRole('region', { name: 'Urgent operational alerts' })
    expect(within(urgentQueue).getAllByRole('article')).toHaveLength(1)
    expect(within(urgentQueue).getByText('Current urgent alert')).toBeVisible()
    expect(screen.queryByText('Expired urgent alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Inactive urgent alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Resolved urgent alert')).not.toBeInTheDocument()

    expect(await screen.findByText('Current Calloff Employee')).toBeVisible()
    expect(screen.queryByText('Historical Calloff Employee')).not.toBeInTheDocument()
    expect(screen.getByText('Active attendance')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Current sick and call-off records' })).toBeVisible()
  })
})

function operationalAlert(title: string, overrides: Partial<AlertFixture> = {}): AlertFixture {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    alertType: 'employee_call_off',
    priority: 'urgent',
    title,
    summary: `${title} summary`,
    employeeId: '20000000-0000-4000-8000-000000000001',
    shiftId: '30000000-0000-4000-8000-000000000001',
    directPath: '/requests?callOff=40000000-0000-4000-8000-000000000001',
    createdAt: '2026-10-05T10:00:00.000Z',
    acknowledgedAt: null,
    active: true,
    lifecycleStatus: 'active_operations',
    ...overrides,
  }
}

function callOffReport(employeeName: string, endsAt: string, id = '50000000-0000-4000-8000-000000000001'): CallOffFixture {
  return {
    id,
    employeeId: '60000000-0000-4000-8000-000000000001',
    employeeName,
    shiftId: '70000000-0000-4000-8000-000000000001',
    startsAt: '2026-10-05T04:00:00.000Z',
    endsAt,
    timeZone: 'America/Denver',
    location: 'Central Site',
    callOffType: 'sick',
    reason: 'Unable to work the scheduled shift.',
    callReceivedAt: '2026-10-05T03:00:00.000Z',
    receivedBy: 'Dispatch',
    replacementNeeded: true,
    operationalDetails: null,
    reportedAt: '2026-10-05T03:00:00.000Z',
    resolvedAt: null,
    coverageStatus: null,
  }
}
