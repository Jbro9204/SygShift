import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TimeMaintenanceWorkbench } from './TimePage'

const mocks = vi.hoisted(() => ({
  record: vi.fn(), correct: vi.fn(),
  events: [] as Array<Record<string, unknown>>,
  startsAt: '2026-11-01T07:30:12.345Z',
}))
const employeeId = '11111111-1111-4111-8111-111111111111'
const shiftId = '22222222-2222-4222-8222-222222222222'
const eventId = '33333333-3333-4333-8333-333333333333'
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({ getSessionContext: async () => ({ employeeId, role: 'admin', permissions: ['time.maintenance', 'time.correct'], hasMfa: true }) }))
vi.mock('../data/timekeeping', async (original) => ({
  ...await original<typeof import('../data/timekeeping')>(),
  getTeamAttendanceSummary: async () => ({ rows: [] }),
  getLiveTimeRoster: async () => ({ rows: [] }),
  getTimekeepingReview: async () => ({ rows: [], pendingCorrections: [], fromDate: '2026-11-01', throughDate: '2026-11-07' }),
  getTimeMaintenance: async () => ({ fromDate: '2026-11-01', throughDate: '2026-11-07', operationalTimeZone: 'America/Denver', serverTimestamp: '2026-11-02T16:00:00.000Z', employees: [{ id: employeeId, displayName: 'DST Test Guard', username: 'dst-guard', role: 'guard', employmentType: 'hourly', status: 'active' }], events: mocks.events }),
  getTimeMaintenanceLocationOptions: async () => [],
  getTimeMaintenanceShiftOptions: async () => [{ shiftId, operationalDate: '2026-11-01', startsAt: mocks.startsAt, endsAt: '2026-11-01T13:00:00.000Z', timeZone: 'America/New_York', requiresArmed: false, isOvertime: false, headcountRequired: 1, scheduleStatus: 'published', scheduleRevision: 1, siteName: 'DST Test Site', siteCode: 'DST', postName: 'Test post', eventName: null, locationName: 'DST Test Site', assignedEmployees: [], selectedEmployeeAssigned: true, workType: 'post' }],
  supervisorRecordTimeEvent: mocks.record,
  supervisorCorrectTimeEvent: mocks.correct,
}))

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter><TimeMaintenanceWorkbench defaultDate="2026-11-01" defaultPeriod={{ fromDate: '2026-11-01', throughDate: '2026-11-07' }} focusRequest={null} initialEmployeeId={employeeId} lockEmployeeFilter /></MemoryRouter></QueryClientProvider>)
}
async function chooseShift() {
  mount()
  const site = await screen.findByLabelText(/^Site\/Post/)
  await waitFor(() => expect(site).toBeEnabled())
  fireEvent.change(site, { target: { value: shiftId } })
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Verified synthetic DST punch.' } })
  return screen.getByRole('button', { name: 'Add time event' })
}
function existingEvent(instant: string) {
  return { id: eventId, employeeId, username: 'dst-guard', employeeName: 'DST Test Guard', role: 'guard', employmentType: 'hourly', shiftId, occurrenceKey: shiftId, assignmentAnchor: instant, operationalDate: '2026-11-01', kind: 'clock_in', recordedAt: instant, effectiveAt: instant, clientRecordedAt: null, source: 'web', createdBy: null, createdByName: null, voided: false, pendingCorrectionCount: 0, maintenanceNoteCount: 0, latestNote: null, latestAction: null, siteName: 'DST Test Site', siteCode: 'DST', postName: 'Test post', eventName: null, locationName: 'DST Test Site', timeZone: 'America/New_York', workType: 'post', payrollCategory: 'regular', payrollCategoryLabel: 'Regular' }
}

describe('Time Maintenance DST entry and correction', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    mocks.events = []
    mocks.startsAt = '2026-11-01T07:30:12.345Z'
    mocks.record.mockReset().mockResolvedValue({ id: eventId, kind: 'clock_in' })
    mocks.correct.mockReset().mockResolvedValue({})
  })

  it('retains a selected cross-zone shift’s exact first-fold instant and seconds in the Mountain form', async () => {
    const save = await chooseShift()
    expect(screen.getByLabelText('Punch date')).toHaveValue('2026-11-01')
    expect(screen.getByLabelText('Time / Mountain')).toHaveValue('01:30')
    expect(screen.getByLabelText('Punch time clock occurrence')).toHaveValue('2026-11-01T07:30:00.000Z')
    fireEvent.click(save)
    await waitFor(() => expect(mocks.record).toHaveBeenCalledOnce())
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ employeeId, shiftId, effectiveAt: '2026-11-01T07:30:12.345Z' })
  })

  it('clears the suggested instant after manual edits, requires a fresh occurrence, and supports the second fold', async () => {
    const save = await chooseShift()
    fireEvent.change(screen.getByLabelText('Time / Mountain'), { target: { value: '01:45' } })
    expect(screen.getByLabelText('Punch time clock occurrence')).toHaveValue('')
    fireEvent.submit(save.closest('form')!)
    expect(await screen.findByRole('alert')).toHaveTextContent('occurs twice')
    expect(mocks.record).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Punch time clock occurrence'), { target: { value: '2026-11-01T08:45:00.000Z' } })
    fireEvent.click(save)
    await waitFor(() => expect(mocks.record).toHaveBeenCalledOnce())
    expect(mocks.record.mock.calls[0][0].effectiveAt).toBe('2026-11-01T08:45:00.000Z')
  })

  it('does not normalize a spring gap or submit a second event while a save is pending', async () => {
    const save = await chooseShift()
    fireEvent.change(screen.getByLabelText('Punch date'), { target: { value: '2026-03-08' } })
    fireEvent.change(screen.getByLabelText('Time / Mountain'), { target: { value: '02:30' } })
    fireEvent.submit(save.closest('form')!)
    expect(await screen.findByRole('alert')).toHaveTextContent('does not exist')
    expect(mocks.record).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Punch date'), { target: { value: '2026-11-01' } })
    fireEvent.change(screen.getByLabelText('Time / Mountain'), { target: { value: '03:30' } })
    let finish!: (value: { id: string, kind: string }) => void
    mocks.record.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(save)
    await waitFor(() => expect(screen.getByLabelText('Time / Mountain')).toBeDisabled())
    expect(screen.getByLabelText('Punch date')).toBeDisabled()
    fireEvent.submit(save.closest('form')!)
    expect(mocks.record).toHaveBeenCalledOnce()
    await act(async () => finish({ id: eventId, kind: 'clock_in' }))
  })

  it('preserves an unchanged existing first-fold correction including sub-minute evidence', async () => {
    mocks.events = [existingEvent('2026-11-01T07:30:12.345Z')]
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Correct punch' }))
    const dialog = await screen.findByRole('dialog', { name: 'Correct punch' })
    expect(within(dialog).getByLabelText('New time / Mountain')).toHaveValue('01:30')
    expect(within(dialog).getByLabelText('Corrected punch clock occurrence')).toHaveValue('2026-11-01T07:30:00.000Z')
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Retain verified exact DST occurrence.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save corrected punch' }))
    await waitFor(() => expect(mocks.correct).toHaveBeenCalledOnce())
    expect(mocks.correct.mock.calls[0][0]).toMatchObject({ timeEventId: eventId, replacementTime: '2026-11-01T07:30:12.345Z', voided: false })
  })

  it('renders and preserves local midnight as 00:00, not an invalid 24:00 input', async () => {
    mocks.startsAt = '2026-11-01T06:00:12.345Z'
    const save = await chooseShift()
    expect(screen.getByLabelText('Time / Mountain')).toHaveValue('00:00')
    fireEvent.click(save)
    await waitFor(() => expect(mocks.record).toHaveBeenCalledOnce())
    expect(mocks.record.mock.calls[0][0].effectiveAt).toBe('2026-11-01T06:00:12.345Z')
  })
})
