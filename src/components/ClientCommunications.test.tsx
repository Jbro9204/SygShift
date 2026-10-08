import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientCommunications, SygSphereClientAssociation } from './ClientCommunications'

const mocks = vi.hoisted(() => ({
  getClientCommunicationCandidates: vi.fn(),
  getClientCommunicationForConversation: vi.fn(),
  getClientCommunications: vi.fn(),
  linkClientConversation: vi.fn(),
  unlinkClientConversation: vi.fn(),
}))

vi.mock('../data/clientCommunications', () => ({
  getClientCommunicationCandidates: mocks.getClientCommunicationCandidates,
  getClientCommunicationForConversation: mocks.getClientCommunicationForConversation,
  getClientCommunications: mocks.getClientCommunications,
  linkClientConversation: mocks.linkClientConversation,
  unlinkClientConversation: mocks.unlinkClientConversation,
}))

const employeeId = '10000000-0000-4000-8000-000000000001'
const secondEmployeeId = '10000000-0000-4000-8000-000000000009'
const clientId = '20000000-0000-4000-8000-000000000002'
const conversationId = '30000000-0000-4000-8000-000000000003'
const linkId = '40000000-0000-4000-8000-000000000004'

function workspace() {
  return {
    actor: { employeeId, canManage: true, canView: true },
    clientId,
    rows: [{
      linkId,
      clientId,
      clientName: 'T.Client',
      clientNumber: 'CLI-1222',
      conversationId,
      conversationName: 'T.Client Operations',
      kind: 'group' as const,
      archived: false,
      unread: 2,
      updatedAt: '2026-10-08T14:00:00Z',
      latestBody: 'Confirm tomorrow’s coverage.',
      latestCreatedAt: '2026-10-08T14:00:00Z',
      purpose: 'Scheduling and site coordination',
      linkedAt: '2026-10-08T13:00:00Z',
      linkedBy: employeeId,
      owner: true,
    }],
    pagination: { page: 1, pageSize: 20 as const, totalCount: 1, totalPages: 1 },
  }
}

function candidates() {
  return {
    rows: [{
      conversationId: '50000000-0000-4000-8000-000000000005',
      conversationName: 'T.Client Billing',
      kind: 'channel' as const,
      archived: false,
      owner: true,
      updatedAt: '2026-10-08T12:00:00Z',
    }],
    pagination: { page: 1, pageSize: 20 as const, totalCount: 1, totalPages: 1 },
  }
}

function renderWithData(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>)
  return queryClient
}

describe('Client communications', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
    mocks.getClientCommunications.mockReset().mockResolvedValue(workspace())
    mocks.getClientCommunicationCandidates.mockReset().mockResolvedValue(candidates())
    mocks.getClientCommunicationForConversation.mockReset().mockResolvedValue({ actor: workspace().actor, communication: workspace().rows[0] })
    mocks.linkClientConversation.mockReset().mockResolvedValue(undefined)
    mocks.unlinkClientConversation.mockReset().mockResolvedValue(undefined)
  })

  it('makes a linked internal conversation discoverable without copying its source record', async () => {
    renderWithData(<ClientCommunications clientId={clientId} employeeId={employeeId} />)
    expect(await screen.findByText('T.Client Operations')).toBeVisible()
    expect(screen.getByText('Confirm tomorrow’s coverage.')).toBeVisible()
    expect(screen.getByText('2 unread')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open in SygSphere' })).toHaveAttribute('href', `/sygsphere?conversation=${conversationId}`)
    expect(screen.getByText(/Membership remains authoritative/)).toBeVisible()
  })

  it('never carries one employee\'s communication previews into another employee\'s query', async () => {
    const firstWorkspace = workspace()
    const secondWorkspace = {
      ...workspace(),
      actor: { ...workspace().actor, employeeId: secondEmployeeId },
      rows: workspace().rows.map((row) => ({
        ...row,
        conversationName: 'Employee B private conversation',
        latestBody: 'Employee B private preview.',
      })),
    }
    let resolveSecond!: (value: typeof secondWorkspace) => void
    mocks.getClientCommunications.mockReset()
      .mockResolvedValueOnce(firstWorkspace)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const tree = (activeEmployeeId: string) => <QueryClientProvider client={queryClient}><MemoryRouter><ClientCommunications clientId={clientId} employeeId={activeEmployeeId} /></MemoryRouter></QueryClientProvider>
    const view = render(tree(employeeId))

    expect(await screen.findByText('T.Client Operations')).toBeVisible()
    view.rerender(tree(secondEmployeeId))

    expect(screen.queryByText('T.Client Operations')).not.toBeInTheDocument()
    expect(screen.queryByText('Confirm tomorrow’s coverage.')).not.toBeInTheDocument()
    expect(screen.getByText('Loading client communications…')).toBeVisible()

    await act(async () => { resolveSecond(secondWorkspace) })
    expect(await screen.findByText('Employee B private conversation')).toBeVisible()
    expect(screen.getByText('Employee B private preview.')).toBeVisible()
    expect(queryClient.getQueryData(['client-communications', employeeId, 'workspace', clientId, '', 1, 20])).toEqual(firstWorkspace)
    expect(queryClient.getQueryData(['client-communications', secondEmployeeId, 'workspace', clientId, '', 1, 20])).toEqual(secondWorkspace)
  })

  it('does not reuse another employee\'s candidate list when the account changes', async () => {
    const secondCandidates = {
      ...candidates(),
      rows: candidates().rows.map((row) => ({ ...row, conversationName: 'Employee B candidate' })),
    }
    let resolveSecond!: (value: typeof secondCandidates) => void
    mocks.getClientCommunicationCandidates.mockReset()
      .mockResolvedValueOnce(candidates())
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const tree = (activeEmployeeId: string) => <QueryClientProvider client={queryClient}><MemoryRouter><ClientCommunications clientId={clientId} employeeId={activeEmployeeId} /></MemoryRouter></QueryClientProvider>
    const user = userEvent.setup()
    const view = render(tree(employeeId))

    await user.click(await screen.findByRole('button', { name: 'Link conversation' }))
    expect(await screen.findByRole('option', { name: /T\.Client Billing/ })).toBeVisible()

    view.rerender(tree(secondEmployeeId))
    await user.click(await screen.findByRole('button', { name: 'Link conversation' }))

    expect(screen.queryByRole('option', { name: /T\.Client Billing/ })).not.toBeInTheDocument()
    expect(screen.getByText('Loading available conversations…')).toBeVisible()
    await act(async () => { resolveSecond(secondCandidates) })
    expect(await screen.findByRole('option', { name: /Employee B candidate/ })).toBeVisible()
  })

  it('links an existing conversation the manager participates in and preserves the stated purpose', async () => {
    const user = userEvent.setup()
    renderWithData(<ClientCommunications clientId={clientId} employeeId={employeeId} />)
    await user.click(await screen.findByRole('button', { name: 'Link conversation' }))
    await user.selectOptions(screen.getByLabelText('SygSphere conversation'), '50000000-0000-4000-8000-000000000005')
    const purpose = screen.getByLabelText('Client purpose')
    await user.clear(purpose)
    await user.type(purpose, 'Billing coordination')
    await user.click(screen.getAllByRole('button', { name: 'Link conversation' }).at(-1)!)
    await waitFor(() => expect(mocks.linkClientConversation.mock.calls[0]?.[0]).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      clientId,
      conversationId: '50000000-0000-4000-8000-000000000005',
      purpose: 'Billing coordination',
    }))
  })

  it('reuses the request UUID when an unchanged link submission is retried', async () => {
    mocks.linkClientConversation
      .mockReset()
      .mockRejectedValueOnce(new Error('The first response was lost.'))
      .mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    renderWithData(<ClientCommunications clientId={clientId} employeeId={employeeId} />)
    await user.click(await screen.findByRole('button', { name: 'Link conversation' }))
    await user.selectOptions(screen.getByLabelText('SygSphere conversation'), '50000000-0000-4000-8000-000000000005')
    await user.click(screen.getAllByRole('button', { name: 'Link conversation' }).at(-1)!)
    expect(await screen.findByText('The first response was lost.')).toBeVisible()

    const firstRequestId = mocks.linkClientConversation.mock.calls[0]?.[0].requestId
    await user.click(screen.getAllByRole('button', { name: 'Link conversation' }).at(-1)!)
    await waitFor(() => expect(mocks.linkClientConversation).toHaveBeenCalledTimes(2))
    expect(mocks.linkClientConversation.mock.calls[1]?.[0].requestId).toBe(firstRequestId)
  })

  it('uses a new request UUID when a failed link payload is edited', async () => {
    mocks.linkClientConversation
      .mockReset()
      .mockRejectedValueOnce(new Error('The first response was lost.'))
      .mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    renderWithData(<ClientCommunications clientId={clientId} employeeId={employeeId} />)
    await user.click(await screen.findByRole('button', { name: 'Link conversation' }))
    await user.selectOptions(screen.getByLabelText('SygSphere conversation'), '50000000-0000-4000-8000-000000000005')
    await user.click(screen.getAllByRole('button', { name: 'Link conversation' }).at(-1)!)
    expect(await screen.findByText('The first response was lost.')).toBeVisible()

    const firstRequestId = mocks.linkClientConversation.mock.calls[0]?.[0].requestId
    const purpose = screen.getByLabelText('Client purpose')
    await user.clear(purpose)
    await user.type(purpose, 'Updated client purpose')
    await user.click(screen.getAllByRole('button', { name: 'Link conversation' }).at(-1)!)
    await waitFor(() => expect(mocks.linkClientConversation).toHaveBeenCalledTimes(2))
    expect(mocks.linkClientConversation.mock.calls[1]?.[0].requestId).not.toBe(firstRequestId)
  })

  it('targets the exact link generation and reuses the unlink request UUID on retry', async () => {
    mocks.unlinkClientConversation
      .mockReset()
      .mockRejectedValueOnce(new Error('The first response was lost.'))
      .mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    renderWithData(<ClientCommunications clientId={clientId} employeeId={employeeId} />)
    await user.click(await screen.findByRole('button', { name: 'Unlink' }))
    await user.click(screen.getByRole('button', { name: 'Unlink conversation' }))
    expect(await screen.findByText('The first response was lost.')).toBeVisible()

    const firstRequest = mocks.unlinkClientConversation.mock.calls[0]?.[0]
    expect(firstRequest).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      linkId,
      clientId,
      conversationId,
      reason: 'Conversation is no longer associated with this client.',
    })
    await user.click(screen.getByRole('button', { name: 'Unlink conversation' }))
    await waitFor(() => expect(mocks.unlinkClientConversation).toHaveBeenCalledTimes(2))
    expect(mocks.unlinkClientConversation.mock.calls[1]?.[0].requestId).toBe(firstRequest.requestId)
    expect(mocks.unlinkClientConversation.mock.calls[1]?.[0].linkId).toBe(linkId)
  })

  it('shows the reverse Client File link from SygSphere conversation details', async () => {
    renderWithData(<SygSphereClientAssociation conversationId={conversationId} employeeId={employeeId} />)
    expect(await screen.findByText('T.Client')).toBeVisible()
    expect(screen.getByRole('link', { name: 'View Client File' })).toHaveAttribute('href', `/clients/${clientId}`)
  })

  it('does not reuse another employee\'s cached SygSphere association', async () => {
    const firstAssociation = { actor: workspace().actor, communication: workspace().rows[0] }
    const secondAssociation = { actor: { ...workspace().actor, employeeId: secondEmployeeId }, communication: null }
    let resolveSecond!: (value: typeof secondAssociation) => void
    mocks.getClientCommunicationForConversation.mockReset()
      .mockResolvedValueOnce(firstAssociation)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const tree = (activeEmployeeId: string) => <QueryClientProvider client={queryClient}><MemoryRouter><SygSphereClientAssociation conversationId={conversationId} employeeId={activeEmployeeId} /></MemoryRouter></QueryClientProvider>
    const view = render(tree(employeeId))

    expect(await screen.findByText('T.Client')).toBeVisible()
    view.rerender(tree(secondEmployeeId))

    expect(screen.queryByText('T.Client')).not.toBeInTheDocument()
    expect(screen.getByText('Checking Client File link…')).toBeVisible()
    await act(async () => { resolveSecond(secondAssociation) })
    expect(await screen.findByText('No Client File linked')).toBeVisible()
  })
})
