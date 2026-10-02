import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HrDocumentLibraryWorkspace } from '../data/hrDocumentLibrary'

const libraryApi = vi.hoisted(() => ({
  getLibrary: vi.fn(),
}))

vi.mock('../data/hrDocumentLibrary', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/hrDocumentLibrary')>(),
  getHrDocumentLibrary: libraryApi.getLibrary,
}))

const documentApi = vi.hoisted(() => ({
  getBlob: vi.fn(),
}))

vi.mock('../data/hrDocuments', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/hrDocuments')>(),
  getHrDocumentBlob: documentApi.getBlob,
}))

const viewer = vi.hoisted(() => ({
  render: vi.fn(),
}))

vi.mock('./SecurePdfViewer', () => ({
  SecurePdfViewer: (props: { bytes?: Uint8Array; title: string; url?: string }) => {
    viewer.render(props)
    return <div data-testid="secure-pdf-viewer">{props.title}</div>
  },
}))

import { HrDocumentLibrary } from './HrDocumentLibrary'

const sourceDocumentId = '10000000-0000-4000-8000-000000000001'

const workspace: HrDocumentLibraryWorkspace = {
  categories: [{ count: 1, name: 'Separation and Offboarding' }],
  items: [{
    audience: 'supervisors_and_hr',
    availability: 'available',
    category: 'Separation and Offboarding',
    code: 'GS-HR-700',
    documentKind: 'hr_source',
    guideCode: null,
    id: '20000000-0000-4000-8000-000000000002',
    lifecycleStatus: 'draft_for_adoption',
    pageCount: 2,
    purpose: 'Record a voluntary resignation and offboarding details.',
    recordClass: 'Personnel File / Separation',
    relatedModules: [],
    section: '07 Separation and Offboarding',
    sensitivity: 'restricted',
    sourceDocumentId,
    sourceFilename: 'GS-HR-700.pdf',
    sourceSha256: 'a'.repeat(64),
    sourceType: 'controlled_form',
    title: 'Voluntary Resignation Acknowledgment',
    updatedAt: '2026-10-01T12:00:00Z',
  }],
  libraryVersion: '2.1',
  pagination: { page: 1, pageSize: 10, totalCount: 1, totalPages: 1 },
  permissions: { canManage: false, canSeeHr: true, canSeeSupervisor: true },
  releaseState: 'released',
  summary: { availableCount: 1, categoryCount: 1, matchingCount: 1, visibleCount: 1 },
}

describe('HrDocumentLibrary protected PDF preview', () => {
  const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  const createObjectUrl = vi.fn(() => 'blob:library-preview')

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    createObjectUrl.mockClear()
    libraryApi.getLibrary.mockReset().mockResolvedValue(workspace)
    documentApi.getBlob.mockReset()
    viewer.render.mockReset()
  })

  afterEach(() => {
    if (originalCreateObjectUrl) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl)
    else Reflect.deleteProperty(URL, 'createObjectURL')
  })

  it('passes protected preview bytes directly to SecurePdfViewer without creating a blob URL', async () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    Object.defineProperty(blob, 'arrayBuffer', {
      configurable: true,
      value: async () => pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength),
    })
    documentApi.getBlob.mockResolvedValue({ blob, filename: 'GS-HR-700.pdf' })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <HrDocumentLibrary collection="forms" mode="studio" onUseDocument={vi.fn()} />
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /GS-HR-700.*Voluntary Resignation Acknowledgment/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Preview source PDF' }))

    await waitFor(() => expect(viewer.render).toHaveBeenCalled())
    expect(documentApi.getBlob).toHaveBeenCalledWith(
      sourceDocumentId,
      'preview',
      'Authorized review of the controlled HR document library.',
    )
    const viewerProps = viewer.render.mock.calls.at(-1)?.[0]
    expect(viewerProps?.bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(viewerProps?.bytes ?? [])).toEqual(Array.from(pdfBytes))
    expect(viewerProps?.title).toBe('Voluntary Resignation Acknowledgment')
    expect(viewerProps?.url).toBeUndefined()
    expect(screen.getByTestId('secure-pdf-viewer')).toBeInTheDocument()
    expect(createObjectUrl).not.toHaveBeenCalled()
  })
})
