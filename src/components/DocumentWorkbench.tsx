import '@fontsource/alex-brush/400.css'
import '@fontsource/allura/400.css'
import '@fontsource/dancing-script/600.css'
import '@fontsource/great-vibes/400.css'

import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePenLine,
  FileSignature,
  FolderInput,
  Redo2,
  Search,
  Send,
  Trash2,
  Type,
  Undo2,
  UploadCloud,
} from 'lucide-react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ModalDialog } from './ModalDialog'
import { createSignatureEnvelope, getDocumentStudioWorkspace, sendSignatureEnvelope } from '../data/documentStudio'
import { getHrDocumentWorkspace, uploadHrDocument, type HrDocumentWorkspace } from '../data/hrDocuments'
import {
  completedPdfFilename,
  createTypedSignaturePng,
  finalizePdf,
  type PdfAnnotation,
  type PdfAnnotationKind,
} from '../lib/pdfWorkbench'

GlobalWorkerOptions.workerSrc = workerUrl

type WorkbenchPanel = 'edit' | 'file' | 'send'
type RequiredAction = 'acknowledge' | 'approve' | 'certify' | 'review' | 'sign'
type SignatureFamily = 'Alex Brush' | 'Allura' | 'Dancing Script' | 'Great Vibes'

const signatureFamilies: SignatureFamily[] = ['Great Vibes', 'Dancing Script', 'Allura', 'Alex Brush']
const actionLabels: Record<RequiredAction, string> = {
  acknowledge: 'Acknowledge receipt',
  approve: 'Approve',
  certify: 'Certify',
  review: 'Review only',
  sign: 'Sign',
}

interface DocumentWorkbenchProps {
  employeeOnly?: boolean
  initialFile?: File | null
  initialTitle?: string
  onClose: () => void
  onSaved: () => void
  workspace: HrDocumentWorkspace
}

function friendlyError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function bytesAsFile(bytes: Uint8Array, title: string): File {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new File([copy.buffer], completedPdfFilename(title), { type: 'application/pdf' })
}

export function DocumentWorkbench({ employeeOnly = false, initialFile = null, initialTitle = '', onClose, onSaved, workspace }: DocumentWorkbenchProps) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const idempotencyKeysRef = useRef(new Map<string, string>())
  const [file, setFile] = useState<File | null>(initialFile)
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [sheetSize, setSheetSize] = useState({ height: 0, width: 0 })
  const [viewportWidth, setViewportWidth] = useState(0)
  const [rendering, setRendering] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [title, setTitle] = useState(initialTitle || initialFile?.name.replace(/\.pdf$/i, '') || '')
  const [panel, setPanel] = useState<WorkbenchPanel>(employeeOnly ? 'file' : 'edit')
  const [tool, setTool] = useState<PdfAnnotationKind | null>('text')
  const [textValue, setTextValue] = useState('')
  const [signatureName, setSignatureName] = useState('')
  const [signatureFamily, setSignatureFamily] = useState<SignatureFamily>('Great Vibes')
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([])
  const [redoStack, setRedoStack] = useState<PdfAnnotation[]>([])
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [employeeId, setEmployeeId] = useState(employeeOnly ? '' : 'company')
  const [category, setCategory] = useState('Business document')
  const [description, setDescription] = useState('')
  const [progress, setProgress] = useState(0)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const [savedDocument, setSavedDocument] = useState<{ employeeId: string; fingerprint: string; id: string } | null>(null)
  const [recipientSearch, setRecipientSearch] = useState('')
  const [recipientIds, setRecipientIds] = useState<string[]>([])
  const [requiredAction, setRequiredAction] = useState<RequiredAction>('sign')
  const [message, setMessage] = useState('Please review and complete this document in SygShift.')
  const [expiresAt, setExpiresAt] = useState('')

  const studio = useQuery({
    enabled: panel === 'send',
    queryFn: () => getDocumentStudioWorkspace(),
    queryKey: ['document-studio'],
  })
  const manageableVaults = workspace.vaults.filter((vault) => vault.canManage && vault.allowedMimeTypes.includes('application/pdf'))
  const selectedVault = manageableVaults.find((vault) => vault.code === 'hr-general') ?? manageableVaults[0]
  const filteredEmployees = useMemo(() => {
    const search = employeeSearch.trim().toLocaleLowerCase()
    return workspace.employees.filter((employee) => !search || `${employee.legalName} ${employee.employeeNumber ?? ''}`.toLocaleLowerCase().includes(search))
  }, [employeeSearch, workspace.employees])
  const filteredRecipients = useMemo(() => {
    const search = recipientSearch.trim().toLocaleLowerCase()
    return workspace.employees.filter((employee) => ['active', 'leave'].includes(employee.status) && (!search || `${employee.legalName} ${employee.employeeNumber ?? ''}`.toLocaleLowerCase().includes(search)))
  }, [recipientSearch, workspace.employees])
  const documentFingerprint = useMemo(() => JSON.stringify({
    annotations: annotations.map(({ fontFamily, kind, page: annotationPage, text, xRatio, yRatio }) => ({ fontFamily, kind, page: annotationPage, text, xRatio, yRatio })),
    category,
    description,
    employeeId,
    source: file ? `${file.name}:${file.size}:${file.lastModified}` : '',
    title,
  }), [annotations, category, description, employeeId, file, title])

  useEffect(() => {
    const container = viewportRef.current
    if (!container) return
    const update = () => setViewportWidth(Math.max(240, Math.floor(container.clientWidth)))
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [file])

  useEffect(() => {
    if (!file) {
      setSourceBytes(null)
      setPdf(null)
      return
    }
    let cancelled = false
    let loadingTask: ReturnType<typeof getDocument> | null = null
    setLoadError(null)
    setPage(1)
    setAnnotations([])
    setRedoStack([])
    void (async () => {
      try {
        if (file.type !== 'application/pdf' && !file.name.toLocaleLowerCase().endsWith('.pdf')) throw new Error('Choose a PDF so it can be opened, completed, and signed here.')
        const bytes = new Uint8Array(await file.arrayBuffer())
        const renderCopy = new Uint8Array(bytes.byteLength)
        renderCopy.set(bytes)
        loadingTask = getDocument({ data: renderCopy })
        const loaded = await loadingTask.promise
        if (cancelled) return
        setSourceBytes(bytes)
        setPdf(loaded)
      } catch (error) {
        if (!cancelled) setLoadError(friendlyError(error, 'This PDF could not be opened.'))
      }
    })()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      void loadingTask?.destroy()
    }
  }, [file])

  useEffect(() => {
    if (!pdf || !canvasRef.current || viewportWidth <= 0) return
    let cancelled = false
    let activeTask: RenderTask | null = null
    setRendering(true)
    void (async () => {
      try {
        const previous = renderTaskRef.current
        if (previous) {
          previous.cancel()
          await previous.promise.catch(() => undefined)
        }
        const pdfPage = await pdf.getPage(page)
        const base = pdfPage.getViewport({ scale: 1 })
        const cssWidth = Math.min(960, Math.max(220, viewportWidth - 30))
        const viewport = pdfPage.getViewport({ scale: cssWidth / base.width })
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const buffer = document.createElement('canvas')
        buffer.width = Math.max(1, Math.floor(viewport.width * ratio))
        buffer.height = Math.max(1, Math.floor(viewport.height * ratio))
        const context = buffer.getContext('2d', { alpha: false })
        if (!context) throw new Error('The document canvas is unavailable.')
        context.fillStyle = '#fff'
        context.fillRect(0, 0, buffer.width, buffer.height)
        activeTask = pdfPage.render({ canvas: buffer, canvasContext: context, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0], viewport })
        renderTaskRef.current = activeTask
        await activeTask.promise
        if (cancelled || !canvasRef.current) return
        const canvas = canvasRef.current
        canvas.width = buffer.width
        canvas.height = buffer.height
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        canvas.getContext('2d', { alpha: false })?.drawImage(buffer, 0, 0)
        setSheetSize({ height: viewport.height, width: viewport.width })
      } catch (error) {
        if (!cancelled && (error as { name?: string } | null)?.name !== 'RenderingCancelledException') setLoadError('This page could not be displayed. Choose the PDF again or download the original.')
      } finally {
        if (!cancelled) setRendering(false)
        if (renderTaskRef.current === activeTask) renderTaskRef.current = null
      }
    })()
    return () => {
      cancelled = true
      activeTask?.cancel()
    }
  }, [page, pdf, viewportWidth])

  async function createFinalFile(): Promise<File> {
    if (!sourceBytes || !title.trim()) throw new Error('Open a PDF and add a document title first.')
    return bytesAsFile(await finalizePdf(sourceBytes, annotations), title)
  }

  async function addAnnotation(event: ReactPointerEvent<HTMLDivElement>) {
    if (!tool || !sheetRef.current) return
    if (tool === 'text' && !textValue.trim()) { setLoadError('Type the text you want to add first.'); return }
    if (tool === 'signature' && !signatureName.trim()) { setLoadError('Type the signer name first.'); return }
    const bounds = sheetRef.current.getBoundingClientRect()
    let signaturePng: Uint8Array | undefined
    try {
      if (tool === 'signature') signaturePng = await createTypedSignaturePng(signatureName, signatureFamily)
    } catch (error) {
      setLoadError(friendlyError(error, 'The signature could not be generated.'))
      return
    }
    const value = tool === 'text' ? textValue.trim() : tool === 'date' ? new Intl.DateTimeFormat('en-US').format(new Date()) : tool === 'checkmark' ? '✓' : signatureName.trim()
    setAnnotations((current) => [...current, {
      id: crypto.randomUUID(),
      fontFamily: tool === 'signature' ? signatureFamily : undefined,
      kind: tool,
      page,
      signaturePng,
      text: value,
      xRatio: Math.min(.98, Math.max(.02, (event.clientX - bounds.left) / bounds.width)),
      yRatio: Math.min(.98, Math.max(.02, (event.clientY - bounds.top) / bounds.height)),
    }])
    setRedoStack([])
    setLoadError(null)
    if (tool === 'text') setTextValue('')
  }

  function chooseFile(nextFile: File | null) {
    if (!nextFile) return
    setFile(nextFile)
    setTitle(nextFile.name.replace(/\.pdf$/i, ''))
    setSavedMessage(null)
    setSavedDocument(null)
    idempotencyKeysRef.current.clear()
  }

  function undo() {
    setAnnotations((current) => {
      const removed = current.at(-1)
      if (!removed) return current
      setRedoStack((redo) => [...redo, removed])
      return current.slice(0, -1)
    })
  }

  function redo() {
    setRedoStack((current) => {
      const restored = current.at(-1)
      if (!restored) return current
      setAnnotations((items) => [...items, restored])
      return current.slice(0, -1)
    })
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!selectedVault) throw new Error('No document filing area is available for this PDF.')
      if (!employeeId) throw new Error('Choose the employee whose file should receive this document.')
      const finished = await createFinalFile()
      const idempotencyKey = idempotencyKeysRef.current.get(`save:${documentFingerprint}`) ?? crypto.randomUUID()
      idempotencyKeysRef.current.set(`save:${documentFingerprint}`, idempotencyKey)
      return uploadHrDocument({
        accessClassification: selectedVault.classification,
        category,
        description,
        employeeId: employeeId === 'company' ? null : employeeId,
        file: finished,
        documentId: savedDocument?.employeeId === employeeId ? savedDocument.id : null,
        idempotencyKey,
        replacementReason: savedDocument?.employeeId === employeeId ? 'Updated from the Document Center workbench.' : null,
        title,
        vaultCode: selectedVault.code,
      }, setProgress)
    },
    onSuccess: async (result) => {
      const owner = employeeId === 'company' ? 'Company documents' : workspace.employees.find((employee) => employee.id === employeeId)?.legalName ?? 'the employee file'
      setSavedDocument({ employeeId, fingerprint: documentFingerprint, id: result.documentId })
      setSavedMessage(`Saved to ${owner}. It will appear in the document list automatically.`)
      await queryClient.invalidateQueries({ queryKey: ['hr-documents'] })
      onSaved()
    },
  })

  const sendDocument = useMutation({
    mutationFn: async () => {
      if (!selectedVault) throw new Error('No document filing area is available for this PDF.')
      if (!recipientIds.length) throw new Error('Choose at least one recipient.')
      const standardPolicy = studio.data?.policies.find((policy) => policy.active && policy.code === 'STANDARD_EMPLOYEE_ELECTRONIC_SIGNATURE')
        ?? studio.data?.policies.find((policy) => policy.active && policy.code === 'EMPLOYEE_ACK')
        ?? studio.data?.policies.find((policy) => policy.active && policy.executionMethod === 'electronic')
      if (!standardPolicy) throw new Error('Document sending is temporarily unavailable. Your PDF can still be downloaded or saved to an employee file.')
      const finished = await createFinalFile()
      const filingEmployeeId = employeeId || 'company'
      let documentId = savedDocument?.fingerprint === documentFingerprint ? savedDocument.id : null
      if (!documentId) {
        const idempotencyKey = idempotencyKeysRef.current.get(`send-upload:${documentFingerprint}`) ?? crypto.randomUUID()
        idempotencyKeysRef.current.set(`send-upload:${documentFingerprint}`, idempotencyKey)
        const uploaded = await uploadHrDocument({
          accessClassification: selectedVault.classification,
          category,
          description,
          documentId: savedDocument?.employeeId === filingEmployeeId ? savedDocument.id : null,
          employeeId: filingEmployeeId !== 'company' ? filingEmployeeId : null,
          file: finished,
          idempotencyKey,
          replacementReason: savedDocument?.employeeId === filingEmployeeId ? 'Updated for delivery from the Document Center workbench.' : null,
          title,
          vaultCode: selectedVault.code,
        }, setProgress)
        documentId = uploaded.documentId
        setSavedDocument({ employeeId: filingEmployeeId, fingerprint: documentFingerprint, id: uploaded.documentId })
      }

      let ready = false
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const current = await getHrDocumentWorkspace({ page: 1, pageSize: 20, search: title.trim().slice(0, 120) })
        const stored = current.documents.find((document) => document.id === documentId)
        if (stored?.version?.scanState === 'clean') { ready = true; break }
        if (stored?.version?.scanState === 'rejected') throw new Error('This file could not be accepted. Download it, check the PDF, and try again.')
        await delay(2_000)
      }
      if (!ready) throw new Error('The PDF was saved, but delivery is taking longer than expected. It remains in Saved documents and can be sent from Signature requests once ready.')

      const deliveryFingerprint = JSON.stringify({ documentFingerprint, expiresAt, message, recipientIds: [...recipientIds].sort(), requiredAction })
      const envelopeKey = idempotencyKeysRef.current.get(`send-envelope:${deliveryFingerprint}`) ?? crypto.randomUUID()
      idempotencyKeysRef.current.set(`send-envelope:${deliveryFingerprint}`, envelopeKey)
      const created = await createSignatureEnvelope({
        documentId,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        idempotencyKey: envelopeKey,
        message: message.trim(),
        policyId: standardPolicy.id,
        recipients: recipientIds.map((recipientId) => ({
          authenticationTier: standardPolicy.authenticationTier,
          employeeId: recipientId,
          recipientRole: 'employee',
          requiredAction,
          routingOrder: 1,
        })),
        templateVersionId: null,
        title: title.trim(),
      })
      if (typeof created.id !== 'string') throw new Error('The document was prepared, but the delivery confirmation was invalid.')
      await sendSignatureEnvelope(created.id)
    },
    onSuccess: async () => {
      setSavedMessage(`Sent to ${recipientIds.length} ${recipientIds.length === 1 ? 'employee' : 'employees'}. The request is now tracked under Signature requests.`)
      setRecipientIds([])
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['document-studio'] }),
        queryClient.invalidateQueries({ queryKey: ['hr-documents'] }),
        queryClient.invalidateQueries({ queryKey: ['my-documents'] }),
        queryClient.invalidateQueries({ queryKey: ['my-notifications'] }),
      ])
      onSaved()
    },
  })

  async function download() {
    try {
      const finished = await createFinalFile()
      const url = URL.createObjectURL(finished)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = finished.name
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
      setSavedMessage('Downloaded. You can keep working or choose another destination.')
    } catch (error) {
      setLoadError(friendlyError(error, 'The completed PDF could not be downloaded.'))
    }
  }

  const visibleAnnotations = annotations.filter((annotation) => annotation.page === page)
  const busy = save.isPending || sendDocument.isPending
  const operationError = save.error ?? sendDocument.error

  return <ModalDialog
    busy={busy}
    busyLabel={save.isPending ? `Saving document… ${progress}%` : progress < 100 ? `Preparing document… ${progress}%` : 'Sending document…'}
    className="document-workbench"
    description={file ? 'Type, sign, download, send, or add this PDF to an employee file from one place.' : 'Choose a PDF from your device. It opens immediately so you can work without a setup process.'}
    dismissible={!busy}
    headingIcon={<FilePenLine />}
    onClose={onClose}
    title={file ? title || 'Work on document' : employeeOnly ? 'Add to an employee file' : 'Open a document'}
  >
    {!file ? <div className="document-workbench__start">
      <div className={`document-workbench__dropzone${dragActive ? ' active' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }} onDragLeave={() => setDragActive(false)} onDragOver={(event) => event.preventDefault()} onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragActive(false); chooseFile(event.dataTransfer.files.item(0)) }}>
        <input accept="application/pdf,.pdf" hidden onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)} ref={inputRef} type="file" />
        <UploadCloud aria-hidden="true" size={42} />
        <h3>Drop a PDF here</h3>
        <p>Or choose one from your computer. It will open here immediately.</p>
        <button className="primary-action" data-dialog-autofocus onClick={() => inputRef.current?.click()} type="button">Choose PDF</button>
      </div>
      <div className="document-workbench__start-notes"><span><CheckCircle2 size={18} />Type directly on the document</span><span><CheckCircle2 size={18} />Create a signature from a typed name</span><span><CheckCircle2 size={18} />Download, send, or add to an employee file</span></div>
    </div> : <div className="document-workbench__body">
      <header className="document-workbench__toolbar">
        <div className="document-workbench__paging">
          <button aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button"><ChevronLeft size={18} /></button>
          <strong>Page {page} of {pdf?.numPages ?? '—'}</strong>
          <button aria-label="Next page" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((current) => Math.min(pdf?.numPages ?? current, current + 1))} type="button"><ChevronRight size={18} /></button>
        </div>
        <div className="document-workbench__history">
          <button aria-label="Undo" disabled={!annotations.length} onClick={undo} title="Undo" type="button"><Undo2 size={18} /></button>
          <button aria-label="Redo" disabled={!redoStack.length} onClick={redo} title="Redo" type="button"><Redo2 size={18} /></button>
          <button aria-label="Clear all additions" disabled={!annotations.length} onClick={() => { setAnnotations([]); setRedoStack([]) }} title="Clear all additions" type="button"><Trash2 size={18} /></button>
        </div>
        <button className="secondary-button secondary-button--small" onClick={() => inputRef.current?.click()} type="button">Choose another PDF</button>
        <input accept="application/pdf,.pdf" hidden onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)} ref={inputRef} type="file" />
      </header>

      <div className="document-workbench__main">
        <section className="document-workbench__document" aria-busy={rendering} ref={viewportRef}>
          {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}
          {!pdf && !loadError ? <p className="document-workbench__loading">Opening PDF…</p> : null}
          <div className={`document-workbench__sheet${tool ? ' is-placing' : ''}`} onPointerDown={(event) => void addAnnotation(event)} ref={sheetRef} style={{ height: sheetSize.height || undefined, width: sheetSize.width || undefined }}>
            <canvas hidden={!pdf || !sheetSize.width} ref={canvasRef} />
            {visibleAnnotations.map((annotation) => <button
              aria-label={`Remove ${annotation.kind}: ${annotation.text}`}
              className={`document-workbench__annotation is-${annotation.kind}`}
              key={annotation.id}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setAnnotations((current) => current.filter((item) => item.id !== annotation.id))}
              style={{ left: `${annotation.xRatio * 100}%`, top: `${annotation.yRatio * 100}%`, ...(annotation.kind === 'signature' ? { fontFamily: `"${annotation.fontFamily ?? signatureFamily}", cursive` } : {}) }}
              title="Click to remove"
              type="button"
            >{annotation.text}</button>)}
          </div>
        </section>

        <aside className="document-workbench__side">
          <div className="document-workbench__side-tabs" role="tablist" aria-label="Document actions">
            <button aria-selected={panel === 'edit'} className={panel === 'edit' ? 'active' : ''} onClick={() => setPanel('edit')} role="tab" type="button"><FilePenLine size={17} />Edit</button>
            <button aria-selected={panel === 'file'} className={panel === 'file' ? 'active' : ''} onClick={() => setPanel('file')} role="tab" type="button"><FolderInput size={17} />File</button>
            <button aria-selected={panel === 'send'} className={panel === 'send' ? 'active' : ''} onClick={() => setPanel('send')} role="tab" type="button"><Send size={17} />Send</button>
          </div>

          {panel === 'edit' ? <div className="document-workbench__panel">
            <div><p className="eyebrow">Add to the PDF</p><h3>Choose a tool, then click the page</h3><p>Every addition can be undone or removed before you finish.</p></div>
            <div className="document-workbench__tools">
              <button aria-pressed={tool === 'text'} className={tool === 'text' ? 'active' : ''} onClick={() => setTool('text')} type="button"><Type size={18} /><span>Text</span></button>
              <button aria-pressed={tool === 'signature'} className={tool === 'signature' ? 'active' : ''} onClick={() => setTool('signature')} type="button"><FileSignature size={18} /><span>Signature</span></button>
              <button aria-pressed={tool === 'date'} className={tool === 'date' ? 'active' : ''} onClick={() => setTool('date')} type="button"><CalendarDays size={18} /><span>Date</span></button>
              <button aria-pressed={tool === 'checkmark'} className={tool === 'checkmark' ? 'active' : ''} onClick={() => setTool('checkmark')} type="button"><Check size={18} /><span>Check</span></button>
            </div>
            {tool === 'text' ? <label className="document-workbench__field">Text to add<input maxLength={240} onChange={(event) => setTextValue(event.target.value)} placeholder="Type here" value={textValue} /></label> : null}
            {tool === 'signature' ? <div className="document-workbench__signature">
              <label className="document-workbench__field">Signer name<input maxLength={120} onChange={(event) => setSignatureName(event.target.value)} placeholder="Type the full name" value={signatureName} /></label>
              <div className="document-workbench__signature-preview" style={{ fontFamily: `"${signatureFamily}", cursive` }}>{signatureName || 'Your signature'}</div>
              <div className="document-workbench__signature-styles" aria-label="Signature style">{signatureFamilies.map((family) => <button aria-pressed={signatureFamily === family} className={signatureFamily === family ? 'active' : ''} key={family} onClick={() => setSignatureFamily(family)} style={{ fontFamily: `"${family}", cursive` }} type="button">{signatureName || 'Signature'}</button>)}</div>
            </div> : null}
            <p className="document-workbench__tip">Tip: additions on the page are removable—click one to take it off.</p>
          </div> : null}

          {panel === 'file' ? <div className="document-workbench__panel">
            <div><p className="eyebrow">Save to SygShift</p><h3>{employeeOnly ? 'Add to an employee file' : 'Choose where this belongs'}</h3><p>The filing area is selected automatically. Choose only the person or company record.</p></div>
            <label className="document-workbench__field">Document title<input maxLength={160} onChange={(event) => setTitle(event.target.value)} value={title} /></label>
            {!employeeOnly ? <label className="document-workbench__choice"><input checked={employeeId === 'company'} onChange={() => setEmployeeId('company')} type="radio" /><span><strong>Company documents</strong><small>Shared company record</small></span></label> : null}
            <label className="document-workbench__field">Find an employee<div className="document-workbench__search"><Search size={17} /><input maxLength={120} onChange={(event) => setEmployeeSearch(event.target.value)} placeholder="Search by name or employee number" value={employeeSearch} /></div></label>
            <div className="document-workbench__people">{filteredEmployees.map((employee) => <label className="document-workbench__choice" key={employee.id}><input checked={employeeId === employee.id} onChange={() => setEmployeeId(employee.id)} type="radio" /><span><strong>{employee.legalName}</strong><small>{employee.employeeNumber ?? 'Employee record'}</small></span></label>)}</div>
            <label className="document-workbench__field">Document type<select onChange={(event) => setCategory(event.target.value)} value={category}><option>Business document</option><option>Proposal</option><option>Employment document</option><option>Policy or acknowledgment</option><option>Training document</option><option>Other</option></select></label>
            <label className="document-workbench__field">Note <span>Optional</span><textarea maxLength={1000} onChange={(event) => setDescription(event.target.value)} placeholder="Add a short internal note" rows={3} value={description} /></label>
            <button className="primary-action document-workbench__wide-action" disabled={!employeeId || !title.trim() || save.isPending || savedDocument?.fingerprint === documentFingerprint} onClick={() => save.mutate()} type="button"><FolderInput size={18} />{savedDocument?.fingerprint === documentFingerprint ? 'Saved' : employeeId === 'company' ? 'Save to company documents' : 'Add to employee file'}</button>
          </div> : null}

          {panel === 'send' ? <div className="document-workbench__panel">
            <div><p className="eyebrow">Send from SygShift</p><h3>Who needs this document?</h3><p>Choose the people and what they need to do. SygShift handles the delivery details.</p></div>
            <label className="document-workbench__field">Action<select onChange={(event) => setRequiredAction(event.target.value as RequiredAction)} value={requiredAction}>{Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="document-workbench__field">Find recipients<div className="document-workbench__search"><Search size={17} /><input maxLength={120} onChange={(event) => setRecipientSearch(event.target.value)} placeholder="Search employees" value={recipientSearch} /></div></label>
            <div className="document-workbench__people"><p>{recipientIds.length} selected</p>{filteredRecipients.map((employee) => <label className="document-workbench__choice" key={employee.id}><input checked={recipientIds.includes(employee.id)} onChange={() => setRecipientIds((current) => current.includes(employee.id) ? current.filter((id) => id !== employee.id) : current.length < 25 ? [...current, employee.id] : current)} type="checkbox" /><span><strong>{employee.legalName}</strong><small>{employee.employeeNumber ?? 'Active employee'}</small></span></label>)}</div>
            <label className="document-workbench__field">Message <span>Optional</span><textarea maxLength={2000} onChange={(event) => setMessage(event.target.value)} rows={3} value={message} /></label>
            <label className="document-workbench__field">Due date <span>Optional</span><input onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" value={expiresAt} /></label>
            {studio.isError ? <p className="form-error">Document sending is temporarily unavailable. Download and filing still work.</p> : null}
            <button className="primary-action document-workbench__wide-action" disabled={!recipientIds.length || !title.trim() || !studio.data || sendDocument.isPending} onClick={() => sendDocument.mutate()} type="button"><Send size={18} />Send document</button>
          </div> : null}
        </aside>
      </div>

      <footer className="document-workbench__footer">
        <div aria-live="polite">{savedMessage ? <span className="document-workbench__success"><CheckCircle2 size={18} />{savedMessage}</span> : <span>{annotations.length} {annotations.length === 1 ? 'addition' : 'additions'} · Changes are applied when you download, send, or file the PDF.</span>}</div>
        {operationError ? <p className="form-error" role="alert">{friendlyError(operationError, 'The document action could not be completed.')}</p> : null}
        <div><button className="secondary-button" disabled={busy} onClick={onClose} type="button">Close</button><button className="primary-action" disabled={!sourceBytes || !title.trim() || busy} onClick={() => void download()} type="button"><Download size={18} />Download PDF</button></div>
      </footer>
    </div>}
  </ModalDialog>
}
