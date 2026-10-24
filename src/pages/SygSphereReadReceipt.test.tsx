import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationMessages } from './SygSpherePage'
import type { SphereConversation, SphereMessage } from '../data/sygsphere'

const mocks = vi.hoisted(() => ({
  sphereConversation: vi.fn(),
  sphereMessage: vi.fn(),
  sphereMessages: vi.fn(),
  sphereRequest: vi.fn(),
}))

vi.mock('../data/sygsphere', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/sygsphere')>()
  return {
    ...actual,
    sphereConversation: mocks.sphereConversation,
    sphereMessage: mocks.sphereMessage,
    sphereMessages: mocks.sphereMessages,
    sphereRequest: mocks.sphereRequest,
  }
})

const employeeId = '11111111-1111-4111-8111-111111111111'
const authorId = '22222222-2222-4222-8222-222222222222'
const conversationId = '33333333-3333-4333-8333-333333333333'
const messageId = '44444444-4444-4444-8444-444444444444'
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

const conversation: SphereConversation = {
  id: conversationId,
  kind: 'group',
  name: 'Dispatch',
  description: '',
  archived: false,
  owner: false,
  muted: false,
  favorite: false,
  updatedAt: '2026-10-24T12:00:00Z',
  unread: 1,
  latest: null,
  avatar: null,
}

const unreadMessage: SphereMessage = {
  id: messageId,
  sequence: 1,
  conversationId,
  authorId,
  authorName: 'Dispatch Lead',
  body: 'Please review this instruction.',
  parentId: null,
  createdAt: '2026-10-24T12:00:00Z',
  editedAt: null,
  deleted: false,
  pinned: false,
  saved: false,
  read: false,
  readBy: [],
  replyCount: 0,
  unreadReplies: 0,
  reactions: [],
  acknowledgment: { mine: false, count: 0, people: [] },
  mentions: [],
}

class VisibleIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = '0px'
  readonly scrollMargin = '0px'
  readonly thresholds = [0.25]
  private readonly callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) { this.callback = callback }

  disconnect() {}
  takeRecords() { return [] }
  unobserve() {}
  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this)
  }
}

function renderMessages() {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={client}>
      <ConversationMessages
        conversation={conversation}
        employeeId={employeeId}
        focusId={null}
        onThread={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

describe('SygSphere read receipts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    mocks.sphereConversation.mockReset().mockResolvedValue({ description: '', members: [] })
    mocks.sphereMessage.mockReset()
    mocks.sphereMessages.mockReset().mockResolvedValue([unreadMessage])
    mocks.sphereRequest.mockReset()
    vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver)
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })

  it('retries the same visible unread message after a transient save failure', async () => {
    mocks.sphereRequest
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce({ ok: true })
    renderMessages()

    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })

    expect(mocks.sphereRequest).toHaveBeenCalledTimes(2)
    expect(mocks.sphereRequest).toHaveBeenNthCalledWith(1, 'read', {
      conversationId,
      messageIds: [messageId],
    })
    expect(mocks.sphereRequest).toHaveBeenNthCalledWith(2, 'read', {
      conversationId,
      messageIds: [messageId],
    })
    expect(screen.queryByText(/could not confirm your read status/i)).not.toBeInTheDocument()
  })

  it('shows an explicit retry after automatic attempts fail and accepts a later retry', async () => {
    mocks.sphereRequest
      .mockRejectedValueOnce(new Error('read failure 1'))
      .mockRejectedValueOnce(new Error('read failure 2'))
      .mockRejectedValueOnce(new Error('read failure 3'))
      .mockResolvedValueOnce({ ok: true })
    renderMessages()

    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100) })

    expect(screen.getByRole('alert')).toHaveTextContent('could not confirm your read status')
    expect(mocks.sphereRequest).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(mocks.sphereRequest).toHaveBeenCalledTimes(3)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(mocks.sphereRequest).toHaveBeenCalledTimes(4)
    expect(screen.queryByText(/could not confirm your read status/i)).not.toBeInTheDocument()
  })

  it('keeps an authoritative saved receipt when the follow-up message refresh fails', async () => {
    mocks.sphereRequest.mockResolvedValue({ ok: true })
    mocks.sphereMessages
      .mockReset()
      .mockResolvedValueOnce([unreadMessage])
      .mockRejectedValueOnce(new Error('message refresh failed'))
    renderMessages()

    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(mocks.sphereRequest).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/could not confirm your read status/i)).not.toBeInTheDocument()
  })
})
