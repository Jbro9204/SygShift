import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SchedulePage } from './SchedulePage'
import type { ScheduleShift, WeeklySchedule } from '../data/schedule'
import type { SessionContext } from '../data/auth'

const mocks = vi.hoisted(() => {
  const channel: Record<string, ReturnType<typeof vi.fn>> = {}
  channel.on = vi.fn(() => channel)
  channel.subscribe = vi.fn(() => channel)
  return { channel, getWeeklySchedule: vi.fn(), createBatch: vi.fn(), updateShift: vi.fn(), actorId: '11111111-1111-4111-8111-111111111111' }
})
const site = { id: '33333333-3333-4333-8333-333333333333', code: 'DST-TEST', name: 'DST Test Site', time_zone: 'America/New_York' as const, supports_dispatch_phone_duty: false, supports_ep_truep_payroll: false }
const post = { id: '44444444-4444-4444-8444-444444444444', name: 'Test post', requires_armed: false, site }

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabaseClient: () => ({ channel: () => mocks.channel, removeChannel: vi.fn() }),
}))
vi.mock('../data/auth', async (original) => ({
  ...await original<typeof import('../data/auth')>(),
  getSessionContext: async () => ({ employeeId: mocks.actorId, displayName: 'Test Scheduler', username: 'dst-scheduler', role: 'admin', timeZone: 'America/New_York', hasMfa: true, mfaRequired: true, mustChangePassword: false, permissions: ['scheduler.view', 'scheduler.manage', 'schedule.view'] }),
}))
vi.mock('../data/maintenance', () => ({ getMaintenanceStatus: async () => ({ active: [], upcoming: [], recentlyCompleted: [], serverTime: '2026-10-31T16:00:00.000Z' }) }))
vi.mock('../data/availability', () => ({ getAvailabilityWorkspace: async () => ({ availability: [] }) }))
vi.mock('../data/schedule', async (original) => ({
  ...await original<typeof import('../data/schedule')>(),
  getWeeklySchedule: mocks.getWeeklySchedule,
  getScheduleBuilderOptions: async () => ({ employees: [], posts: [post] }),
  getScheduleStaffingSuggestions: async () => [],
  createSupervisorCoveragePlanBatch: mocks.createBatch,
  updateScheduleDraftShift: mocks.updateShift,
}))

function shift(startsAt = '2026-11-01T06:30:00.000Z'): ScheduleShift {
  return { id: '55555555-5555-4555-8555-555555555555', starts_at: startsAt, ends_at: '2026-11-01T08:00:00.000Z', time_zone: 'America/New_York', time_zone_source: 'site', headcount_required: 1, requires_armed: false, is_open: true, is_overtime: false, payrollCategory: 'regular', notes: null, post, event: null, assignments: [], versionToken: 'version-one' }
}
function schedule(shifts: ScheduleShift[] = []): WeeklySchedule {
  return { id: '22222222-2222-4222-8222-222222222222', week_starts_on: '2026-11-01', revision: 1, status: 'draft', published_at: null, shifts }
}
function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return { ...render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/scheduler?week=2026-11-01']}><SchedulePage mode="scheduler" /></MemoryRouter></QueryClientProvider>), queryClient }
}
async function openCreate() {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Add shift or event' }))
  const dialog = screen.getByRole('dialog', { name: 'Add a shift or event' })
  fireEvent.change(within(dialog).getByLabelText('Site and post'), { target: { value: post.id } })
  fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '01:30' } })
  fireEvent.change(within(dialog).getByLabelText('End time'), { target: { value: '03:00' } })
  return dialog
}

describe('Schedule repeated-hour save safeguards', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-31T16:00:00.000Z'))
    vi.stubGlobal('ResizeObserver', class { disconnect() {} observe() {} unobserve() {} })
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
  })
  afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  beforeEach(() => {
    window.sessionStorage.clear()
    mocks.actorId = '11111111-1111-4111-8111-111111111111'
    mocks.getWeeklySchedule.mockReset().mockResolvedValue(schedule())
    mocks.createBatch.mockReset().mockResolvedValue([{ schedule_id: schedule().id, schedule_revision: 1, shift_ids: [shift().id], starts_at: shift().starts_at, ends_at: shift().ends_at }])
    mocks.updateShift.mockReset().mockImplementation(async () => schedule([shift()]))
  })

  it('blocks an unconfirmed create even when a form submit is dispatched directly, then sends the existing time-only contract after confirmation', async () => {
    const dialog = await openCreate()
    const save = within(dialog).getByRole('button', { name: 'Save open draft shift' })
    expect(save).toBeDisabled()
    fireEvent.submit(save.closest('form')!)
    expect(await within(dialog).findByText(/Confirm the second \(standard-time\) occurrence/)).toBeInTheDocument()
    expect(mocks.createBatch).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Use the second (standard-time) occurrence shown above.' }))
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    await waitFor(() => expect(mocks.createBatch).toHaveBeenCalledOnce())
    expect(mocks.createBatch.mock.calls[0][0]).toMatchObject({ shiftDates: ['2026-11-01'], startTime: '01:30', endTime: '03:00', expectedTimeZone: 'America/New_York' })
    expect(mocks.createBatch.mock.calls[0][0]).not.toHaveProperty('startsAt')
  })

  it('clears confirmation after a time change, even if the user returns to the previously confirmed input', async () => {
    const dialog = await openCreate()
    const confirm = within(dialog).getByRole('checkbox', { name: 'Use the second (standard-time) occurrence shown above.' })
    fireEvent.click(confirm)
    expect(confirm).toBeChecked()
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '01:45' } })
    await waitFor(() => expect(confirm).not.toBeChecked())
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '01:30' } })
    expect(confirm).not.toBeChecked()
    expect(within(dialog).getByRole('button', { name: 'Save open draft shift' })).toBeDisabled()
    expect(mocks.createBatch).not.toHaveBeenCalled()
  })

  it('keeps an existing second-fold range unchanged when only notes are edited', async () => {
    mocks.getWeeklySchedule.mockResolvedValue(schedule([shift()]))
    mount()
    fireEvent.click(await screen.findByTitle('Edit this schedule block'))
    const dialog = await screen.findByRole('dialog', { name: 'Edit DST Test Site' })
    expect(within(dialog).queryByRole('checkbox', { name: 'Use the second (standard-time) occurrence shown above.' })).not.toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Notes'), { target: { value: 'Test-only note' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft shift' }))
    await waitFor(() => expect(mocks.updateShift).toHaveBeenCalledOnce())
    expect(mocks.updateShift.mock.calls[0][0]).toMatchObject({ shiftDate: '2026-11-01', startTime: '01:30', endTime: '03:00', notes: 'Test-only note', expectedVersionToken: 'version-one' })
  })

  it('requires fresh confirmation when multiple-day coverage changes and submits all confirmed dates atomically', async () => {
    const dialog = await openCreate()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Use the second (standard-time) occurrence shown above.' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Add this same shift to multiple days this week' }))
    fireEvent.change(within(dialog).getByLabelText('Through date'), { target: { value: '2026-11-02' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Mon' }))
    const confirm = within(dialog).getByRole('checkbox', { name: 'Use the second (standard-time) occurrence shown above.' })
    await waitFor(() => expect(confirm).not.toBeChecked())
    const save = within(dialog).getByRole('button', { name: 'Save 2 open draft shifts' })
    expect(save).toBeDisabled()
    fireEvent.submit(save.closest('form')!)
    expect(await within(dialog).findByText(/Confirm the second \(standard-time\) occurrence/)).toBeInTheDocument()
    expect(mocks.createBatch).not.toHaveBeenCalled()
    fireEvent.click(confirm)
    fireEvent.click(save)
    await waitFor(() => expect(mocks.createBatch).toHaveBeenCalledOnce())
    expect(mocks.createBatch.mock.calls[0][0].shiftDates).toEqual(['2026-11-01', '2026-11-02'])
  })

  it('explains DST wall-clock copy semantics without claiming to preview authoritative destination occurrences', async () => {
    mount()
    const copy = await screen.findByRole('button', { name: 'Copy week' })
    await waitFor(() => expect(copy).toBeEnabled())
    fireEvent.click(copy)
    const dialog = await screen.findByRole('dialog', { name: 'Copy week' })
    expect(within(dialog).getByText(/Repeated clock times resolve to the second \(standard-time\) occurrence/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Review the destination draft’s dates, offsets, and elapsed hours before publishing/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Copy into draft' })).toBeDisabled()
  })

  it('does not submit an existing first-fold shift through an interface that would reinterpret it', async () => {
    mocks.getWeeklySchedule.mockResolvedValue(schedule([shift('2026-11-01T05:30:00.000Z')]))
    mount()
    fireEvent.click(await screen.findByTitle('Edit this schedule block'))
    const dialog = await screen.findByRole('dialog', { name: 'Edit DST Test Site' })
    expect(within(dialog).getByText(/saved shift uses the first occurrence/)).toBeInTheDocument()
    const save = within(dialog).getByRole('button', { name: 'Save draft shift' })
    expect(save).toBeDisabled()
    fireEvent.submit(save.closest('form')!)
    expect(mocks.updateShift).not.toHaveBeenCalled()
  })

  it('does not reuse another signed-in actor’s repeated-hour edit confirmation', async () => {
    mocks.getWeeklySchedule.mockResolvedValue(schedule([shift()]))
    const { queryClient } = mount()
    fireEvent.click(await screen.findByTitle('Edit this schedule block'))
    let dialog = await screen.findByRole('dialog', { name: 'Edit DST Test Site' })
    fireEvent.change(within(dialog).getByLabelText('Start'), { target: { value: '01:45' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Use the second (standard-time) occurrence shown above.' }))
    expect(within(dialog).getByRole('checkbox', { name: 'Use the second (standard-time) occurrence shown above.' })).toBeChecked()
    const previousSession = queryClient.getQueryData<SessionContext>(['session-context'])!
    mocks.actorId = '66666666-6666-4666-8666-666666666666'
    act(() => queryClient.setQueryData(['session-context'], { ...previousSession, employeeId: mocks.actorId }))
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Edit DST Test Site' })).getByLabelText('Start')).toHaveValue('01:30'))
    dialog = screen.getByRole('dialog', { name: 'Edit DST Test Site' })
    fireEvent.change(within(dialog).getByLabelText('Start'), { target: { value: '01:45' } })
    expect(within(dialog).getByRole('checkbox', { name: 'Use the second (standard-time) occurrence shown above.' })).not.toBeChecked()
    expect(within(dialog).getByRole('button', { name: 'Save draft shift' })).toBeDisabled()
    expect(mocks.updateShift).not.toHaveBeenCalled()
  })
})
