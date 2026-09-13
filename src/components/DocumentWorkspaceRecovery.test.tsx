import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { HrisDocumentsPage } from '../pages/HrisDocumentsPage'
import { IdentityVerificationHost } from './IdentityVerificationHost'
import { cancelIdentityVerification } from '../lib/identityVerificationCoordinator'

const verification = vi.hoisted(() => ({ fresh: false }))
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: 'test-session' } }, error: null }),
} }) }))
vi.mock('../data/mfa', () => ({ listMfaFactors: async () => [], createMfaChallenge: vi.fn(), verifyMfaChallenge: vi.fn() }))
vi.mock('../data/securityKeys', () => ({
  getSecurityKeyDirectory: async () => ({ featureEnabled: true, pilotEligible: true, keys: [{ id: 'test-key', label: 'Test security key' }] }),
  authenticateWithSecurityKey: async () => { verification.fresh = true },
}))

afterEach(() => { cancelIdentityVerification(); vi.unstubAllGlobals() })

describe('Document Studio identity recovery', () => {
  it('opens one real verification modal for both protected reads, then loads both real workspaces', async () => {
    verification.fresh = false
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
    const counts = { studio: 0, inventory: 0 }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const studio = new URL(url, 'https://app.sygshift.example').pathname.endsWith('/studio')
      if (!studio && !url.includes('/workspace?')) throw new Error('Unexpected document request')
      counts[studio ? 'studio' : 'inventory']++
      if (!verification.fresh) return Response.json({ error: 'recent_document_mfa_required' }, { status: 403 })
      return Response.json(studio ? {
        releaseState: { documentPipeline: true, workspace: true, processing: true, signatures: true, advancedEditing: false, regulatedDocuments: false, externalSigners: false, organizationalSeal: false },
        permissions: { canUpload: true, canCreate: true, canManageTemplates: true, canRequestSignatures: true, canManageSignatures: true, canViewAudit: true, canManagePolicies: true, canManageRetention: true, canManageLegalHold: true },
        summary: { documents: 537, templates: 0, awaitingAction: 0, completed: 0, exceptions: 0, legalHolds: 0 },
        templates: [], envelopes: [], policies: [], processing: [], pagination: { pageSize: 10, offset: 0 },
      } : {
        releaseState: 'released', actor: { canManageAny: true }, vaults: [], employees: [],
        documents: [{
          id: '10000000-0000-4000-8000-000000000001', employeeId: null, employeeNumber: null, employeeLegalName: null,
          vaultCode: 'hr-general', title: 'Test HR reference PDF', category: 'HR library', description: null,
          accessClassification: 'confidential', effectiveDate: null, expirationDate: null, archivedAt: null,
          canManage: true, canPreview: true, canDownload: true,
          version: { id: '10000000-0000-4000-8000-000000000002', versionNumber: 1, filename: 'test-reference.pdf', mimeType: 'application/pdf', sizeBytes: 1024, uploadedAt: '2026-09-06T18:00:00Z', scanState: 'clean' },
        }], pagination: { page: 1, pageSize: 10, totalCount: 537, totalPages: 54 },
      })
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } })
    render(<QueryClientProvider client={client}><MemoryRouter><IdentityVerificationHost /><HrisDocumentsPage /></MemoryRouter></QueryClientProvider>)

    await screen.findByRole('button', { name: 'Verify with security key' })
    await waitFor(() => expect(counts).toEqual({ studio: 1, inventory: 1 }))
    expect(screen.getAllByRole('dialog', { name: 'Verify your identity' })).toHaveLength(1)
    expect(screen.queryByText('Test HR reference PDF')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Verify with security key' }))

    await screen.findByText('What do you need to do?')
    await screen.findByText('Test HR reference PDF')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Document Studio unavailable')).not.toBeInTheDocument()
    expect(screen.queryByText('Document inventory unavailable')).not.toBeInTheDocument()
    expect(counts).toEqual({ studio: 2, inventory: 2 })
    expect(screen.getAllByText('537')).toHaveLength(1)
    client.clear()
  })

  it('opens a focused employee-file inventory without placing the general Document Studio ahead of the files', async () => {
    verification.fresh = true
    const employeeId = '50000000-0000-4000-8000-000000000001'
    const requestedUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requestedUrls.push(url)
      if (!url.includes('/api/v1/hr/documents/workspace?')) throw new Error(`Unexpected document request: ${url}`)
      return Response.json({
        releaseState: 'released', actor: { canManageAny: true }, vaults: [],
        employees: [{ id: employeeId, employeeNumber: 'SYG-1058', legalName: 'Zachary Alexander Ward', status: 'active' }],
        documents: [{
          id: '60000000-0000-4000-8000-000000000001', employeeId, employeeNumber: 'SYG-1058', employeeLegalName: 'Zachary Alexander Ward',
          vaultCode: 'hr-general', title: 'Zach Ward Medical Excuse 9.11.26', category: 'Business document', description: null,
          accessClassification: 'confidential', effectiveDate: null, expirationDate: null, archivedAt: null,
          canManage: true, canPreview: false, canDownload: false,
          version: { id: '70000000-0000-4000-8000-000000000001', versionNumber: 1, filename: 'zach-ward-medical-excuse.pdf', mimeType: 'application/pdf', sizeBytes: 719094, uploadedAt: '2026-09-11T20:00:23Z', scanState: 'scan_pending' },
        }],
        pagination: { page: 1, pageSize: 10, totalCount: 1, totalPages: 1 },
      })
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/hr/documents?employeeId=${employeeId}&employeeName=Zachary%20Alexander%20Ward`]}><HrisDocumentsPage /></MemoryRouter></QueryClientProvider>)

    await screen.findByText('Zach Ward Medical Excuse 9.11.26')
    expect(requestedUrls).toHaveLength(1)
    expect(requestedUrls[0]).toContain(`employeeId=${employeeId}`)
    expect(screen.getByRole('region', { name: 'Documents for Zachary Alexander Ward' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Employee' })).toHaveValue(employeeId)
    expect(screen.getByRole('link', { name: 'Employee File' })).toHaveAttribute('href', `/hr/people/${employeeId}`)
    expect(screen.queryByText('What do you need to do?')).not.toBeInTheDocument()
    client.clear()
  })
})
