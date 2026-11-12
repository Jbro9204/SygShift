import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimeOffRequest, TimeOffPageCursor, TimeOffPageStatus, TimeOffPageBucket } from '../data/requests'
import { RequestsPage } from './RequestsPage'

const mocks = vi.hoisted(() => ({ page: vi.fn(), center: vi.fn(), session: vi.fn(), cancel: vi.fn(), end: vi.fn() }))
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({ getSessionContextWithSignal: mocks.session }))
vi.mock('../data/requests', async (original) => ({ ...await original<typeof import('../data/requests')>(),
  getTimeOffRequestPage: mocks.page, getRequestCenter: mocks.center, cancelApprovedTimeOff: mocks.cancel, endApprovedTimeOffNow: mocks.end }))
const viewer = '10000000-0000-4000-8000-000000000001'
const otherViewer = '10000000-0000-4000-8000-000000000002'
const employee = '20000000-0000-4000-8000-000000000001'
type Input = { employeeId: string; search?: string; status?: TimeOffPageStatus; bucket?: TimeOffPageBucket; limit?: number; cursor?: TimeOffPageCursor | null; requestId?: string | null }
function row(index: number): TimeOffRequest {
  return { id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`, employee_id: employee,
    employee_number: 'TEST-1', starts_on: '2099-12-01', ends_on: '2099-12-02', partial_day_start: null, partial_day_end: null,
    request_type: 'unpaid_time_off', employment_type_snapshot: 'hourly', pay_treatment: 'unpaid', requested_minutes: 480,
    return_on: '2099-12-03', affected_shift_count: 0, affected_shifts: [], reason: `Historical request ${index}`,
    status: 'approved', decision_note: 'Approved originally', decided_at: null, decided_by_name: null,
    updated_at: null, created_at: '2026-11-12T18:00:00.000001Z', employee: { id: employee, first_name: 'Test', last_name: 'Employee', preferred_name: null },
    cancellationContext: { phase: 'future', canCancel: true, canEndNow: false, blockReason: null,
      startsAt: '2099-12-01T07:00:00Z', endsAt: '2099-12-03T07:00:00Z', timeZone: 'America/Denver' } }
}
let records: TimeOffRequest[]
function result(input: Input) {
  const filtered = records.filter((item) => (!input.requestId || item.id === input.requestId)
    && (!input.search || item.reason?.toLowerCase().includes(input.search.toLowerCase())))
  const matches = filtered.filter((item) => (!input.status || input.status === 'all' || item.status === input.status)
    && (!input.bucket || input.bucket === 'all' || (input.bucket === 'pending' ? item.status === 'pending'
      : input.bucket === 'history' ? item.status !== 'pending' : input.bucket === 'upcoming' ? item.status === 'approved' : item.status !== 'approved')))
  const offset = input.cursor?.id ? Number(input.cursor.id.slice(-12)) : 0
  const limit = input.limit ?? 20
  const cursor: TimeOffPageCursor = input.cursor ?? { version: 1, scope: 'a'.repeat(64), asOf: '2026-11-12T20:00:00.123456Z', createdAt: null, id: null }
  const next = offset + limit < matches.length ? { ...cursor, createdAt: '2026-11-12T18:00:00.000001Z', id: `40000000-0000-4000-8000-${String(offset + limit).padStart(12, '0')}` } : null
  return { employeeId: input.employeeId, employeeTimeZone: 'America/Denver', permissions: { canManage: input.employeeId === viewer },
    items: matches.slice(offset, offset + limit),
    counts: { all: filtered.length, pending: filtered.filter((item) => item.status === 'pending').length,
      approved: filtered.filter((item) => item.status === 'approved').length, closed: 0, pastOrClosed: 0,
      declined: 0, withdrawn: 0, canceled: 0, endedEarly: 0, upcoming: filtered.length, history: filtered.length },
    page: { limit, total: matches.length, currentCursor: cursor, nextCursor: next, hasMore: Boolean(next), asOf: cursor.asOf },
    filters: { search: input.search ?? '', status: input.status ?? 'all', bucket: input.bucket ?? 'all', requestId: input.requestId ?? null } }
}
function renderPage(entry = '/time-off') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><RequestsPage /></MemoryRouter></QueryClientProvider>)
  return client
}
beforeEach(() => {
  records = Array.from({ length: 121 }, (_, index) => row(index + 1))
  mocks.page.mockReset().mockImplementation(async (input: Input) => result(input))
  mocks.session.mockReset().mockResolvedValue({ employeeId: viewer, accessGeneration: 1, timeZone: 'America/Denver', permissions: ['requests.manage'] })
  mocks.center.mockReset().mockRejectedValue(new Error('Legacy capped reader must not be used by Time Off'))
  mocks.cancel.mockReset().mockResolvedValue(undefined)
  mocks.end.mockReset().mockResolvedValue(undefined)
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})

describe('complete time-off history discovery', () => {
  it('shows server totals for 121 records and finds future approved leave beyond the old 100-row cap', async () => {
    const user = userEvent.setup()
    renderPage()
    const history = (await screen.findByRole('heading', { name: 'Decision history' })).closest('section')!
    await within(history).findByText('Historical request 1')
    expect(within(history).getAllByRole('article')).toHaveLength(20)
    expect(within(screen.getByRole('region', { name: 'Time-off request totals' })).getAllByText('121')).toHaveLength(2)
    for (let page = 2; page <= 7; page += 1) {
      await user.click(within(history).getByRole('button', { name: 'Older requests' }))
      await within(history).findByText(`Page ${page} · 121 matching requests`)
    }
    expect(within(history).getByText('Historical request 121')).toBeVisible()
    expect(within(history).getByRole('button', { name: 'Cancel approved time off' })).toBeEnabled()
    expect(mocks.center).not.toHaveBeenCalled()
  })

  it('searches the authorized server history, resets cursors and keeps input focus', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Historical request 1')
    const search = screen.getByRole('searchbox', { name: 'Search requests' })
    await user.type(search, 'request 121')
    await screen.findByText('Historical request 121')
    expect(search).toHaveFocus()
    const filteredCalls = mocks.page.mock.calls.map(([input]) => input).filter((input) => input.search === 'request 121')
    expect(filteredCalls).toHaveLength(2)
    expect(filteredCalls.every((input) => input.cursor === null)).toBe(true)
    expect(screen.queryByText('Historical request 1')).not.toBeInTheDocument()
  })

  it('reuses the first snapshot cursor when navigating back and starts a new snapshot only on refresh', async () => {
    const user = userEvent.setup()
    renderPage()
    const history = (await screen.findByRole('heading', { name: 'Decision history' })).closest('section')!
    await within(history).findByText('Historical request 1')
    await user.click(within(history).getByRole('button', { name: 'Older requests' }))
    await within(history).findByText('Historical request 21')
    await user.click(within(history).getByRole('button', { name: 'Newer requests' }))
    await within(history).findByText('Historical request 1')
    const historyCalls = mocks.page.mock.calls.map(([input]) => input).filter((input) => input.bucket === 'history')
    expect(historyCalls.at(-1).cursor).toMatchObject({ asOf: '2026-11-12T20:00:00.123456Z', createdAt: null, id: null })
    await user.click(screen.getByRole('button', { name: 'Refresh requests' }))
    await waitFor(() => expect(mocks.page.mock.calls.at(-1)?.[0].cursor).toBeNull())
  })

  it('shows read failure as unknown rather than empty or zero and keeps other request services untouched', async () => {
    mocks.page.mockRejectedValue(new Error('private.secret raw SQL'))
    renderPage()
    const errors = await screen.findAllByRole('alert')
    expect(errors).toHaveLength(2)
    expect(errors[0]).toHaveTextContent('saved requests have not changed')
    expect(screen.queryByText(/No completed requests|No pending time-off/)).not.toBeInTheDocument()
    expect(screen.queryByText(/private.secret/)).not.toBeInTheDocument()
    expect(mocks.center).not.toHaveBeenCalled()
  })

  it('loads an exact deep-linked record outside current pages without granting broad history', async () => {
    renderPage(`/time-off?request=${row(121).id}`)
    const selected = await screen.findByRole('region', { name: 'Selected time-off request' })
    expect(within(selected).getByText('Historical request 121')).toBeVisible()
    expect(mocks.page).toHaveBeenCalledWith(expect.objectContaining({ employeeId: viewer, requestId: row(121).id, limit: 1 }))
  })

  it('retains a selected cancellation and its typed reason when background pages refresh', async () => {
    const user = userEvent.setup()
    const client = renderPage()
    await screen.findByText('Historical request 1')
    await user.click(screen.getAllByRole('button', { name: 'Cancel approved time off' })[0])
    const dialog = screen.getByRole('dialog', { name: 'Cancel approved time off?' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Cancellation reason' }), 'No longer needed')
    records = records.slice(20)
    await act(async () => { await client.invalidateQueries({ queryKey: ['time-off-request-page'] }) })
    expect(dialog).toBeVisible()
    expect(within(dialog).getByRole('textbox', { name: 'Cancellation reason' })).toHaveValue('No longer needed')
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('ignores late search responses instead of replacing current matching rows', async () => {
    let settleOld: ((value: ReturnType<typeof result>) => void) | undefined
    mocks.page.mockImplementation((input: Input) => input.search === 'request 12'
      ? new Promise((resolve) => { if (input.bucket === 'history') settleOld = resolve; else resolve(result(input)) })
      : Promise.resolve(result(input)))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Historical request 1')
    const search = screen.getByRole('searchbox', { name: 'Search requests' })
    await user.type(search, 'request 12')
    await waitFor(() => expect(settleOld).toBeDefined())
    await user.type(search, '1')
    await screen.findByText('Historical request 121')
    await act(async () => settleOld?.(result({ employeeId: viewer, search: 'request 12', bucket: 'history' })))
    expect(screen.getByText('Historical request 121')).toBeVisible()
    expect(screen.queryByText('Historical request 12')).not.toBeInTheDocument()
  })

  it('switches account scope and removes the previous account selection immediately', async () => {
    const user = userEvent.setup()
    const client = renderPage()
    await screen.findByText('Historical request 1')
    await user.click(screen.getAllByRole('button', { name: 'Cancel approved time off' })[0])
    records = [{ ...row(999), employee_id: otherViewer, reason: 'New account only' }]
    await act(async () => client.setQueryData(['session-context'], { employeeId: otherViewer, accessGeneration: 2, timeZone: 'America/Denver', permissions: [] }))
    await screen.findByText('New account only')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Historical request 1')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel approved time off' })).not.toBeInTheDocument()
  })

  it('shows malformed historical context as HR review, preserves the record and disables leave changes', async () => {
    records = [{ ...row(1), cancellationContextUnavailable: true, cancellationContextIssue: 'private.raw.error is not display copy' }]
    renderPage()
    expect(await screen.findByText('Historical request 1')).toBeVisible()
    expect(screen.getByRole('note')).toHaveTextContent('Ask HR to review it before making changes.')
    expect(screen.queryByText('private.raw.error is not display copy')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel approved time off' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'End leave now' })).not.toBeInTheDocument()
  })
})
