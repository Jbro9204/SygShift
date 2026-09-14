import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountabilityPage } from './AccountabilityPage'

const mocks = vi.hoisted(() => ({
  createAccountabilityOccurrence: vi.fn(),
  getCallOffCoverageWorkspace: vi.fn(),
  resolveCallOffCoverage: vi.fn(),
}))

const callOffId = '10000000-0000-4000-8000-000000000001'
const shiftId = '20000000-0000-4000-8000-000000000001'
const employeeId = '30000000-0000-4000-8000-000000000001'

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({
  getSessionContext: async () => ({
    employeeId: '40000000-0000-4000-8000-000000000001',
    permissions: ['accountability.view', 'accountability.create', 'accountability.manage'],
  }),
}))
vi.mock('../data/accountability', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../data/accountability')>(),
  createAccountabilityOccurrence: mocks.createAccountabilityOccurrence,
  getAccountabilityWorkspace: async () => ({
    serverTimestamp: '2026-09-14T14:00:00.000Z',
    fromDate: '2026-08-15',
    throughDate: '2026-09-14',
    operationalTimeZone: 'America/Denver',
    capabilities: { canCreate: true, canManage: true },
    employees: [{
      id: employeeId,
      name: 'Randy Guard',
      username: 'rguard',
      role: 'guard',
      employmentType: 'hourly',
    }],
    shiftOptions: [{
      id: shiftId,
      employeeId,
      operationalDate: '2026-09-14',
      startsAt: '2026-09-14T14:00:00.000Z',
      endsAt: '2026-09-14T22:00:00.000Z',
      timeZone: 'America/Denver',
      locationName: 'Central Site',
      siteCode: 'CTR',
      postName: 'Main post',
      eventName: null,
    }],
    events: [],
    exceptionSummaries: [],
  }),
}))
vi.mock('../data/requests', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../data/requests')>(),
  getCallOffCoverageWorkspace: mocks.getCallOffCoverageWorkspace,
  resolveCallOffCoverage: mocks.resolveCallOffCoverage,
}))

describe('Accountability absence coverage handoff', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    mocks.createAccountabilityOccurrence.mockReset().mockResolvedValue({
      id: '50000000-0000-4000-8000-000000000001',
      employeeId,
      shiftId,
      eventType: 'call_off',
      status: 'reported',
      operationalDate: '2026-09-14',
      createdAt: '2026-09-14T14:00:00.000Z',
      callOffId,
      coverageRequired: true,
    })
    mocks.getCallOffCoverageWorkspace.mockReset().mockResolvedValue({
      callOff: {
        id: callOffId,
        employeeId,
        employeeName: 'Randy Guard',
        reason: 'Unable to report for the scheduled shift.',
        reportedAt: '2026-09-14T14:00:00.000Z',
        replacementNeeded: true,
      },
      shift: {
        id: shiftId,
        startsAt: '2026-09-14T14:00:00.000Z',
        endsAt: '2026-09-14T22:00:00.000Z',
        timeZone: 'America/Denver',
        title: 'Main post',
        location: 'Central Site',
        requiresArmed: false,
        isOpen: false,
      },
      coverageCase: null,
      candidates: [],
      actions: [],
      attendancePolicy: { pointsActive: false, message: 'No points policy is active.' },
      patrolFallback: { available: true, message: 'Dispatch can review patrol coverage.' },
    })
  })

  it('turns an Absent entry into the guided coverage workflow without closing the task', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><AccountabilityPage /></MemoryRouter>
      </QueryClientProvider>,
    )

    await user.click(await screen.findByRole('button', { name: 'Record occurrence' }))
    const dialog = screen.getByRole('dialog', { name: 'Record accountability occurrence' })
    expect(within(dialog).getByLabelText('Occurrence type')).toHaveValue('call_off')
    await user.selectOptions(within(dialog).getByLabelText('Employee'), employeeId)
    await user.selectOptions(within(dialog).getByLabelText('Scheduled shift'), shiftId)
    await user.type(within(dialog).getByLabelText('Factual note'), 'Unable to report for the scheduled shift.')
    await user.click(within(dialog).getByRole('button', { name: 'Record occurrence' }))

    expect(await screen.findByRole('heading', { name: 'Handle an employee absence' })).toBeVisible()
    expect(screen.getByText('The original schedule will not disappear')).toBeVisible()
  })
})
