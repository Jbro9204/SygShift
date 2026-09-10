import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HrDocumentWorkspace } from '../data/hrDocuments'

const pdf = vi.hoisted(() => {
  const renderPage = vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() }))
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ height: 800 * scale, width: 600 * scale })),
    render: renderPage,
  }
  const loaded = { destroy: vi.fn(async () => undefined), getPage: vi.fn(async () => page), numPages: 1 }
  const getDocument = vi.fn(() => ({ destroy: vi.fn(async () => undefined), promise: Promise.resolve(loaded) }))
  return { getDocument, loaded, page, renderPage }
})

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: pdf.getDocument }))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.test.mjs' }))

import { DocumentWorkbench } from './DocumentWorkbench'

const workspace: HrDocumentWorkspace = {
  actor: { canManageAny: true },
  documents: [],
  employees: [{ employeeNumber: 'SYG-1001', id: '10000000-0000-4000-8000-000000000001', legalName: 'Michelle Hood', status: 'active' }],
  pagination: { page: 1, pageSize: 10, totalCount: 0, totalPages: 0 },
  releaseState: 'released',
  vaults: [{
    allowedMimeTypes: ['application/pdf'],
    canManage: true,
    canView: true,
    classification: 'confidential',
    code: 'hr-general',
    description: 'General HR documents',
    maximumFileSizeBytes: 25_000_000,
    name: 'HR documents',
  }],
}

const canvasContext = {
  drawImage: vi.fn(),
  fillRect: vi.fn(),
  fillStyle: '',
}

describe('DocumentWorkbench editor', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
    HTMLElement.prototype.setPointerCapture = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(760)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isSheet = this.classList?.contains('document-workbench__sheet')
      const width = isSheet ? 600 : 760
      const height = isSheet ? 800 : 900
      return { bottom: height, height, left: 0, right: width, toJSON: () => ({}), top: 0, width, x: 0, y: 0 }
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('wraps, edits, moves, resizes, and restores text boxes without removing them on selection', async () => {
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'proposal.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    await waitFor(() => expect(pdf.renderPage).toHaveBeenCalled())
    const textInput = await screen.findByPlaceholderText('Type the complete text here')
    fireEvent.change(textInput, { target: { value: 'John Holliday requires an unlimited plainclothes endorsement to provide discreet services.\nApproved for the listed assignment.' } })
    const sheet = document.querySelector<HTMLElement>('.document-workbench__sheet')
    expect(sheet).not.toBeNull()
    fireEvent.pointerDown(sheet!, { clientX: 120, clientY: 200, pointerId: 1 })

    const annotation = await screen.findByRole('button', { name: /Text box: John Holliday requires/ })
    const wrapper = annotation.closest<HTMLElement>('.document-workbench__annotation')
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveStyle({ left: '20%', top: '25%', width: '44%' })
    expect(screen.getByRole('region', { name: 'Selected text box controls' })).toBeInTheDocument()

    fireEvent.pointerDown(annotation, { clientX: 120, clientY: 200, pointerId: 2 })
    fireEvent.pointerMove(annotation, { clientX: 180, clientY: 240, pointerId: 2 })
    fireEvent.pointerUp(annotation, { clientX: 180, clientY: 240, pointerId: 2 })
    await waitFor(() => {
      expect(Number.parseFloat(wrapper!.style.left)).toBeCloseTo(30)
      expect(Number.parseFloat(wrapper!.style.top)).toBeCloseTo(30)
    })

    const resizeHandle = screen.getByRole('button', { name: 'Resize selected text box' })
    fireEvent.pointerDown(resizeHandle, { clientX: 384, clientY: 240, pointerId: 3 })
    fireEvent.pointerMove(resizeHandle, { clientX: 444, clientY: 240, pointerId: 3 })
    fireEvent.pointerUp(resizeHandle, { clientX: 444, clientY: 240, pointerId: 3 })
    await waitFor(() => expect(Number.parseFloat(wrapper!.style.width)).toBeCloseTo(54))

    fireEvent.click(screen.getByRole('button', { name: 'Undo last document change' }))
    await waitFor(() => expect(Number.parseFloat(wrapper!.style.width)).toBeCloseTo(44))
    expect(annotation).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Increase text size' }))
    expect(screen.getByText('13 pt')).toBeInTheDocument()

    const maximize = screen.getByRole('button', { name: 'Maximize editor' })
    fireEvent.click(maximize)
    expect(screen.getByRole('dialog')).toHaveClass('is-maximized')
    expect(screen.getByRole('button', { name: 'Restore editor size' })).toBeInTheDocument()
    client.clear()
  })
})
