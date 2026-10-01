import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, StandardFontEmbedder, StandardFonts } from 'pdf-lib'
import type { HrDocumentWorkspace } from '../data/hrDocuments'

const pdf = vi.hoisted(() => {
  const renderPage = vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() }))
  const page = {
    getAnnotations: vi.fn(async () => [] as Array<Record<string, unknown>>),
    getTextContent: vi.fn(async () => ({ items: [] as Array<Record<string, unknown>> })),
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ convertToViewportPoint: (x: number, y: number) => [x * scale, 800 * scale - y * scale], convertToViewportRectangle: ([x1, y1, x2, y2]: number[]) => [x1 * scale, 800 * scale - y1 * scale, x2 * scale, 800 * scale - y2 * scale], height: 800 * scale, width: 600 * scale })),
    render: renderPage,
  }
  const loaded = { destroy: vi.fn(async () => undefined), getPage: vi.fn(async () => page), numPages: 1 }
  const getDocument = vi.fn(() => ({ destroy: vi.fn(async () => undefined), promise: Promise.resolve(loaded) }))
  return { getDocument, loaded, page, renderPage }
})

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: pdf.getDocument }))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.test.mjs' }))

const studioApi = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
}))

vi.mock('../data/documentStudio', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/documentStudio')>(),
  getDocumentStudioWorkspace: studioApi.getWorkspace,
}))

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

import { detectTemplateFields, DocumentWorkbench } from './DocumentWorkbench'

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
    studioApi.getWorkspace.mockReset().mockResolvedValue({ policies: [] })
    pdf.getDocument.mockReset().mockImplementation(() => ({ destroy: vi.fn(async () => undefined), promise: Promise.resolve(pdf.loaded) }))
    pdf.loaded.getPage.mockClear()
    pdf.renderPage.mockClear()
    pdf.page.getAnnotations.mockReset().mockResolvedValue([])
    pdf.page.getTextContent.mockReset().mockResolvedValue({ items: [] })
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

  it('shows a complete long-name signature image in the editor instead of clipping CSS text', async () => {
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'long-signature.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    await waitFor(() => expect(pdf.renderPage).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Signature' }))
    fireEvent.change(screen.getByPlaceholderText('Type the full name'), { target: { value: 'Jordan C Brown' } })
    fireEvent.pointerDown(document.querySelector<HTMLElement>('.document-workbench__sheet')!, { clientX: 300, clientY: 640, pointerId: 14 })

    const signature = await screen.findByRole('button', { name: /signature: Jordan C Brown/i })
    expect(signature.querySelector('img')).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/))
    expect(screen.getByRole('region', { name: 'Selected signature controls' }).querySelector('img')).toBeInTheDocument()
    client.clear()
  })

  it('turns flattened bracket prompts into guided fields on the correct PDF page', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [{ height: 12, str: '[Legal name]', transform: [12, 0, 0, 12, 120, 620], width: 82 }],
    })
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'company-template.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    const region = await screen.findByRole('region', { name: 'Detected form fields' })
    const field = within(region).getByPlaceholderText('Enter legal name')
    fireEvent.change(field, { target: { value: 'Zachary Alexander Ward' } })
    const onDocument = await screen.findByRole('textbox', { name: 'Legal name on document' })
    expect(onDocument).toHaveValue('Zachary Alexander Ward')
    fireEvent.change(onDocument, { target: { value: 'Zachary Ward' } })
    expect(field).toHaveValue('Zachary Ward')
    expect(region).toHaveTextContent('Page 1')
    fireEvent.click(screen.getByRole('tab', { name: 'File' }))
    expect(await screen.findByRole('button', { name: /Text box: Zachary Ward/ })).toBeInTheDocument()
    client.clear()
  })

  it('keeps direct long-form editing inside the space before the next printed section', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [
        { height: 12, str: '[Employee explanation and relevant context]', transform: [12, 0, 0, 12, 100, 500], width: 250 },
        { height: 12, str: 'CORRECTIVE ACTION PLAN', transform: [12, 0, 0, 12, 100, 420], width: 180 },
      ],
    })
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'bounded-long-form.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    const onDocument = await screen.findByRole('textbox', { name: 'Employee explanation and relevant context on document' })
    expect(Number.parseFloat(onDocument.style.height)).toBeLessThan(12)
    expect(onDocument).toHaveClass('document-workbench__template-control', 'is-long_text')
    fireEvent.change(onDocument, { target: { value: 'This answer stays inside the printed explanation section.' } })
    expect(within(screen.getByRole('region', { name: 'Detected form fields' })).getByDisplayValue('This answer stays inside the printed explanation section.')).toBeInTheDocument()
    client.clear()
  })

  it('turns printed checkbox symbols into directly clickable form controls', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [{ height: 11, str: '☐ Written warning', transform: [11, 0, 0, 11, 100, 520], width: 105 }],
    })
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'printed-checkbox.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    const onDocument = await screen.findByRole('button', { name: 'Written warning on document: not checked' })
    expect(onDocument).not.toBePressed()
    fireEvent.click(onDocument)
    expect(await screen.findByRole('button', { name: 'Written warning on document: checked' })).toBePressed()
    const sideCheckbox = within(screen.getByRole('region', { name: 'Detected form fields' })).getByRole('checkbox', { name: /Written warning/i })
    expect(sideCheckbox).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Written warning on document: checked' }))
    expect(await screen.findByRole('button', { name: 'Written warning on document: not checked' })).not.toBePressed()
    client.clear()
  })

  it('finalizes detected checkboxes without inventing an incomplete erase boundary', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [{ height: 11, str: '☐ Written warning', transform: [11, 0, 0, 11, 100, 520], width: 105 }],
    })
    const sourcePdf = await PDFDocument.create()
    sourcePdf.addPage([600, 800])
    const source = await sourcePdf.save()
    const sourceBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
    const file = new File([sourceBuffer], 'printed-checkbox-output.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => sourceBuffer })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    fireEvent.click(await screen.findByRole('button', { name: 'Written warning on document: not checked' }))
    const preview = screen.getByRole('button', { name: 'Preview finished PDF' })
    fireEvent.click(preview)
    expect(await screen.findByRole('dialog', { name: 'Review printed-checkbox-output' })).toBeInTheDocument()
    expect(screen.queryByText(/incomplete source-placeholder boundary/i)).not.toBeInTheDocument()
    client.clear()
  })

  it('recognizes a signature placeholder and snaps the complete generated signature into that box', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [{ height: 12, str: '[Enter / Sign]', transform: [12, 0, 0, 12, 120, 620], width: 86 }],
    })
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'signature-template.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    const region = await screen.findByRole('region', { name: 'Detected form fields' })
    const signatureField = await screen.findByRole('button', { name: /Signature field Signature on document/i })
    fireEvent.click(signatureField)
    fireEvent.change(screen.getByPlaceholderText('Type the full name'), { target: { value: 'Jordan C Brown' } })
    fireEvent.click(within(screen.getByRole('region', { name: 'Sign Signature' })).getByRole('button', { name: 'Place signature' }))

    const signature = await screen.findByRole('button', { name: /Signature field Signature on document: Jordan C Brown/i })
    expect(signature.querySelector('img')).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Review signature' })).toBeInTheDocument()
    expect(region).toHaveTextContent('Jordan C Brown is placed in this signature field.')
    client.clear()
  })

  it('maps repeated signature-table cells by arbitrary row role and column purpose', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [
        { height: 11, str: 'PRINTED NAME', transform: [11, 0, 0, 11, 150, 680], width: 120 },
        { height: 11, str: 'SIGNATURE', transform: [11, 0, 0, 11, 300, 680], width: 90 },
        { height: 11, str: 'DATE / TIME', transform: [11, 0, 0, 11, 430, 680], width: 90 },
        { height: 11, str: 'Shift Commander', transform: [11, 0, 0, 11, 45, 620], width: 95 },
        { height: 11, str: '[Enter / Sign]', transform: [11, 0, 0, 11, 150, 620], width: 95 },
        { height: 11, str: '[Enter / Sign]', transform: [11, 0, 0, 11, 300, 620], width: 95 },
        { height: 11, str: '[Enter / Sign]', transform: [11, 0, 0, 11, 430, 620], width: 95 },
      ],
    })
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'role-signature-grid.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    expect(await screen.findByRole('textbox', { name: 'Shift Commander — Printed name on document' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Signature field Shift Commander — Signature on document/i })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Shift Commander — Date / time on document' })).toHaveAttribute('placeholder', 'Date')
    const region = screen.getByRole('region', { name: 'Detected form fields' })
    expect(region).toHaveTextContent('Signatures — Shift Commander')
    expect(within(region).getByLabelText('Show Shift Commander — Date / time on form')).toBeInTheDocument()
    client.clear()
  })

  it('keeps inline body text readable and edits its values from the guided panel', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [{ height: 12, str: 'Guardianship received notice on [Notice date] and the final day is [Final day].', transform: [12, 0, 0, 12, 70, 560], width: 450 }],
    })
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'body-fields.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    const bodyAnchor = await screen.findByRole('button', { name: /Notice date in document body/i })
    expect(bodyAnchor).toHaveClass('document-workbench__template-anchor', 'is-inline-body')
    expect(screen.queryByRole('textbox', { name: 'Notice date on document' })).not.toBeInTheDocument()
    const region = screen.getByRole('region', { name: 'Detected form fields' })
    const noticeDate = within(region).getByRole('textbox', { name: 'Notice date' })
    fireEvent.change(noticeDate, { target: { value: '10/01/2026' } })
    expect(await screen.findByRole('button', { name: /Notice date in document body: 10\/01\/2026/i })).toBeInTheDocument()
    expect(region).toHaveTextContent('Document body')
    client.clear()
  })

  it('preserves placed signatures, manual fields, and manual annotations when employee details are filled', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [
        { height: 12, str: '[Employee legal name]', transform: [12, 0, 0, 12, 120, 650], width: 130 },
        { height: 12, str: '[Enter / Sign]', transform: [12, 0, 0, 12, 120, 580], width: 100 },
      ],
    })
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'prefill-preservation.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    fireEvent.click(await screen.findByRole('button', { name: /Signature field Signature on document/i }))
    fireEvent.change(screen.getByPlaceholderText('Type the full name'), { target: { value: 'Jordan C Brown' } })
    fireEvent.click(within(screen.getByRole('region', { name: 'Sign Signature' })).getByRole('button', { name: 'Place signature' }))
    expect(await screen.findByRole('button', { name: /Signature field Signature on document: Jordan C Brown/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Text' }))
    fireEvent.change(screen.getByPlaceholderText('Type the complete text here'), { target: { value: 'Preserved manual note' } })
    fireEvent.pointerDown(document.querySelector<HTMLElement>('.document-workbench__sheet')!, { clientX: 350, clientY: 300, pointerId: 31 })
    expect(await screen.findByRole('button', { name: /Text box: Preserved manual note/i })).toBeInTheDocument()

    const region = screen.getByRole('region', { name: 'Detected form fields' })
    fireEvent.change(within(region).getByRole('textbox', { name: 'Employee legal name' }), { target: { value: 'Manually verified name' } })
    fireEvent.change(within(region).getByRole('combobox', { name: /Whose form is this/i }), { target: { value: workspace.employees[0].id } })
    expect(await screen.findByRole('button', { name: /Signature field Signature on document: Jordan C Brown/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Text box: Preserved manual note/i })).toBeInTheDocument()
    expect(within(region).getByDisplayValue('Manually verified name')).toBeInTheDocument()
    client.clear()
  })

  it('updates only employee-prefilled values and removes stale generated values when the next employee value is blank', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [
        { height: 12, str: '[Employee ID]', transform: [12, 0, 0, 12, 100, 680], width: 90 },
        { height: 12, str: '[Job title]', transform: [12, 0, 0, 12, 100, 620], width: 90 },
        { height: 12, str: '[Work location]', transform: [12, 0, 0, 12, 100, 560], width: 110 },
      ],
    })
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'prefill-provenance.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const prefillWorkspace: HrDocumentWorkspace = {
      ...workspace,
      employees: [
        { ...workspace.employees[0], jobTitle: 'Field supervisor', locationText: 'Denver HQ' },
        { employeeNumber: 'SYG-2002', id: '10000000-0000-4000-8000-000000000002', legalName: 'Taylor Reed', status: 'active' },
      ],
    }
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={prefillWorkspace} /></QueryClientProvider>)

    const region = await screen.findByRole('region', { name: 'Detected form fields' })
    const employee = within(region).getByRole('combobox', { name: /Whose form is this/i })
    const jobTitle = within(region).getByRole('textbox', { name: 'Job title' })
    fireEvent.change(jobTitle, { target: { value: 'Manually confirmed title' } })
    fireEvent.change(employee, { target: { value: prefillWorkspace.employees[0].id } })
    expect(within(region).getByRole('textbox', { name: 'Employee ID' })).toHaveValue('SYG-1001')
    expect(jobTitle).toHaveValue('Manually confirmed title')
    expect(within(region).getByRole('textbox', { name: 'Work location' })).toHaveValue('Denver HQ')

    fireEvent.change(employee, { target: { value: prefillWorkspace.employees[1].id } })
    expect(within(region).getByRole('textbox', { name: 'Employee ID' })).toHaveValue('SYG-2002')
    expect(jobTitle).toHaveValue('Manually confirmed title')
    expect(within(region).getByRole('textbox', { name: 'Work location' })).toHaveValue('')
    client.clear()
  })

  it('disables every finished-output action while a replacement PDF is still being mapped or mapping fails', async () => {
    const firstSource = new Uint8Array([37, 80, 68, 70, 45, 49])
    const firstFile = new File([firstSource], 'first.pdf', { type: 'application/pdf' })
    Object.defineProperty(firstFile, 'arrayBuffer', { value: async () => firstSource.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={firstFile} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    const preview = screen.getByRole('button', { name: 'Preview finished PDF' })
    const download = screen.getByRole('button', { name: 'Download PDF' })
    await waitFor(() => expect(preview).toBeEnabled())
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!
    let finishDetection: ((value: { items: Array<Record<string, unknown>> }) => void) | undefined
    pdf.page.getTextContent.mockImplementationOnce(() => new Promise((resolve) => { finishDetection = resolve }))
    const secondSource = new Uint8Array([37, 80, 68, 70, 45, 50])
    const secondFile = new File([secondSource], 'second.pdf', { type: 'application/pdf' })
    Object.defineProperty(secondFile, 'arrayBuffer', { value: async () => secondSource.buffer.slice(0) })
    fireEvent.change(fileInput, { target: { files: { 0: secondFile, item: () => secondFile, length: 1 } } })

    expect(preview).toBeDisabled()
    expect(download).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: 'Send' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Michelle Hood/ }))
    await waitFor(() => expect(studioApi.getWorkspace).toHaveBeenCalled())
    const send = screen.getByRole('button', { name: 'Send document' })
    expect(send).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: 'File' }))
    expect(screen.getByRole('button', { name: 'Save to company documents' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save to company documents' }))
    expect(documentApi.upload).not.toHaveBeenCalled()

    await waitFor(() => expect(finishDetection).toBeTypeOf('function'))
    finishDetection!({ items: [] })
    await waitFor(() => expect(preview).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Save to company documents' })).toBeEnabled()
    fireEvent.click(screen.getByRole('tab', { name: 'Send' }))
    expect(screen.getByRole('button', { name: 'Send document' })).toBeEnabled()
    fireEvent.click(screen.getByRole('tab', { name: 'File' }))

    pdf.page.getTextContent.mockRejectedValueOnce(new Error('Field mapping failed safely.'))
    const failedSource = new Uint8Array([37, 80, 68, 70, 45, 51])
    const failedFile = new File([failedSource], 'failed.pdf', { type: 'application/pdf' })
    Object.defineProperty(failedFile, 'arrayBuffer', { value: async () => failedSource.buffer.slice(0) })
    fireEvent.change(fileInput, { target: { files: { 0: failedFile, item: () => failedFile, length: 1 } } })

    expect(await screen.findByRole('alert')).toHaveTextContent('Field mapping failed safely.')
    expect(preview).toBeDisabled()
    expect(download).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save to company documents' })).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: 'Send' }))
    expect(screen.getByRole('button', { name: 'Send document' })).toBeDisabled()
    client.clear()
  })

  it('detects more than eighty fields without silently truncating the form', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: Array.from({ length: 120 }, (_, index) => ({
        height: 10,
        str: `[Field ${index + 1}]`,
        transform: [10, 0, 0, 10, 30 + (index % 10) * 52, 760 - Math.floor(index / 10) * 52],
        width: 45,
      })),
    })

    const result = await detectTemplateFields(pdf.loaded as never)
    expect(result.truncated).toBe(false)
    expect(result.fields).toHaveLength(120)
    expect(new Set(result.fields.map((field) => field.id)).size).toBe(120)
  })

  it('labels generic table entries by section, row, and column without overlapping cells', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [
        { height: 13, str: 'TRAINING COMPLETION LOG', transform: [13, 0, 0, 13, 80, 730], width: 260 },
        { height: 10, str: 'COURSE / TOPIC', transform: [10, 0, 0, 10, 100, 690], width: 110 },
        { height: 10, str: 'DATE', transform: [10, 0, 0, 10, 300, 690], width: 45 },
        { height: 10, str: '[Enter]', transform: [10, 0, 0, 10, 100, 650], width: 50 },
        { height: 10, str: '[Enter]', transform: [10, 0, 0, 10, 300, 650], width: 50 },
        { height: 10, str: '[Enter]', transform: [10, 0, 0, 10, 100, 610], width: 50 },
        { height: 10, str: '[Enter]', transform: [10, 0, 0, 10, 300, 610], width: 50 },
      ],
    })

    const result = await detectTemplateFields(pdf.loaded as never)
    expect(result.fields.map((field) => field.label)).toEqual(expect.arrayContaining([
      'Row 1 — Course / topic',
      'Row 1 — Date',
      'Row 2 — Course / topic',
      'Row 2 — Date',
    ]))
    expect(result.fields.filter((field) => field.label.endsWith('Date')).every((field) => field.controlType === 'date')).toBe(true)
    const firstRow = result.fields.filter((field) => field.label.startsWith('Row 1')).sort((left, right) => left.xRatio - right.xRatio)
    expect(firstRow[0].xRatio + firstRow[0].widthRatio).toBeLessThan(firstRow[1].xRatio)
  })

  it('combines multiline table headers into one usable label per column', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [
        { height: 10, str: 'SCHEDULED SHIFT / SITE', transform: [10, 0, 0, 10, 45, 690], width: 115 },
        { height: 10, str: 'SCHEDULE', transform: [10, 0, 0, 10, 175, 696], width: 70 },
        { height: 10, str: 'PUBLISHED', transform: [10, 0, 0, 10, 175, 684], width: 70 },
        { height: 10, str: 'CALL-OFF RECEIVED', transform: [10, 0, 0, 10, 270, 690], width: 92 },
        { height: 10, str: 'CONTACT / EVIDENCE', transform: [10, 0, 0, 10, 375, 690], width: 100 },
        { height: 10, str: 'COUNTED?', transform: [10, 0, 0, 10, 500, 690], width: 58 },
        ...[45, 175, 270, 375, 500].map((x) => ({ height: 10, str: '[Enter]', transform: [10, 0, 0, 10, x, 650], width: 42 })),
      ],
    })

    const result = await detectTemplateFields(pdf.loaded as never)
    expect(result.fields.map((field) => field.label)).toEqual([
      'Row 1 — Scheduled shift / site',
      'Row 1 — Schedule published',
      'Row 1 — Call-off received',
      'Row 1 — Contact / evidence',
      'Row 1 — Counted?',
    ])
    expect(result.fields.every((field) => field.mappingStatus === 'mapped')).toBe(true)
  })

  it('blocks every finished-output path until an ambiguous field receives a clear mapping', async () => {
    pdf.page.getTextContent.mockResolvedValue({
      items: [{ height: 10, str: '[Enter]', transform: [10, 0, 0, 10, 240, 520], width: 42 }],
    })
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'mapping-review.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    const readiness = await screen.findByRole('region', { name: 'Document readiness' })
    expect(readiness).toHaveTextContent('Mapping review needed')
    fireEvent.click(screen.getByRole('button', { name: 'Preview finished PDF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Review and label “Enter” on page 1 before previewing, downloading, filing, or sending this form.')
    expect(screen.queryByRole('dialog', { name: /Review mapping-review/i })).not.toBeInTheDocument()

    const guided = screen.getByRole('region', { name: 'Detected form fields' })
    const label = within(guided).getByRole('textbox', { name: 'Field label' })
    await waitFor(() => expect(label).toHaveFocus())
    fireEvent.change(label, { target: { value: 'Supervisor approval code' } })
    fireEvent.click(within(guided).getByRole('button', { name: 'Use this mapping' }))
    expect(readiness).toHaveTextContent('Ready to complete')
    expect(within(guided).getByRole('textbox', { name: 'Supervisor approval code' })).toBeInTheDocument()
    client.clear()
  })

  it('keeps a short inline placeholder erase mask within its exact body slot', async () => {
    const text = 'Return by [DUE] only.'
    pdf.page.getTextContent.mockResolvedValue({
      items: [{ height: 11, str: text, transform: [11, 0, 0, 11, 70, 560], width: 180 }],
    })

    const result = await detectTemplateFields(pdf.loaded as never)
    const field = result.fields[0]
    const metricFont = StandardFontEmbedder.for(StandardFonts.Helvetica as unknown as Parameters<typeof StandardFontEmbedder.for>[0])
    const expectedGlyphWidth = 180 * metricFont.widthOfTextAtSize('[DUE]', 100) / metricFont.widthOfTextAtSize(text, 100)
    expect(field.layout).toBe('inline-body')
    expect(field.eraseWidthRatio).toBeCloseTo((expectedGlyphWidth + 1) / 600, 5)
    expect(field.widthRatio).toBeGreaterThanOrEqual(field.eraseWidthRatio)
    expect(field.eraseHeightRatio - field.boxHeightRatio).toBeLessThanOrEqual(.004)
    expect(field.sourceLine).toMatchObject({ text, xRatio: 70 / 600 })
    expect(field.sourceSpan).toEqual({ length: '[DUE]'.length, start: text.indexOf('[DUE]') })
  })

  it('turns native PDF form widgets into plain-language guided controls', async () => {
    pdf.page.getAnnotations.mockResolvedValue([
      { alternativeText: 'Employee legal name', fieldName: 'employee_name', fieldType: 'Tx', fieldValue: 'Existing Name', multiLine: false, rect: [80, 650, 330, 680], subtype: 'Widget' },
      { alternativeText: 'Supervisor notes', fieldName: 'supervisor_notes', fieldType: 'Tx', fieldValue: '', multiLine: true, rect: [80, 420, 520, 620], subtype: 'Widget' },
      { alternativeText: 'Employee received copy', checkBox: true, fieldName: 'received_copy', fieldType: 'Btn', fieldValue: 'Off', rect: [80, 380, 100, 400], subtype: 'Widget' },
    ])
    const source = new Uint8Array([37, 80, 68, 70])
    const file = new File([source], 'fillable-form.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => source.buffer.slice(0) })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={vi.fn()} workspace={workspace} /></QueryClientProvider>)

    const region = await screen.findByRole('region', { name: 'Detected form fields' })
    expect(within(region).getByDisplayValue('Existing Name')).toBeInTheDocument()
    expect(within(region).getByPlaceholderText('Enter supervisor notes').tagName).toBe('TEXTAREA')
    fireEvent.change(within(region).getByRole('combobox', { name: /Whose form is this/i }), { target: { value: workspace.employees[0].id } })
    expect(within(region).getByDisplayValue('Existing Name')).toBeInTheDocument()
    const received = within(region).getByRole('checkbox', { name: /Employee received copy/i })
    expect(received).not.toBeChecked()
    fireEvent.click(received)
    expect(await screen.findByRole('button', { name: /Employee received copy on document: checked/i })).toBePressed()
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

  it('reports a completed filing immediately after the exact PDF is stored', async () => {
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
      return { documentId, operationId: '30000000-0000-4000-8000-000000000001', requestId: 'request', scanState: 'clean', versionId: '40000000-0000-4000-8000-000000000001' }
    })
    const onSaved = vi.fn()
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DocumentWorkbench initialFile={file} onClose={vi.fn()} onSaved={onSaved} workspace={workspace} /></QueryClientProvider>)

    await waitFor(() => expect(pdf.renderPage).toHaveBeenCalled())
    fireEvent.change(screen.getByPlaceholderText('Type the complete text here'), { target: { value: 'Stored round-trip marker 12345' } })
    fireEvent.pointerDown(document.querySelector<HTMLElement>('.document-workbench__sheet')!, { clientX: 100, clientY: 180, pointerId: 20 })
    fireEvent.click(screen.getByRole('tab', { name: 'File' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save to company documents' }))

    await screen.findByText('Saved to Company documents.')
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
    await waitFor(() => expect(pdf.getDocument).toHaveBeenLastCalledWith({ data: expect.any(Uint8Array) }))
    expect(URL.createObjectURL).not.toHaveBeenCalledWith(uploadedFile)
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
