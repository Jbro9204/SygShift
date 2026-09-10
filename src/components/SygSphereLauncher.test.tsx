import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SphereInbox } from '../data/sygsphere'
import { SygSphereLauncher } from './SygSphereLauncher'

const mocks = vi.hoisted(() => ({
  channel: vi.fn(),
  getSoundPreferences: vi.fn(),
  getSession: vi.fn(),
  removeChannel: vi.fn(),
  setRealtimeAuth: vi.fn(),
  sphereInbox: vi.fn(),
  sphereRequest: vi.fn(),
}))

vi.mock('../data/sygsphere', async () => {
  const actual = await vi.importActual<typeof import('../data/sygsphere')>('../data/sygsphere')
  return { ...actual, sphereInbox: mocks.sphereInbox, sphereRequest: mocks.sphereRequest }
})

vi.mock('../lib/notificationSounds', () => ({
  getSoundPreferences: mocks.getSoundPreferences,
}))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({
    auth: { getSession: mocks.getSession },
    channel: mocks.channel,
    realtime: { setAuth: mocks.setRealtimeAuth },
    removeChannel: mocks.removeChannel,
  }),
}))

const employeeId = '11111111-1111-4111-8111-111111111111'
const conversationId = '22222222-2222-4222-8222-222222222222'
const firstMessageId = '33333333-3333-4333-8333-333333333333'
const newMessageId = '44444444-4444-4444-8444-444444444444'
const authorId = '55555555-5555-4555-8555-555555555555'

function inbox(messageId: string, unread = 0): SphereInbox {
  return {
    employeeId,
    soundEnabled: true,
    mentions: [],
    conversations: [{
      id: conversationId,
      kind: 'direct',
      name: 'Chief Hood',
      description: '',
      archived: false,
      owner: false,
      muted: false,
      favorite: false,
      updatedAt: new Date().toISOString(),
      unread,
      latest: {
        id: messageId,
        authorId,
        body: 'New operational message',
        createdAt: new Date().toISOString(),
        parentId: null,
      },
      avatar: null,
    }],
  }
}

function renderLauncher(initial: SphereInbox) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['sygsphere', employeeId, 'inbox'], initial)
  render(<QueryClientProvider client={client}><MemoryRouter><SygSphereLauncher employeeId={employeeId} /></MemoryRouter></QueryClientProvider>)
  return client
}

describe('SygSphere launcher sounds', () => {
  const play = vi.fn<() => Promise<void>>()
  const pause = vi.fn()
  const sound = { currentTime: 0, muted: false, pause, play, preload: '', volume: 1 }

  beforeEach(() => {
    localStorage.clear()
    mocks.getSoundPreferences.mockReset().mockReturnValue({ login: true, notification: true, muted: false, volume: 0.65 })
    mocks.sphereInbox.mockReset().mockResolvedValue(inbox(firstMessageId))
    mocks.sphereRequest.mockReset().mockResolvedValue(null)
    mocks.getSession.mockReset().mockResolvedValue({ data: { session: null } })
    mocks.setRealtimeAuth.mockReset().mockResolvedValue(undefined)
    mocks.channel.mockReset()
    mocks.removeChannel.mockReset()
    play.mockReset()
    pause.mockReset()
    sound.currentTime = 0
    sound.muted = false
    sound.preload = ''
    sound.volume = 1
    vi.stubGlobal('Audio', vi.fn(function AudioMock() { return sound }))
  })

  it('uses the shared launcher visual system without changing unread behavior', () => {
    renderLauncher(inbox(firstMessageId, 3))

    const launcher = screen.getByRole('link', { name: 'Open SygSphere messages, 1 unread conversations' })
    expect(launcher).toHaveClass('syg-launcher', 'syg-launcher--sphere')
    expect(launcher.querySelector('.syg-launcher__badge')).toHaveTextContent('1')
  })

  it('offers explicit recovery after blocked playback and plays once on recovery', async () => {
    const user = userEvent.setup()
    play.mockRejectedValueOnce(new DOMException('Playback blocked', 'NotAllowedError')).mockResolvedValueOnce(undefined)
    const client = renderLauncher(inbox(firstMessageId))

    client.setQueryData(['sygsphere', employeeId, 'inbox'], inbox(newMessageId, 1))

    const recovery = await screen.findByRole('button', { name: 'Enable SygSphere sounds' })
    expect(play).toHaveBeenCalledTimes(1)
    expect(sound.volume).toBe(0.65)

    await user.click(recovery)

    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Enable SygSphere sounds' })).not.toBeInTheDocument())
  })

  it('preserves mute and volume preferences without showing a false blocked state', async () => {
    mocks.getSoundPreferences.mockReturnValue({ login: true, notification: true, muted: true, volume: 0.65 })
    const client = renderLauncher(inbox(firstMessageId))

    client.setQueryData(['sygsphere', employeeId, 'inbox'], inbox(newMessageId, 1))

    expect(await screen.findByText('You have a new message. Open conversation.')).toBeInTheDocument()
    expect(play).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Enable SygSphere sounds' })).not.toBeInTheDocument()
  })

  it('authenticates the private realtime channel before subscribing', async () => {
    const stream = { on: vi.fn(), subscribe: vi.fn() }
    stream.on.mockReturnValue(stream)
    stream.subscribe.mockReturnValue(stream)
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'native-or-memory-session-token', user: { id: '66666666-6666-4666-8666-666666666666' } } } })
    mocks.channel.mockReturnValue(stream)

    renderLauncher(inbox(firstMessageId))

    await waitFor(() => expect(mocks.setRealtimeAuth).toHaveBeenCalledWith('native-or-memory-session-token'))
    await waitFor(() => expect(mocks.channel).toHaveBeenCalledWith('sygsphere:66666666-6666-4666-8666-666666666666', { config: { private: true } }))
    expect(mocks.setRealtimeAuth.mock.invocationCallOrder[0]).toBeLessThan(mocks.channel.mock.invocationCallOrder[0])
    expect(stream.subscribe).toHaveBeenCalledOnce()
  })
})
