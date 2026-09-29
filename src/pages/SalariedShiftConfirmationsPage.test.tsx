import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { SalariedShiftConfirmationsPage } from './SalariedShiftConfirmationsPage'

const mocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  record: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/salariedShiftTracking', async (original) => ({
  ...await original<typeof import('../data/salariedShiftTracking')>(),
  getSalariedShiftWorkspace: mocks.getWorkspace,
  recordSalariedShiftOutcome: mocks.record,
}))

const employee = {
  id: '10000000-0000-4000-8000-000000000001',
  employeeNumber: 'SYG-1001',
  displayName: 'Salary Employee',
  timeZone: 'America/New_York',
}
const baseAssignment = {
  shiftId: '30000000-0000-4000-8000-000000000001',
  employee,
  startsAt: '2026-09-28T13:00:00.000Z',
  endsAt: '2026-09-28T21:00:00.000Z',
  shiftTimeZone: 'America/New_York',
  employeeTimeZone: 'America/New_York',
  workday: '2026-09-28',
  scheduleStatus: 'published' as const,
  assignmentStatus: 'confirmed' as const,
  assignmentType: 'standard' as const,
  siteCode: 'EAST',
  siteName: 'East Campus',
  postName: 'Main Desk',
  eventName: null,
  location: 'East Campus / Main Desk',
  recordedNote: null,
  recordedBy: null,
  updatedAt: null,
  history: [],
}
const readyAssignment = {
  ...baseAssignment,
  assignmentId: '20000000-0000-4000-8000-000000000001',
  presenceStatus: 'unconfirmed' as const,
  workedAt: null,
  canMarkWorked: true,
  canVoid: false,
  blockingReason: null,
}
const scheduledAssignment = {
  ...baseAssignment,
  assignmentId: '20000000-0000-4000-8000-000000000002',
  shiftId: '30000000-0000-4000-8000-000000000002',
  startsAt: '2026-10-02T13:00:00.000Z',
  endsAt: '2026-10-02T21:00:00.000Z',
  workday: '2026-10-02',
  presenceStatus: 'unconfirmed' as const,
  workedAt: null,
  canMarkWorked: false,
  canVoid: false,
  blockingReason: 'shift_not_ended' as const,
}
const workedAssignment = {
  ...baseAssignment,
  assignmentId: '20000000-0000-4000-8000-000000000003',
  shiftId: '30000000-0000-4000-8000-000000000003',
  startsAt: '2026-09-27T13:00:00.000Z',
  endsAt: '2026-09-27T21:00:00.000Z',
  workday: '2026-09-27',
  presenceStatus: 'worked' as const,
  workedAt: '2026-09-28T14:00:00.000Z',
  recordedNote: 'Manager confirmed the whole shift.',
  recordedBy: { id: '40000000-0000-4000-8000-000000000001', displayName: 'Schedule Manager' },
  canMarkWorked: false,
  canVoid: true,
  blockingReason: 'already_worked' as const,
  history: [{
    id: '50000000-0000-4000-8000-000000000001',
    action: 'worked' as const,
    note: 'Manager confirmed the whole shift.',
    actor: { id: '40000000-0000-4000-8000-000000000001', displayName: 'Schedule Manager' },
    recordedAt: '2026-09-28T14:00:00.000Z',
  }],
}
const workspace = {
  generatedAt: '2026-09-29T12:00:00.000Z',
  range: { startsOn: '2026-08-30', endsOn: '2026-09-29' },
  viewer: { employeeId: '40000000-0000-4000-8000-000000000001', timeZone: 'America/Denver', employmentType: 'hourly' as const, canManage: true },
  filters: { employeeId: null },
  summary: { total: 2, worked: 1, unconfirmed: 1 },
  employees: [employee],
  assignments: [readyAssignment, scheduledAssignment, workedAssignment],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><SalariedShiftConfirmationsPage /></MemoryRouter></QueryClientProvider>)
}

describe('Salaried Shift Confirmation workspace', () => {
  beforeAll(() => {
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
      HTMLDialogElement.prototype.close = function close() { this.open = false }
    }
  })

  beforeEach(() => {
    mocks.getWorkspace.mockReset().mockResolvedValue(workspace)
    mocks.record.mockReset().mockResolvedValue({
      assignmentId: readyAssignment.assignmentId,
      presenceStatus: 'worked',
      workedAt: '2026-09-29T13:00:00.000Z',
      updatedAt: '2026-09-29T13:00:00.000Z',
      action: 'recorded',
    })
  })

  it('shows clear loading and empty states without exposing timekeeping controls', async () => {
    mocks.getWorkspace.mockImplementationOnce(() => new Promise(() => undefined))
    const loadingView = renderPage()
    expect(screen.getByText('Loading shift confirmations')).toBeInTheDocument()
    loadingView.unmount()

    mocks.getWorkspace.mockResolvedValueOnce({
      ...workspace,
      assignments: [],
      employees: [],
      summary: { total: 0, worked: 0, unconfirmed: 0 },
    })
    renderPage()
    expect(await screen.findByText('No ended salaried shifts are waiting to be marked Worked.')).toBeInTheDocument()
    expect(screen.getByText('No upcoming salaried shifts match these filters.')).toBeInTheDocument()
    expect(screen.getByText('No Worked shifts match these filters.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /clock/i })).not.toBeInTheDocument()
  })

  it('shows only whole-shift Worked tracking and keeps future shifts neutral', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Salaried Shift Confirmation' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/')
    expect(screen.getAllByText(/Eastern Time/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Scheduled').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Mark Worked' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /did not work/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /exception/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /clock/i })).not.toBeInTheDocument()

    const readyMetric = screen.getByText('Ready to Mark').closest<HTMLElement>('.time-metric')
    expect(readyMetric).not.toBeNull()
    expect(within(readyMetric!).getByText('1')).toBeInTheDocument()
  })

  it('marks one eligible scheduled shift Worked and immediately refreshes the workspace', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Worked' }))
    expect(screen.getByRole('dialog', { name: 'Mark salaried shift Worked?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Worked' }))

    await waitFor(() => expect(mocks.record).toHaveBeenCalledWith({
      assignmentId: readyAssignment.assignmentId,
      note: null,
      presenceStatus: 'worked',
      requestId: expect.any(String),
    }))
    const success = await screen.findByText('Shift confirmation saved')
    expect(success.closest('section')).toHaveTextContent('The shift is marked Worked.')
    expect(mocks.getWorkspace).toHaveBeenCalledTimes(2)
  })

  it('prevents duplicate submission while a Worked marker is saving', async () => {
    let resolveRecord!: (value: Awaited<ReturnType<typeof mocks.record>>) => void
    mocks.record.mockReturnValueOnce(new Promise((resolve) => { resolveRecord = resolve }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Worked' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Worked' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Marking shift Worked...')
    expect(screen.getByRole('button', { name: 'Confirm Worked' })).toBeDisabled()

    resolveRecord({
      assignmentId: readyAssignment.assignmentId,
      presenceStatus: 'worked',
      workedAt: '2026-09-29T13:00:00.000Z',
      updatedAt: '2026-09-29T13:00:00.000Z',
      action: 'recorded',
    })
    expect(await screen.findByText('Shift confirmation saved')).toBeInTheDocument()
  })

  it('reuses the same request identifier when a lost response is manually retried', async () => {
    mocks.record
      .mockRejectedValueOnce(new Error('The shift confirmation could not be saved. Refresh the record and try again.'))
      .mockResolvedValueOnce({
        assignmentId: readyAssignment.assignmentId,
        presenceStatus: 'worked',
        workedAt: '2026-09-29T13:00:00.000Z',
        updatedAt: '2026-09-29T13:00:00.000Z',
        action: 'unchanged',
      })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Worked' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Worked' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The shift confirmation could not be saved.')

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Worked' }))
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(2))

    const firstRequestId = mocks.record.mock.calls[0]?.[0]?.requestId
    const retriedRequestId = mocks.record.mock.calls[1]?.[0]?.requestId
    expect(firstRequestId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(retriedRequestId).toBe(firstRequestId)
    expect(await screen.findByText('Shift confirmation saved')).toBeInTheDocument()
  })

  it('requires an audited reason to remove a Worked marker and clears an error when reopened', async () => {
    mocks.record.mockRejectedValueOnce(new Error('The shift confirmation could not be saved. Refresh the record and try again.'))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Worked marker' }))
    const submit = screen.getByRole('button', { name: 'Remove marker' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Recorded for the wrong assignment.' } })
    fireEvent.click(submit)
    expect(await screen.findByRole('alert')).toHaveTextContent('The shift confirmation could not be saved.')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Worked marker' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
