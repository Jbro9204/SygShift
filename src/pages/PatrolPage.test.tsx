import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PatrolWorkspace } from '../data/patrol'
import { PatrolPage } from './PatrolPage'

const dataMocks = vi.hoisted(() => ({
  assignPatrolMakeup: vi.fn(),
  getPatrolWorkspace: vi.fn(),
  linkPatrolRouteShift: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/patrol', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../data/patrol')>()
  return {
    ...original,
    assignPatrolMakeup: dataMocks.assignPatrolMakeup,
    getPatrolWorkspace: dataMocks.getPatrolWorkspace,
    linkPatrolRouteShift: dataMocks.linkPatrolRouteShift,
  }
})

const obligation = (status: string) => ({
  allowPhotos: true, allowVideos: true, completedHitId: null, dueEndAt: '2999-01-01T02:00:00.000Z',
  dueStartAt: '2000-01-01T00:00:00.000Z', evidenceInstructions: null, hitNumber: 1,
  id: crypto.randomUUID(), locationConfigured: true, locationLabel: 'Sample stop', requireEvidence: false,
  requirementId: crypto.randomUUID(), requirementLabel: 'Required patrol', status, stopId: crypto.randomUUID(),
})

const assignment = (name: string, overrides: Record<string, unknown> = {}) => ({
  employeeId: crypto.randomUUID(), employeeName: name, endsAt: '2999-01-01T02:00:00.000Z', hits: [],
  id: crypto.randomUUID(), makeupObligations: [], obligations: [obligation('due')], requiresArmed: false,
  routeId: crypto.randomUUID(), routeName: 'Sample Route', routeVersionId: crypto.randomUUID(),
  serviceDate: '09/07/2026', shiftId: crypto.randomUUID(), startsAt: '2000-01-01T00:00:00.000Z',
  status: 'active', timeZone: 'America/Denver', ...overrides,
})

function workspace(canManage = true): PatrolWorkspace {
  const sharedShift = crypto.randomUUID()
  return {
    actor: {
      canExportReports: false, canManageAssignments: canManage, canManageExceptions: canManage,
      canManageRoutes: canManage, canViewEvidence: true, canViewOperations: true, employeeId: crypto.randomUUID(),
    },
    assignments: [
      assignment('Current Guard'),
      assignment('Completed Guard', { obligations: [obligation('completed')], status: 'completed' }),
      assignment('Review Guard', { obligations: [obligation('missed')] }),
      assignment('Future Guard', { startsAt: '2998-12-31T22:00:00.000Z' }),
      assignment('Configuration Guard', { obligations: [] }),
    ],
    locations: [],
    makeupQueue: [{
      assignmentId: crypto.randomUUID(), dueEndAt: '2026-09-07T02:00:00.000Z', employeeId: crypto.randomUUID(),
      employeeName: 'Review Guard', locationLabel: 'Sample stop', obligationId: crypto.randomUUID(),
      routeName: 'Sample Route', serviceDate: '09/07/2026', status: 'missed',
    }],
    routes: [{
      changeReason: 'Current route', code: 'sample', effectiveFrom: null, effectiveThrough: null,
      id: crypto.randomUUID(), name: 'Sample Route', requiresArmed: false, status: 'active', stops: [],
      timeZone: 'America/Denver', versionId: crypto.randomUUID(), versionNumber: 1,
    }],
    scheduleCandidates: [
      { employeeId: '00000000-0000-4000-8000-000000000001', employeeName: 'Employee A', endsAt: '2999-01-01T02:00:00.000Z', postName: 'Patrol', requiresArmed: false, shiftId: sharedShift, siteName: 'Site A', startsAt: '2999-01-01T00:00:00.000Z', timeZone: 'America/Denver' },
      { employeeId: '00000000-0000-4000-8000-000000000002', employeeName: 'Employee B', endsAt: '2999-01-01T02:00:00.000Z', postName: 'Patrol', requiresArmed: false, shiftId: sharedShift, siteName: 'Site A', startsAt: '2999-01-01T00:00:00.000Z', timeZone: 'America/Denver' },
    ],
  } as PatrolWorkspace
}

function renderOperations() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/patrol/operations']}><Routes><Route path="/patrol/:patrolTab" element={<PatrolPage />} /></Routes></MemoryRouter></QueryClientProvider>)
}

describe('Patrol Operations page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dataMocks.linkPatrolRouteShift.mockResolvedValue(crypto.randomUUID())
  })

  it('selects the exact employee on a shared shift and reports truthful assignment states', async () => {
    dataMocks.getPatrolWorkspace.mockResolvedValue(workspace(true))
    const user = userEvent.setup()
    renderOperations()

    const shiftPicker = await screen.findByLabelText('Published assigned shift')
    const employeeB = screen.getByRole('option', { name: /Employee B/ }) as HTMLOptionElement
    const employeeA = screen.getByRole('option', { name: /Employee A/ }) as HTMLOptionElement
    expect(employeeA.value).not.toBe(employeeB.value)
    await user.selectOptions(screen.getByLabelText('Active route'), screen.getByRole('option', { name: 'Sample Route' }))
    await user.selectOptions(shiftPicker, employeeB)
    await user.click(screen.getByRole('button', { name: 'Connect patrol' }))
    await waitFor(() => expect(dataMocks.linkPatrolRouteShift).toHaveBeenCalledWith(expect.any(String), expect.any(String), '00000000-0000-4000-8000-000000000002'))

    for (const label of ['In progress', 'Completed', 'Needs review', 'Scheduled', 'No requirements']) {
      expect(screen.getByText(label, { selector: '.patrol-operation-row .patrol-status' })).toBeInTheDocument()
    }
  })

  it('does not show mutation controls to an Operations viewer without management permissions', async () => {
    dataMocks.getPatrolWorkspace.mockResolvedValue(workspace(false))
    renderOperations()

    await screen.findByRole('heading', { name: 'Patrol assignments' })
    expect(screen.queryByRole('heading', { name: 'Connect route to published shift' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign makeup' })).not.toBeInTheDocument()
    expect(screen.getByText('Awaiting assignment')).toBeInTheDocument()
  })
})
