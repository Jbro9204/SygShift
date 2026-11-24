import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FloatingPatrolPostScope, FloatingPatrolScope, PatrolWorkspace } from '../data/patrol'
import { FloatingPatrolProperties } from './FloatingPatrolProperties'

const data = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), getPost: vi.fn(), savePost: vi.fn() }))
vi.mock('../data/patrol', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/patrol')>(),
  getFloatingPatrolScope: data.get,
  saveFloatingPatrolScope: data.save,
  getFloatingPatrolPostScope: data.getPost,
  saveFloatingPatrolPostScope: data.savePost,
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

async function openEditor(dataWorkspace = workspace, suggestion: typeof shift | null = shift) {
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><FloatingPatrolProperties workspace={dataWorkspace} suggested={suggestion ?? undefined} /></QueryClientProvider>)
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
    await user.type(screen.getByRole('searchbox', { name: 'Find a property' }), 'Management A')
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

  it('filters by guard and uses only the selected published shift and employee', async () => {
    const otherShift = { ...shift, shiftId: 'another-shift', employeeName: 'Another Guard' }
    data.get.mockImplementation(async (target) => ({ ...empty, shiftId: target.shiftId, employeeId: target.employeeId }))
    const user = await openEditor({ ...workspace, scheduleCandidates: [shift, otherShift] }, null)
    expect(data.get).not.toHaveBeenCalled()
    await user.type(screen.getByRole('searchbox', { name: 'Find an assigned shift' }), 'Another Guard')
    expect(screen.queryByRole('option', { name: /Test Guard/ })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Floating patrol shift and employee'), 'another-shift:assigned-guard')
    expect(await screen.findByRole('checkbox', { name: /Neon Local/ })).toBeInTheDocument()
    expect(data.get).toHaveBeenCalledExactlyOnceWith(otherShift)
  })

  it('shows a reusable list only to an authorized route and assignment manager and verifies exact post readback', async () => {
    const postId = 'floating-dispatch-post'
    const initial: FloatingPatrolPostScope = { postId, active: false, siteIds: [], approvedSiteIds: [], revision: null }
    const saved = { ...initial, active: true, siteIds: ['neon'], approvedSiteIds: ['neon'], revision: 1 }
    data.get.mockResolvedValue(empty)
    data.getPost.mockResolvedValueOnce(initial).mockResolvedValue(saved)
    data.savePost.mockResolvedValue(saved)
    const user = await openEditor({ ...workspace, actor: { ...workspace.actor, canManageRoutes: true }, locations: [{ ...neon, postId, postName: 'Dispatch Patrol' }, ...workspace.locations] })
    await user.click(screen.getByRole('button', { name: 'Manage reusable post lists' }))
    expect(data.getPost).not.toHaveBeenCalled()
    await user.selectOptions(screen.getByLabelText('Scheduling post'), postId)
    await user.click(await screen.findByRole('checkbox', { name: /Neon Local/ }))
    await user.type(screen.getByLabelText('Reason for changing this post’s list'), 'Recurring dispatch coverage')
    expect(screen.getByRole('button', { name: 'Save reusable list' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /I confirm this change applies/ }))
    await user.click(screen.getByRole('button', { name: 'Save reusable list' }))
    expect(await screen.findByText(/Verified. This post now has a reusable list/)).toBeInTheDocument()
    expect(data.savePost).toHaveBeenCalledExactlyOnceWith(postId, ['neon'], null, 'Recurring dispatch coverage')
    expect(data.getPost).toHaveBeenNthCalledWith(1, postId)
    expect(data.getPost).toHaveBeenNthCalledWith(2, postId)
    expect(data.save).not.toHaveBeenCalled()
  })

  it('cannot manage reusable lists with only assignment access, and can explicitly block inherited sites for one shift', async () => {
    const inherit = { ...approved, approvedSiteIds: [], revision: null }
    const blocked = { ...approved, siteIds: [], approvedSiteIds: [], active: false, status: 'blocked' as const }
    data.get.mockResolvedValueOnce(inherit).mockResolvedValue(blocked)
    data.save.mockResolvedValue(blocked)
    const user = await openEditor()
    expect(screen.queryByRole('button', { name: 'Manage reusable post lists' })).not.toBeInTheDocument()
    expect(await screen.findByRole('checkbox', { name: /Neon Local/, checked: true })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Block inherited access for this shift' }))
    await user.type(screen.getByLabelText('Reason for changing this assignment'), 'This specific shift is not floating')
    await user.click(screen.getByRole('button', { name: 'Remove floating patrol access' }))
    expect(await screen.findByText(/Verified. Floating patrol locations are now removed/)).toBeInTheDocument()
    expect(data.save).toHaveBeenCalledExactlyOnceWith(shift, [], null, 'This specific shift is not floating')
  })

  it('requires a reason and explicit review before reapproving a blocked reusable selection', async () => {
    const postId = 'floating-dispatch-post'
    const initial: FloatingPatrolPostScope = { postId, active: false, siteIds: [], approvedSiteIds: ['neon'], revision: 1 }
    const updated = { ...initial, active: true, siteIds: ['neon'], revision: 2 }
    data.get.mockResolvedValue(empty)
    data.getPost.mockResolvedValueOnce(initial).mockResolvedValue(updated)
    data.savePost.mockResolvedValue(updated)
    const user = await openEditor({ ...workspace, actor: { ...workspace.actor, canManageRoutes: true }, locations: [{ ...neon, postId, postName: 'Dispatch Patrol' }, ...workspace.locations] })
    await user.click(screen.getByRole('button', { name: 'Manage reusable post lists' }))
    await user.selectOptions(screen.getByLabelText('Scheduling post'), postId)
    expect(await screen.findByRole('button', { name: 'Save reusable list' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Review saved selection for reapproval' }))
    await user.type(screen.getByLabelText('Reason for changing this post’s list'), 'Reverified exact property and client')
    await user.click(screen.getByRole('checkbox', { name: /I confirm this change applies/ }))
    await user.click(screen.getByRole('button', { name: 'Save reusable list' }))
    expect(await screen.findByText(/Verified. This post now has a reusable list/)).toBeInTheDocument()
    expect(data.savePost).toHaveBeenCalledExactlyOnceWith(postId, ['neon'], 1, 'Reverified exact property and client')
  })
})
