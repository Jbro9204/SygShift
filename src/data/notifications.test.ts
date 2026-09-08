import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMyNotifications } from './notifications'

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
})
