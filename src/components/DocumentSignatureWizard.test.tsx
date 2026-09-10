import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentSignatureWizard } from './DocumentSignatureWizard'
import type { DocumentStudioPolicy } from '../data/documentStudio'
import type { HrDocumentWorkspace } from '../data/hrDocuments'

const mocks = vi.hoisted(() => ({
  createEnvelope: vi.fn(),
  getWorkspace: vi.fn(),
  sendEnvelope: vi.fn(),
  uploadDocument: vi.fn(),
}))

vi.mock('../data/documentStudio', async (load) => ({
  ...(await load<typeof import('../data/documentStudio')>()),
  createSignatureEnvelope: mocks.createEnvelope,
  sendSignatureEnvelope: mocks.sendEnvelope,
}))
vi.mock('../data/hrDocuments', async (load) => ({
  ...(await load<typeof import('../data/hrDocuments')>()),
  getHrDocumentWorkspace: mocks.getWorkspace,
  uploadHrDocument: mocks.uploadDocument,
}))

const employeeId = '11111111-1111-4111-8111-111111111111'
const documentId = '22222222-2222-4222-8222-222222222222'
const policyId = '33333333-3333-4333-8333-333333333333'
const envelopeId = '44444444-4444-4444-8444-444444444444'

const workspace = {
  actor: { canManageAny: true },
  documents: [],
  employees: [{ employeeNumber: 'SYG-1001', id: employeeId, legalName: 'Jordan Employee', status: 'active' }],
  pagination: { page: 1, pageSize: 10, totalCount: 0, totalPages: 0 },
  releaseState: 'released',
  vaults: [{ allowedMimeTypes: ['application/pdf'], canManage: true, canView: true, classification: 'confidential', code: 'hr-general', description: 'General records', maximumFileSizeBytes: 25_000_000, name: 'General personnel records' }],
} satisfies HrDocumentWorkspace

const policy = {
  active: true, authenticationTier: 'standard', category: 'Employment document', code: 'STANDARD_EMPLOYEE_ELECTRONIC_SIGNATURE', executionMethod: 'electronic', id: policyId, jurisdiction: 'US', name: 'Standard employee electronic signature', publishedAt: '2026-09-01T00:00:00Z', regulated: false, routingMode: 'sequential', versionNumber: 1,
} satisfies DocumentStudioPolicy

function renderWizard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><DocumentSignatureWizard onClose={vi.fn()} onCompleted={vi.fn().mockResolvedValue(undefined)} policies={[policy]} workspace={workspace}/></QueryClientProvider>)
}

describe('Document signature wizard', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', '') })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open') })
    mocks.createEnvelope.mockReset().mockResolvedValue({ id: envelopeId })
    mocks.sendEnvelope.mockReset().mockResolvedValue({ status: 'sent' })
    mocks.uploadDocument.mockReset().mockImplementation(async (_input, onProgress: (value: number) => void) => { onProgress(100); return { documentId, operationId: crypto.randomUUID(), requestId: 'request-1', scanState: 'scan_pending', versionId: crypto.randomUUID() } })
    mocks.getWorkspace.mockReset().mockResolvedValue({ ...workspace, documents: [{ accessClassification: 'confidential', archivedAt: null, canDownload: true, canManage: true, canPreview: true, category: 'Proposal', description: null, effectiveDate: null, employeeId: null, employeeLegalName: null, employeeNumber: null, expirationDate: null, id: documentId, title: 'Service proposal', vaultCode: 'hr-general', version: { filename: 'proposal.pdf', id: crypto.randomUUID(), mimeType: 'application/pdf', scanState: 'clean', sizeBytes: 120, uploadedAt: '2026-09-10T12:00:00Z', versionNumber: 1 } }], pagination: { page: 1, pageSize: 20, totalCount: 1, totalPages: 1 } })
  })

  it('uploads, scans, and sends an outside document without asking for a policy or template', async () => {
    const user = userEvent.setup()
    const view = renderWizard()
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(fileInput).not.toBeNull()
    await user.upload(fileInput!, new File(['proposal'], 'proposal.pdf', { type: 'application/pdf' }))
    await user.clear(screen.getByLabelText('Document title'))
    await user.type(screen.getByLabelText('Document title'), 'Service proposal')
    await user.click(screen.getByRole('button', { name: /Choose recipients/ }))
    await user.click(screen.getByRole('checkbox', { name: /Jordan Employee/ }))
    await user.click(screen.getByRole('button', { name: /Review request/ }))
    expect(screen.queryByLabelText('Policy')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Template')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Upload and send/ }))
    expect(await screen.findByRole('heading', { name: 'Document sent' })).toBeInTheDocument()
    expect(mocks.uploadDocument).toHaveBeenCalledWith(expect.objectContaining({ title: 'Service proposal', vaultCode: 'hr-general' }), expect.any(Function))
    expect(mocks.createEnvelope).toHaveBeenCalledWith(expect.objectContaining({ documentId, policyId, templateVersionId: null, recipients: [expect.objectContaining({ employeeId, routingOrder: 1 })] }))
    await waitFor(() => expect(mocks.sendEnvelope).toHaveBeenCalledWith(envelopeId))
  })
})
