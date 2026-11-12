import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ process: vi.fn(), center: vi.fn(), inbox: vi.fn() }))
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/operations', async (original) => ({ ...await original<typeof import('../data/operations')>(), processNotificationBatch: mocks.process, getNotificationCenter: mocks.center }))
vi.mock('../data/notifications', async (original) => ({ ...await original<typeof import('../data/notifications')>(), getMyNotifications: mocks.inbox }))
vi.mock('../components/NotificationPreferences', () => ({ NotificationPreferences: () => null }))
import { NotificationsPage } from './NotificationsPage'
const id = '10000000-0000-4000-8000-000000000001'
beforeEach(() => {
  mocks.inbox.mockResolvedValue({ permissions: { canSend: true, canManageDelivery: true }, summary: { unread: 0, requiresAction: 0, urgent: 0 }, notifications: [], page: { total: 0, totalPages: 1 } })
  mocks.center.mockResolvedValue({ summary: { pending: 1, delivered: 0, failed: 0 }, batches: [], page: { total: 0, totalPages: 1 } })
  mocks.process.mockReset()
})
describe('manual notification delivery outcomes', () => {
  it.each([
    { label: 'held', delivered: [], held: [id], suppressed: [], failed: [], processed: 1, expected: '1 held for review (not automatically resent)' },
    { label: 'accepted', delivered: [id], held: [], suppressed: [], failed: [], processed: 1, expected: '1 delivered' },
    { label: 'partial', delivered: [id], held: [id], suppressed: [id], failed: [], processed: 3, expected: '1 delivered, 1 suppressed (not sent), 1 held for review' },
    { label: 'zero', delivered: [], held: [], suppressed: [], failed: [], processed: 0, expected: 'No queued email jobs were waiting to process.' },
  ])('renders the confirmed $label result without claiming the queue was sent', async (result) => {
    mocks.process.mockResolvedValue({ ...result, requestId: 'test', requestedBy: 'admin' })
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/notifications?view=delivery']}><NotificationsPage /></MemoryRouter></QueryClientProvider>)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Process queued' }))
    expect(await screen.findByRole('status')).toHaveTextContent(result.expected)
    expect(mocks.process).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/notification sent/i)).not.toBeInTheDocument()
  })
})
