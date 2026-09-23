import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestsPage } from './RequestsPage'

const dataMocks = vi.hoisted(() => ({
  getCallOffCoverageWorkspace: vi.fn(),
  getRequestCenter: vi.fn(),
  resolveCallOffCoverage: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/requests', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../data/requests')>()
  return {
    ...original,
    getCallOffCoverageWorkspace: dataMocks.getCallOffCoverageWorkspace,
    getRequestCenter: dataMocks.getRequestCenter,
    resolveCallOffCoverage: dataMocks.resolveCallOffCoverage,
  }
})

const callOffId = '10000000-0000-4000-8000-000000000001'
const shiftId = '20000000-0000-4000-8000-000000000001'
const absentEmployeeId = '30000000-0000-4000-8000-000000000001'
const replacementEmployeeId = '30000000-0000-4000-8000-000000000002'

function requestCenter() {
  const shift = {
    id: shiftId,
    starts_at: '2026-09-15T00:00:00.000Z',
    ends_at: '2026-09-15T08:00:00.000Z',
    time_zone: 'America/Denver',
    title: 'Night security',
    location: 'Central Site',
    post: null,
    event: null,
  }
  return {
    employeeId: '40000000-0000-4000-8000-000000000001',
    role: 'supervisor' as const,
    permissions: { canManage: true },
    timeOff: [],
    shiftRequests: [],
    callOffs: [{
      id: callOffId,
      employee_id: absentEmployeeId,
      reason: 'Vehicle breakdown reported to Dispatch.',
      reported_at: '2026-09-14T18:00:00.000Z',
      acknowledged_at: null,
      announcement_id: null,
      resolved_at: null,
      employee: { id: absentEmployeeId, first_name: 'Alex', last_name: 'Guard', preferred_name: null },
      shift,
    }],
    upcomingAssignments: [],
  }
}

function coverageWorkspace() {
  return {
    callOff: {
      id: callOffId,
      employeeId: absentEmployeeId,
      employeeName: 'Alex Guard',
      reason: 'Vehicle breakdown reported to Dispatch.',
      reportedAt: '2026-09-14T18:00:00.000Z',
      replacementNeeded: true,
    },
    shift: {
      id: shiftId,
      startsAt: '2026-09-15T00:00:00.000Z',
      endsAt: '2026-09-15T08:00:00.000Z',
      timeZone: 'America/Denver',
      title: 'Night security',
      location: 'Central Site',
      requiresArmed: false,
      isOpen: false,
    },
    coverageCase: null,
    candidates: [{
      id: replacementEmployeeId,
      name: 'Frankie Flex',
      employeeNumber: 'SYG-1042',
      employmentType: 'flex' as const,
      workClassification: 'flex',
      isFlex: true,
      available: true,
      noOverlap: true,
      armedReady: true,
      overtimeMinutes: 0,
      requiresOvertimeApproval: false,
      eligible: true,
      recommended: true,
      blockReason: null,
    }],
    actions: [],
    attendancePolicy: { pointsActive: false, message: 'No attendance-point policy is currently active.' },
    patrolFallback: { available: true, message: 'Dispatch can review this site for a one-night patrol plan.' },
  }
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter><RequestsPage /></MemoryRouter></QueryClientProvider>)
}

describe('Requests absence coverage workflow', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    dataMocks.getRequestCenter.mockResolvedValue(requestCenter())
    dataMocks.getCallOffCoverageWorkspace.mockResolvedValue(coverageWorkspace())
    dataMocks.resolveCallOffCoverage.mockResolvedValue({
      coverageCaseId: '50000000-0000-4000-8000-000000000001',
      status: 'assigned',
      coverageMode: 'assigned_guard',
      coverageShiftId: '20000000-0000-4000-8000-000000000002',
      announcementId: null,
      replacementAssignmentId: '60000000-0000-4000-8000-000000000001',
      idempotentReplay: false,
    })
  })

  it('walks a manager through preserving and assigning coverage', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Review coverage' }))
    expect(await screen.findByText('The original schedule will not disappear')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByText('Coverage already found'))
    await user.click(screen.getByText('Frankie Flex'))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.type(screen.getByLabelText('Required management note'), 'Frankie confirmed availability with Dispatch.')
    await user.click(screen.getByRole('button', { name: 'Save coverage plan' }))

    await waitFor(() => expect(dataMocks.resolveCallOffCoverage).toHaveBeenCalledWith(
      expect.objectContaining({
        callOffId,
        mode: 'assigned_guard',
        replacementEmployeeId,
        allowOvertime: false,
        reason: 'Frankie confirmed availability with Dispatch.',
      }),
      expect.anything(),
    ))
    expect(await screen.findByText('Replacement assigned and original schedule preserved.')).toBeVisible()
  })

  it('shows every qualified non-Flex employee after the Flex recommendations', async () => {
    const baseWorkspace = coverageWorkspace()
    const flexCandidates = Array.from({ length: 15 }, (_, index) => ({
      ...baseWorkspace.candidates[0],
      id: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name: `Flex Guard ${String(index + 1).padStart(2, '0')}`,
      employeeNumber: `SYG-F${index + 1}`,
    }))
    dataMocks.getCallOffCoverageWorkspace.mockResolvedValue({
      ...baseWorkspace,
      candidates: [
        ...flexCandidates,
        {
          ...baseWorkspace.candidates[0],
          id: '70000000-0000-4000-8000-000000000101',
          name: 'Regular Available Guard',
          employeeNumber: 'SYG-R101',
          employmentType: 'hourly',
          workClassification: null,
          isFlex: false,
        },
      ],
    })

    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Review coverage' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByText('Coverage already found'))

    expect(screen.getByRole('heading', { name: 'Recommended Flex' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Available employees' })).toBeVisible()
    expect(screen.getByText('Regular Available Guard')).toBeVisible()
    expect(screen.getByText('SYG-R101 · hourly · No shift conflict · No projected overtime')).toBeVisible()
    expect(screen.getByText('16', { selector: '.coverage-candidate-summary strong' })).toBeVisible()
    expect(screen.getByText(/eligible for this shift/, { selector: '.coverage-candidate-summary span' })).toBeVisible()
  })

  it('requires acknowledgement before continuing with an overtime candidate', async () => {
    const baseWorkspace = coverageWorkspace()
    dataMocks.getCallOffCoverageWorkspace.mockResolvedValue({
      ...baseWorkspace,
      candidates: [{
        ...baseWorkspace.candidates[0],
        id: '70000000-0000-4000-8000-000000000201',
        name: 'Qualified Overtime Guard',
        employeeNumber: 'SYG-OT1',
        overtimeMinutes: 150,
        requiresOvertimeApproval: true,
        recommended: false,
        blockReason: 'This assignment would create scheduled overtime.',
      }],
    })

    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Review coverage' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByText('Coverage already found'))
    await user.click(screen.getByText('Qualified Overtime Guard'))

    const continueButton = screen.getByRole('button', { name: 'Continue' })
    expect(continueButton).toBeDisabled()
    await user.click(screen.getByText('Overtime is approved for this replacement'))
    expect(continueButton).toBeEnabled()
  })
})
