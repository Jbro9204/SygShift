import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { TimeOperationsPage } from './TimeOperationsPage'

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
    alerts: [],
    callOffReports: [],
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
})
