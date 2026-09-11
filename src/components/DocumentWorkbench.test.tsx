import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
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

const documentApi = vi.hoisted(() => ({
  getBlob: vi.fn(),
  getWorkspace: vi.fn(),
  upload: vi.fn(),
}))

vi.mock('../data/hrDocuments', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/hrDocuments')>(),
  getHrDocumentBlob: documentApi.getBlob,
  getHrDocumentWorkspace: documentApi.getWorkspace,
  uploadHrDocument: documentApi.upload,
}))

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
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  fillText: vi.fn(),
  fillRect: vi.fn(),
  fillStyle: '',
  font: '',
  measureText: vi.fn(() => ({ width: 500 })),
  restore: vi.fn(),
  save: vi.fn(),
  scale: vi.fn(),
  textBaseline: '',
  translate: vi.fn(),
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
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:finished-pdf')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    documentApi.getBlob.mockReset()
    documentApi.getWorkspace.mockReset()
    documentApi.upload.mockReset()
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

  it('places one signature at a time, then supports selection, resizing, and explicit removal', async () => {
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'signature.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    await waitFor(() => expect(pdf.renderPage).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Signature' }))
    fireEvent.change(screen.getByPlaceholderText('Type the full name'), { target: { value: 'Michelle Hood' } })
    const sheet = document.querySelector<HTMLElement>('.document-workbench__sheet')
    fireEvent.pointerDown(sheet!, { clientX: 300, clientY: 640, pointerId: 10 })

    const signature = await screen.findByRole('button', { name: /signature: Michelle Hood/i })
    expect(screen.getByRole('region', { name: 'Selected signature controls' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select / move' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('button', { name: /signature: Michelle Hood/i })).toHaveLength(1)

    fireEvent.pointerDown(sheet!, { clientX: 400, clientY: 700, pointerId: 11 })
    expect(screen.getAllByRole('button', { name: /signature: Michelle Hood/i })).toHaveLength(1)
    fireEvent.click(signature)
    fireEvent.change(screen.getByRole('slider', { name: 'Signature size' }), { target: { value: '50' } })
    expect(signature.closest('.document-workbench__annotation')).toHaveStyle({ width: '50%' })

    fireEvent.click(screen.getByRole('button', { name: 'Remove signature' }))
    expect(screen.queryByRole('button', { name: /signature: Michelle Hood/i })).not.toBeInTheDocument()
    client.clear()
  })

  it('preselects the employee when the workbench is opened from that employee file', async () => {
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'employee-record.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench employeeOnly initialEmployeeId={workspace.employees[0].id} initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    fireEvent.click(await screen.findByRole('tab', { name: 'File' }))
    expect(screen.getByRole('radio', { name: /Michelle Hood/ })).toBeChecked()
    expect(screen.getByPlaceholderText('Search by name or employee number')).toHaveValue('Michelle Hood')
    expect(screen.getByRole('button', { name: 'Add to employee file' })).toBeEnabled()
    client.clear()
  })

  it('reports a durable filing immediately while the exact completed PDF finishes processing in the background', async () => {
    const sourcePdf = await PDFDocument.create()
    sourcePdf.addPage([612, 792])
    const source = await sourcePdf.save()
    const sourceBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
    const file = new File([sourceBuffer], 'verified.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) })
    const documentId = '20000000-0000-4000-8000-000000000001'
    let uploadedFile: File | null = null
    documentApi.upload.mockImplementation(async (input: { file: File }) => {
      uploadedFile = input.file
      return { documentId, operationId: '30000000-0000-4000-8000-000000000001', requestId: 'request', scanState: 'scan_pending', versionId: '40000000-0000-4000-8000-000000000001' }
    })
    const onSaved = vi.fn()
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={onSaved} workspace={workspace} /></QueryClientProvider>)

    await waitFor(() => expect(pdf.renderPage).toHaveBeenCalled())
    fireEvent.change(screen.getByPlaceholderText('Type the complete text here'), { target: { value: 'Stored round-trip marker 12345' } })
    fireEvent.pointerDown(document.querySelector<HTMLElement>('.document-workbench__sheet')!, { clientX: 100, clientY: 180, pointerId: 20 })
    fireEvent.click(screen.getByRole('tab', { name: 'File' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save to company documents' }))

    await screen.findByText('Saved to Company documents. You can close this window; processing will finish in the background.')
    expect(documentApi.getWorkspace).not.toHaveBeenCalled()
    expect(documentApi.getBlob).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(uploadedFile).not.toBeNull()
    const pdfjs = await vi.importActual<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>('pdfjs-dist/legacy/build/pdf.mjs')
    const completedBytes = new Uint8Array(await uploadedFile!.arrayBuffer())
    const completed = await pdfjs.getDocument({ data: completedBytes }).promise
    const text = (await (await completed.getPage(1)).getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' ')
    expect(text).toContain('Stored round-trip marker 12345')

    fireEvent.click(screen.getByRole('button', { name: 'Preview finished PDF' }))
    await screen.findByRole('dialog', { name: 'Review verified' })
    expect(URL.createObjectURL).toHaveBeenCalledWith(uploadedFile)
    client.clear()
  })

  it('does not report filing success when the durable upload was rejected', async () => {
    const sourcePdf = await PDFDocument.create()
    sourcePdf.addPage([612, 792])
    const source = await sourcePdf.save()
    const sourceBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
    const file = new File([sourceBuffer], 'mismatch.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => sourceBuffer })
    const documentId = '50000000-0000-4000-8000-000000000001'
    documentApi.upload.mockResolvedValue({
      documentId,
      operationId: '60000000-0000-4000-8000-000000000001',
      requestId: 'request',
      scanState: 'rejected',
      versionId: '70000000-0000-4000-8000-000000000001',
    })
    const onSaved = vi.fn()
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={onSaved} workspace={workspace} /></QueryClientProvider>)

    await waitFor(() => expect(pdf.renderPage).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'File' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save to company documents' }))

    await screen.findByText('This file could not be accepted. Download it, check the PDF, and try again.')
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.queryByText(/Saved to Company documents/i)).not.toBeInTheDocument()
    client.clear()
  })
})
