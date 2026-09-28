import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestsPage } from './RequestsPage'

const dataMocks = vi.hoisted(() => ({
  getCallOffCoverageWorkspace: vi.fn(),
  getRequestCenter: vi.fn(),
  getTimeOffRequestContext: vi.fn(),
  getTimeOffReviewContext: vi.fn(),
  resolveCallOffCoverage: vi.fn(),
  withdrawTimeOff: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/requests', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../data/requests')>()
  return {
    ...original,
    getCallOffCoverageWorkspace: dataMocks.getCallOffCoverageWorkspace,
    getRequestCenter: dataMocks.getRequestCenter,
    getTimeOffRequestContext: dataMocks.getTimeOffRequestContext,
    getTimeOffReviewContext: dataMocks.getTimeOffReviewContext,
    resolveCallOffCoverage: dataMocks.resolveCallOffCoverage,
    withdrawTimeOff: dataMocks.withdrawTimeOff,
  }
})

const callOffId = '10000000-0000-4000-8000-000000000001'
const shiftId = '20000000-0000-4000-8000-000000000001'
const absentEmployeeId = '30000000-0000-4000-8000-000000000001'
const replacementEmployeeId = '30000000-0000-4000-8000-000000000002'
const managerEmployeeId = '40000000-0000-4000-8000-000000000001'
const timeOffRequestId = '80000000-0000-4000-8000-000000000001'

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
    employeeId: managerEmployeeId,
    employeeTimeZone: 'America/Denver',
    role: 'supervisor' as const,
    permissions: { canManage: true },
    timeOffHistory: { managerHistoryLimit: 100, truncated: false },
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

function timeOffRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: timeOffRequestId,
    employee_id: absentEmployeeId,
    employee_number: 'SYG-1041',
    starts_on: '2026-10-12',
    ends_on: '2026-10-14',
    partial_day_start: null,
    partial_day_end: null,
    request_type: 'sick_time' as const,
    employment_type_snapshot: 'hourly' as const,
    pay_treatment: 'sick_policy' as const,
    requested_minutes: 960,
    return_on: '2026-10-15',
    affected_shift_count: 1,
    affected_shifts: [{
      shiftId,
      assignmentId: '90000000-0000-4000-8000-000000000001',
      workday: '2026-10-12',
      startsAt: '2026-10-12T14:00:00.000Z',
      endsAt: '2026-10-12T22:00:00.000Z',
      timeZone: 'America/Denver',
      siteCode: 'CENTRAL',
      siteName: 'Central Site',
      postName: 'Front Desk',
      eventName: null,
      location: 'Central Site',
      estimatedMinutes: 480,
    }],
    reason: 'Medical appointment and recovery time.',
    status: 'pending' as const,
    decision_note: null,
    decided_at: null,
    decided_by_name: null,
    updated_at: '2026-09-28T15:00:00.000Z',
    created_at: '2026-09-28T15:00:00.000Z',
    employee: { id: absentEmployeeId, first_name: 'Alex', last_name: 'Guard', preferred_name: null },
    ...overrides,
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

function renderPage(initialEntry = '/time-off?tab=call-offs') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[initialEntry]}><RequestsPage /></MemoryRouter></QueryClientProvider>)
}

describe('Requests absence coverage workflow', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    dataMocks.getRequestCenter.mockResolvedValue(requestCenter())
    dataMocks.getTimeOffRequestContext.mockResolvedValue({
      employee: {
        id: managerEmployeeId,
        employeeNumber: 'SYG-1000',
        name: 'Morgan Manager',
        employmentType: 'salary',
        timeZone: 'America/Denver',
        status: 'active',
      },
      allowedTypes: ['paid_vacation', 'sick_time', 'unpaid_time_off'],
      affectedShifts: [],
      requestedMinutes: 0,
      recentRequests: [],
    })
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
    dataMocks.withdrawTimeOff.mockResolvedValue(undefined)
  })

  it('keeps manager time-off work in a dedicated review and decision-history view', async () => {
    dataMocks.getRequestCenter.mockResolvedValue({
      ...requestCenter(),
      callOffs: [],
      timeOff: [
        timeOffRequest(),
        timeOffRequest({
          id: '80000000-0000-4000-8000-000000000002',
          employee_id: managerEmployeeId,
          employee_number: 'SYG-1000',
          employee: { id: managerEmployeeId, first_name: 'Morgan', last_name: 'Manager', preferred_name: null },
        }),
        timeOffRequest({
          id: '80000000-0000-4000-8000-000000000003',
          status: 'approved',
          decision_note: 'Coverage is confirmed.',
          decided_at: '2026-09-29T16:00:00.000Z',
          decided_by_name: 'Taylor Supervisor',
        }),
      ],
    })

    renderPage('/time-off?tab=time-off')

    expect(await screen.findByRole('heading', { name: 'Pending Time Off review' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Decision history' })).toBeVisible()
    expect(screen.getByRole('button', { name: /New time-off request/i })).toBeVisible()
    expect(screen.getAllByText('1 published shift')).toHaveLength(3)
    expect(screen.getByText(/Your request is waiting for a different authorized reviewer/)).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Review request' })).toHaveLength(1)
    expect(screen.getByText('Coverage is confirmed.')).toBeVisible()
    expect(screen.getByText(/Taylor Supervisor/)).toBeVisible()
  })

  it('opens a manager time-off review from the canonical deep link', async () => {
    dataMocks.getRequestCenter.mockResolvedValue({
      ...requestCenter(),
      callOffs: [],
      timeOff: [timeOffRequest()],
    })
    dataMocks.getTimeOffReviewContext.mockResolvedValue({
      id: timeOffRequestId,
      employee: { id: absentEmployeeId, employeeNumber: 'SYG-1041', name: 'Alex Guard' },
      requestType: 'sick_time',
      employmentType: 'hourly',
      payTreatment: 'sick_policy',
      startsOn: '2026-10-12',
      endsOn: '2026-10-14',
      partialStart: null,
      partialEnd: null,
      returnOn: '2026-10-15',
      requestedMinutes: 960,
      reason: 'Medical appointment and recovery time.',
      status: 'pending',
      createdAt: '2026-09-28T15:00:00.000Z',
      affectedShifts: timeOffRequest().affected_shifts,
      decisionNote: null,
      decisionSnapshot: null,
    })

    renderPage(`/time-off?tab=time-off&request=${timeOffRequestId}`)

    expect(await screen.findByRole('heading', { name: 'Review Time-Off Request' })).toBeVisible()
    expect(await screen.findByText('Alex Guard')).toBeVisible()
    expect(screen.getByText('Return 10/15/2026')).toBeVisible()
  })

  it('highlights a completed manager deep link without opening a stale decision form', async () => {
    const completedRequestId = '80000000-0000-4000-8000-000000000009'
    dataMocks.getTimeOffReviewContext.mockClear()
    dataMocks.getRequestCenter.mockResolvedValue({
      ...requestCenter(),
      callOffs: [],
      timeOff: [timeOffRequest({
        id: completedRequestId,
        status: 'approved',
        decision_note: 'Coverage is confirmed.',
      })],
    })

    const { container } = renderPage(`/time-off?tab=time-off&request=${completedRequestId}`)

    expect(await screen.findByText('Coverage is confirmed.')).toBeVisible()
    await waitFor(() => expect(container.querySelector(`#request-${completedRequestId}`)).toHaveClass('time-off-record--highlighted'))
    expect(screen.queryByRole('heading', { name: 'Review Time-Off Request' })).not.toBeInTheDocument()
    expect(dataMocks.getTimeOffReviewContext).not.toHaveBeenCalled()
  })

  it('highlights an employee deep link without treating it as a review action', async () => {
    dataMocks.getTimeOffReviewContext.mockClear()
    dataMocks.getRequestCenter.mockResolvedValue({
      ...requestCenter(),
      employeeId: absentEmployeeId,
      role: 'guard',
      permissions: { canManage: false },
      callOffs: [],
      timeOff: [timeOffRequest()],
    })

    const { container } = renderPage(`/time-off?tab=time-off&request=${timeOffRequestId}`)

    expect(await screen.findByText('Medical appointment and recovery time.')).toBeVisible()
    await waitFor(() => expect(container.querySelector(`#request-${timeOffRequestId}`)).toHaveClass('time-off-record--highlighted'))
    expect(screen.queryByRole('heading', { name: 'Review Time-Off Request' })).not.toBeInTheDocument()
    expect(dataMocks.getTimeOffReviewContext).not.toHaveBeenCalled()
  })

  it('confirms before an employee withdraws a pending request', async () => {
    dataMocks.getRequestCenter.mockResolvedValue({
      ...requestCenter(),
      employeeId: absentEmployeeId,
      role: 'guard',
      permissions: { canManage: false },
      callOffs: [],
      timeOff: [timeOffRequest()],
    })
    const user = userEvent.setup()
    renderPage('/time-off')

    await user.click(await screen.findByRole('button', { name: 'Withdraw request' }))
    const dialog = screen.getByRole('dialog', { name: 'Withdraw time-off request?' })
    expect(within(dialog).getByText('10/12/2026 – 10/14/2026')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw request' }))

    await waitFor(() => expect(dataMocks.withdrawTimeOff).toHaveBeenCalledWith(timeOffRequestId))
    expect(await screen.findByText(/was withdrawn and remains in your history/)).toBeVisible()
  })

  it('keeps raw withdrawal errors out of the Time Off workspace', async () => {
    dataMocks.getRequestCenter.mockResolvedValue({
      ...requestCenter(),
      employeeId: absentEmployeeId,
      role: 'guard',
      permissions: { canManage: false },
      callOffs: [],
      timeOff: [timeOffRequest()],
    })
    dataMocks.withdrawTimeOff.mockRejectedValueOnce(new Error('PostgREST 500: private.time_off_secret was unavailable'))
    const user = userEvent.setup()
    renderPage('/time-off')

    await user.click(await screen.findByRole('button', { name: 'Withdraw request' }))
    const dialog = screen.getByRole('dialog', { name: 'Withdraw time-off request?' })
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw request' }))

    expect(await within(dialog).findByText('The request could not be withdrawn. Refresh its status and try again.')).toBeVisible()
    expect(screen.queryByText(/private\.time_off_secret/i)).not.toBeInTheDocument()
  })

  it('uses the viewer employee zone when grouping requests at an Eastern and Denver date boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2099-10-12T04:30:00.000Z'))
    try {
      dataMocks.getRequestCenter.mockResolvedValue({
        ...requestCenter(),
        employeeId: absentEmployeeId,
        employeeTimeZone: 'America/New_York',
        role: 'guard',
        permissions: { canManage: false },
        callOffs: [],
        timeOff: [timeOffRequest({
          starts_on: '2099-10-11',
          ends_on: '2099-10-11',
          status: 'approved',
          reason: 'Eastern boundary request.',
        })],
      })

      renderPage('/time-off')

      const historySection = (await screen.findByRole('heading', { name: 'Past and closed requests' })).closest('section')
      const upcomingSection = screen.getByRole('heading', { name: 'Upcoming requests' }).closest('section')
      expect(historySection).not.toBeNull()
      expect(upcomingSection).not.toBeNull()
      expect(within(historySection!).getByText('Eastern boundary request.')).toBeVisible()
      expect(within(upcomingSection!).queryByText('Eastern boundary request.')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults new request dates to today in the viewer employee zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2099-10-12T04:30:00.000Z'))
    try {
      dataMocks.getRequestCenter.mockResolvedValue({
        ...requestCenter(),
        employeeTimeZone: 'America/New_York',
        callOffs: [],
      })
      dataMocks.getTimeOffRequestContext.mockResolvedValue({
        employee: {
          id: managerEmployeeId,
          employeeNumber: 'SYG-1000',
          name: 'Morgan Manager',
          employmentType: 'salary',
          timeZone: 'America/New_York',
          status: 'active',
        },
        allowedTypes: ['paid_vacation', 'sick_time', 'unpaid_time_off'],
        affectedShifts: [],
        requestedMinutes: 0,
        recentRequests: [],
      })
      const user = userEvent.setup()
      renderPage('/time-off')

      await user.click(await screen.findByRole('button', { name: /New time-off request/i }))
      const firstDay = await screen.findByLabelText('First day off')
      expect(firstDay).toHaveValue('2099-10-12')
      expect(firstDay).toHaveAttribute('min', '2099-10-12')
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the authoritative DST-aware requested minutes for a spring-forward partial day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-08T05:15:00.000Z'))
    try {
      dataMocks.getRequestCenter.mockResolvedValue({
        ...requestCenter(),
        employeeTimeZone: 'America/New_York',
        callOffs: [],
      })
      type Context = Awaited<ReturnType<typeof dataMocks.getTimeOffRequestContext>>
      let resolveExactPreview: ((context: Context) => void) | undefined
      const context = (requestedMinutes: number): Context => ({
        employee: {
          id: managerEmployeeId,
          employeeNumber: 'SYG-1000',
          name: 'Morgan Manager',
          employmentType: 'salary',
          timeZone: 'America/New_York',
          status: 'active',
        },
        allowedTypes: ['paid_vacation', 'sick_time', 'unpaid_time_off'],
        affectedShifts: [],
        requestedMinutes,
        recentRequests: [],
      })
      dataMocks.getTimeOffRequestContext.mockImplementation((
        _startsOn: string,
        _endsOn: string,
        partialStart: string | null,
        partialEnd: string | null,
      ) => {
        if (partialStart === '00:30' && partialEnd === '04:30') {
          return new Promise<Context>((resolve) => { resolveExactPreview = resolve })
        }
        return Promise.resolve(context(partialStart && partialEnd ? 240 : 0))
      })
      const user = userEvent.setup()
      renderPage('/time-off')

      await user.click(await screen.findByRole('button', { name: /New time-off request/i }))
      await user.click(await screen.findByRole('checkbox', { name: 'Part of one day' }))
      fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '00:30' } })
      fireEvent.change(screen.getByLabelText('End time'), { target: { value: '04:30' } })

      await waitFor(() => expect(dataMocks.getTimeOffRequestContext).toHaveBeenLastCalledWith(
        '2026-03-08',
        '2026-03-08',
        '00:30',
        '04:30',
      ))
      const submitButton = screen.getByRole('button', { name: 'Submit Time-Off Request' })
      expect(submitButton).toBeDisabled()
      resolveExactPreview?.(context(180))
      expect(await screen.findByText('3 hr')).toBeVisible()
      expect(screen.queryByText('4 hr')).not.toBeInTheDocument()
      await waitFor(() => expect(submitButton).toBeEnabled())
    } finally {
      vi.useRealTimers()
    }
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
