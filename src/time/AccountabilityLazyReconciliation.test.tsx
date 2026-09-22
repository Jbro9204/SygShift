import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountabilityPage } from './AccountabilityPage'

const eventId = '10000000-0000-4000-8000-000000000001'
const employeeId = '20000000-0000-4000-8000-000000000001'
const shiftId = '30000000-0000-4000-8000-000000000001'

const mocks = vi.hoisted(() => ({
  getAccountabilityEventReconciliation: vi.fn(),
  getAccountabilityWorkspace: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({
  getSessionContext: async () => ({ employeeId: '40000000-0000-4000-8000-000000000001', permissions: ['accountability.view'] }),
}))
vi.mock('../data/accountability', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../data/accountability')>(),
  getAccountabilityEventReconciliation: mocks.getAccountabilityEventReconciliation,
  getAccountabilityWorkspace: mocks.getAccountabilityWorkspace,
}))

describe('Accountability lazy reconciliation', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    mocks.getAccountabilityEventReconciliation.mockReset().mockResolvedValue({
      startsAt: '2026-09-21T14:00:00.000Z',
      endsAt: '2026-09-21T22:00:00.000Z',
      locationName: 'Central Site',
      scheduledCoverageMinutes: 480,
      actualPaidMinutes: 420,
      scheduledEmployees: [],
      actualEmployees: [],
      discrepancyCodes: ['worked_time_variance'],
    })
    mocks.getAccountabilityWorkspace.mockReset().mockResolvedValue({
      serverTimestamp: '2026-09-22T16:00:00.000Z',
      fromDate: '2026-08-23',
      throughDate: '2026-09-22',
      operationalTimeZone: 'America/Denver',
      capabilities: { canCreate: false, canManage: false },
      employees: [{ id: employeeId, name: 'Randy Guard', username: 'rguard', role: 'guard', employmentType: 'hourly' }],
      shiftOptions: [],
      exceptionSummaries: [],
      events: [{
        id: eventId,
        sourceTable: 'attendance_accountability_events',
        eventType: 'late_arrival',
        status: 'reported',
        employeeId,
        employeeName: 'Randy Guard',
        username: 'rguard',
        role: 'guard',
        employmentType: 'hourly',
        operationalDate: '2026-09-21',
        startsAt: '2026-09-21T14:00:00.000Z',
        endsAt: '2026-09-21T22:00:00.000Z',
        timeZone: 'America/Denver',
        siteName: 'Central Site',
        siteCode: 'CTR',
        postName: 'Main post',
        eventName: null,
        locationName: 'Central Site',
        note: 'Arrived after the scheduled start.',
        createdAt: '2026-09-21T14:45:00.000Z',
        shiftId,
        reviewOutcome: null,
        reviewedAt: null,
        reviewedByName: null,
        decisionNote: null,
        reportedLateMinutes: 45,
        expectedArrivalAt: '2026-09-21T14:45:00.000Z',
        actualArrivalAt: null,
        reviewable: false,
        actionHistory: [],
        reconciliation: null,
      }],
    })
  })

  it('loads schedule-versus-time evidence only after a reviewer opens the occurrence', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><AccountabilityPage /></MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Arrived after the scheduled start.')).toBeVisible()
    expect(mocks.getAccountabilityEventReconciliation).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'View details' }))
    await waitFor(() => expect(mocks.getAccountabilityEventReconciliation).toHaveBeenCalledWith(eventId))
    expect(await screen.findByText('Scheduled shift')).toBeVisible()
    expect(screen.getByText('Rules requiring review')).toBeVisible()
  })
})
