import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TimeOperationsPage } from './TimeOperationsPage'

const mocks = vi.hoisted(() => ({
  getCallOffCoverageWorkspace: vi.fn(),
  reportEmployeeCallOff: vi.fn(),
  resolveCallOffCoverage: vi.fn(),
}))

const callOffId = '10000000-0000-4000-8000-000000000001'
const shiftId = '20000000-0000-4000-8000-000000000001'
const employeeId = '30000000-0000-4000-8000-000000000001'

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({
  getSessionContext: async () => ({ employeeId: '40000000-0000-4000-8000-000000000001' }),
}))
vi.mock('../data/timekeeping', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../data/timekeeping')>(),
  getPendingTimeEventCorrections: async () => [],
}))
vi.mock('../data/timeOperations', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../data/timeOperations')>(),
  getMissingTimeRequestWorkspace: async () => ({ requests: [] }),
  getTimekeepingOperationsWorkspace: async () => ({
    adjustmentRequestActions: [],
    adjustmentRequests: [],
    alerts: [],
    callOffReports: [],
    canCreateManualEntry: false,
    canEditManualEntry: false,
    canReportCallOff: true,
    canResolveExceptions: false,
    canReviewAdjustments: false,
    canViewOperations: true,
    employees: [{ id: employeeId, name: 'Randy Guard', username: 'rguard', employmentType: 'hourly' }],
    exceptions: [],
    manualEntries: [],
    posts: [],
    serverTimestamp: '2026-09-14T14:00:00.000Z',
    shifts: [{
      shiftId,
      employeeId,
      startsAt: '2026-09-15T00:00:00.000Z',
      endsAt: '2026-09-15T08:00:00.000Z',
      timeZone: 'America/Denver',
      location: 'Central Site',
      postId: null,
    }],
  }),
  reportEmployeeCallOff: mocks.reportEmployeeCallOff,
}))
vi.mock('../data/requests', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../data/requests')>(),
  getCallOffCoverageWorkspace: mocks.getCallOffCoverageWorkspace,
  resolveCallOffCoverage: mocks.resolveCallOffCoverage,
}))

function coverageWorkspace() {
  return {
    callOff: {
      id: callOffId,
      employeeId,
      employeeName: 'Randy Guard',
      reason: 'Unable to work the scheduled shift.',
      reportedAt: '2026-09-14T14:00:00.000Z',
      replacementNeeded: true,
    },
    shift: {
      id: shiftId,
      startsAt: '2026-09-15T00:00:00.000Z',
      endsAt: '2026-09-15T08:00:00.000Z',
      timeZone: 'America/Denver',
      title: 'Night security',
      location: 'Central Site',
      requiresArmed: false,
      isOpen: false,
    },
    coverageCase: null,
    candidates: [],
    actions: [],
    attendancePolicy: { pointsActive: false, message: 'No points policy is active.' },
    patrolFallback: { available: true, message: 'Dispatch can review patrol coverage.' },
  }
}

describe('Time Operations call-off coverage handoff', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    mocks.reportEmployeeCallOff.mockReset().mockResolvedValue({
      id: callOffId,
      alertId: '50000000-0000-4000-8000-000000000001',
      status: 'recorded',
      coverageRequired: true,
    })
    mocks.getCallOffCoverageWorkspace.mockReset().mockResolvedValue(coverageWorkspace())
    mocks.resolveCallOffCoverage.mockReset().mockResolvedValue({
      coverageCaseId: '60000000-0000-4000-8000-000000000001',
      status: 'open_pool',
      coverageMode: 'open_pool',
      coverageShiftId: '20000000-0000-4000-8000-000000000002',
      announcementId: '70000000-0000-4000-8000-000000000001',
      replacementAssignmentId: null,
      idempotentReplay: false,
    })
  })

  it('continues directly from recording an absence into the durable coverage workflow', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><TimeOperationsPage /></MemoryRouter>
      </QueryClientProvider>,
    )

    await user.click(await screen.findByRole('button', { name: 'Report Sick / Call-Off' }))
    await user.selectOptions(screen.getByLabelText('Employee'), employeeId)
    await user.selectOptions(screen.getByLabelText('Scheduled shift'), shiftId)
    await user.type(screen.getByLabelText('Reason'), 'Unable to work the scheduled shift.')
    await user.click(screen.getByRole('button', { name: 'Record call-off' }))

    expect(await screen.findByRole('heading', { name: 'Handle an employee absence' })).toBeVisible()
    expect(screen.getByText('The original schedule will not disappear')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Flex-first notification order')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.type(screen.getByLabelText('Required management note'), 'Open the shift for eligible Flex coverage.')
    await user.click(screen.getByRole('button', { name: 'Save coverage plan' }))

    await waitFor(() => expect(mocks.resolveCallOffCoverage).toHaveBeenCalledWith(
      expect.objectContaining({
        callOffId,
        mode: 'open_pool',
        reason: 'Open the shift for eligible Flex coverage.',
      }),
      expect.anything(),
    ))
  })
})
