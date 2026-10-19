import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageCard } from './SygSpherePage'
import { sphereAcknowledge, type SphereMessage } from '../data/sygsphere'

vi.mock('../data/sygsphere', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/sygsphere')>()
  return { ...actual, sphereAcknowledge: vi.fn() }
})

const employeeId = '11111111-1111-4111-8111-111111111111'
const authorId = '22222222-2222-4222-8222-222222222222'
const conversationId = '33333333-3333-4333-8333-333333333333'
const messageId = '44444444-4444-4444-8444-444444444444'

function message(overrides: Partial<SphereMessage> = {}): SphereMessage {
  return {
    id: messageId,
    sequence: 1,
    conversationId,
    authorId,
    authorName: 'Dispatch Lead',
    body: 'Please acknowledge these instructions.',
    parentId: null,
    createdAt: '2026-10-19T12:00:00Z',
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
    ...overrides,
  }
}

function renderCard(target: SphereMessage, conversationKind: 'direct' | 'group' | 'channel' = 'group') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MessageCard employeeId={employeeId} conversationKind={conversationKind} message={target} onThread={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('SygSphere message acknowledgment', () => {
  beforeEach(() => vi.mocked(sphereAcknowledge).mockReset())

  it('does not acknowledge on view and preserves historical check-mark reactions', () => {
    renderCard(message({ reactions: [{ emoji: '✅', count: 1, mine: true }] }))
    expect(sphereAcknowledge).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '✅ reaction, 1' })).toBeVisible()
    fireEvent.click(screen.getByLabelText('Add reaction'))
    expect(screen.queryByRole('button', { name: 'React ✅' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'React 👍' })).toBeVisible()
  })

  it('suppresses repeated taps while a save is pending', async () => {
    vi.mocked(sphereAcknowledge).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(message({
      acknowledgment: { mine: true, count: 1, people: [] },
    })), 250)))
    renderCard(message())

    const action = screen.getByRole('button', { name: 'Acknowledge' })
    fireEvent.click(action)
    await waitFor(() => expect(action).toBeDisabled())
    fireEvent.click(action)
    expect(sphereAcknowledge).toHaveBeenCalledTimes(1)
    expect(sphereAcknowledge).toHaveBeenCalledWith(conversationId, messageId)
    expect(await screen.findByRole('button', { name: 'Acknowledged' })).toBeDisabled()
  })

  it('shows the server-confirmed state and authorized identities after save', async () => {
    vi.mocked(sphereAcknowledge).mockResolvedValue(message({
      acknowledgment: { mine: true, count: 1, people: [{ id: employeeId, name: 'Field Employee', photoPath: null }] },
    }))
    renderCard(message())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' })))

    expect(await screen.findByRole('button', { name: 'Acknowledged' })).toHaveAttribute('aria-pressed', 'true')
    const people = screen.getByLabelText('Acknowledged by 1. Show people.')
    fireEvent.click(people)
    expect(screen.getByText('Field Employee')).toBeVisible()
  })

  it('keeps save failures visible and leaves the action state server-driven', () => {
    const source = readFileSync(`${process.cwd()}/src/pages/SygSpherePage.tsx`, 'utf8')
    expect(source).toContain('<ErrorNotice error={acknowledge.error || mutation.error}')
    expect(source).toContain("disabled={acknowledge.isPending || acknowledgment.mine}")
    expect(source).not.toContain('onMutate:')
  })

  it('shows a failed save, leaves the action retryable, and accepts a later server success', async () => {
    vi.mocked(sphereAcknowledge)
      .mockRejectedValueOnce(new Error('Acknowledgment could not be saved.'))
      .mockResolvedValueOnce(message({
        acknowledgment: { mine: true, count: 1, people: [{ id: employeeId, name: 'Field Employee', photoPath: null }] },
      }))
    renderCard(message())

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Acknowledgment could not be saved.')
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    expect(await screen.findByRole('button', { name: 'Acknowledged' })).toBeDisabled()
    expect(sphereAcknowledge).toHaveBeenCalledTimes(2)
  })

  it('restores acknowledged state from a reloaded payload without another save', () => {
    renderCard(message({
      acknowledgment: { mine: true, count: 2, people: [
        { id: employeeId, name: 'Field Employee', photoPath: null },
        { id: '55555555-5555-4555-8555-555555555555', name: 'Second Employee', photoPath: null },
      ] },
    }), 'channel')
    expect(screen.getByRole('button', { name: 'Acknowledged' })).toBeDisabled()
    expect(screen.getByLabelText('Acknowledged by 2. Show people.')).toBeVisible()
    expect(sphereAcknowledge).not.toHaveBeenCalled()
  })

  it('does not offer an acknowledgment action in direct chats or on an author’s own message', () => {
    const direct = renderCard(message(), 'direct')
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument()
    direct.unmount()
    renderCard(message({ authorId: employeeId, authorName: 'Field Employee' }), 'group')
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument()
  })

  it('uses the same wrapped action row and bounded identity panel on mobile and desktop', () => {
    const styles = readFileSync(`${process.cwd()}/src/styles/sygsphere.css`, 'utf8')
    expect(styles).toMatch(/\.sphere-message-actions\{[^}]*flex-wrap:wrap/)
    expect(styles).toMatch(/\.sphere-ack-panel\{[^}]*width:min\(290px,calc\(100vw - 46px\)\)/)
    expect(styles).toMatch(/@media\(max-width:760px\)[\s\S]*\.sphere-message-actions>button\.sphere-acknowledge\{[^}]*min-height:44px/)
    expect(styles).toMatch(/@media\(max-width:760px\)[\s\S]*\.sphere-message-actions>details:has\(\.sphere-ack-panel\)>summary\{[^}]*min-height:44px/)
  })
})
