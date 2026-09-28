import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VacancyPatrolFinanceReport, VacancyPatrolFinanceRow } from '../data/vacancyPatrolFinance'
import { VacancyPatrolFinanceReportWorkspace } from './VacancyPatrolFinanceReportWorkspace'

const dataMocks = vi.hoisted(() => ({
  authorizeExport: vi.fn(),
  getReport: vi.fn(),
  reviewBilling: vi.fn(),
}))
const exportMocks = vi.hoisted(() => ({
  csv: vi.fn(),
  pdf: vi.fn(),
  xlsx: vi.fn(),
}))

vi.mock('../data/vacancyPatrolFinance', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../data/vacancyPatrolFinance')>()
  return {
    ...original,
    authorizeVacancyPatrolFinanceExport: dataMocks.authorizeExport,
    getVacancyPatrolFinanceReport: dataMocks.getReport,
    reviewVacancyPatrolBilling: dataMocks.reviewBilling,
  }
})

vi.mock('./vacancyPatrolFinanceExport', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('./vacancyPatrolFinanceExport')>()
  return {
    ...original,
    downloadVacancyPatrolFinanceCsv: exportMocks.csv,
    downloadVacancyPatrolFinancePdf: exportMocks.pdf,
    downloadVacancyPatrolFinanceXlsx: exportMocks.xlsx,
  }
})

const requestId = '30000000-0000-4000-8000-000000000001'
const employeeId = '30000000-0000-4000-8000-000000000002'

function financeRow(overrides: Partial<VacancyPatrolFinanceRow> = {}): VacancyPatrolFinanceRow {
  return {
    acceptedAt: '2026-09-27T23:00:00Z',
    acceptedById: employeeId,
    acceptedByName: 'Patrol Manager',
    acceptedRouteId: '30000000-0000-4000-8000-000000000003',
    acceptedRouteName: 'Central Night',
    assignedEmployeeId: employeeId,
    assignedEmployeeName: 'Patrol Officer',
    assignedEmployeeNumber: 'SYG-1001',
    billingDisposition: 'pending_review',
    billingReason: null,
    billingReference: null,
    canReview: true,
    clientId: null,
    clientName: 'Elevon',
    completedAt: '2026-09-28T01:30:00Z',
    completedHits: 3,
    endsAt: '2026-09-28T04:00:00Z',
    missedHits: 0,
    originalShiftHours: 6,
    patrolAssignmentId: '30000000-0000-4000-8000-000000000004',
    plannedHits: 3,
    postId: null,
    postName: 'Elevon-Unarmed',
    remainingHits: 0,
    requestId,
    requestNumber: 'VPR-20260927-000001',
    requestedAt: '2026-09-27T22:30:00Z',
    requestedById: employeeId,
    requestedByName: 'Scheduler',
    requestedRouteId: '30000000-0000-4000-8000-000000000003',
    requestedRouteName: 'Central Night',
    reviewedAt: null,
    reviewedById: null,
    reviewedByName: null,
    serviceDate: '2026-09-27',
    shiftId: '30000000-0000-4000-8000-000000000005',
    siteId: null,
    siteName: 'Elevon',
    startsAt: '2026-09-27T22:00:00Z',
    status: 'completed',
    timeZone: 'America/Denver',
    ...overrides,
  }
}

function financeReport(rows = [financeRow()]): VacancyPatrolFinanceReport {
  return {
    from: '2026-09-27',
    generatedAt: '2026-09-28T02:00:00Z',
    permissions: { canExport: true, canReview: true, canView: true },
    rows,
    summary: {
      awaitingCompletion: 0,
      billSeparately: 0,
      duplicateSuppressed: 0,
      includedInContract: 0,
      nonBillable: 0,
      pendingReview: 1,
      reviewed: 0,
      totalRequests: rows.length,
    },
    through: '2026-10-03',
  }
}

function renderWorkspace() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <VacancyPatrolFinanceReportWorkspace from="2026-09-27" onRangeChange={vi.fn()} through="2026-10-03" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Vacancy Patrol Finance report workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.setAttribute('open', '') })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.removeAttribute('open') })
    dataMocks.getReport.mockResolvedValue(financeReport())
    dataMocks.authorizeExport.mockResolvedValue(undefined)
    dataMocks.reviewBilling.mockResolvedValue({
      auditId: 205,
      billingDisposition: 'included_in_contract',
      billingReason: 'Covered by the existing client service agreement.',
      billingReference: null,
      idempotentReplay: false,
      requestId,
      requestNumber: 'VPR-20260927-000001',
      reviewedAt: '2026-09-28T02:10:00Z',
      reviewedBy: { employeeId, name: 'Finance Reviewer' },
    })
    exportMocks.csv.mockReturnValue('vacancy.csv')
    exportMocks.xlsx.mockReturnValue('vacancy.xlsx')
    exportMocks.pdf.mockResolvedValue('vacancy.pdf')
  })

  it('requires an explicit disposition and records the completed service decision directly from the row', async () => {
    const user = userEvent.setup()
    renderWorkspace()

    await user.click(await screen.findByRole('button', { name: 'Review billing' }))
    const dialog = screen.getByRole('dialog', { name: 'Review vacancy Patrol billing' })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Billing disposition')).toHaveValue('')
    expect(within(dialog).getByRole('button', { name: 'Record billing decision' })).toBeDisabled()

    await user.selectOptions(within(dialog).getByLabelText('Billing disposition'), 'included_in_contract')
    await user.type(within(dialog).getByLabelText('Decision reason'), 'Covered by the existing client service agreement.')
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Record billing decision' }))

    await waitFor(() => expect(dataMocks.reviewBilling).toHaveBeenCalledWith({
      billingReference: null,
      disposition: 'included_in_contract',
      idempotencyKey: expect.any(String),
      reason: 'Covered by the existing client service agreement.',
      requestId,
    }))
    expect(await screen.findByRole('heading', { name: 'Billing decision recorded' })).toBeInTheDocument()
  })

  it('keeps incomplete Patrol work read-only even when the viewer has Finance review permission', async () => {
    dataMocks.getReport.mockResolvedValue(financeReport([financeRow({ completedAt: null, completedHits: 1, remainingHits: 2, status: 'in_progress' })]))
    const user = userEvent.setup()
    renderWorkspace()

    expect(await screen.findByRole('button', { name: 'View details' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review billing' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View details' }))
    expect(screen.queryByRole('button', { name: 'Review billing' })).not.toBeInTheDocument()
    expect(screen.getAllByText('Not recorded')).not.toHaveLength(0)
  })

  it('authorizes protected exports before downloading the filtered rows', async () => {
    const second = financeRow({ clientName: 'Other Client', postName: 'Other Post', requestId: '30000000-0000-4000-8000-000000000006', requestNumber: 'VPR-20260927-000002', siteName: 'Other Site' })
    dataMocks.getReport.mockResolvedValue(financeReport([financeRow(), second]))
    const user = userEvent.setup()
    renderWorkspace()

    await screen.findByRole('heading', { name: '2 matching records' })
    await user.type(screen.getByRole('searchbox'), 'Elevon')
    await screen.findByRole('heading', { name: '1 matching record' })
    await user.click(screen.getByRole('button', { name: 'CSV' }))

    await waitFor(() => expect(dataMocks.authorizeExport).toHaveBeenCalledWith({
      format: 'csv', from: '2026-09-27', through: '2026-10-03',
    }))
    expect(exportMocks.csv).toHaveBeenCalledTimes(1)
    expect(exportMocks.csv.mock.calls[0][0].rows).toHaveLength(1)
    expect(exportMocks.csv.mock.invocationCallOrder[0]).toBeGreaterThan(dataMocks.authorizeExport.mock.invocationCallOrder[0])
  })
})
