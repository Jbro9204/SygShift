import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { TimeWorkspace } from './TimeWorkspace'

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({
  getSessionContext: async () => ({ permissions: ['time.self.view', 'time.punch'] }),
}))
vi.mock('../data/timekeeping', async (original) => ({
  ...await original<typeof import('../data/timekeeping')>(),
  getTimekeepingDashboard: async () => ({
    eligibleShifts: [{
      assignmentId: '10000000-0000-4000-8000-000000000001',
      assignmentType: 'standard',
      endsAt: '2026-10-12T21:00:00.000Z',
      eventName: null,
      isOvertime: false,
      locationName: 'Administrative',
      postName: 'Human Resources',
      requiresArmed: false,
      shiftId: '20000000-0000-4000-8000-000000000001',
      siteCode: 'ADMIN',
      siteName: 'Administrative',
      startsAt: '2026-10-12T13:00:00.000Z',
      status: 'assigned',
      timeZone: 'America/Denver',
      workType: 'post',
    }],
    employee: {
      displayName: 'Misty Kimbal',
      employmentType: 'hourly',
      id: '30000000-0000-4000-8000-000000000001',
      role: 'admin',
      timeZone: 'America/New_York',
      username: 'mkimbal',
    },
    lastEvent: null,
    operationalDate: '2026-10-12',
    operationalTimeZone: 'America/New_York',
    pendingCorrectionCount: 0,
    recentEvents: [],
    serverTimestamp: '2026-10-12T12:56:00.000Z',
  }),
  recordTimeEvent: vi.fn(),
}))

describe('Time Workspace employee time zone', () => {
  it('shows clock-in shift choices in the employee profile zone instead of the stored site zone', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/time']}>
          <TimeWorkspace />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const selector = await screen.findByRole('combobox', { name: 'Shift for clock in' })
    const option = within(selector).getByRole('option')
    expect(option).toHaveTextContent('Employee Time — Eastern: 9:00 AM (09:00) – 5:00 PM (17:00)')
    expect(option).toHaveTextContent('Site Time — Mountain: 7:00 AM (07:00) – 3:00 PM (15:00)')
  })
})
