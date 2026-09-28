import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VacancyPatrolRecoveryBootstrap, VacancyPatrolRecoveryReceipt } from '../data/vacancyPatrolRecovery'
import { VacancyPatrolRecoveryDialog } from './VacancyPatrolRecoveryDialog'

const dataMocks = vi.hoisted(() => ({
  createVacancyPatrolRecovery: vi.fn(),
  getVacancyPatrolRecoveryBootstrap: vi.fn(),
}))

vi.mock('../data/vacancyPatrolRecovery', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../data/vacancyPatrolRecovery')>()
  return {
    ...original,
    createVacancyPatrolRecovery: dataMocks.createVacancyPatrolRecovery,
    getVacancyPatrolRecoveryBootstrap: dataMocks.getVacancyPatrolRecoveryBootstrap,
  }
})

const shiftId = '10000000-0000-4000-8000-000000000001'
const routeId = '10000000-0000-4000-8000-000000000002'

function bootstrap(overrides: Partial<VacancyPatrolRecoveryBootstrap> = {}): VacancyPatrolRecoveryBootstrap {
  return {
    defaults: {
      hitWindows: [{
        plannedHits: 2,
        windowEndAt: '2026-10-02T04:00:00.000Z',
        windowStartAt: '2026-10-02T00:00:00.000Z',
      }],
      maxHitWindows: 4,
      reasonMinLength: 10,
    },
    existingRequest: null,
    permissions: { canInitiate: true },
    routeChoices: [{
      code: 'CENTRAL',
      name: 'Central Night Route',
      requiresArmed: false,
      routeId,
      routeVersionId: '10000000-0000-4000-8000-000000000003',
      timeZone: 'America/Denver',
    }],
    shift: {
      endsAt: '2026-10-02T06:00:00.000Z',
      isPublished: true,
      isUnassigned: true,
      postId: '10000000-0000-4000-8000-000000000004',
      postName: 'Main entrance',
      requiresArmed: false,
      scheduleId: '10000000-0000-4000-8000-000000000005',
      scheduleName: 'Week of 09/27/2026',
      shiftId,
      siteId: '10000000-0000-4000-8000-000000000006',
      siteName: 'Central Apartments',
      startsAt: '2026-10-01T22:00:00.000Z',
      timeZone: 'America/Denver',
    },
    ...overrides,
  }
}

const receipt: VacancyPatrolRecoveryReceipt = {
  createdAt: '2026-09-27T23:00:00.000Z',
  idempotentReplay: false,
  requestId: '10000000-0000-4000-8000-000000000007',
  requestNumber: 'VPR-20260927-000001',
  status: 'requested',
}

function renderDialog(onCreated = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  const invalidation = vi.spyOn(queryClient, 'invalidateQueries')
  render(
    <QueryClientProvider client={queryClient}>
      <VacancyPatrolRecoveryDialog onClose={vi.fn()} onCreated={onCreated} shiftId={shiftId} />
    </QueryClientProvider>,
  )
  return { invalidation, queryClient }
}

describe('VacancyPatrolRecoveryDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    dataMocks.getVacancyPatrolRecoveryBootstrap.mockResolvedValue(bootstrap())
    dataMocks.createVacancyPatrolRecovery.mockResolvedValue(receipt)
  })

  it('shows read-only vacancy context and keeps Patrol, call-off, attendance, and billing meanings separate', async () => {
    renderDialog()

    expect(await screen.findByRole('heading', { name: 'Resolve vacancy with Patrol' })).toBeInTheDocument()
    expect(await screen.findByText('Central Apartments')).toBeInTheDocument()
    expect(screen.getByText('Main entrance')).toBeInTheDocument()
    expect(screen.getByText(/does not create a call-off, attendance event, time entry, patrol assignment, or final billing decision/i)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /Requested Patrol route/i })).toHaveValue(routeId)
    expect(screen.getByRole('button', { name: 'Send to Patrol' })).toBeDisabled()
    expect(screen.getByText('2', { selector: '.scheduler-workflow-summary strong' })).toBeInTheDocument()
  })

  it('submits the route preference, note, planned hits, explicit acknowledgement, and invalidates affected queries', async () => {
    const onCreated = vi.fn()
    const { invalidation } = renderDialog(onCreated)
    const user = userEvent.setup()

    await screen.findByRole('combobox', { name: /Requested Patrol route/i })
    await user.type(screen.getByRole('textbox', { name: /Operational \/ billing note/i }), 'Client-authorized documented vacancy checks.')
    await user.click(screen.getByRole('checkbox', { name: /does not assign a Patrol officer/i }))
    await user.click(screen.getByRole('button', { name: 'Send to Patrol' }))

    await waitFor(() => expect(dataMocks.createVacancyPatrolRecovery).toHaveBeenCalledTimes(1))
    expect(dataMocks.createVacancyPatrolRecovery).toHaveBeenCalledWith({
      hitWindows: [{
        plannedHits: 2,
        windowEndAt: '2026-10-02T04:00:00.000Z',
        windowStartAt: '2026-10-02T00:00:00.000Z',
      }],
      idempotencyKey: expect.any(String),
      reason: 'Client-authorized documented vacancy checks.',
      requestedRouteId: routeId,
      shiftId,
    })
    expect(await screen.findByText(/VPR-20260927-000001 was sent to Patrol for review/i)).toBeInTheDocument()
    expect(onCreated).toHaveBeenCalledWith(receipt)
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['vacancy-patrol-recovery-map'] })
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['weekly-schedule'] })
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['patrol-workspace'] })
  })

  it('supports a multi-window requested hit plan with reachable add and remove controls', async () => {
    renderDialog()
    const user = userEvent.setup()

    await screen.findByRole('button', { name: 'Add window' })
    await user.click(screen.getByRole('button', { name: 'Add window' }))

    expect(screen.getByText('Window 2')).toBeInTheDocument()
    expect(screen.getByText('3', { selector: '.scheduler-workflow-summary strong' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove visit window 2' }))
    expect(screen.queryByText('Window 2')).not.toBeInTheDocument()
  })

  it('shows an existing request instead of allowing a duplicate submission', async () => {
    dataMocks.getVacancyPatrolRecoveryBootstrap.mockResolvedValue(bootstrap({
      existingRequest: {
        createdAt: '2026-09-27T23:00:00.000Z',
        hitWindows: [{
          plannedHits: 2,
          windowEndAt: '2026-10-02T04:00:00.000Z',
          windowStartAt: '2026-10-02T00:00:00.000Z',
        }],
        reason: 'Client-authorized documented vacancy checks.',
        requestId: receipt.requestId,
        requestNumber: receipt.requestNumber,
        requestedRouteId: routeId,
        status: 'requested',
      },
    }))
    renderDialog()

    expect(await screen.findByText(/already covers this vacancy/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send to Patrol' })).not.toBeInTheDocument()
    expect(dataMocks.createVacancyPatrolRecovery).not.toHaveBeenCalled()
  })

  it('fails closed when the focused bootstrap denies initiation', async () => {
    dataMocks.getVacancyPatrolRecoveryBootstrap.mockResolvedValue(bootstrap({ permissions: { canInitiate: false } }))
    renderDialog()

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not allow vacancy recovery requests/i)
    expect(screen.queryByRole('button', { name: 'Send to Patrol' })).not.toBeInTheDocument()
  })
})
