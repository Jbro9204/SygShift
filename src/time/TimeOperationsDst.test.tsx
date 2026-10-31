import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimeOperationsWorkspace } from '../data/timeOperations'
import { TimeOperationsPage } from './TimeOperationsPage'

const employeeId = 'd1000000-0000-4000-8000-000000000001'
const postId = 'd2000000-0000-4000-8000-000000000001'
const shiftId = 'd3000000-0000-4000-8000-000000000001'
const state = vi.hoisted(() => ({
  workspace: {} as TimeOperationsWorkspace,
  create: vi.fn(), edit: vi.fn(), adjustment: vi.fn(), callOff: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({ getSessionContext: async () => ({ employeeId: 'd1000000-0000-4000-8000-000000000001' }) }))
vi.mock('../pages/RequestsPage', () => ({ CoverageWorkflowDialog: () => null }))
vi.mock('../data/timekeeping', async (original) => ({
  ...await original<typeof import('../data/timekeeping')>(),
  getPendingTimeEventCorrections: async () => [],
}))
vi.mock('../data/timeOperations', async (original) => ({
  ...await original<typeof import('../data/timeOperations')>(),
  getMissingTimeRequestWorkspace: async () => ({ requests: [] }),
  getTimekeepingOperationsWorkspace: async () => state.workspace,
  createManualTimeEntry: state.create,
  editManualTimeEntry: state.edit,
  submitTimeAdjustmentRequest: state.adjustment,
  reportEmployeeCallOff: state.callOff,
}))

function renderPage(onMutate?: () => Promise<void>) {
  render(<QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
    mutationCache: onMutate ? new MutationCache({ onMutate }) : undefined,
  })}>
    <MemoryRouter><TimeOperationsPage /></MemoryRouter>
  </QueryClientProvider>)
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
  state.create.mockReset().mockResolvedValue({ id: 'new-entry' })
  state.edit.mockReset().mockResolvedValue({ id: 'edited-entry' })
  state.adjustment.mockReset().mockResolvedValue({ id: 'request' })
  state.callOff.mockReset().mockResolvedValue({ id: 'call-off' })
  state.workspace = {
    adjustmentRequestActions: [], adjustmentRequests: [], alerts: [], callOffReports: [],
    canCreateManualEntry: true, canEditManualEntry: true, canReportCallOff: true,
    canResolveExceptions: false, canReviewAdjustments: true, canViewOperations: true,
    employees: [{ id: employeeId, name: 'DST Test Guard', username: 'dst-test', employmentType: 'hourly' }],
    exceptions: [], manualEntries: [],
    posts: [{ id: postId, siteId: postId, postName: 'Test post', siteName: 'DST Test Site', siteCode: 'DST', timeZone: 'America/Denver' }],
    serverTimestamp: '2026-11-01T08:30:47.125Z',
    shifts: [{ shiftId, employeeId, startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-01T13:00:00.000Z', timeZone: 'America/Denver', location: 'DST Test Site', postId }],
  }
})

describe('Time Operations manual DST boundaries', () => {
  it('requires the selected occurrence before adding manual time and sends that exact instant', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Add manual time' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('Employee'), { target: { value: employeeId } })
    fireEvent.change(dialog.getByLabelText(/^Site \/ post/), { target: { value: postId } })
    fireEvent.change(dialog.getByLabelText('Work date'), { target: { value: '2026-11-01' } })
    fireEvent.change(dialog.getByLabelText('Clock-in', { exact: true }), { target: { value: '2026-11-01T01:30' } })
    fireEvent.change(dialog.getByLabelText('Clock-out', { exact: true }), { target: { value: '2026-11-01T03:30' } })
    fireEvent.change(dialog.getByLabelText('Entry reason'), { target: { value: 'Controlled DST regression.' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save manual entry' }))
    expect(state.create).not.toHaveBeenCalled()
    fireEvent.change(dialog.getByRole('combobox', { name: 'Clock-in clock occurrence' }), { target: { value: '2026-11-01T08:30:00.000Z' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save manual entry' }))
    await waitFor(() => expect(state.create).toHaveBeenCalledWith(expect.objectContaining({
      clockInAt: '2026-11-01T08:30:00.000Z', clockOutAt: '2026-11-01T10:30:00.000Z',
    })))
  })

  it('keeps a spring-gap manual entry in its modal without sending a mutation', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Add manual time' }))
    const element = await screen.findByRole('dialog')
    const dialog = within(element)
    fireEvent.change(dialog.getByLabelText('Employee'), { target: { value: employeeId } })
    fireEvent.change(dialog.getByLabelText(/^Site \/ post/), { target: { value: postId } })
    fireEvent.change(dialog.getByLabelText('Clock-in', { exact: true }), { target: { value: '2026-03-08T02:30' } })
    fireEvent.change(dialog.getByLabelText('Clock-out', { exact: true }), { target: { value: '2026-03-08T04:30' } })
    fireEvent.change(dialog.getByLabelText('Entry reason'), { target: { value: 'Controlled gap regression.' } })
    fireEvent.submit(element.querySelector('form')!)
    expect(await dialog.findByRole('alert')).toHaveTextContent('does not exist')
    expect(state.create).not.toHaveBeenCalled()
    expect(dialog.getByLabelText('Clock-in', { exact: true })).toHaveValue('2026-03-08T02:30')
  })

  it('preserves original second-fold seconds when editing only a manual-entry reason', async () => {
    state.workspace.manualEntries = [{
      id: 'd4000000-0000-4000-8000-000000000001', employeeId, employeeName: 'DST Test Guard',
      workDate: '2026-11-01', clockInAt: '2026-11-01T08:30:47.125Z', clockOutAt: '2026-11-01T10:30:42.321Z',
      shiftId, postId, reason: 'Original test entry.', notes: null, approvalStatus: 'approved',
      createdBy: 'Test reviewer', createdAt: '2026-11-01T11:00:00.000Z', lastEditedBy: null, lastEditedAt: null, history: [],
    }]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('combobox', { name: 'Clock-in clock occurrence' })).toHaveValue('2026-11-01T08:30:00.000Z')
    fireEvent.change(dialog.getByLabelText('Edit reason'), { target: { value: 'Reason correction only.' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save correction' }))
    await waitFor(() => expect(state.edit.mock.calls[0]?.[0]).toMatchObject({
      clockInAt: '2026-11-01T08:30:47.125Z', clockOutAt: '2026-11-01T10:30:42.321Z',
    }))
  })

  it('preserves the trusted second-fold call-received instant when its field is unchanged', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Report Sick / Call-Off' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('Employee'), { target: { value: employeeId } })
    fireEvent.change(dialog.getByLabelText('Scheduled shift'), { target: { value: shiftId } })
    fireEvent.change(dialog.getByLabelText('Reason', { exact: true }), { target: { value: 'Controlled call-received regression.' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Record call-off' }))
    await waitFor(() => expect(state.callOff).toHaveBeenCalledWith(expect.objectContaining({ callReceivedAt: '2026-11-01T08:30:47.125Z' })))
  })

  it('records the explicitly chosen occurrence on an adjustment request without approving time', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Request a time change' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('Scheduled shift (optional)'), { target: { value: shiftId } })
    fireEvent.change(dialog.getByLabelText('Work date'), { target: { value: '2026-11-01' } })
    fireEvent.change(dialog.getByLabelText('Requested clock-in', { exact: true }), { target: { value: '2026-11-01T01:15' } })
    fireEvent.change(dialog.getByRole('combobox', { name: 'Requested clock-in clock occurrence' }), { target: { value: '2026-11-01T08:15:00.000Z' } })
    fireEvent.change(dialog.getByLabelText('Requested clock-out', { exact: true }), { target: { value: '2026-11-01T03:30' } })
    fireEvent.change(dialog.getByLabelText('Reason', { exact: true }), { target: { value: 'Controlled second-fold request.' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Submit request' }))
    await waitFor(() => expect(state.adjustment).toHaveBeenCalledWith(expect.objectContaining({
      requestedClockInAt: '2026-11-01T08:15:00.000Z', requestedClockOutAt: '2026-11-01T10:30:00.000Z',
    })))
    expect(state.edit).not.toHaveBeenCalled()
    expect(state.create).not.toHaveBeenCalled()
  })

  it('binds a queued save to its submitted employee, zone, values, and warning confirmation', async () => {
    const otherEmployeeId = 'd1000000-0000-4000-8000-000000000002'
    const otherPostId = 'd2000000-0000-4000-8000-000000000002'
    state.workspace.employees.push({ id: otherEmployeeId, name: 'Other Test Guard', username: 'other-test', employmentType: 'hourly' })
    state.workspace.posts.push({ id: otherPostId, siteId: otherPostId, postName: 'Eastern post', siteName: 'Eastern Test Site', timeZone: 'America/New_York' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const onMutate = vi.fn(() => gate)
    renderPage(onMutate)
    fireEvent.click(await screen.findByRole('button', { name: 'Add manual time' }))
    const element = await screen.findByRole('dialog')
    const dialog = within(element)
    const employee = dialog.getByLabelText('Employee')
    const post = dialog.getByLabelText(/^Site \/ post/)
    const clockIn = dialog.getByLabelText('Clock-in', { exact: true })
    fireEvent.change(employee, { target: { value: employeeId } })
    fireEvent.change(post, { target: { value: postId } })
    fireEvent.change(clockIn, { target: { value: '2026-11-01T01:30' } })
    fireEvent.change(dialog.getByRole('combobox', { name: 'Clock-in clock occurrence' }), { target: { value: '2026-11-01T08:30:00.000Z' } })
    fireEvent.change(dialog.getByLabelText('Clock-out', { exact: true }), { target: { value: '2026-11-01T03:30' } })
    fireEvent.change(dialog.getByLabelText('Entry reason'), { target: { value: 'Queued snapshot regression.' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save manual entry' }))
    await waitFor(() => expect(onMutate).toHaveBeenCalledTimes(1))
    expect(element.querySelector('form')).toHaveAttribute('inert')
    expect(state.create).not.toHaveBeenCalled()
    // Force late events to test snapshot binding even though real interaction is inert while saving.
    fireEvent.change(employee, { target: { value: otherEmployeeId } })
    fireEvent.change(post, { target: { value: otherPostId } })
    fireEvent.change(clockIn, { target: { value: '2026-11-01T03:00' } })
    await act(async () => { release() })
    await waitFor(() => expect(state.create).toHaveBeenCalledWith(expect.objectContaining({
      employeeId, postId, shiftId: null, confirmWarnings: false,
      clockInAt: '2026-11-01T08:30:00.000Z', clockOutAt: '2026-11-01T10:30:00.000Z',
    })))
  })
})
