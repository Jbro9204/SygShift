import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FloatingPatrolScope, PatrolWorkspace } from '../data/patrol'
import { FloatingPatrolProperties } from './FloatingPatrolProperties'

const data = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }))
vi.mock('../data/patrol', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/patrol')>(),
  getFloatingPatrolScope: data.get,
  saveFloatingPatrolScope: data.save,
}))

const shift = {
  shiftId: 'current-shift', employeeId: 'assigned-guard', employeeName: 'Test Guard',
  startsAt: '2026-11-22T03:00:00.000Z', endsAt: '2026-11-22T11:00:00.000Z',
  timeZone: 'America/Denver', siteName: 'Yard', postName: 'Coverage', requiresArmed: false,
}
const neon = {
  siteId: 'neon', siteName: 'Neon Local', clientId: 'client-a', clientName: 'Management A', siteCode: 'NLA',
  postId: null, postName: null, requiresArmed: false, addressLine1: null, city: 'Denver',
  region: 'CO', postalCode: null, timeZone: 'America/Denver',
}
const workspace: PatrolWorkspace = {
  actor: { employeeId: 'operations', canViewOperations: true, canManageAssignments: true, canViewEvidence: false, canManageRoutes: false, canManageExceptions: false, canExportReports: false },
  scheduleCandidates: [shift], assignments: [], makeupQueue: [], routes: [],
  locations: [neon, { ...neon, siteId: 'cherry', siteName: 'Cherry Tree', clientId: 'client-b', clientName: 'Management B' }, { ...neon, siteId: 'unlinked', siteName: 'No client', clientId: null }],
}
const empty: FloatingPatrolScope = {
  shiftId: shift.shiftId, employeeId: shift.employeeId, siteIds: [], approvedSiteIds: [],
  active: false, configured: false, eligible: true, status: 'not_configured', revision: null,
}
const approved: FloatingPatrolScope = { ...empty, active: true, configured: true, status: 'ready', revision: 1, siteIds: ['neon'], approvedSiteIds: ['neon'] }

async function openEditor() {
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><FloatingPatrolProperties workspace={workspace} suggested={shift} /></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: 'Set up floating patrol' }))
  return user
}

describe('Floating patrol properties', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(cleanup)

  it('filters the property checklist and confirms the exact approved assignment by readback', async () => {
    data.get.mockResolvedValueOnce(empty).mockResolvedValue(approved)
    data.save.mockResolvedValue(approved)
    const user = await openEditor()
    expect(await screen.findByRole('checkbox', { name: /Neon Local/ })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /No client/ })).not.toBeInTheDocument()
    await user.type(screen.getByRole('searchbox'), 'Management A')
    expect(screen.queryByRole('checkbox', { name: /Cherry Tree/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /Neon Local/ }))
    await user.type(screen.getByLabelText('Reason for changing this assignment'), 'Tonight’s dispatch coverage')
    await user.click(screen.getByRole('button', { name: 'Save approved properties' }))
    expect(await screen.findByText(/Verified. Have the guard refresh/)).toBeInTheDocument()
    expect(data.save).toHaveBeenCalledExactlyOnceWith(shift, ['neon'], null, 'Tonight’s dispatch coverage')
    expect(data.get).toHaveBeenCalledTimes(2)
  })

  it('checks a lost write response without sending the approval twice', async () => {
    data.get.mockResolvedValueOnce(empty).mockResolvedValue(approved)
    data.save.mockRejectedValue(new Error('Connection lost'))
    const user = await openEditor()
    await user.click(await screen.findByRole('checkbox', { name: /Neon Local/ }))
    await user.type(screen.getByLabelText('Reason for changing this assignment'), 'Tonight’s dispatch coverage')
    await user.click(screen.getByRole('button', { name: 'Save approved properties' }))
    expect(await screen.findByText(/Verified. Have the guard refresh/)).toBeInTheDocument()
    expect(data.save).toHaveBeenCalledTimes(1)
  })

  it('never reports success when the saved list cannot be verified', async () => {
    data.get.mockResolvedValueOnce(empty).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue(approved)
    data.save.mockResolvedValue(approved)
    const user = await openEditor()
    await user.click(await screen.findByRole('checkbox', { name: /Neon Local/ }))
    await user.type(screen.getByLabelText('Reason for changing this assignment'), 'Tonight’s dispatch coverage')
    await user.click(screen.getByRole('button', { name: 'Save approved properties' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified')
    expect(screen.queryByText(/Verified. Have the guard refresh/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reload saved list' }))
    expect(await screen.findByRole('checkbox', { name: /Neon Local/, checked: true })).toBeInTheDocument()
    expect(data.save).toHaveBeenCalledTimes(1)
  })

  it('does not offer a floating approval when a scheduled patrol route is authoritative', async () => {
    data.get.mockResolvedValue({ ...empty, eligible: false, status: 'native_route' })
    await openEditor()
    expect(await screen.findByText(/uses a scheduled patrol route/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save approved properties' })).not.toBeInTheDocument()
  })
})
