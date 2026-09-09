import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMyNotifications, getMyNotifications } from './notifications'

const supabaseMock = vi.hoisted(() => ({
  rpc: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc: supabaseMock.rpc }),
}))

describe('notification data operations', () => {
  beforeEach(() => supabaseMock.rpc.mockReset())

  it('uses the protected bulk-clear RPC and returns its preservation summary', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: { markedRead: 4, dismissed: 3, remainingRequired: 1 },
      error: null,
    })

    await expect(clearMyNotifications()).resolves.toEqual({
      markedRead: 4,
      dismissed: 3,
      remainingRequired: 1,
    })
    expect(supabaseMock.rpc).toHaveBeenCalledWith('clear_my_notifications')
  })

  it('does not hide a database failure behind an empty success result', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'Notification service is unavailable.' },
    })

    await expect(clearMyNotifications()).rejects.toThrow('Notification service is unavailable.')
  })

  it('preserves open and resolved workflow state from the protected inbox', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        summary: { unread: 1, requiresAction: 1, urgent: 0 },
        permissions: { canSend: false, canManageDelivery: false },
        page: { number: 1, size: 10, total: 1, totalPages: 1 },
        notifications: [{
          id: '10000000-0000-4000-8000-000000000001',
          title: 'Time correction needs review',
          body: 'An employee time correction is waiting for an authorized decision.',
          priority: 'important',
          sourceType: 'time_correction_request',
          sourceId: '20000000-0000-4000-8000-000000000001',
          requiresAcknowledgement: false,
          actionRequired: true,
          resolvedAt: null,
          readAt: null,
          acknowledgedAt: null,
          createdAt: '2026-09-09T12:00:00.000Z',
          expiresAt: null,
          actionPath: '/time/review',
          actionLabel: 'Review correction',
          senderName: 'SygShift System',
        }],
      },
      error: null,
    })

    const inbox = await getMyNotifications({ filter: 'action', category: 'all', page: 1, pageSize: 10 })
    expect(inbox.notifications[0]).toMatchObject({ actionRequired: true, resolvedAt: null })
    expect(supabaseMock.rpc).toHaveBeenCalledWith('get_my_notifications', {
      target_filter: 'action', target_category: 'all', target_page: 1, target_page_size: 10,
    })
  })
})
