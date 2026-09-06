import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { MyTimePage } from './MyTimePage'

const mocks = vi.hoisted(() => ({ review: vi.fn() }))
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({ getSessionContext: async () => ({ permissions: ['time.self.view'] }) }))
vi.mock('../data/timekeeping', async (original) => ({ ...await original<typeof import('../data/timekeeping')>(),
  getTimekeepingDashboard: async () => ({ employee: { id: 'employee', displayName: 'Test Employee' }, operationalDate: '2026-09-06', serverTimestamp: '2026-09-06T16:00:00Z', recentEvents: [], eligibleShifts: [], pendingCorrectionCount: 0 }),
  getPayrollPeriodContext: async () => ({ serverTimestamp: '2026-09-06T16:00:00Z', fromDate: '2026-09-06', throughDate: '2026-09-19', weekStartsOn: 0, availablePeriods: [
    { offset: 0, fromDate: '2026-09-06', throughDate: '2026-09-19' }, { offset: 1, fromDate: '2026-08-23', throughDate: '2026-09-05' }, { offset: 2, fromDate: '2026-08-09', throughDate: '2026-08-22' },
  ] }), getOwnTimekeepingReview: mocks.review,
}))
vi.mock('../data/timeOperations', async (original) => ({ ...await original<typeof import('../data/timeOperations')>(), getMissingTimeRequestWorkspace: async () => ({ requests: [], posts: [] }) }))

describe('My Time pay-period history', () => {
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
})
