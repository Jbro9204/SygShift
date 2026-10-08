import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientFilesPage } from './ClientFilesPage'

const authData = vi.hoisted(() => ({ getSessionContext: vi.fn() }))
const clientData = vi.hoisted(() => ({ getClientFile: vi.fn(), getClientsWorkspace: vi.fn() }))
const communicationsData = vi.hoisted(() => ({ render: vi.fn() }))

vi.mock('../data/auth', () => ({ getSessionContext: authData.getSessionContext }))

vi.mock('../components/ClientCommunications', () => ({
  ClientCommunications: (props: { clientId?: string; employeeId: string }) => {
    communicationsData.render(props)
    return <div data-testid="client-communications-workspace">Client communications workspace</div>
  },
}))

vi.mock('../data/clients', () => ({
  exportClientActivity: vi.fn(),
  getClientDocumentBlob: vi.fn(),
  getClientFile: clientData.getClientFile,
  getClientImportQueue: vi.fn(),
  getClientImportSourceRecords: vi.fn(),
  getClientsWorkspace: clientData.getClientsWorkspace,
  isClientIdentityVerificationRequired: () => false,
  linkSiteToClient: vi.fn(),
  resolveClientImportRow: vi.fn(),
  saveClient: vi.fn(),
  saveClientContact: vi.fn(),
  saveClientServiceRecord: vi.fn(),
  updateClientSiteLocation: vi.fn(),
  uploadClientDocument: vi.fn(),
}))

function workspace(displayName: string) {
  return {
    actor: {
      canExport: false,
      canManage: false,
      canManageActivity: false,
      canManageDocuments: false,
      canManageImports: false,
      canPublishPortal: false,
      canViewActivity: true,
      canViewContracts: false,
      canViewDocuments: true,
    },
    clients: [{
      city: 'Denver',
      clientNumber: 'CLI-1222',
      contactCount: 1,
      dbaName: null,
      displayName,
      documentCount: 0,
      id: '10000000-0000-4000-8000-000000000001',
      legalName: `${displayName} LLC`,
      region: 'CO',
      renewalOn: null,
      siteCount: 1,
      status: 'active',
      timeZone: 'America/Denver',
    }],
    importQueueCount: 0,
    metrics: { active: 1, needsAttention: 0, prospects: 0, renewalsDue: 0 },
    pagination: { page: 1, pageSize: 10, totalCount: 1, totalPages: 1 },
  }
}

function session(permissions: string[]) {
  return {
    displayName: 'Client Files User',
    employeeId: '20000000-0000-4000-8000-000000000001',
    hasMfa: true,
    mfaEnrolledAt: '2026-10-01T00:00:00.000Z',
    mfaRequired: true,
    mustChangePassword: false,
    passwordChangedAt: '2026-10-01T00:00:00.000Z',
    permissions,
    role: 'supervisor' as const,
    timeZone: 'America/Denver',
    username: 'clientfilesuser',
  }
}

function clientFile() {
  return {
    actor: {
      canExport: false,
      canManage: false,
      canManageActivity: false,
      canManageDocuments: false,
      canManageImports: false,
      canPublishPortal: false,
      canViewActivity: true,
      canViewContracts: false,
      canViewDocuments: true,
    },
    activity: [],
    activityPagination: { page: 1, pageSize: 10 },
    client: {
      accountOwnerEmployeeId: null,
      addressLine1: null,
      addressLine2: null,
      billingEmail: null,
      billingPhone: null,
      city: 'Denver',
      clientNumber: 'CLI-1222',
      dbaName: null,
      displayName: 'T.Client',
      id: '10000000-0000-4000-8000-000000000001',
      industry: null,
      internalNotes: null,
      legalName: 'T.Client LLC',
      postalCode: null,
      region: 'CO',
      renewalOn: null,
      serviceEndedOn: null,
      serviceStartedOn: null,
      serviceTier: null,
      status: 'active',
      timeZone: 'America/Denver',
      website: null,
    },
    contacts: [],
    documentPagination: { page: 1, pageSize: 10, totalCount: 0 },
    documents: [],
    sites: [],
    unassignedSites: [],
  }
}

function NavigationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><output data-testid="location">{location.pathname}{location.search}</output><button onClick={() => navigate(-1)} type="button">Test browser back</button></>
}

function renderPage(initialEntries = ['/clients']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}><Routes><Route path="/clients" element={<ClientFilesPage />} /><Route path="/clients/:clientId" element={<ClientFilesPage />} /></Routes><NavigationProbe /></MemoryRouter></QueryClientProvider>)
  return queryClient
}

describe('Client Directory search', () => {
  beforeEach(() => {
    authData.getSessionContext.mockReset().mockResolvedValue(session(['clients.view', 'clients.communications.view']))
    clientData.getClientFile.mockReset()
    clientData.getClientsWorkspace.mockReset()
    communicationsData.render.mockReset()
  })

  it('keeps one focused search input mounted while delayed results update', async () => {
    const pending = new Map<string, (result: ReturnType<typeof workspace>) => void>()
    clientData.getClientsWorkspace.mockImplementation((search: string) => new Promise((resolve) => { pending.set(search, resolve) }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(<QueryClientProvider client={queryClient}><MemoryRouter><ClientFilesPage /></MemoryRouter></QueryClientProvider>)

    expect(screen.getByRole('heading', { name: 'Loading Client Files' })).toBeVisible()
    await waitFor(() => expect(pending.has('')).toBe(true))
    await act(async () => { pending.get('')!(workspace('Existing Client')) })
    await screen.findByText('Existing Client')

    const search = screen.getByRole('textbox', { name: 'Search Client Files' })
    await user.type(search, 'T.Client')

    expect(search).toHaveFocus()
    expect(search).toHaveValue('T.Client')
    expect(screen.getByText('Existing Client')).toBeVisible()
    await waitFor(() => expect(pending.has('T.Client')).toBe(true))
    expect(document.querySelector('.client-directory-panel')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Updating client results…')

    await act(async () => { pending.get('T.Client')!(workspace('T.Client')) })
    await screen.findByText('T.Client')
    await waitFor(() => expect(document.querySelector('.client-directory-panel')).toHaveAttribute('aria-busy', 'false'))
    expect(search).toHaveFocus()
    expect(search).toHaveValue('T.Client')
    queryClient.clear()
  })

  it('hides the global entry unless the exact communications view permission is effective', async () => {
    authData.getSessionContext.mockResolvedValue(session(['clients.view', 'clients.communications.manage']))
    clientData.getClientsWorkspace.mockResolvedValue(workspace('T.Client'))
    const queryClient = renderPage()

    await screen.findByRole('heading', { name: 'Client Directory' })
    expect(screen.queryByRole('button', { name: 'Client communications' })).not.toBeInTheDocument()
    queryClient.clear()
  })

  it('redirects a denied direct communications view without mounting the protected workspace', async () => {
    authData.getSessionContext.mockResolvedValue(session(['clients.view']))
    clientData.getClientsWorkspace.mockResolvedValue(workspace('T.Client'))
    const queryClient = renderPage(['/clients?view=communications'])

    await screen.findByRole('heading', { name: 'Client Directory' })
    expect(screen.getByTestId('location')).toHaveTextContent('/clients')
    expect(communicationsData.render).not.toHaveBeenCalled()
    queryClient.clear()
  })

  it('shows the allowed global workspace and replaces its Directory return in browser history', async () => {
    clientData.getClientsWorkspace.mockResolvedValue(workspace('T.Client'))
    const queryClient = renderPage()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Client communications' }))
    expect(await screen.findByTestId('client-communications-workspace')).toBeVisible()
    expect(communicationsData.render).toHaveBeenLastCalledWith({ employeeId: '20000000-0000-4000-8000-000000000001' })
    expect(screen.getAllByRole('button', { name: 'Client Directory' })).toHaveLength(1)
    expect(screen.getByTestId('location')).toHaveTextContent('/clients?view=communications')

    await user.click(screen.getByRole('button', { name: 'Client Directory' }))
    await screen.findByRole('heading', { name: 'Client Directory' })
    expect(screen.getByTestId('location')).toHaveTextContent('/clients')

    await user.click(screen.getByRole('button', { name: 'Test browser back' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/clients')
    expect(screen.queryByTestId('client-communications-workspace')).not.toBeInTheDocument()
    queryClient.clear()
  })

  it('hides the Client File Communications tab without the exact view permission', async () => {
    authData.getSessionContext.mockResolvedValue(session(['clients.view', 'clients.communications.manage']))
    clientData.getClientFile.mockResolvedValue(clientFile())
    const queryClient = renderPage(['/clients/10000000-0000-4000-8000-000000000001'])

    await screen.findByRole('heading', { name: 'T.Client' })
    expect(screen.queryByRole('button', { name: 'Communications' })).not.toBeInTheDocument()
    queryClient.clear()
  })

  it('shows and opens the Client File Communications tab with the exact view permission', async () => {
    clientData.getClientFile.mockResolvedValue(clientFile())
    const queryClient = renderPage(['/clients/10000000-0000-4000-8000-000000000001'])
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Communications' }))
    expect(await screen.findByTestId('client-communications-workspace')).toBeVisible()
    expect(communicationsData.render).toHaveBeenLastCalledWith({
      clientId: '10000000-0000-4000-8000-000000000001',
      employeeId: '20000000-0000-4000-8000-000000000001',
    })
    queryClient.clear()
  })
})
