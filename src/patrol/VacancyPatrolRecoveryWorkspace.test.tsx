import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VacancyPatrolRecoveryDetail, VacancyPatrolRecoveryWorklist } from '../data/vacancyPatrolOperations'
import { VacancyPatrolRecoveryWorkspace } from './VacancyPatrolRecoveryWorkspace'

const dataMocks = vi.hoisted(() => ({
  accept: vi.fn(),
  getDetail: vi.fn(),
  getWorklist: vi.fn(),
  update: vi.fn(),
}))

vi.mock('../data/vacancyPatrolOperations', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../data/vacancyPatrolOperations')>()
  return {
    ...original,
    acceptVacancyPatrolRecovery: dataMocks.accept,
    getVacancyPatrolRecovery: dataMocks.getDetail,
    getVacancyPatrolRecoveryWorklist: dataMocks.getWorklist,
    updateVacancyPatrolRecovery: dataMocks.update,
  }
})

const requestId = '20000000-0000-4000-8000-000000000001'
const routeId = '20000000-0000-4000-8000-000000000002'
const routeVersionId = '20000000-0000-4000-8000-000000000003'
const armedEmployeeId = '20000000-0000-4000-8000-000000000004'
const unarmedEmployeeId = '20000000-0000-4000-8000-000000000005'

function request(canAccept = true): VacancyPatrolRecoveryDetail {
  return {
    acceptedRoute: null,
    assignedEmployee: null,
    billingDisposition: null,
    completedHits: 0,
    createdAt: '2026-09-27T22:00:00.000Z',
    displayStage: 'requested',
    employeeChoices: [
      { armedQualified: false, employeeId: unarmedEmployeeId, employeeNumber: 'E-101', name: 'Unarmed Guard' },
      { armedQualified: true, employeeId: armedEmployeeId, employeeNumber: 'E-102', name: 'Armed Guard' },
    ],
    hitWindows: [{
      completedHits: 0,
      hitWindowId: '20000000-0000-4000-8000-000000000006',
      missedHits: 0,
      plannedHits: 2,
      remainingHits: 2,
      sequence: 1,
      status: 'planned',
      windowEndAt: '2026-10-02T04:00:00.000Z',
      windowStartAt: '2026-10-02T00:00:00.000Z',
    }],
    patrolAssignmentId: null,
    permissions: { canAccept, canReviewBilling: false, canUpdate: canAccept },
    plannedHits: 2,
    reason: 'Recover the vacancy with two documented armed Patrol visits.',
    requestId,
    requestNumber: 'VPR-20260927-000001',
    requestedRoute: { code: 'ARMED', name: 'Armed Night Route', requiresArmed: true, routeId, routeVersionId, timeZone: 'America/Denver' },
    routeChoices: [{ code: 'ARMED', isRequestedRoute: true, name: 'Armed Night Route', requiresArmed: true, routeId, routeVersionId, timeZone: 'America/Denver' }],
    shift: {
      clientId: '20000000-0000-4000-8000-000000000007',
      clientName: 'Sample Client',
      endsAt: '2026-10-02T06:00:00.000Z',
      isPublished: true,
      isUnassigned: true,
      postId: null,
      postName: null,
      requiresArmed: true,
      scheduleId: '20000000-0000-4000-8000-000000000008',
      scheduleName: 'Week of 09/27/2026',
      shiftId: '20000000-0000-4000-8000-000000000009',
      siteId: '20000000-0000-4000-8000-000000000010',
      siteName: 'Vacant property',
      startsAt: '2026-10-01T22:00:00.000Z',
      timeZone: 'America/Denver',
      weekStartsOn: '2026-09-27',
    },
    status: 'requested',
    statusHistory: [{
      action: 'request',
      actorEmployeeId: '20000000-0000-4000-8000-000000000011',
      actorName: 'Scheduler',
      createdAt: '2026-09-27T22:00:00.000Z',
      fromStatus: null,
      historyId: 1,
      metadata: {},
      note: 'Sent to Patrol.',
      toStatus: 'requested',
    }],
    updatedAt: '2026-09-27T22:00:00.000Z',
  }
}

function worklist(detail: VacancyPatrolRecoveryDetail): VacancyPatrolRecoveryWorklist {
  return {
    counts: { canceled: 0, completed: 0, declined: 0, inProgress: 0, patrolPlanned: 0, requested: 1, total: 1 },
    generatedAt: '2026-09-27T23:00:00.000Z',
    permissions: { canAccept: detail.permissions.canAccept, canUpdate: detail.permissions.canUpdate },
    requests: [detail],
  }
}

function updateReceipt(plannedHits = 2) {
  return {
    completedHits: 0,
    displayStage: 'requested' as const,
    idempotentReplay: false,
    missedHits: 0,
    plannedHits,
    requestId,
    requestNumber: 'VPR-20260927-000001',
    status: 'requested' as const,
    updatedAt: '2026-09-27T23:20:00.000Z',
  }
}

function renderWorkspace() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  return {
    queryClient,
    ...render(<QueryClientProvider client={queryClient}><VacancyPatrolRecoveryWorkspace /></QueryClientProvider>),
  }
}

describe('Vacancy Patrol recovery manager workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.setAttribute('open', '') })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.removeAttribute('open') })
    dataMocks.accept.mockResolvedValue({
      acceptedAt: '2026-09-27T23:10:00.000Z',
      acceptedRouteId: routeId,
      assignedEmployeeId: armedEmployeeId,
      completedHits: 0,
      idempotentReplay: false,
      patrolAssignmentId: '20000000-0000-4000-8000-000000000013',
      plannedHits: 2,
      requestId,
      requestNumber: 'VPR-20260927-000001',
      status: 'patrol_planned',
    })
    dataMocks.update.mockResolvedValue({
      completedHits: 0, displayStage: 'canceled', idempotentReplay: false, missedHits: 0,
      plannedHits: 2, requestId, requestNumber: 'VPR-20260927-000001', status: 'canceled',
      updatedAt: '2026-09-27T23:20:00.000Z',
    })
  })

  it('accepts the requested plan with a server-scoped armed employee and documented note', async () => {
    const detail = request(true)
    dataMocks.getWorklist.mockResolvedValue(worklist(detail))
    dataMocks.getDetail.mockResolvedValue(detail)
    const user = userEvent.setup()
    renderWorkspace()

    await user.click(await screen.findByRole('button', { name: 'Review request' }))
    const employeeSelect = await screen.findByLabelText('Assigned Patrol employee')
    await waitFor(() => expect(employeeSelect).toHaveValue(armedEmployeeId))
    expect(screen.getByRole('option', { name: /Unarmed Guard/ })).toBeDisabled()
    await user.type(screen.getByLabelText('Manager decision note'), 'Reviewed route, hit windows, and armed qualification.')
    await user.click(screen.getByRole('button', { name: 'Accept and plan Patrol' }))

    await waitFor(() => expect(dataMocks.accept).toHaveBeenCalledWith({
      employeeId: armedEmployeeId,
      idempotencyKey: expect.any(String),
      note: 'Reviewed route, hit windows, and armed qualification.',
      requestId,
      routeId,
    }))
  })

  it('keeps decision controls hidden for a read-only reviewer', async () => {
    const detail = request(false)
    dataMocks.getWorklist.mockResolvedValue(worklist(detail))
    dataMocks.getDetail.mockResolvedValue(detail)
    const user = userEvent.setup()
    renderWorkspace()

    expect(await screen.findByText(/Patrol Assignment Management permission/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review request' }))
    await screen.findByText('Requested visit windows')

    expect(screen.queryByRole('button', { name: 'Accept and plan Patrol' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Decline request' })).not.toBeInTheDocument()
  })

  it('updates a requested visit plan and refreshes every dependent recovery query without losing acceptance choices', async () => {
    const detail = request(true)
    dataMocks.getWorklist.mockResolvedValue(worklist(detail))
    dataMocks.getDetail.mockResolvedValue(detail)
    dataMocks.update.mockResolvedValueOnce(updateReceipt(3))
    const user = userEvent.setup()
    const { queryClient } = renderWorkspace()
    const invalidation = vi.spyOn(queryClient, 'invalidateQueries')

    await user.click(await screen.findByRole('button', { name: 'Review request' }))
    await user.type(await screen.findByLabelText('Manager decision note'), 'Route and qualified employee review remains ready.')
    await user.click(await screen.findByRole('button', { name: 'Edit visit plan' }))
    const plannedHits = screen.getByLabelText('Window 1 planned hits')
    await user.clear(plannedHits)
    await user.type(plannedHits, '3')
    await user.type(screen.getByLabelText('Plan update note'), 'Adjusted the requested visit frequency before acceptance.')
    await user.click(screen.getByRole('button', { name: 'Save visit plan' }))

    await waitFor(() => expect(dataMocks.update).toHaveBeenCalledWith({
      action: 'update_plan',
      hitWindows: [{
        plannedHits: 3,
        windowEndAt: '2026-10-02T04:00:00.000Z',
        windowStartAt: '2026-10-02T00:00:00.000Z',
      }],
      idempotencyKey: expect.any(String),
      note: 'Adjusted the requested visit frequency before acceptance.',
      requestId,
    }))
    expect(await screen.findByText('Visit plan saved with 3 planned hits.')).toBeInTheDocument()
    await waitFor(() => expect(dataMocks.getDetail).toHaveBeenCalledTimes(2))
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['vacancy-patrol-recovery-worklist'] })
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['vacancy-patrol-recovery-detail', requestId] })
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['vacancy-patrol-recovery-map'] })
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['patrol-workspace'] })
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['vacancy-patrol-finance-report'] })
    expect(screen.getByRole('button', { name: 'Accept and plan Patrol' })).toBeEnabled()
    expect(screen.getByLabelText('Assigned Patrol employee')).toHaveValue(armedEmployeeId)
    expect(screen.getByLabelText('Manager decision note')).toHaveValue('Route and qualified employee review remains ready.')
  })

  it('locks the plan editor and announces progress while an update is saving', async () => {
    const detail = request(true)
    dataMocks.getWorklist.mockResolvedValue(worklist(detail))
    dataMocks.getDetail.mockResolvedValue(detail)
    let finishUpdate: (value: ReturnType<typeof updateReceipt>) => void = () => undefined
    dataMocks.update.mockImplementationOnce(() => new Promise((resolve) => { finishUpdate = resolve }))
    const user = userEvent.setup()
    renderWorkspace()

    await user.click(await screen.findByRole('button', { name: 'Review request' }))
    await user.click(await screen.findByRole('button', { name: 'Edit visit plan' }))
    await user.type(screen.getByLabelText('Plan update note'), 'Keep this plan pending while the save completes.')
    await user.click(screen.getByRole('button', { name: 'Save visit plan' }))

    expect(await screen.findByText('Saving the updated visit plan...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saving plan...' })).toBeDisabled()
    expect(screen.getByLabelText('Window 1 starts')).toBeDisabled()

    await act(async () => { finishUpdate(updateReceipt()) })
    expect(await screen.findByText('Visit plan saved with 2 planned hits.')).toBeInTheDocument()
  })

  it('keeps the editable plan and reports a protected update failure', async () => {
    const detail = request(true)
    dataMocks.getWorklist.mockResolvedValue(worklist(detail))
    dataMocks.getDetail.mockResolvedValue(detail)
    dataMocks.update.mockRejectedValueOnce(new Error('The recovery changed before this plan could be saved.'))
    const user = userEvent.setup()
    renderWorkspace()

    await user.click(await screen.findByRole('button', { name: 'Review request' }))
    await user.click(await screen.findByRole('button', { name: 'Edit visit plan' }))
    await user.type(screen.getByLabelText('Plan update note'), 'Document the revised pre-acceptance plan.')
    await user.click(screen.getByRole('button', { name: 'Save visit plan' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The recovery changed before this plan could be saved.')
    expect(screen.getByRole('form', { name: 'Edit requested visit plan' })).toBeInTheDocument()
    expect(screen.getByLabelText('Plan update note')).toHaveValue('Document the revised pre-acceptance plan.')
  })

  it('rejects overlapping visit windows before calling the update action', async () => {
    const detail = request(true)
    dataMocks.getWorklist.mockResolvedValue(worklist(detail))
    dataMocks.getDetail.mockResolvedValue(detail)
    const user = userEvent.setup()
    renderWorkspace()

    await user.click(await screen.findByRole('button', { name: 'Review request' }))
    await user.click(await screen.findByRole('button', { name: 'Edit visit plan' }))
    await user.click(screen.getByRole('button', { name: 'Add window' }))
    await user.clear(screen.getByLabelText('Window 2 starts'))
    await user.type(screen.getByLabelText('Window 2 starts'), '2026-10-01T21:00')
    await user.type(screen.getByLabelText('Plan update note'), 'Split the requested coverage into two visit periods.')
    await user.click(screen.getByRole('button', { name: 'Save visit plan' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Visit windows cannot overlap')
    expect(dataMocks.update).not.toHaveBeenCalled()
  })

  it('lets a Patrol assignment manager cancel accepted recovery work with an audited note', async () => {
    const base = request(true)
    const detail: VacancyPatrolRecoveryDetail = {
      ...base,
      acceptedRoute: base.requestedRoute,
      assignedEmployee: { employeeId: armedEmployeeId, employeeNumber: 'E-102', name: 'Armed Guard' },
      displayStage: 'patrol_planned',
      patrolAssignmentId: '20000000-0000-4000-8000-000000000013',
      status: 'patrol_planned',
    }
    dataMocks.getWorklist.mockResolvedValue(worklist(detail))
    dataMocks.getDetail.mockResolvedValue(detail)
    const user = userEvent.setup()
    renderWorkspace()

    await user.click(await screen.findByRole('button', { name: 'Review request' }))
    expect(screen.queryByRole('button', { name: 'Edit visit plan' })).not.toBeInTheDocument()
    await user.type(await screen.findByLabelText('Operational update note'), 'Regular coverage was assigned before Patrol service began.')
    await user.click(screen.getByRole('button', { name: 'Cancel recovery' }))

    await waitFor(() => expect(dataMocks.update).toHaveBeenCalledWith({
      action: 'cancel',
      idempotencyKey: expect.any(String),
      note: 'Regular coverage was assigned before Patrol service began.',
      requestId,
    }))
  })
})
