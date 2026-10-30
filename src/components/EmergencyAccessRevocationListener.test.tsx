import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EmergencyAccessRevocationListener } from './EmergencyAccessRevocationListener'

const mocks = vi.hoisted(() => ({
  channel: {
    on: vi.fn(),
    subscribe: vi.fn(),
  },
  client: {
    auth: {
      getSession: vi.fn(),
    },
    channel: vi.fn(),
    realtime: {
      setAuth: vi.fn(),
    },
    removeChannel: vi.fn(),
  },
  notifySessionContextChanged: vi.fn(),
  acknowledgeEmergencyPlatformSessionRevocation: vi.fn(),
}))

vi.mock('../data/auth', () => ({
  notifySessionContextChanged: mocks.notifySessionContextChanged,
}))

vi.mock('../data/emergencyAccessSession', () => ({
  acknowledgeEmergencyPlatformSessionRevocation: mocks.acknowledgeEmergencyPlatformSessionRevocation,
}))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => mocks.client,
}))

describe('EmergencyAccessRevocationListener', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.channel.on.mockReturnValue(mocks.channel)
    mocks.channel.subscribe.mockReturnValue(mocks.channel)
    mocks.client.channel.mockReturnValue(mocks.channel)
    mocks.client.realtime.setAuth.mockResolvedValue(undefined)
    mocks.client.removeChannel.mockResolvedValue(undefined)
    mocks.acknowledgeEmergencyPlatformSessionRevocation.mockResolvedValue({
      acknowledged: true,
      closed: true,
    })
    mocks.client.auth.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'active-session-token',
          user: { id: 'cc65cc0f-1715-4c58-9a86-001731f67376' },
        },
      },
      error: null,
    })
  })

  it('honors the private forced-logout event once for the active Auth user', async () => {
    const onRevoking = vi.fn()
    const onRevoked = vi.fn().mockResolvedValue(undefined)
    render(<EmergencyAccessRevocationListener onRevoked={onRevoked} onRevoking={onRevoking} />)

    await waitFor(() => expect(mocks.channel.subscribe).toHaveBeenCalledOnce())
    expect(mocks.client.channel).toHaveBeenCalledWith(
      'employee:cc65cc0f-1715-4c58-9a86-001731f67376',
      { config: { private: true } },
    )
    const handler = mocks.channel.on.mock.calls[0]?.[2] as ((event: { payload: Record<string, unknown> }) => void)

    await act(async () => {
      handler({
        payload: {
          accessGeneration: 7,
          authUserId: 'cc65cc0f-1715-4c58-9a86-001731f67376',
          operationId: 'c17a05f4-515b-44f0-a175-a54e4db83ed3',
        },
      })
      handler({
        payload: {
          accessGeneration: 7,
          authUserId: 'cc65cc0f-1715-4c58-9a86-001731f67376',
          operationId: 'c17a05f4-515b-44f0-a175-a54e4db83ed3',
        },
      })
    })

    await waitFor(() => expect(onRevoked).toHaveBeenCalledOnce())
    expect(onRevoking).toHaveBeenCalledOnce()
    expect(mocks.acknowledgeEmergencyPlatformSessionRevocation).toHaveBeenCalledWith(
      'c17a05f4-515b-44f0-a175-a54e4db83ed3',
      7,
      'active-session-token',
      expect.any(AbortSignal),
    )
    expect(onRevoking.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acknowledgeEmergencyPlatformSessionRevocation.mock.invocationCallOrder[0],
    )
    expect(mocks.acknowledgeEmergencyPlatformSessionRevocation.mock.invocationCallOrder[0]).toBeLessThan(
      onRevoked.mock.invocationCallOrder[0],
    )
  })

  it('still closes the local session when central acknowledgement is unavailable', async () => {
    mocks.acknowledgeEmergencyPlatformSessionRevocation.mockRejectedValueOnce(new Error('offline'))
    const onRevoking = vi.fn()
    const onRevoked = vi.fn().mockResolvedValue(undefined)
    render(<EmergencyAccessRevocationListener onRevoked={onRevoked} onRevoking={onRevoking} />)

    await waitFor(() => expect(mocks.channel.subscribe).toHaveBeenCalledOnce())
    const handler = mocks.channel.on.mock.calls[0]?.[2] as ((event: { payload: Record<string, unknown> }) => void)
    act(() => {
      handler({
        payload: {
          accessGeneration: 7,
          authUserId: 'cc65cc0f-1715-4c58-9a86-001731f67376',
          operationId: 'c17a05f4-515b-44f0-a175-a54e4db83ed3',
        },
      })
    })

    await waitFor(() => expect(onRevoked).toHaveBeenCalledOnce())
    expect(onRevoking).toHaveBeenCalledOnce()
  })

  it('rechecks central access when an offline or background browser returns', async () => {
    render(<EmergencyAccessRevocationListener onRevoked={vi.fn()} onRevoking={vi.fn()} />)
    await waitFor(() => expect(mocks.channel.subscribe).toHaveBeenCalledOnce())

    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))

    expect(mocks.notifySessionContextChanged).toHaveBeenCalledTimes(2)
  })
})
