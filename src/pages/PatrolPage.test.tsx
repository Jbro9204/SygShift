import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PatrolRouteSaveError, type PatrolRouteInput, type PatrolWorkspace } from '../data/patrol'
import { PatrolPage } from './PatrolPage'

const dataMocks = vi.hoisted(() => ({
  assignPatrolMakeup: vi.fn(),
  getPatrolWorkspace: vi.fn(),
  linkPatrolRouteShift: vi.fn(),
  savePatrolRoute: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../patrol/VacancyPatrolRecoveryWorkspace', () => ({
  VacancyPatrolRecoveryWorkspace: () => <section><h2>Vacancy Patrol recovery</h2></section>,
}))
vi.mock('../data/patrol', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../data/patrol')>()
  return {
    ...original,
    assignPatrolMakeup: dataMocks.assignPatrolMakeup,
    getPatrolWorkspace: dataMocks.getPatrolWorkspace,
    linkPatrolRouteShift: dataMocks.linkPatrolRouteShift,
    savePatrolRoute: dataMocks.savePatrolRoute,
    getPatrolReleaseReadiness: vi.fn().mockResolvedValue({ checks: [], routes: [], summary: {}, readyForBroadRelease: false }),
  }
})

const propertyId = '00000000-0000-4000-8000-000000000011'
const otherPropertyId = '00000000-0000-4000-8000-000000000012'
const postId = '00000000-0000-4000-8000-000000000013'
function routeWorkspace() {
  const value = workspace()
  const location = { addressLine1: '10 Main St', city: 'Denver', clientId: crypto.randomUUID(), clientName: 'Test Client', postId: null, postName: null, postalCode: '80202', region: 'CO', requiresArmed: false, siteCode: 'TEST', siteId: propertyId, siteName: 'Property without a post', timeZone: 'America/Denver' }
  value.locations = [location, { ...location, siteId: otherPropertyId, siteName: 'Other property', postId, postName: 'Lobby' }]
  return value
}

function renderRoutes(value = routeWorkspace()) {
  dataMocks.getPatrolWorkspace.mockResolvedValue(value)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const result = render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/patrol/routes']}><Routes><Route path="/patrol/:patrolTab" element={<PatrolPage />} /></Routes></MemoryRouter></QueryClientProvider>)
  return { ...result, queryClient }
}

function persistedRoute(input: PatrolRouteInput, id: string): PatrolWorkspace['routes'][number] {
  return { ...input, id, versionId: crypto.randomUUID(), versionNumber: 2, stops: input.stops.map((stop, index) => ({ ...stop, id: crypto.randomUUID(), sequence: index + 1, requirements: stop.requirements.map((requirement) => ({ ...requirement, id: crypto.randomUUID() })) })) }
}

async function fillDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Build route' }))
  await user.type(screen.getByLabelText('Route name'), 'New patrol route')
  await user.type(screen.getByLabelText('Route code'), 'new-route')
  await user.click(screen.getByText('New patrol stop'))
  await user.type(screen.getByLabelText('Location name'), 'Draft stop')
}

describe('Patrol route editor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  })
  it('selects a property without a post and blocks activation until an active requirement exists', async () => {
    const user = userEvent.setup()
    renderRoutes()
    await user.click(await screen.findByRole('button', { name: 'Build route' }))
    await user.click(screen.getByText('New patrol stop'))
    await user.selectOptions(screen.getByLabelText('Property'), propertyId)
    expect(screen.getByText('Linked client: Test Client')).toBeInTheDocument()
    expect(screen.getByLabelText('Post (optional)')).toHaveValue('')
    expect(within(screen.getByLabelText('Post (optional)')).queryByRole('option', { name: 'Lobby' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Route status'), 'active')
    expect(screen.getByRole('button', { name: 'Save route version' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Add requirement' }))
    expect(screen.getByRole('button', { name: 'Save route version' })).toBeEnabled()
  })

  it('saves an incomplete draft and retries an uncertain result with exactly the same immutable request', async () => {
    const user = userEvent.setup()
    const value = routeWorkspace()
    const routeId = crypto.randomUUID()
    renderRoutes(value)
    await fillDraft(user)
    dataMocks.savePatrolRoute.mockRejectedValueOnce(new PatrolRouteSaveError('Lost response', 'uncertain')).mockImplementationOnce(async (input: PatrolRouteInput) => {
      dataMocks.getPatrolWorkspace.mockResolvedValue({ ...value, routes: [...value.routes, persistedRoute(input, routeId)] })
      return routeId
    })
    await user.click(screen.getByRole('button', { name: 'Save route version' }))
    await screen.findByRole('button', { name: 'Retry same save' })
    expect(screen.getByLabelText('Route name')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close editor' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry same save' }))
    await screen.findByText('Route version saved and verified. Existing assignments and historical patrol records were not changed.')
    const [first, second] = dataMocks.savePatrolRoute.mock.calls.map((call) => call[0] as PatrolRouteInput)
    expect(first).toEqual(second)
    expect(first.idempotencyKey).toMatch(/^[\da-f-]{36}$/)
    expect(first.expectedVersionId).toBeNull()
    expect(first.stops[0].siteId).toBeNull()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('refreshes only after a committed save whose readback failed, keeping the editor and request intact', async () => {
    const user = userEvent.setup()
    const value = routeWorkspace()
    const routeId = crypto.randomUUID()
    renderRoutes(value)
    await fillDraft(user)
    dataMocks.savePatrolRoute.mockImplementationOnce(async () => {
      dataMocks.getPatrolWorkspace.mockRejectedValue(new Error('Offline'))
      return routeId
    })
    await user.click(screen.getByRole('button', { name: 'Save route version' }))
    await screen.findByRole('button', { name: 'Refresh saved route' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Route name')).toHaveValue('New patrol route')
    const snapshot = dataMocks.savePatrolRoute.mock.calls[0][0] as PatrolRouteInput
    dataMocks.getPatrolWorkspace.mockResolvedValue({ ...value, routes: [...value.routes, persistedRoute(snapshot, routeId)] })
    await user.click(screen.getByRole('button', { name: 'Refresh saved route' }))
    await screen.findByText('Route version saved and verified. Existing assignments and historical patrol records were not changed.')
    expect(dataMocks.savePatrolRoute).toHaveBeenCalledTimes(1)
  })

  it('does not reset edits on a background refetch and requires explicit latest-version reconciliation after conflict', async () => {
    const user = userEvent.setup()
    const value = routeWorkspace()
    value.routes[0].status = 'draft'
    const { queryClient } = renderRoutes(value)
    await user.click(await screen.findByRole('button', { name: 'Edit route' }))
    await user.clear(screen.getByLabelText('Route name'))
    await user.type(screen.getByLabelText('Route name'), 'My unsaved changes')
    await user.type(screen.getByLabelText('Change reason'), 'Update properties')
    const newer = { ...value.routes[0], name: 'Newer route', versionId: crypto.randomUUID(), versionNumber: 2 }
    dataMocks.getPatrolWorkspace.mockResolvedValue({ ...value, routes: [newer] })
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['patrol-workspace'] }) })
    expect(screen.getByLabelText('Route name')).toHaveValue('My unsaved changes')
    dataMocks.savePatrolRoute.mockRejectedValueOnce(new PatrolRouteSaveError('Version changed', 'conflict'))
    await user.click(screen.getByRole('button', { name: 'Save route version' }))
    await screen.findByRole('button', { name: 'Load latest route for review' })
    expect(dataMocks.savePatrolRoute.mock.calls[0][0]).toMatchObject({ expectedVersionId: value.routes[0].versionId, name: 'My unsaved changes' })
    expect(screen.getByLabelText('Route name')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Load latest route for review' }))
    await waitFor(() => expect(screen.getByLabelText('Route name')).toHaveValue('Newer route'))
    expect(screen.getByLabelText('Change reason')).toHaveValue('')
    await user.type(screen.getByLabelText('Change reason'), 'Reviewed latest changes')
    dataMocks.savePatrolRoute.mockImplementationOnce(async (input: PatrolRouteInput) => {
      dataMocks.getPatrolWorkspace.mockResolvedValue({ ...value, routes: [persistedRoute(input, newer.id)] })
      return newer.id
    })
    await user.click(screen.getByRole('button', { name: 'Save route version' }))
    await screen.findByText('Route version saved and verified. Existing assignments and historical patrol records were not changed.')
    expect(dataMocks.savePatrolRoute.mock.calls[1][0].expectedVersionId).toBe(newer.versionId)
    expect(dataMocks.savePatrolRoute.mock.calls[1][0].idempotencyKey).not.toBe(dataMocks.savePatrolRoute.mock.calls[0][0].idempotencyKey)
  })

  it('blocks activation for unavailable property links and preserves the original selection for review', async () => {
    const user = userEvent.setup()
    const value = routeWorkspace()
    const stop = persistedRoute({ id: null, expectedVersionId: null, idempotencyKey: crypto.randomUUID(), changeReason: 'Existing', code: 'test', name: 'Old route', status: 'active', timeZone: 'America/Denver', effectiveFrom: null, effectiveThrough: null, requiresArmed: false, stops: [{ addressLine1: null, allowPhotos: true, allowVideos: true, city: null, evidenceInstructions: null, geofenceRadiusMeters: null, incidentVideoLimitSeconds: 900, instructions: null, latitude: null, locationLabel: 'Old property', longitude: null, postalCode: null, postId: crypto.randomUUID(), region: null, requireEvidence: false, siteId: crypto.randomUUID(), stableKey: crypto.randomUUID(), standardVideoLimitSeconds: 180, requirements: [] }] }, value.routes[0].id).stops[0]
    value.routes[0].stops = [stop]
    renderRoutes(value)
    await user.click(await screen.findByRole('button', { name: 'Edit route' }))
    await user.click(screen.getByText('Old property', { selector: 'strong' }))
    expect(screen.getByLabelText('Property')).toHaveValue(stop.siteId)
    expect(screen.getByLabelText('Post (optional)')).toHaveValue(stop.postId)
    expect(screen.getByRole('button', { name: 'Save route version' })).toBeDisabled()
    expect(dataMocks.savePatrolRoute).not.toHaveBeenCalled()
  })

  it('does not expose the route editor when the actor lacks route management access', async () => {
    const value = routeWorkspace()
    value.actor.canManageRoutes = false
    renderRoutes(value)
    await screen.findByRole('heading', { name: 'Patrol Command Center' })
    expect(screen.queryByRole('button', { name: 'Build route' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit route' })).not.toBeInTheDocument()
    expect(dataMocks.savePatrolRoute).not.toHaveBeenCalled()
  })

  it('cancels an unsaved draft without a mutation', async () => {
    const user = userEvent.setup()
    renderRoutes()
    await fillDraft(user)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(dataMocks.savePatrolRoute).not.toHaveBeenCalled()
  })

  it.each([true, false])('removes the editor on account change without resending an uncertain request (new manager=%s)', async (canManageRoutes) => {
    const user = userEvent.setup()
    const value = routeWorkspace()
    const { queryClient } = renderRoutes(value)
    await fillDraft(user)
    dataMocks.savePatrolRoute.mockRejectedValueOnce(new PatrolRouteSaveError('Lost response', 'uncertain'))
    await user.click(screen.getByRole('button', { name: 'Save route version' }))
    await screen.findByRole('button', { name: 'Retry same save' })
    dataMocks.getPatrolWorkspace.mockResolvedValue({ ...value, actor: { ...value.actor, employeeId: crypto.randomUUID(), canManageRoutes } })
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['patrol-workspace'] }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(dataMocks.savePatrolRoute).toHaveBeenCalledTimes(1)
  })

  it('blocks repeat clicks while one save is pending', async () => {
    const user = userEvent.setup()
    renderRoutes()
    await fillDraft(user)
    let rejectSave: (error: Error) => void = () => undefined
    dataMocks.savePatrolRoute.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject }))
    await user.dblClick(screen.getByRole('button', { name: 'Save route version' }))
    expect(dataMocks.savePatrolRoute).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Route name')).toBeDisabled()
    await act(async () => rejectSave(new PatrolRouteSaveError('Lost response', 'uncertain')))
    await screen.findByRole('button', { name: 'Retry same save' })
  })

  it('verifies a native database readback with normalized optional text and time-window seconds', async () => {
    const user = userEvent.setup()
    const value = routeWorkspace()
    renderRoutes(value)
    await fillDraft(user)
    await user.type(screen.getByLabelText('Address (optional)'), '   ')
    await user.click(screen.getByRole('button', { name: 'Add requirement' }))
    await user.click(screen.getByText('Optional time window, spacing, and sequence'))
    await user.type(screen.getByLabelText('Start time'), '22:00')
    await user.type(screen.getByLabelText('End time'), '23:30')
    dataMocks.savePatrolRoute.mockImplementationOnce(async (input: PatrolRouteInput) => {
      const saved = persistedRoute(input, crypto.randomUUID())
      saved.stops[0].addressLine1 = null
      saved.stops[0].requirements[0].windowStart = '22:00:00'
      saved.stops[0].requirements[0].windowEnd = '23:30:00'
      dataMocks.getPatrolWorkspace.mockResolvedValue({ ...value, routes: [saved] })
      return saved.id
    })
    await user.click(screen.getByRole('button', { name: 'Save route version' }))
    await screen.findByText('Route version saved and verified. Existing assignments and historical patrol records were not changed.')
    expect(dataMocks.savePatrolRoute).toHaveBeenCalledTimes(1)
  })

  it('reconciles an accepted new route superseded before readback without automatically creating another version', async () => {
    const user = userEvent.setup()
    const value = routeWorkspace()
    const routeId = crypto.randomUUID()
    let latest: PatrolWorkspace['routes'][number] | undefined
    renderRoutes(value)
    await fillDraft(user)
    dataMocks.savePatrolRoute.mockImplementationOnce(async (input: PatrolRouteInput) => {
      latest = { ...persistedRoute(input, routeId), name: 'Later manager version', versionNumber: 3 }
      dataMocks.getPatrolWorkspace.mockResolvedValue({ ...value, routes: [latest] })
      return routeId
    })
    await user.click(screen.getByRole('button', { name: 'Save route version' }))
    await screen.findByRole('button', { name: 'Review latest route' })
    expect(screen.getByLabelText('Route name')).toHaveValue('New patrol route')
    dataMocks.getPatrolWorkspace.mockRejectedValueOnce(new Error('Network interrupted'))
    await user.click(screen.getByRole('button', { name: 'Review latest route' }))
    await screen.findByRole('button', { name: 'Review latest route' })
    expect(screen.getByLabelText('Route name')).toBeDisabled()
    expect(dataMocks.savePatrolRoute).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Review latest route' }))
    await waitFor(() => expect(screen.getByLabelText('Route name')).toHaveValue('Later manager version'))
    expect(screen.getByLabelText('Change reason')).toHaveValue('')
    expect(dataMocks.savePatrolRoute).toHaveBeenCalledTimes(1)
    await user.type(screen.getByLabelText('Change reason'), 'Reviewed newer version')
    dataMocks.savePatrolRoute.mockRejectedValueOnce(new PatrolRouteSaveError('Test rejection', 'rejected'))
    await user.click(screen.getByRole('button', { name: 'Save route version' }))
    await waitFor(() => expect(dataMocks.savePatrolRoute).toHaveBeenCalledTimes(2))
    expect(dataMocks.savePatrolRoute.mock.calls[1][0]).toMatchObject({ id: routeId, expectedVersionId: latest?.versionId })
    expect(dataMocks.savePatrolRoute.mock.calls[1][0].idempotencyKey).not.toBe(dataMocks.savePatrolRoute.mock.calls[0][0].idempotencyKey)
  })

  it.each([false, true])('normalizes requirement order while preserving required-hit differences (changed=%s)', async (changedHits) => {
    const user = userEvent.setup()
    const value = routeWorkspace()
    renderRoutes(value)
    await fillDraft(user)
    await user.click(screen.getByRole('button', { name: 'Add requirement' }))
    await user.selectOptions(screen.getByLabelText('Day'), '2')
    await user.click(screen.getByRole('button', { name: 'Add requirement' }))
    dataMocks.savePatrolRoute.mockImplementationOnce(async (input: PatrolRouteInput) => {
      const saved = persistedRoute(input, crypto.randomUUID())
      saved.stops[0].requirements.reverse()
      if (changedHits) saved.stops[0].requirements[0].requiredHits = 9
      dataMocks.getPatrolWorkspace.mockResolvedValue({ ...value, routes: [saved] })
      return saved.id
    })
    await user.click(screen.getByRole('button', { name: 'Save route version' }))
    if (changedHits) {
      await screen.findByRole('button', { name: 'Review latest route' })
      expect(screen.queryByText('Route version saved and verified. Existing assignments and historical patrol records were not changed.')).not.toBeInTheDocument()
    } else {
      await screen.findByText('Route version saved and verified. Existing assignments and historical patrol records were not changed.')
    }
    expect(dataMocks.savePatrolRoute).toHaveBeenCalledTimes(1)
  })
})

const obligation = (status: string) => ({
  allowPhotos: true, allowVideos: true, completedHitId: null, dueEndAt: '2999-01-01T02:00:00.000Z',
  dueStartAt: '2000-01-01T00:00:00.000Z', evidenceInstructions: null, hitNumber: 1,
  id: crypto.randomUUID(), locationConfigured: true, locationLabel: 'Sample stop', requireEvidence: false,
  requirementId: crypto.randomUUID(), requirementLabel: 'Required patrol', status, stopId: crypto.randomUUID(),
})

const assignment = (name: string, overrides: Record<string, unknown> = {}) => ({
  employeeId: crypto.randomUUID(), employeeName: name, endsAt: '2999-01-01T02:00:00.000Z', hits: [],
  id: crypto.randomUUID(), makeupObligations: [], obligations: [obligation('due')], requiresArmed: false,
  routeId: crypto.randomUUID(), routeName: 'Sample Route', routeVersionId: crypto.randomUUID(),
  serviceDate: '09/07/2026', shiftId: crypto.randomUUID(), startsAt: '2000-01-01T00:00:00.000Z',
  status: 'active', timeZone: 'America/Denver', ...overrides,
})

function workspace(canManage = true): PatrolWorkspace {
  const sharedShift = crypto.randomUUID()
  return {
    actor: {
      canExportReports: false, canManageAssignments: canManage, canManageExceptions: canManage,
      canManageRoutes: canManage, canViewEvidence: true, canViewOperations: true, employeeId: crypto.randomUUID(),
    },
    assignments: [
      assignment('Current Guard'),
      assignment('Completed Guard', { obligations: [obligation('completed')], status: 'completed' }),
      assignment('Review Guard', { obligations: [obligation('missed')] }),
      assignment('Future Guard', { startsAt: '2998-12-31T22:00:00.000Z' }),
      assignment('Configuration Guard', { obligations: [] }),
    ],
    locations: [],
    makeupQueue: [{
      assignmentId: crypto.randomUUID(), dueEndAt: '2026-09-07T02:00:00.000Z', employeeId: crypto.randomUUID(),
      employeeName: 'Review Guard', locationLabel: 'Sample stop', obligationId: crypto.randomUUID(),
      routeName: 'Sample Route', serviceDate: '09/07/2026', status: 'missed',
    }],
    routes: [{
      changeReason: 'Current route', code: 'sample', effectiveFrom: null, effectiveThrough: null,
      id: crypto.randomUUID(), name: 'Sample Route', requiresArmed: false, status: 'active', stops: [],
      timeZone: 'America/Denver', versionId: crypto.randomUUID(), versionNumber: 1,
    }],
    scheduleCandidates: [
      { employeeId: '00000000-0000-4000-8000-000000000001', employeeName: 'Employee A', endsAt: '2999-01-01T02:00:00.000Z', postName: 'Patrol', requiresArmed: false, shiftId: sharedShift, siteName: 'Site A', startsAt: '2999-01-01T00:00:00.000Z', timeZone: 'America/Denver' },
      { employeeId: '00000000-0000-4000-8000-000000000002', employeeName: 'Employee B', endsAt: '2999-01-01T02:00:00.000Z', postName: 'Patrol', requiresArmed: false, shiftId: sharedShift, siteName: 'Site A', startsAt: '2999-01-01T00:00:00.000Z', timeZone: 'America/Denver' },
    ],
  } as PatrolWorkspace
}

function renderOperations() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/patrol/operations']}><Routes><Route path="/patrol/:patrolTab" element={<PatrolPage />} /></Routes></MemoryRouter></QueryClientProvider>)
}

function renderRecovery(canManage = true) {
  dataMocks.getPatrolWorkspace.mockResolvedValue(workspace(canManage))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/patrol/recovery']}><Routes><Route path="/patrol/:patrolTab" element={<PatrolPage />} /></Routes></MemoryRouter></QueryClientProvider>)
}

describe('Patrol Operations page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dataMocks.linkPatrolRouteShift.mockResolvedValue(crypto.randomUUID())
  })

  it('selects the exact employee on a shared shift and reports truthful assignment states', async () => {
    dataMocks.getPatrolWorkspace.mockResolvedValue(workspace(true))
    const user = userEvent.setup()
    renderOperations()

    const shiftPicker = await screen.findByLabelText('Published assigned shift')
    const employeeB = screen.getByRole('option', { name: /Employee B/ }) as HTMLOptionElement
    const employeeA = screen.getByRole('option', { name: /Employee A/ }) as HTMLOptionElement
    expect(employeeA.value).not.toBe(employeeB.value)
    await user.selectOptions(screen.getByLabelText('Active route'), screen.getByRole('option', { name: 'Sample Route' }))
    await user.selectOptions(shiftPicker, employeeB)
    await user.click(screen.getByRole('button', { name: 'Connect patrol' }))
    await waitFor(() => expect(dataMocks.linkPatrolRouteShift).toHaveBeenCalledWith(expect.any(String), expect.any(String), '00000000-0000-4000-8000-000000000002'))

    for (const label of ['In progress', 'Completed', 'Needs review', 'Scheduled', 'No requirements']) {
      expect(screen.getByText(label, { selector: '.patrol-operation-row .patrol-status' })).toBeInTheDocument()
    }
  })

  it('shows retained route-version links and blocks silent reconnection to a newer version', async () => {
    const value = workspace(true)
    value.assignments[0] = { ...value.assignments[0], employeeId: value.scheduleCandidates[0].employeeId, shiftId: value.scheduleCandidates[0].shiftId, routeId: value.routes[0].id, routeVersionId: crypto.randomUUID(), status: 'completed' }
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    const user = userEvent.setup()
    renderOperations()
    await screen.findByLabelText('Published assigned shift')
    await user.selectOptions(screen.getByLabelText('Active route'), screen.getByRole('option', { name: 'Sample Route' }))
    await user.selectOptions(screen.getByLabelText('Published assigned shift'), screen.getByRole('option', { name: /Employee A/ }))
    expect(screen.getByText(/Version reference:/)).toHaveTextContent(value.assignments[0].routeVersionId)
    expect(screen.getByText(/Operations must reconcile/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect patrol' })).toBeDisabled()
    expect(dataMocks.linkPatrolRouteShift).not.toHaveBeenCalled()
  })

  it('does not show mutation controls to an Operations viewer without management permissions', async () => {
    dataMocks.getPatrolWorkspace.mockResolvedValue(workspace(false))
    renderOperations()

    await screen.findByRole('heading', { name: 'Patrol assignments' })
    expect(screen.queryByRole('heading', { name: 'Connect route to published shift' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign makeup' })).not.toBeInTheDocument()
    expect(screen.getByText('Awaiting assignment')).toBeInTheDocument()
  })

  it('opens the focused vacancy recovery worklist only for assignment managers', async () => {
    const { unmount } = renderRecovery(true)

    expect(await screen.findByRole('heading', { name: 'Vacancy Patrol recovery' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Vacancy Recovery' })).toHaveClass('is-active')
    unmount()

    renderRecovery(false)
    expect(await screen.findByRole('heading', { name: 'Patrol Command Center' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Vacancy Recovery' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Vacancy Patrol recovery' })).not.toBeInTheDocument()
  })
})
