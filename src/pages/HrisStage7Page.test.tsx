import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HrisCompensationPage } from './HrisStage7Page'
import { getSessionContext } from '../data/auth'
import { getHrEmployeeCompensation, reviewHrEmployeePayRate } from '../data/hrCompensation'
import { getHrCompensationWorkspace } from '../data/hrStage7'

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({ getSessionContext: vi.fn() }))
vi.mock('../data/hrCompensation', () => ({
  getHrEmployeeCompensation: vi.fn(),
  proposeHrEmployeePayRate: vi.fn(),
  reviewHrEmployeePayRate: vi.fn(),
}))
vi.mock('../data/hrStage7', () => ({
  getHrBenefitsWorkspace: vi.fn(),
  getHrCompensationWorkspace: vi.fn(),
  getHrLeaveWorkspace: vi.fn(),
}))

const proposalId = '11111111-1111-4111-8111-111111111111'
const employeeId = '22222222-2222-4222-8222-222222222222'

const workspace = {
  enabled: true,
  pageSize: 10 as const,
  offset: 0,
  counts: { activeComponents: 1, pendingProposals: 1, activeRecords: 1 },
  items: [{
    id: proposalId,
    employeeId,
    employeeNumber: 'SYG-1029',
    employeeName: 'William Lane',
    componentName: 'Base pay',
    amountCents: 2600,
    currencyCode: 'USD',
    payFrequency: 'hourly',
    effectiveFrom: '2026-08-08',
    status: 'pending',
    proposedAt: '2026-09-10T12:00:00Z',
  }],
  components: [{ id: '33333333-3333-4333-8333-333333333333', code: 'base_pay', name: 'Base pay', componentType: 'base_pay', status: 'active' }],
}

const session = {
  employeeId: '44444444-4444-4444-8444-444444444444',
  username: 'approver',
  displayName: 'HR Approver',
  role: 'admin' as const,
  mustChangePassword: false,
  passwordChangedAt: '2026-01-01T00:00:00Z',
  mfaEnrolledAt: '2026-01-01T00:00:00Z',
  mfaRequired: true,
  hasMfa: true,
  timeZone: 'America/Denver',
  permissions: ['hr.compensation.view', 'hr.compensation.approve'],
}

const employeeCompensation = {
  employeeId,
  employeeName: 'William Lane',
  employeeNumber: 'SYG-1029',
  canManage: true,
  canApprove: true,
  currentRate: null,
  pendingProposals: [{
    id: proposalId,
    amountCents: 2600,
    currencyCode: 'USD',
    payFrequency: 'hourly' as const,
    effectiveFrom: '2026-08-08',
    reason: 'Approved market adjustment.',
    proposedBy: 'HR Manager',
    proposedByCurrentActor: false,
    proposedAt: '2026-09-10T12:00:00Z',
  }],
  history: [],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return { client, ...render(<QueryClientProvider client={client}><HrisCompensationPage /></QueryClientProvider>) }
}

beforeEach(() => {
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
  vi.mocked(getSessionContext).mockResolvedValue(session)
  vi.mocked(getHrCompensationWorkspace).mockResolvedValue(workspace)
  vi.mocked(getHrEmployeeCompensation).mockResolvedValue(employeeCompensation)
  vi.mocked(reviewHrEmployeePayRate).mockResolvedValue({
    proposalId,
    employeeId,
    status: 'approved',
    compensationRecordId: '55555555-5555-4555-8555-555555555555',
    decidedAt: '2026-09-10T13:00:00Z',
  })
})

describe('Compensation approval worklist', () => {
  it('reviews and approves the exact pending proposal without leaving the workspace', async () => {
    const { client } = renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Review compensation for William Lane' }))
    expect(await screen.findByRole('dialog', { name: 'Review pay rate · William Lane' })).toBeInTheDocument()
    expect(await screen.findByText('Approved market adjustment.')).toBeInTheDocument()
    expect(screen.getByText('HR Manager')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Review reason'), { target: { value: 'Verified against the signed compensation authorization.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record approval' }))

    await waitFor(() => expect(vi.mocked(reviewHrEmployeePayRate).mock.calls[0]?.[0]).toEqual({
      proposalId,
      decision: 'approved',
      reason: 'Verified against the signed compensation authorization.',
    }))
    expect(await screen.findByText('Pay-rate proposal approved.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    client.clear()
  })

  it('keeps the approval action unavailable without compensation approval permission', async () => {
    vi.mocked(getSessionContext).mockResolvedValue({ ...session, permissions: ['hr.compensation.view'] })
    const { client } = renderPage()

    await screen.findByText('William Lane')
    expect(screen.queryByRole('button', { name: 'Review compensation for William Lane' })).not.toBeInTheDocument()
    expect(screen.getByText('pending')).toBeInTheDocument()
    expect(getHrEmployeeCompensation).not.toHaveBeenCalled()
    client.clear()
  })

  it('explains when the current approver proposed the pay change', async () => {
    vi.mocked(getHrEmployeeCompensation).mockResolvedValue({
      ...employeeCompensation,
      pendingProposals: [{ ...employeeCompensation.pendingProposals[0], proposedByCurrentActor: true }],
    })
    const { client } = renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Review compensation for William Lane' }))
    expect(await screen.findByText('A different authorized approver is required.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record approval' })).not.toBeInTheDocument()
    client.clear()
  })
})
