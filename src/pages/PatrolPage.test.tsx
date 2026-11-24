import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PatrolRouteSaveError, type PatrolRouteInput, type PatrolWorkspace } from '../data/patrol'
import { PatrolPage } from './PatrolPage'

const dataMocks = vi.hoisted(() => ({
  assignPatrolMakeup: vi.fn(),
  getPatrolWorkspace: vi.fn(),
  linkPatrolRouteShift: vi.fn(),
  reconcilePatrolScheduleConnection: vi.fn(),
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
    reconcilePatrolScheduleConnection: dataMocks.reconcilePatrolScheduleConnection,
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
  it('names incomplete property links before opening an active route without making changes', async () => {
    const value = routeWorkspace()
    value.routes[0].stops = [persistedRoute({ ...emptyRouteInput(), stops: [{ ...emptyRouteInput().stops[0], locationLabel: 'Unlinked stop' }] }, value.routes[0].id).stops[0]]
    renderRoutes(value)
    expect(await screen.findByText('Sample Route: property setup incomplete')).toBeInTheDocument()
    expect(screen.getByText('Stop 1 — Unlinked stop: Link an active property.')).toBeInTheDocument()
    expect(screen.getByText('Stop 1 — Unlinked stop: Add an active weekly hit requirement.')).toBeInTheDocument()
    expect(screen.getByText(/An Active label alone does not verify property setup/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(dataMocks.savePatrolRoute).not.toHaveBeenCalled()
    expect(dataMocks.linkPatrolRouteShift).not.toHaveBeenCalled()
  })

  it('does not flag a linked property without a post when its weekly requirements are valid', async () => {
    const value = routeWorkspace()
    const input = emptyRouteInput()
    input.stops[0] = { ...input.stops[0], siteId: propertyId, requirements: [{ dayOfWeek: 1, label: 'Night patrol', minimumSpacingMinutes: null, requiredHits: 1, sequenceRequired: false, status: 'active', windowEnd: null, windowStart: null }] }
    value.routes[0].stops = persistedRoute(input, value.routes[0].id).stops
    renderRoutes(value)
    await screen.findByRole('button', { name: 'Edit route' })
    expect(screen.queryByText(/property setup incomplete/)).not.toBeInTheDocument()
    expect(dataMocks.savePatrolRoute).not.toHaveBeenCalled()
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

function emptyRouteInput(): PatrolRouteInput {
  return {
    id: null, idempotencyKey: crypto.randomUUID(), expectedVersionId: null,
    code: 'sample', name: 'Sample Route', changeReason: 'Test fixture', status: 'active', requiresArmed: false,
    effectiveFrom: null, effectiveThrough: null, timeZone: 'America/Denver',
    stops: [{ addressLine1: null, allowPhotos: true, allowVideos: true, city: null, evidenceInstructions: null,
      geofenceRadiusMeters: null, incidentVideoLimitSeconds: 900, instructions: null, latitude: null,
      locationLabel: 'Sample stop', longitude: null, postalCode: null, postId: null, region: null,
      requireEvidence: false, siteId: null, stableKey: crypto.randomUUID(), standardVideoLimitSeconds: 180, requirements: [] }],
  }
}

function renderOperations(path = '/patrol/operations', cachedWorkspace?: PatrolWorkspace) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  if (cachedWorkspace) {
    queryClient.setQueryDefaults(['patrol-workspace'], { staleTime: Infinity })
    queryClient.setQueryData(['patrol-workspace'], cachedWorkspace)
  }
  const result = render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}><Routes><Route path="/patrol/:patrolTab?" element={<PatrolPage />} /></Routes></MemoryRouter></QueryClientProvider>)
  return { ...result, queryClient }
}

function renderRecovery(canManage = true) {
  dataMocks.getPatrolWorkspace.mockResolvedValue(workspace(canManage))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/patrol/recovery']}><Routes><Route path="/patrol/:patrolTab" element={<PatrolPage />} /></Routes></MemoryRouter></QueryClientProvider>)
}

describe('Patrol schedule connection review', () => {
  function reviewWorkspace(removed = false) {
    const value = workspace(true)
    const candidate = value.scheduleCandidates[0]
    value.continuityIssues = [{
      id: crypto.randomUUID(), assignmentId: crypto.randomUUID(), sourceShiftId: crypto.randomUUID(),
      targetShiftId: removed ? null : candidate.shiftId, scheduleId: crypto.randomUUID(),
      employeeId: candidate.employeeId, employeeName: candidate.employeeName, routeId: value.routes[0].id,
      routeName: value.routes[0].name, reason: removed ? 'shift_removed' : 'shift_changed', createdAt: '2026-11-18T13:00:00Z',
    }]
    return value
  }

  beforeEach(() => {
    vi.clearAllMocks()
    dataMocks.reconcilePatrolScheduleConnection.mockReset()
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  })

  it('reviews and explicitly confirms the exact current employee without automatically linking on open', async () => {
    const value = reviewWorkspace()
    const issue = value.continuityIssues![0]
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    dataMocks.reconcilePatrolScheduleConnection.mockImplementation(async () => {
      dataMocks.getPatrolWorkspace.mockResolvedValue({ ...value, continuityIssues: [] })
      return { status: 'reconnected', assignmentId: crypto.randomUUID() }
    })
    const user = userEvent.setup()
    renderOperations()
    await user.click(await screen.findByRole('button', { name: 'Review connection' }))
    expect(dataMocks.reconcilePatrolScheduleConnection).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Scheduled employee')).toHaveValue(issue.employeeId)
    await user.type(screen.getByLabelText('Review reason'), 'Confirmed the changed shift and route.')
    await user.click(screen.getByRole('button', { name: 'Confirm patrol reconnection' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(dataMocks.reconcilePatrolScheduleConnection).toHaveBeenCalledExactlyOnceWith(issue.id, issue.employeeId, 'Confirmed the changed shift and route.')
    expect(dataMocks.linkPatrolRouteShift).not.toHaveBeenCalled()
  })

  it('retains the review reason after rejection and does not falsely show success', async () => {
    const value = reviewWorkspace()
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    dataMocks.reconcilePatrolScheduleConnection.mockRejectedValue(new Error('Existing report protects this patrol work.'))
    const user = userEvent.setup()
    renderOperations()
    await user.click(await screen.findByRole('button', { name: 'Review connection' }))
    await user.type(screen.getByLabelText('Review reason'), 'Review the revised shift.')
    await user.click(screen.getByRole('button', { name: 'Confirm patrol reconnection' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Existing report protects this patrol work.')
    expect(screen.getByLabelText('Review reason')).toHaveValue('Review the revised shift.')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText(/Patrol reconnected to the reviewed/)).not.toBeInTheDocument()
  })

  it('requires explicit confirmation to close unused removed work without choosing a replacement', async () => {
    const value = reviewWorkspace(true)
    const issue = value.continuityIssues![0]
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    dataMocks.reconcilePatrolScheduleConnection.mockResolvedValue({ status: 'closed', assignmentId: null })
    const user = userEvent.setup()
    renderOperations()
    await user.click(await screen.findByRole('button', { name: 'Review connection' }))
    expect(screen.queryByLabelText('Scheduled employee')).not.toBeInTheDocument()
    expect(screen.getByText(/No replacement shift will be created/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Review reason'), 'The future shift was removed.')
    await user.click(screen.getByRole('button', { name: 'Close unworked patrol' }))
    await waitFor(() => expect(dataMocks.reconcilePatrolScheduleConnection).toHaveBeenCalledExactlyOnceWith(issue.id, null, 'The future shift was removed.'))
  })

  it('keeps review-only Operations users out of the reconciliation action', async () => {
    const value = reviewWorkspace()
    value.actor.canManageAssignments = false
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    renderOperations()
    await screen.findByRole('heading', { name: 'Patrol connections needing review' })
    expect(screen.queryByRole('button', { name: 'Review connection' })).not.toBeInTheDocument()
    expect(dataMocks.reconcilePatrolScheduleConnection).not.toHaveBeenCalled()
  })

  it('keeps changed patrol history visible but does not open a new-hit form before review', async () => {
    const value = workspace(false)
    value.assignments[0].employeeId = value.actor.employeeId
    value.assignments[0].continuityStatus = 'review_required'
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/patrol/my-patrol']}><Routes><Route path="/patrol/:patrolTab" element={<PatrolPage />} /></Routes></MemoryRouter></QueryClientProvider>)
    const user = userEvent.setup()
    await screen.findByText('Patrol schedule changes need review')
    expect(screen.getByText('Sample stop')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Record extra hit' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(/The schedule changed. Operations must review this patrol connection/)).toBeInTheDocument()
  })
})

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

  it('identifies an unconnected exact employee and shift without inventing a patrol assignment', async () => {
    const value = workspace(true)
    const candidate = value.scheduleCandidates[0]
    value.assignments[0] = { ...value.assignments[0], employeeId: value.scheduleCandidates[1].employeeId, shiftId: candidate.shiftId }
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    const user = userEvent.setup()
    renderOperations()
    await user.selectOptions(await screen.findByLabelText('Published assigned shift'), screen.getByRole('option', { name: /Employee A/ }))
    expect(screen.getByText('No patrol route is connected to this employee and shift.')).toBeInTheDocument()
    expect(screen.getByText(/Employee A has a published schedule assignment/)).toBeInTheDocument()
    expect(screen.getByText(/Unchanged schedule revisions retain verified connections/)).toBeInTheDocument()
    expect(dataMocks.linkPatrolRouteShift).not.toHaveBeenCalled()
    await user.selectOptions(screen.getByLabelText('Published assigned shift'), screen.getByRole('option', { name: /Employee B/ }))
    expect(screen.queryByText('No patrol route is connected to this employee and shift.')).not.toBeInTheDocument()
    expect(dataMocks.linkPatrolRouteShift).not.toHaveBeenCalled()
  })

  it('does not mistake a restricted location catalog for missing property links', async () => {
    const value = workspace(true)
    value.actor.canManageRoutes = false
    value.locations = []
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    const user = userEvent.setup()
    renderOperations()
    await user.selectOptions(await screen.findByLabelText('Active route'), screen.getByRole('option', { name: 'Sample Route' }))
    expect(screen.queryByText(/property setup incomplete/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit route' })).not.toBeInTheDocument()
    expect(dataMocks.linkPatrolRouteShift).not.toHaveBeenCalled()
  })

  it('does not show mutation controls to an Operations viewer without management permissions', async () => {
    const value = workspace(false)
    value.makeupQueue[0].dueEndAt = new Date(Date.now() - 60_000).toISOString()
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
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

const fourteenDays = 14 * 24 * 60 * 60 * 1000

function missedHit(locationLabel: string, overrides: Partial<PatrolWorkspace['makeupQueue'][number]> = {}): PatrolWorkspace['makeupQueue'][number] {
  return {
    assignmentId: crypto.randomUUID(), dueEndAt: '2020-09-30T06:30:00.000Z', employeeId: crypto.randomUUID(),
    employeeName: 'History Officer', locationLabel, obligationId: crypto.randomUUID(),
    routeName: 'History Route', serviceDate: '2020-09-29', status: 'missed', ...overrides,
  }
}

function olderMissedHits(count: number) {
  const summary = screen.getByText(new RegExp('^Older missed hits\\s*[·:]?\\s*' + count + '\\s+unresolved$', 'i'))
  const details = summary.closest('details')
  if (!details) throw new Error('Missing older missed hits disclosure')
  return { summary, details, history: within(details) }
}

describe('Patrol missed-hit queue aging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retains the exact 14-day UTC deadline and moves a hit to history while the page stays open', async () => {
    // This rolling window crosses the fall DST transition. These offset timestamps
    // are separated by one millisecond even though both use the old civil offset.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-11-08T06:00:00.000Z'))
    const value = workspace(false)
    value.makeupQueue = [
      missedHit('Exact-boundary property', { dueEndAt: '2026-10-25T00:00:00.000-06:00' }),
      missedHit('Already-older property', { dueEndAt: '2026-10-24T23:59:59.999-06:00' }),
      missedHit('Unknown deadline property', { dueEndAt: 'invalid timestamp' }),
    ]
    const snapshot = structuredClone(value.makeupQueue)
    const { queryClient, unmount } = renderOperations('/patrol/operations', value)
    try {
      expect(screen.getByText('Exact-boundary property')).toBeVisible()
      expect(screen.getByText('Unknown deadline property')).toBeVisible()
      expect(olderMissedHits(1).details).not.toHaveAttribute('open')

      await act(async () => { await vi.advanceTimersByTimeAsync(1) })

      const older = olderMissedHits(2)
      expect(older.details).not.toHaveAttribute('open')
      expect(screen.getByText('Unknown deadline property')).toBeVisible()
      expect(older.history.getByText('Exact-boundary property')).not.toBeVisible()
      expect(queryClient.getQueryData<PatrolWorkspace>(['patrol-workspace'])?.makeupQueue).toEqual(snapshot)
      expect(dataMocks.getPatrolWorkspace).not.toHaveBeenCalled()
      expect(dataMocks.assignPatrolMakeup).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('keeps an older-only unresolved count on Overview without presenting old hits as live work', async () => {
    const value = workspace(false)
    value.makeupQueue = [missedHit('Older-only property')]
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    const user = userEvent.setup()
    renderOperations('/patrol')

    await screen.findByText(/^Older missed hits.*1 unresolved$/i)
    expect(screen.queryByText('Older-only property')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review queue' }))
    expect(screen.getByRole('heading', { name: 'Missed hits awaiting makeup' })).toBeVisible()
    const older = olderMissedHits(1)
    expect(older.details).not.toHaveAttribute('open')
    expect(screen.queryByRole('button', { name: 'Assign makeup' })).not.toBeInTheDocument()
    await user.click(older.summary)
    expect(older.history.getByText('Older-only property')).toBeVisible()
    expect(dataMocks.assignPatrolMakeup).not.toHaveBeenCalled()
  })

  it('searches every historical page by property, route, guard, and both date formats without changing the unresolved total', async () => {
    const value = workspace(false)
    value.makeupQueue = Array.from({ length: 42 }, (_, index) =>
      missedHit('Past property ' + (index + 1), {
        dueEndAt: new Date(Date.UTC(2020, 10, 15) - index * 86_400_000).toISOString(),
        serviceDate: '2020-10-15',
      }))
    value.makeupQueue[41] = {
      ...value.makeupQueue[41], employeeName: 'Unique Guard', locationLabel: 'Distinct Property',
      routeName: 'Canyon Loop', serviceDate: '2020-09-29',
    }
    const snapshot = structuredClone(value.makeupQueue)
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    const user = userEvent.setup()
    renderOperations()
    await screen.findByText(/^Older missed hits.*42 unresolved$/i)
    const older = olderMissedHits(42)
    await user.click(older.summary)
    expect(older.history.getByText('Past property 1')).toBeVisible()
    expect(older.history.queryByText('Distinct Property')).not.toBeInTheDocument()
    for (let page = 1; page < 5; page += 1) {
      await user.click(older.history.getByRole('button', { name: 'Next' }))
    }
    expect(older.history.getByText('Distinct Property')).toBeVisible()
    expect(older.history.getByRole('button', { name: 'Next' })).toBeDisabled()

    const search = older.history.getByRole('searchbox', { name: 'Search older missed hits' })
    for (const term of ['distinct PROPERTY', 'canyon loop', 'unique GUARD', '2020-09-29', '09/29/2020']) {
      await user.clear(search)
      await user.type(search, term)
      expect(older.history.getByText('Distinct Property')).toBeVisible()
      expect(older.history.getByText(/09\/29\/2020/)).toBeVisible()
      expect(older.history.queryByText('Past property 1')).not.toBeInTheDocument()
      expect(older.summary).toHaveTextContent('42 unresolved')
    }
    await user.clear(search)
    await user.type(search, 'no matching property')
    expect(older.history.getByText('No older missed hits match your search.')).toBeVisible()
    expect(older.summary).toHaveTextContent('42 unresolved')
    expect(dataMocks.assignPatrolMakeup).not.toHaveBeenCalled()
    expect(value.makeupQueue).toEqual(snapshot)
  })

  it('does not expose Operations missed-hit history or totals to a Guard', async () => {
    const value = workspace(false)
    value.actor.canViewOperations = false
    // Test the component gate even if a stale query snapshot contains rows.
    value.makeupQueue = [missedHit('Restricted history property')]
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    renderOperations('/patrol/operations')

    await screen.findByRole('heading', { name: 'Patrol Command Center' })
    expect(screen.queryByText(/Older missed hits/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Restricted history property')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review queue' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign makeup' })).not.toBeInTheDocument()
    expect(dataMocks.assignPatrolMakeup).not.toHaveBeenCalled()
  })

  it('reports both queues empty with zero unresolved instead of implying cleanup completed any work', async () => {
    const value = workspace(false)
    value.makeupQueue = []
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    const user = userEvent.setup()
    renderOperations()

    expect(await screen.findByText('No recent missed patrol hits are waiting for makeup.')).toBeVisible()
    const older = olderMissedHits(0)
    await user.click(older.summary)
    expect(older.history.getByText('No older missed hits are unresolved.')).toBeVisible()
    expect(older.history.queryByRole('button', { name: 'Assign makeup' })).not.toBeInTheDocument()
    expect(dataMocks.assignPatrolMakeup).not.toHaveBeenCalled()
  })

  it('keeps explicit makeup assignment available with a valid source and never turns history into a mutation', async () => {
    const value = workspace(true)
    const [source, target] = value.assignments
    value.assignments[1] = { ...target, routeVersionId: source.routeVersionId, status: 'active' }
    value.makeupQueue = [
      missedHit('Live makeup property', { assignmentId: source.id, dueEndAt: new Date(Date.now() - 60_000).toISOString() }),
      missedHit('Older linked property', { assignmentId: source.id, dueEndAt: new Date(Date.now() - fourteenDays - 60_000).toISOString() }),
      missedHit('Older unlinked property'),
    ]
    dataMocks.getPatrolWorkspace.mockResolvedValue(value)
    const user = userEvent.setup()
    renderOperations()

    const liveRow = (await screen.findByText('Live makeup property')).closest('.patrol-operation-row') as HTMLElement
    await user.click(within(liveRow).getByRole('button', { name: 'Assign makeup' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Assign makeup patrol hit' }))
    expect(dialog.getByRole('option', { name: /Completed Guard/ })).toBeInTheDocument()
    expect(dataMocks.assignPatrolMakeup).not.toHaveBeenCalled()
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))

    const older = olderMissedHits(2)
    await user.click(older.summary)
    expect(older.history.getByText('Older unlinked property')).toBeVisible()
    expect(older.history.getByText('Older linked property')).toBeVisible()
    expect(older.history.getAllByRole('button', { name: 'Assign makeup' })).toHaveLength(1)
    expect(dataMocks.assignPatrolMakeup).not.toHaveBeenCalled()

    dataMocks.assignPatrolMakeup.mockResolvedValueOnce(crypto.randomUUID())
    await user.click(older.history.getByRole('button', { name: 'Assign makeup' }))
    const olderDialog = within(screen.getByRole('dialog', { name: 'Assign makeup patrol hit' }))
    await user.selectOptions(olderDialog.getByRole('combobox', { name: /Current or upcoming assignment on the same route/ }), target.id)
    await user.click(olderDialog.getByRole('button', { name: 'Assign makeup' }))
    await waitFor(() => expect(dataMocks.assignPatrolMakeup).toHaveBeenCalledExactlyOnceWith(value.makeupQueue[1].obligationId, target.id, expect.any(String)))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assign makeup patrol hit' })).not.toBeInTheDocument())
    expect(value.makeupQueue.every((item) => item.status === 'missed')).toBe(true)
  })
})
