import '@fontsource/alex-brush/400.css'
import '@fontsource/allura/400.css'
import '@fontsource/dancing-script/600.css'
import '@fontsource/great-vibes/400.css'

import { useEffect, useMemo, useRef, useState, type ChangeEvent as ReactChangeEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FilePenLine,
  FileSignature,
  FolderInput,
  Maximize2,
  Minimize2,
  Minus,
  Move,
  Plus,
  Redo2,
  Scaling,
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
import { SecurePdfViewer } from './SecurePdfViewer'
import { createSignatureEnvelope, getDocumentStudioWorkspace, sendSignatureEnvelope } from '../data/documentStudio'
import { getHrDocumentBlob, getHrDocumentWorkspace, uploadHrDocument, type HrDocumentWorkspace } from '../data/hrDocuments'
import {
  completedPdfFilename,
  createTypedSignaturePng,
  DEFAULT_SIGNATURE_WIDTH_RATIO,
  DEFAULT_TEXT_FONT_SIZE,
  DEFAULT_TEXT_WIDTH_RATIO,
  finalizePdf,
  movePdfAnnotation,
  resizePdfAnnotation,
  resizePdfTextAnnotation,
  type PdfAnnotation,
  type PdfAnnotationKind,
} from '../lib/pdfWorkbench'

GlobalWorkerOptions.workerSrc = workerUrl

type WorkbenchPanel = 'edit' | 'file' | 'send'
type RequiredAction = 'acknowledge' | 'approve' | 'certify' | 'review' | 'sign'
type SignatureFamily = 'Alex Brush' | 'Allura' | 'Dancing Script' | 'Great Vibes'

interface AnnotationGesture {
  annotationId: string
  changed: boolean
  mode: 'move' | 'resize'
  originalAnnotations: PdfAnnotation[]
  pointerId: number
  sheetHeight: number
  sheetWidth: number
  startClientX: number
  startClientY: number
  startWidthRatio: number
  startXRatio: number
  startYRatio: number
}

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
  initialEmployeeId?: string
  initialFile?: File | null
  initialTitle?: string
  onClose: () => void
  onSaved: () => void
  workspace: HrDocumentWorkspace
}

interface DetectedTemplateField {
  boxHeightRatio: number
  controlType: 'checkbox' | 'choice' | 'long_text' | 'signature' | 'text'
  defaultValue?: string
  eraseHeightRatio: number
  eraseWidthRatio: number
  fontSize: number
  id: string
  label: string
  nativeFieldName?: string
  options?: Array<{ label: string; value: string }>
  page: number
  widthRatio: number
  xRatio: number
  yRatio: number
}

function humanizePdfFieldName(value: string): string {
  const leaf = value.split('.').at(-1) ?? value
  const cleaned = leaf
    .replace(/\[\d+\]$/g, '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'Document field'
  return cleaned.replace(/\b\w/g, (letter) => letter.toLocaleUpperCase())
}

function inferredControlType(label: string): DetectedTemplateField['controlType'] {
  if (!/\bdate\b/i.test(label) && /enter\s*\/\s*sign|\b(?:sign|signature|initials?)\b/i.test(label)) return 'signature'
  return /(describe|description|details|explain|explanation|facts|narrative|notes?|reason|statement|summary)/i.test(label)
    ? 'long_text'
    : 'text'
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

function bytesAsDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192))
  }
  return `data:${mimeType};base64,${window.btoa(binary)}`
}

function SignatureImage({ annotation }: { annotation: PdfAnnotation }) {
  const source = useMemo(() => annotation.signaturePng ? bytesAsDataUrl(annotation.signaturePng, 'image/png') : null, [annotation.signaturePng])
  return source ? <img alt="" draggable={false} src={source} /> : <span>{annotation.text}</span>
}

async function detectTemplateFields(pdf: PDFDocumentProxy): Promise<DetectedTemplateField[]> {
  const fields: DetectedTemplateField[] = []
  const seen = new Set<string>()
  const seenNativeNames = new Set<string>()
  for (let pageNumber = 1; pageNumber <= pdf.numPages && fields.length < 80; pageNumber += 1) {
    const pdfPage = await pdf.getPage(pageNumber)
    const viewport = pdfPage.getViewport({ scale: 1 })
    if (typeof pdfPage.getAnnotations === 'function') {
      const widgets = await pdfPage.getAnnotations({ intent: 'display' }).catch(() => [])
      for (const widget of widgets) {
        if (!widget || widget.subtype !== 'Widget' || typeof widget.fieldName !== 'string' || seenNativeNames.has(widget.fieldName) || !Array.isArray(widget.rect)) continue
        const fieldType = widget.fieldType === 'Tx'
          ? widget.multiLine ? 'long_text' : 'text'
          : widget.fieldType === 'Btn' && widget.checkBox
            ? 'checkbox'
            : widget.fieldType === 'Ch'
              ? 'choice'
              : widget.fieldType === 'Sig'
                ? 'signature'
              : null
        if (!fieldType) continue
        const rect = widget.rect.map(Number)
        const firstCorner = viewport.convertToViewportPoint(rect[0], rect[1])
        const secondCorner = viewport.convertToViewportPoint(rect[2], rect[3])
        const converted = [...firstCorner, ...secondCorner]
        const left = Math.max(0, Math.min(converted[0], converted[2]))
        const top = Math.max(0, Math.min(converted[1], converted[3]))
        const width = Math.max(18, Math.abs(converted[2] - converted[0]))
        const height = Math.max(12, Math.abs(converted[3] - converted[1]))
        const label = typeof widget.alternativeText === 'string' && widget.alternativeText.trim()
          ? widget.alternativeText.trim()
          : humanizePdfFieldName(widget.fieldName)
        const options = Array.isArray(widget.options)
          ? widget.options.map((option: unknown) => {
              const record = option && typeof option === 'object' ? option as Record<string, unknown> : {}
              const value = typeof record.exportValue === 'string' ? record.exportValue : typeof record.displayValue === 'string' ? record.displayValue : ''
              const optionLabel = typeof record.displayValue === 'string' ? record.displayValue : value
              return { label: optionLabel, value }
            }).filter((option: { value: string }) => option.value)
          : undefined
        seenNativeNames.add(widget.fieldName)
        fields.push({
          boxHeightRatio: Math.min(.4, height / viewport.height),
          controlType: fieldType,
          defaultValue: fieldType === 'checkbox' ? String(Boolean(widget.fieldValue && widget.fieldValue !== 'Off')) : typeof widget.fieldValue === 'string' ? widget.fieldValue : '',
          eraseHeightRatio: 0,
          eraseWidthRatio: 0,
          fontSize: Math.max(8, Math.min(15, Math.round(height * .65))),
          id: `native:${widget.fieldName}`,
          label,
          nativeFieldName: widget.fieldName,
          options,
          page: pageNumber,
          widthRatio: Math.min(.88, width / viewport.width),
          xRatio: Math.max(.01, Math.min(.97, left / viewport.width)),
          yRatio: Math.max(.01, Math.min(.97, top / viewport.height)),
        })
      }
    }
    if (typeof pdfPage.getTextContent !== 'function') continue
    const content = await pdfPage.getTextContent()
    const positionedText = content.items.flatMap((contentItem) => {
      if (!('str' in contentItem) || !contentItem.str.trim() || !Array.isArray(contentItem.transform)) return []
      const contentHeight = Math.max(Math.abs(Number(contentItem.height) || Number(contentItem.transform[3]) || 0), 9)
      const contentWidth = Math.max(Number(contentItem.width) || 0, contentHeight)
      const [contentX, contentBaselineY] = viewport.convertToViewportPoint(Number(contentItem.transform[4]) || 0, Number(contentItem.transform[5]) || 0)
      return [{
        heightRatio: Math.max(.012, contentHeight / viewport.height),
        leftRatio: Math.max(0, Math.min(1, contentX / viewport.width)),
        text: contentItem.str.replace(/\s+/g, ' ').trim(),
        topRatio: Math.max(0, Math.min(1, (contentBaselineY - contentHeight * 1.08) / viewport.height)),
        widthRatio: Math.max(.012, contentWidth / viewport.width),
      }]
    })
    const followingTextTops = positionedText.map((item) => item.topRatio).sort((left, right) => left - right)
    for (const item of content.items) {
      if (!('str' in item) || !item.str.includes('[') || !Array.isArray(item.transform)) continue
      const expression = /\[([^\]\r\n]{2,160})\]/g
      let match: RegExpExecArray | null
      while ((match = expression.exec(item.str)) && fields.length < 80) {
        const label = match[1].replace(/\s+/g, ' ').trim()
        if (!label) continue
        const itemWidth = Math.max(Number(item.width) || 0, 24)
        const itemHeight = Math.max(Math.abs(Number(item.height) || Number(item.transform[3]) || 0), 9)
        const startFraction = match.index / Math.max(item.str.length, 1)
        const widthFraction = match[0].length / Math.max(item.str.length, 1)
        const [baselineX, baselineY] = viewport.convertToViewportPoint(Number(item.transform[4]) || 0, Number(item.transform[5]) || 0)
        const xRatio = Math.max(.01, Math.min(.92, (baselineX + itemWidth * startFraction) / viewport.width))
        const controlType = inferredControlType(label)
        const promptWidth = Math.max(.08, Math.min(.7, (itemWidth * widthFraction + 10) / viewport.width))
        const detectedWidth = controlType === 'long_text'
          ? Math.max(promptWidth, Math.min(.72, .94 - xRatio))
          : controlType === 'signature'
            ? Math.max(promptWidth, Math.min(.28, .94 - xRatio))
            : Math.max(promptWidth, Math.min(.2, .94 - xRatio))
        const yRatio = Math.max(.01, Math.min(.97, (baselineY - itemHeight * 1.08) / viewport.height))
        const nextTextTop = controlType === 'long_text'
          ? followingTextTops.find((candidate) => candidate > yRatio + Math.max(.03, itemHeight * 2 / viewport.height))
          : undefined
        const boundedLongTextHeight = nextTextTop === undefined
          ? Math.max(.06, Math.min(.18, .92 - yRatio))
          : Math.max(.045, Math.min(.18, nextTextTop - yRatio - .008))
        const key = `${pageNumber}:${Math.round(xRatio * 1_000)}:${Math.round(yRatio * 1_000)}:${label.toLocaleLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        fields.push({
          boxHeightRatio: controlType === 'long_text'
            ? boundedLongTextHeight
            : Math.max(.018, Math.min(.05, itemHeight * 1.55 / viewport.height)),
          controlType,
          eraseHeightRatio: Math.max(.018, Math.min(.08, itemHeight * 1.45 / viewport.height)),
          eraseWidthRatio: Math.max(promptWidth, Math.min(.72, (itemWidth * widthFraction + 14) / viewport.width)),
          fontSize: Math.max(8, Math.min(15, Math.round(itemHeight))),
          id: key,
          label,
          page: pageNumber,
          widthRatio: Math.min(detectedWidth, .98 - xRatio),
          xRatio,
          yRatio,
        })
      }
    }
    for (const item of positionedText) {
      const symbol = /[☐☑□■]/u.exec(item.text)
      if (!symbol || fields.length >= 80) continue
      const afterSymbol = item.text.slice(symbol.index + symbol[0].length).trim()
      const beforeSymbol = item.text.slice(0, symbol.index).trim()
      const adjacentLabel = positionedText
        .filter((candidate) => candidate !== item
          && Math.abs(candidate.topRatio - item.topRatio) <= Math.max(.012, item.heightRatio)
          && candidate.leftRatio > item.leftRatio
          && candidate.leftRatio - item.leftRatio < .35)
        .sort((left, right) => left.leftRatio - right.leftRatio)[0]?.text
      const label = (afterSymbol || beforeSymbol || adjacentLabel || 'Checkbox').slice(0, 160)
      const symbolFraction = symbol.index / Math.max(1, item.text.length)
      const xRatio = Math.max(.01, Math.min(.97, item.leftRatio + item.widthRatio * symbolFraction))
      const yRatio = Math.max(.01, Math.min(.97, item.topRatio))
      const key = `checkbox:${pageNumber}:${Math.round(xRatio * 1_000)}:${Math.round(yRatio * 1_000)}:${label.toLocaleLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      fields.push({
        boxHeightRatio: Math.max(.016, Math.min(.04, item.heightRatio * 1.25)),
        controlType: 'checkbox',
        defaultValue: String(/[☑■]/u.test(symbol[0])),
        eraseHeightRatio: 0,
        eraseWidthRatio: 0,
        fontSize: Math.max(8, Math.min(15, Math.round(item.heightRatio * viewport.height))),
        id: key,
        label,
        page: pageNumber,
        widthRatio: Math.max(.016, Math.min(.04, item.heightRatio * viewport.height / viewport.width * 1.25)),
        xRatio,
        yRatio,
      })
    }
  }
  return fields
}

export function DocumentWorkbench({ employeeOnly = false, initialEmployeeId, initialFile = null, initialTitle = '', onClose, onSaved, workspace }: DocumentWorkbenchProps) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const gestureRef = useRef<AnnotationGesture | null>(null)
  const annotationsRef = useRef<PdfAnnotation[]>([])
  const idempotencyKeysRef = useRef(new Map<string, string>())
  const finalFileCacheRef = useRef<{ file: File; fingerprint: string } | null>(null)
  const [file, setFile] = useState<File | null>(initialFile)
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [sheetSize, setSheetSize] = useState({ height: 0, width: 0 })
  const [sheetScale, setSheetScale] = useState(1)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [rendering, setRendering] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [title, setTitle] = useState(initialTitle || initialFile?.name.replace(/\.pdf$/i, '') || '')
  const [panel, setPanel] = useState<WorkbenchPanel>(employeeOnly ? 'file' : 'edit')
  const [maximized, setMaximized] = useState(false)
  const [tool, setTool] = useState<PdfAnnotationKind | null>('text')
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [selectedTemplateFieldId, setSelectedTemplateFieldId] = useState<string | null>(null)
  const [textValue, setTextValue] = useState('')
  const [signatureName, setSignatureName] = useState('')
  const [signatureFamily, setSignatureFamily] = useState<SignatureFamily>('Great Vibes')
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([])
  const [templateFields, setTemplateFields] = useState<DetectedTemplateField[]>([])
  const [undoHistory, setUndoHistory] = useState<PdfAnnotation[][]>([])
  const [redoHistory, setRedoHistory] = useState<PdfAnnotation[][]>([])
  const initialEmployee = workspace.employees.find((employee) => employee.id === initialEmployeeId)
  const [employeeSearch, setEmployeeSearch] = useState(initialEmployee?.legalName ?? '')
  const [employeeId, setEmployeeId] = useState(initialEmployee?.id ?? (employeeOnly ? '' : 'company'))
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
  const [preview, setPreview] = useState<{ bytes: Uint8Array; fingerprint: string } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

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
    annotations: annotations.map(({ boxHeightRatio, eraseHeightRatio, eraseWidthRatio, eraseXRatio, eraseYRatio, fieldLabel, fitMode, fontFamily, fontSize, kind, nativeFieldName, nativeFieldType, page: annotationPage, templateFieldKey, text, widthRatio, xRatio, yRatio }) => ({ boxHeightRatio, eraseHeightRatio, eraseWidthRatio, eraseXRatio, eraseYRatio, fieldLabel, fitMode, fontFamily, fontSize, kind, nativeFieldName, nativeFieldType, page: annotationPage, templateFieldKey, text, widthRatio, xRatio, yRatio })),
    category,
    description,
    employeeId,
    source: file ? `${file.name}:${file.size}:${file.lastModified}` : '',
    title,
  }), [annotations, category, description, employeeId, file, title])
  const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null

  useEffect(() => {
    annotationsRef.current = annotations
    if (selectedAnnotationId && !annotations.some((annotation) => annotation.id === selectedAnnotationId)) setSelectedAnnotationId(null)
  }, [annotations, selectedAnnotationId])

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
    annotationsRef.current = []
    setUndoHistory([])
    setRedoHistory([])
    setSelectedAnnotationId(null)
    setSelectedTemplateFieldId(null)
    setTemplateFields([])
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
        const detected = await detectTemplateFields(loaded)
        if (!cancelled) {
          setTemplateFields(detected)
          if (detected.length) setTool(null)
        }
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
        setSheetScale(viewport.width / base.width)
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
  }, [page, pdf, viewportWidth, maximized])

  async function createFinalFile(): Promise<File> {
    if (!sourceBytes || !title.trim()) throw new Error('Open a PDF and add a document title first.')
    if (finalFileCacheRef.current?.fingerprint === documentFingerprint) return finalFileCacheRef.current.file
    const finished = bytesAsFile(await finalizePdf(sourceBytes, annotations), title)
    finalFileCacheRef.current = { file: finished, fingerprint: documentFingerprint }
    return finished
  }

  async function fileChecksum(value: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await value.arrayBuffer())
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  async function verifyStoredDocument(documentId: string, expected: File, expectedTitle: string): Promise<void> {
    let ready = false
    for (let attempt = 0; attempt < 45; attempt += 1) {
      const current = await getHrDocumentWorkspace({ page: 1, pageSize: 20, search: expectedTitle.trim().slice(0, 120) })
      const stored = current.documents.find((document) => document.id === documentId)
      if (stored?.version?.scanState === 'clean') { ready = true; break }
      if (stored?.version?.scanState === 'rejected') throw new Error('This file could not be accepted. Download it, check the PDF, and try again.')
      await delay(2_000)
    }
    if (!ready) throw new Error('The PDF is still being prepared. It remains safely saved and can be opened from Saved documents when preparation finishes.')
    const stored = await getHrDocumentBlob(documentId, 'preview')
    const [expectedChecksum, storedChecksum] = await Promise.all([fileChecksum(expected), fileChecksum(stored.blob)])
    if (expected.size !== stored.blob.size || expectedChecksum !== storedChecksum) {
      throw new Error('The saved copy did not match the completed PDF. Keep this window open and try saving again.')
    }
  }

  async function openPreview() {
    setPreviewBusy(true)
    setPreviewError(null)
    try {
      const finished = await createFinalFile()
      setPreview({ bytes: new Uint8Array(await finished.arrayBuffer()), fingerprint: documentFingerprint })
    } catch (error) {
      setPreviewError(friendlyError(error, 'The completed PDF could not be previewed.'))
    } finally {
      setPreviewBusy(false)
    }
  }

  function closePreview() {
    setPreview(null)
  }

  function setAnnotationSnapshot(next: PdfAnnotation[]) {
    annotationsRef.current = next
    setAnnotations(next)
  }

  function commitAnnotationSnapshot(next: PdfAnnotation[]) {
    const current = annotationsRef.current
    if (next === current) return
    setUndoHistory((history) => [...history, current].slice(-60))
    setRedoHistory([])
    setAnnotationSnapshot(next)
  }

  function updateAnnotation(id: string, update: (annotation: PdfAnnotation) => PdfAnnotation) {
    commitAnnotationSnapshot(annotationsRef.current.map((annotation) => annotation.id === id ? update(annotation) : annotation))
  }

  function templateAnnotation(field: DetectedTemplateField, value: string): PdfAnnotation {
    return {
      boxHeightRatio: field.boxHeightRatio,
      eraseHeightRatio: field.nativeFieldName ? undefined : field.eraseHeightRatio,
      eraseWidthRatio: field.nativeFieldName ? undefined : field.eraseWidthRatio,
      fieldLabel: field.label,
      fitMode: field.controlType === 'long_text' ? 'bounded' : 'single-line',
      fontSize: field.fontSize,
      id: `template:${field.id}`,
      kind: field.controlType === 'checkbox' ? 'checkmark' : 'text',
      nativeFieldName: field.nativeFieldName,
      nativeFieldType: field.controlType === 'checkbox' ? 'checkbox' : field.controlType === 'choice' ? 'choice' : field.nativeFieldName ? 'text' : undefined,
      page: field.page,
      templateFieldKey: field.id,
      text: value,
      widthRatio: field.widthRatio,
      xRatio: field.controlType === 'checkbox' ? field.xRatio + field.widthRatio / 2 : field.xRatio,
      yRatio: field.controlType === 'checkbox' ? field.yRatio + field.boxHeightRatio / 2 : field.yRatio,
    }
  }

  function updateTemplateField(field: DetectedTemplateField, value: string) {
    if (field.controlType === 'signature') return
    const withoutField = annotationsRef.current.filter((annotation) => annotation.templateFieldKey !== field.id)
    const shouldPersist = field.controlType === 'checkbox'
      ? Boolean(field.nativeFieldName) || value === 'true'
      : Boolean(field.nativeFieldName) || Boolean(value.trim())
    commitAnnotationSnapshot(shouldPersist ? [...withoutField, templateAnnotation(field, value)] : withoutField)
  }

  function selectTemplateField(field: DetectedTemplateField) {
    const current = annotationsRef.current.find((annotation) => annotation.templateFieldKey === field.id)
    setPage(field.page)
    setPanel('edit')
    setTool(null)
    setSelectedAnnotationId(null)
    setSelectedTemplateFieldId(field.id)
    if (field.controlType === 'signature') setSignatureName(current?.text ?? '')
  }

  async function placeTemplateSignature(field: DetectedTemplateField) {
    const value = signatureName.trim()
    if (!value) {
      setLoadError('Type the signer name first.')
      return
    }
    try {
      const signaturePng = await createTypedSignaturePng(value, signatureFamily)
      const existing = annotationsRef.current.find((annotation) => annotation.templateFieldKey === field.id)
      const annotation = movePdfAnnotation({
        boxHeightRatio: field.boxHeightRatio,
        eraseHeightRatio: field.nativeFieldName ? field.boxHeightRatio : field.eraseHeightRatio,
        eraseWidthRatio: field.nativeFieldName ? field.widthRatio : field.eraseWidthRatio,
        eraseXRatio: field.xRatio,
        eraseYRatio: field.yRatio,
        fieldLabel: field.label,
        fontFamily: signatureFamily,
        id: existing?.id ?? `template-signature:${field.id}`,
        kind: 'signature',
        page: field.page,
        signaturePng,
        templateFieldKey: field.id,
        text: value,
        widthRatio: Math.max(.12, Math.min(.38, field.widthRatio)),
        xRatio: field.xRatio + field.widthRatio / 2,
        yRatio: field.yRatio + field.boxHeightRatio / 2,
      }, field.xRatio + field.widthRatio / 2, field.yRatio + field.boxHeightRatio / 2)
      commitAnnotationSnapshot([
        ...annotationsRef.current.filter((current) => current.templateFieldKey !== field.id),
        annotation,
      ])
      setSelectedTemplateFieldId(field.id)
      setLoadError(null)
    } catch (error) {
      setLoadError(friendlyError(error, 'The signature could not be generated.'))
    }
  }

  function removeTemplateSignature(field: DetectedTemplateField) {
    commitAnnotationSnapshot(annotationsRef.current.filter((annotation) => annotation.templateFieldKey !== field.id))
    setSignatureName('')
    setLoadError(null)
  }

  function fillSelectedEmployeeDetails(targetEmployeeId = employeeId) {
    const employee = workspace.employees.find((candidate) => candidate.id === targetEmployeeId)
    if (!employee) return
    const today = new Intl.DateTimeFormat('en-US').format(new Date())
    const next = annotationsRef.current.filter((annotation) => !annotation.templateFieldKey)
    for (const field of templateFields) {
      if (field.controlType === 'signature') continue
      const normalized = field.label.toLocaleLowerCase()
      const currentValue = annotationsRef.current.find((annotation) => annotation.templateFieldKey === field.id)?.text ?? field.defaultValue ?? ''
      let employeeValue: string | undefined
      if (/(employee|applicant).*(legal )?name|(legal )?name.*(employee|applicant)|^legal name$|^employee$/.test(normalized)) employeeValue = employee.legalName
      else if (/(employee|payroll).*(id|number)|(id|number).*(employee|payroll)/.test(normalized)) employeeValue = employee.employeeNumber ?? ''
      else if (/(job|position).*(title)|title.*(job|position)|^position$/.test(normalized)) employeeValue = employee.jobTitle ?? ''
      else if (/employment.*(type|classification)|(type|classification).*employment/.test(normalized)) employeeValue = employee.employmentType?.replaceAll('_', ' ') ?? ''
      else if (/(supervisor|manager).*(name)?|(name).*(supervisor|manager)/.test(normalized)) employeeValue = employee.supervisorLabel ?? ''
      else if (/(work )?(location|site)|(location|site).*(work|employee)/.test(normalized)) employeeValue = employee.locationText ?? ''
      else if (/(employer|company|business|organization).*(name)?|^employer$|^company$/.test(normalized)) employeeValue = 'Guardianship Security LLC'
      else if (/(document|completion|completed|prepared|today).*(date)|^document date$/.test(normalized)) employeeValue = today
      const value = employeeValue ?? currentValue
      if (value.trim()) next.push(templateAnnotation(field, value))
    }
    commitAnnotationSnapshot(next)
  }

  async function addAnnotation(event: ReactPointerEvent<HTMLDivElement>) {
    if (!tool) { setSelectedAnnotationId(null); setSelectedTemplateFieldId(null); return }
    if (!sheetRef.current) return
    if (tool === 'text' && !textValue.trim()) { setLoadError('Type the text you want to add first.'); return }
    if (tool === 'signature' && !signatureName.trim()) { setLoadError('Type the signer name first.'); return }
    const bounds = sheetRef.current.getBoundingClientRect()
    const clickedXRatio = (event.clientX - bounds.left) / bounds.width
    const clickedYRatio = (event.clientY - bounds.top) / bounds.height
    const signatureTarget = tool === 'signature'
      ? templateFields
        .filter((field) => field.page === page && field.controlType === 'signature')
        .map((field) => ({
          distance: Math.hypot(clickedXRatio - (field.xRatio + field.widthRatio / 2), clickedYRatio - (field.yRatio + field.boxHeightRatio / 2)),
          field,
          inside: clickedXRatio >= field.xRatio - .03
            && clickedXRatio <= field.xRatio + field.widthRatio + .03
            && clickedYRatio >= field.yRatio - .03
            && clickedYRatio <= field.yRatio + field.boxHeightRatio + .03,
        }))
        .filter((candidate) => candidate.inside)
        .sort((left, right) => left.distance - right.distance)[0]?.field
      : undefined
    let signaturePng: Uint8Array | undefined
    try {
      if (tool === 'signature') signaturePng = await createTypedSignaturePng(signatureName, signatureFamily)
    } catch (error) {
      setLoadError(friendlyError(error, 'The signature could not be generated.'))
      return
    }
    const value = tool === 'text' ? textValue.trim() : tool === 'date' ? new Intl.DateTimeFormat('en-US').format(new Date()) : tool === 'checkmark' ? '✓' : signatureName.trim()
    const id = crypto.randomUUID()
    const annotation = movePdfAnnotation({
      boxHeightRatio: signatureTarget?.boxHeightRatio,
      eraseHeightRatio: signatureTarget ? (signatureTarget.nativeFieldName ? signatureTarget.boxHeightRatio : signatureTarget.eraseHeightRatio) : undefined,
      eraseWidthRatio: signatureTarget ? (signatureTarget.nativeFieldName ? signatureTarget.widthRatio : signatureTarget.eraseWidthRatio) : undefined,
      eraseXRatio: signatureTarget?.xRatio,
      eraseYRatio: signatureTarget?.yRatio,
      fieldLabel: signatureTarget?.label,
      fontSize: tool === 'text' ? DEFAULT_TEXT_FONT_SIZE : undefined,
      id,
      fontFamily: tool === 'signature' ? signatureFamily : undefined,
      kind: tool,
      page,
      signaturePng,
      templateFieldKey: signatureTarget?.id,
      text: value,
      widthRatio: tool === 'text'
        ? DEFAULT_TEXT_WIDTH_RATIO
        : tool === 'signature'
          ? signatureTarget ? Math.max(.14, Math.min(.38, signatureTarget.widthRatio)) : DEFAULT_SIGNATURE_WIDTH_RATIO
          : undefined,
      xRatio: signatureTarget ? signatureTarget.xRatio + signatureTarget.widthRatio / 2 : clickedXRatio,
      yRatio: signatureTarget ? signatureTarget.yRatio + signatureTarget.boxHeightRatio / 2 : clickedYRatio,
    }, signatureTarget ? signatureTarget.xRatio + signatureTarget.widthRatio / 2 : clickedXRatio, signatureTarget ? signatureTarget.yRatio + signatureTarget.boxHeightRatio / 2 : clickedYRatio)
    const withoutPreviousTarget = signatureTarget
      ? annotationsRef.current.filter((current) => current.templateFieldKey !== signatureTarget.id)
      : annotationsRef.current
    commitAnnotationSnapshot([...withoutPreviousTarget, annotation])
    setSelectedAnnotationId(id)
    setSelectedTemplateFieldId(null)
    setTool(null)
    setLoadError(null)
    if (tool === 'text') setTextValue('')
  }

  function startAnnotationGesture(event: ReactPointerEvent<HTMLElement>, annotation: PdfAnnotation, mode: AnnotationGesture['mode']) {
    if (!sheetRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const bounds = sheetRef.current.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      annotationId: annotation.id,
      changed: false,
      mode,
      originalAnnotations: annotationsRef.current,
      pointerId: event.pointerId,
      sheetHeight: Math.max(1, bounds.height),
      sheetWidth: Math.max(1, bounds.width),
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWidthRatio: annotation.widthRatio ?? (annotation.kind === 'signature' ? DEFAULT_SIGNATURE_WIDTH_RATIO : DEFAULT_TEXT_WIDTH_RATIO),
      startXRatio: annotation.xRatio,
      startYRatio: annotation.yRatio,
    }
    setSelectedAnnotationId(annotation.id)
    setPanel('edit')
    setTool(null)
  }

  function continueAnnotationGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const deltaX = (event.clientX - gesture.startClientX) / gesture.sheetWidth
    const deltaY = (event.clientY - gesture.startClientY) / gesture.sheetHeight
    if (Math.abs(deltaX) < .001 && Math.abs(deltaY) < .001) return
    gesture.changed = true
    const next = annotationsRef.current.map((annotation) => {
      if (annotation.id !== gesture.annotationId) return annotation
      if (gesture.mode === 'resize') return resizePdfAnnotation(annotation, gesture.startWidthRatio + deltaX)
      return movePdfAnnotation(annotation, gesture.startXRatio + deltaX, gesture.startYRatio + deltaY)
    })
    setAnnotationSnapshot(next)
  }

  function finishAnnotationGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    gestureRef.current = null
    if (!gesture.changed) return
    setUndoHistory((history) => [...history, gesture.originalAnnotations].slice(-60))
    setRedoHistory([])
  }

  function moveAnnotationWithKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>, annotation: PdfAnnotation) {
    const direction = { ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1] }[event.key]
    if (!direction) {
      if ((event.key === 'Delete' || event.key === 'Backspace') && annotation.id === selectedAnnotationId) {
        event.preventDefault()
        commitAnnotationSnapshot(annotationsRef.current.filter((item) => item.id !== annotation.id))
      }
      return
    }
    event.preventDefault()
    const step = event.shiftKey ? .02 : .004
    updateAnnotation(annotation.id, (current) => movePdfAnnotation(current, current.xRatio + direction[0] * step, current.yRatio + direction[1] * step))
  }

  function chooseFile(nextFile: File | null) {
    if (!nextFile) return
    setFile(nextFile)
    setTitle(nextFile.name.replace(/\.pdf$/i, ''))
    setSavedMessage(null)
    setSavedDocument(null)
    finalFileCacheRef.current = null
    closePreview()
    setSelectedAnnotationId(null)
    setUndoHistory([])
    setRedoHistory([])
    idempotencyKeysRef.current.clear()
  }

  function undo() {
    const previous = undoHistory.at(-1)
    if (!previous) return
    setUndoHistory((history) => history.slice(0, -1))
    setRedoHistory((history) => [...history, annotationsRef.current].slice(-60))
    setAnnotationSnapshot(previous)
  }

  function redo() {
    const next = redoHistory.at(-1)
    if (!next) return
    setRedoHistory((history) => history.slice(0, -1))
    setUndoHistory((history) => [...history, annotationsRef.current].slice(-60))
    setAnnotationSnapshot(next)
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!selectedVault) throw new Error('No document filing area is available for this PDF.')
      if (!employeeId) throw new Error('Choose the employee whose file should receive this document.')
      const finished = await createFinalFile()
      const savedFingerprint = documentFingerprint
      const savedEmployeeId = employeeId
      const idempotencyKey = idempotencyKeysRef.current.get(`save:${documentFingerprint}`) ?? crypto.randomUUID()
      idempotencyKeysRef.current.set(`save:${documentFingerprint}`, idempotencyKey)
      const result = await uploadHrDocument({
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
      if (result.scanState === 'rejected' || result.scanState === 'cancelled') {
        throw new Error('This file could not be accepted. Download it, check the PDF, and try again.')
      }
      return { employeeId: savedEmployeeId, fingerprint: savedFingerprint, result }
    },
    onSuccess: ({ employeeId: savedEmployeeId, fingerprint, result }) => {
      const owner = savedEmployeeId === 'company' ? 'Company documents' : workspace.employees.find((employee) => employee.id === savedEmployeeId)?.legalName ?? 'the employee file'
      setSavedDocument({ employeeId: savedEmployeeId, fingerprint, id: result.documentId })
      setSavedMessage(result.scanState === 'clean'
        ? `Saved to ${owner}.`
        : `Saved to ${owner}. You can close this window; processing will finish in the background.`)
      void queryClient.invalidateQueries({ queryKey: ['hr-documents'] })
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
        await verifyStoredDocument(uploaded.documentId, finished, title)
        setSavedDocument({ employeeId: filingEmployeeId, fingerprint: documentFingerprint, id: uploaded.documentId })
      }

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

  function renderTemplateControl(field: DetectedTemplateField) {
    const fieldAnnotation = annotations.find((annotation) => annotation.templateFieldKey === field.id)
    const value = fieldAnnotation?.text ?? field.defaultValue ?? ''
    const selected = selectedTemplateFieldId === field.id
    const hasValue = field.controlType === 'checkbox' ? value === 'true' : Boolean(value)
    const commonClassName = `document-workbench__template-control is-${field.controlType}${selected ? ' is-selected' : ''}${hasValue ? '' : ' is-empty'}`
    const commonStyle = {
      height: `${field.boxHeightRatio * 100}%`,
      left: `${field.xRatio * 100}%`,
      top: `${field.yRatio * 100}%`,
      width: `${field.widthRatio * 100}%`,
    }
    const stopSheetPlacement = (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation()
    const focusField = () => selectTemplateField(field)

    if (field.controlType === 'checkbox') {
      const checked = value === 'true'
      return <button
        aria-label={`${field.label} on document: ${checked ? 'checked' : 'not checked'}`}
        aria-pressed={checked}
        className={commonClassName}
        key={field.id}
        onClick={() => updateTemplateField(field, String(!checked))}
        onFocus={focusField}
        onPointerDown={stopSheetPlacement}
        style={commonStyle}
        title={`${checked ? 'Clear' : 'Check'} ${field.label}`}
        type="button"
      >{checked ? <Check aria-hidden="true" /> : null}</button>
    }

    if (field.controlType === 'signature') {
      return <button
        aria-label={`Signature field ${field.label} on document${value ? `: ${value}` : ''}`}
        className={commonClassName}
        key={field.id}
        onClick={focusField}
        onPointerDown={stopSheetPlacement}
        style={commonStyle}
        title={value ? `Edit signature for ${value}` : `Sign ${field.label}`}
        type="button"
      >{fieldAnnotation ? <SignatureImage annotation={fieldAnnotation} /> : <span>Sign here</span>}</button>
    }

    if (field.controlType === 'choice' && field.options?.length) {
      return <select
        aria-label={`${field.label} on document`}
        className={commonClassName}
        key={field.id}
        onChange={(event) => updateTemplateField(field, event.target.value)}
        onFocus={focusField}
        onPointerDown={stopSheetPlacement}
        style={commonStyle}
        value={value}
      ><option value="">Choose</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    }

    if (field.controlType === 'long_text') {
      return <textarea
        aria-label={`${field.label} on document`}
        className={commonClassName}
        key={field.id}
        maxLength={4000}
        onChange={(event) => updateTemplateField(field, event.target.value)}
        onFocus={focusField}
        onPointerDown={stopSheetPlacement}
        placeholder="Click to type"
        spellCheck
        style={{ ...commonStyle, fontSize: `${Math.max(7, field.fontSize * sheetScale)}px` }}
        value={value}
      />
    }

    const fittedFontSize = Math.max(6, Math.min(
      field.fontSize * sheetScale,
      (field.widthRatio * sheetSize.width - 10) / Math.max(1, value.length * .52),
    ))
    return <input
      aria-label={`${field.label} on document`}
      className={commonClassName}
      key={field.id}
      maxLength={1000}
      onChange={(event) => updateTemplateField(field, event.target.value)}
      onFocus={focusField}
      onPointerDown={stopSheetPlacement}
      placeholder="Click to type"
      spellCheck
      style={{ ...commonStyle, fontSize: `${fittedFontSize}px` }}
      value={value}
    />
  }

  const visibleAnnotations = annotations.filter((annotation) => annotation.page === page
    && (panel !== 'edit' || !annotation.templateFieldKey)
    && !(annotation.nativeFieldType === 'checkbox' && annotation.text !== 'true'))
  const visibleTemplateFields = templateFields.filter((field) => field.page === page)
  const selectedTemplateField = templateFields.find((field) => field.id === selectedTemplateFieldId) ?? null
  const selectedTemplateAnnotation = selectedTemplateField ? annotations.find((annotation) => annotation.templateFieldKey === selectedTemplateField.id) ?? null : null
  const selectedTextAnnotation = selectedAnnotation?.kind === 'text' ? selectedAnnotation : null
  const selectedSignatureAnnotation = selectedAnnotation?.kind === 'signature' ? selectedAnnotation : null
  const busy = save.isPending || sendDocument.isPending || previewBusy
  const operationError = save.error ?? sendDocument.error

  return <ModalDialog
    busy={busy}
    busyLabel={previewBusy ? 'Building the finished preview…' : save.isPending ? `Saving document… ${progress}%` : progress < 100 ? `Preparing document… ${progress}%` : 'Sending document…'}
    className={`document-workbench${maximized ? ' is-maximized' : ''}`}
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
          <button aria-label="Undo last document change" disabled={!undoHistory.length} onClick={undo} title="Undo" type="button"><Undo2 size={18} /></button>
          <button aria-label="Redo last document change" disabled={!redoHistory.length} onClick={redo} title="Redo" type="button"><Redo2 size={18} /></button>
          <button aria-label="Clear all additions" disabled={!annotations.length} onClick={() => { commitAnnotationSnapshot([]); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} title="Clear all additions" type="button"><Trash2 size={18} /></button>
        </div>
        <button aria-label={maximized ? 'Restore editor size' : 'Maximize editor'} aria-pressed={maximized} className="document-workbench__maximize" onClick={() => setMaximized((current) => !current)} title={maximized ? 'Restore editor size' : 'Maximize editor'} type="button">{maximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
        <button className="secondary-button secondary-button--small" onClick={() => inputRef.current?.click()} type="button">Choose another PDF</button>
        <input accept="application/pdf,.pdf" hidden onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)} ref={inputRef} type="file" />
      </header>

      <div className="document-workbench__main">
        <section className="document-workbench__document" aria-busy={rendering} ref={viewportRef}>
          {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}
          {!pdf && !loadError ? <p className="document-workbench__loading">Opening PDF…</p> : null}
          <div className={`document-workbench__sheet${tool ? ' is-placing' : ''}`} onPointerDown={(event) => void addAnnotation(event)} ref={sheetRef} style={{ height: sheetSize.height || undefined, width: sheetSize.width || undefined }}>
            <canvas hidden={!pdf || !sheetSize.width} ref={canvasRef} />
            {panel === 'edit' ? visibleTemplateFields.map(renderTemplateControl) : null}
            {visibleAnnotations.map((annotation) => <div
              className={`document-workbench__annotation is-${annotation.kind}${annotation.templateFieldKey ? ' is-template-field' : ''}${annotation.nativeFieldName ? ' is-native-field' : ''}${selectedAnnotationId === annotation.id ? ' is-selected' : ''}`}
              key={annotation.id}
              style={{
                left: `${annotation.xRatio * 100}%`,
                top: `${annotation.yRatio * 100}%`,
                ...(annotation.kind === 'text' ? {
                  fontSize: `${annotation.fitMode === 'single-line'
                    ? Math.max(6, Math.min((annotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE) * sheetScale, ((annotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO) * sheetSize.width - 12) / Math.max(1, annotation.text.length * .52)))
                    : Math.max(10, (annotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE) * sheetScale)}px`,
                  ...(annotation.boxHeightRatio ? { height: `${annotation.boxHeightRatio * 100}%` } : {}),
                  whiteSpace: annotation.fitMode === 'single-line' ? 'nowrap' : undefined,
                  width: `${(annotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO) * 100}%`,
                } : {}),
                ...(annotation.kind === 'signature' ? { fontFamily: `"${annotation.fontFamily ?? signatureFamily}", cursive`, fontSize: `${Math.max(18, (annotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO) * sheetSize.width / 5)}px`, ...(annotation.boxHeightRatio ? { height: `${annotation.boxHeightRatio * 100}%` } : {}), width: `${(annotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO) * 100}%` } : {}),
              }}
            >
              <button
                aria-label={`${annotation.kind === 'text' ? 'Text box' : annotation.kind}: ${annotation.text}. Drag or use arrow keys to move.`}
                aria-pressed={selectedAnnotationId === annotation.id}
                className="document-workbench__annotation-content"
                onClick={() => { if (!annotation.nativeFieldName) { setSelectedAnnotationId(annotation.id); setSelectedTemplateFieldId(null); setTool(null); setPanel('edit') } }}
                onKeyDown={(event) => moveAnnotationWithKeyboard(event, annotation)}
                onPointerCancel={finishAnnotationGesture}
                onPointerDown={(event) => annotation.nativeFieldName ? event.stopPropagation() : startAnnotationGesture(event, annotation, 'move')}
                onPointerMove={continueAnnotationGesture}
                onPointerUp={finishAnnotationGesture}
                title="Drag to move. Arrow keys also move this item."
                type="button"
              >{annotation.kind === 'signature' ? <SignatureImage annotation={annotation} /> : annotation.nativeFieldType === 'checkbox' ? '✓' : annotation.text}</button>
              {(annotation.kind === 'text' || annotation.kind === 'signature') && !annotation.nativeFieldName && selectedAnnotationId === annotation.id ? <button
                aria-label={annotation.kind === 'signature' ? 'Resize selected signature' : 'Resize selected text box'}
                className="document-workbench__resize-handle"
                onPointerCancel={finishAnnotationGesture}
                onPointerDown={(event) => startAnnotationGesture(event, annotation, 'resize')}
                onPointerMove={continueAnnotationGesture}
                onPointerUp={finishAnnotationGesture}
                title="Drag to resize text box"
                type="button"
              ><Scaling aria-hidden="true" size={13} /></button> : null}
            </div>)}
          </div>
        </section>

        <aside className="document-workbench__side">
          <div className="document-workbench__side-tabs" role="tablist" aria-label="Document actions">
            <button aria-selected={panel === 'edit'} className={panel === 'edit' ? 'active' : ''} onClick={() => setPanel('edit')} role="tab" type="button"><FilePenLine size={17} />Edit</button>
            <button aria-selected={panel === 'file'} className={panel === 'file' ? 'active' : ''} onClick={() => setPanel('file')} role="tab" type="button"><FolderInput size={17} />File</button>
            <button aria-selected={panel === 'send'} className={panel === 'send' ? 'active' : ''} onClick={() => setPanel('send')} role="tab" type="button"><Send size={17} />Send</button>
          </div>

          {panel === 'edit' ? <div className="document-workbench__panel">
            <div><p className="eyebrow">{templateFields.length ? 'Fill on the document' : 'Add to the PDF'}</p><h3>{templateFields.length ? 'Click any highlighted box' : 'Choose a tool, then click the page'}</h3><p>{templateFields.length ? 'Type, check, choose, or sign directly on the form. The field list below remains available when you need it.' : 'Every addition can be undone or removed before you finish.'}</p></div>
            {selectedTemplateField?.controlType === 'signature' ? <section className="document-workbench__direct-signature" aria-label={`Sign ${selectedTemplateField.label}`}>
              <div className="document-workbench__selection-heading"><span><FileSignature aria-hidden="true" size={17} /></span><div><strong>{selectedTemplateAnnotation ? 'Update this signature' : 'Sign this field'}</strong><small>{selectedTemplateField.label} · Page {selectedTemplateField.page}</small></div></div>
              <label className="document-workbench__field">Signer name<input autoFocus maxLength={120} onChange={(event) => setSignatureName(event.target.value)} placeholder="Type the full name" value={signatureName} /></label>
              <div className="document-workbench__signature-preview" style={{ fontFamily: `"${signatureFamily}", cursive` }}>{signatureName || 'Your signature'}</div>
              <div className="document-workbench__signature-styles" aria-label="Signature style">{signatureFamilies.map((family) => <button aria-pressed={signatureFamily === family} className={signatureFamily === family ? 'active' : ''} key={family} onClick={() => setSignatureFamily(family)} style={{ fontFamily: `"${family}", cursive` }} type="button">{signatureName || 'Signature'}</button>)}</div>
              <div className="document-workbench__direct-signature-actions"><button className="primary-action" disabled={!signatureName.trim()} onClick={() => void placeTemplateSignature(selectedTemplateField)} type="button">{selectedTemplateAnnotation ? 'Update signature' : 'Place signature'}</button>{selectedTemplateAnnotation ? <button className="danger-button danger-button--small" onClick={() => removeTemplateSignature(selectedTemplateField)} type="button"><Trash2 size={16} />Remove</button> : null}</div>
            </section> : null}
            {templateFields.length ? <section className="document-workbench__guided-fields" aria-label="Detected form fields">
              <label className="document-workbench__guided-employee">Whose form is this?<select onChange={(event) => { const nextEmployeeId = event.target.value; setEmployeeId(nextEmployeeId); if (nextEmployeeId !== 'company') fillSelectedEmployeeDetails(nextEmployeeId) }} value={employeeId}><option value="company">Not tied to one employee</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.legalName}{employee.employeeNumber ? ` · ${employee.employeeNumber}` : ''}</option>)}</select><small>Choosing an employee fills matching name, ID, title, supervisor, location, and company fields when available.</small></label>
              <div className="document-workbench__guided-heading"><div><p className="eyebrow">Field list</p><h3>{templateFields.length} editable {templateFields.length === 1 ? 'field' : 'fields'} found</h3><p>Click a box on the form for the fastest path, or use this list to jump between pages.</p></div>{workspace.employees.some((employee) => employee.id === employeeId) ? <button className="secondary-button secondary-button--small" onClick={() => fillSelectedEmployeeDetails()} type="button">Fill employee details</button> : null}</div>
              <div className="document-workbench__guided-list">{templateFields.map((field) => {
                const fieldAnnotation = annotations.find((annotation) => annotation.templateFieldKey === field.id)
                const value = fieldAnnotation?.text ?? field.defaultValue ?? ''
                const focusField = () => selectTemplateField(field)
                if (field.controlType === 'signature') return <div className={`document-workbench__guided-signature${selectedTemplateFieldId === field.id ? ' is-active' : ''}`} key={field.id}><span>{field.label}<small>Page {field.page}</small></span><button className="secondary-button secondary-button--small" onClick={() => selectTemplateField(field)} type="button">{fieldAnnotation ? 'Review placed signature' : 'Place signature here'}</button><small>{fieldAnnotation ? `${fieldAnnotation.text} is placed in this signature box.` : 'Click the signature box on the document or use this button.'}</small></div>
                return <label className={selectedTemplateFieldId === field.id ? 'is-active' : ''} key={field.id}><span>{field.label}<small>Page {field.page}</small></span>{field.controlType === 'checkbox'
                  ? <span className="document-workbench__guided-check"><input checked={value === 'true'} onChange={(event) => updateTemplateField(field, String(event.target.checked))} onFocus={focusField} type="checkbox"/><span>Yes</span></span>
                  : field.controlType === 'choice' && field.options?.length
                    ? <select onChange={(event) => updateTemplateField(field, event.target.value)} onFocus={focusField} value={value}><option value="">Choose an option</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                    : field.controlType === 'long_text'
                      ? <textarea maxLength={4000} onChange={(event: ReactChangeEvent<HTMLTextAreaElement>) => updateTemplateField(field, event.target.value)} onFocus={focusField} placeholder={`Enter ${field.label.toLocaleLowerCase()}`} rows={4} value={value}/>
                      : <input maxLength={1000} onChange={(event: ReactChangeEvent<HTMLInputElement>) => updateTemplateField(field, event.target.value)} onFocus={focusField} placeholder={`Enter ${field.label.toLocaleLowerCase()}`} value={value}/>}</label>
              })}</div>
            </section> : null}
            <div className="document-workbench__tools">
              <button aria-pressed={tool === null && !selectedTemplateFieldId} className={tool === null && !selectedTemplateFieldId ? 'active' : ''} onClick={() => { setTool(null); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} type="button"><Move size={18} /><span>Select / move</span></button>
              <button aria-pressed={tool === 'text' && !selectedAnnotationId} className={tool === 'text' && !selectedAnnotationId ? 'active' : ''} onClick={() => { setTool('text'); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} type="button"><Type size={18} /><span>Text</span></button>
              <button aria-pressed={tool === 'signature'} className={tool === 'signature' ? 'active' : ''} onClick={() => { setTool('signature'); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} type="button"><FileSignature size={18} /><span>Signature</span></button>
              <button aria-pressed={tool === 'date'} className={tool === 'date' ? 'active' : ''} onClick={() => { setTool('date'); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} type="button"><CalendarDays size={18} /><span>Date</span></button>
              <button aria-pressed={tool === 'checkmark'} className={tool === 'checkmark' ? 'active' : ''} onClick={() => { setTool('checkmark'); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} type="button"><Check size={18} /><span>Check</span></button>
            </div>
            {tool === 'text' || selectedTextAnnotation ? <>
              <label className="document-workbench__field">{selectedTextAnnotation ? 'Selected text box' : 'Text to add'}<textarea maxLength={2000} onChange={(event) => selectedTextAnnotation ? updateAnnotation(selectedTextAnnotation.id, (current) => ({ ...current, text: event.target.value })) : setTextValue(event.target.value)} placeholder="Type the complete text here" rows={4} value={selectedTextAnnotation?.text ?? textValue} /></label>
              {selectedTextAnnotation ? <section className="document-workbench__text-controls" aria-label="Selected text box controls">
                <div className="document-workbench__selection-heading"><span><Move aria-hidden="true" size={17} /></span><div><strong>Selected text box</strong><small>Drag the text to move it. Drag its gold corner to resize the box.</small></div></div>
                <div className="document-workbench__size-control"><span>Text size</span><div><button aria-label="Decrease text size" disabled={(selectedTextAnnotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE) <= 8} onClick={() => updateAnnotation(selectedTextAnnotation.id, (current) => ({ ...current, fontSize: Math.max(8, (current.fontSize ?? DEFAULT_TEXT_FONT_SIZE) - 1) }))} type="button"><Minus size={16} /></button><output>{selectedTextAnnotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE} pt</output><button aria-label="Increase text size" disabled={(selectedTextAnnotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE) >= 28} onClick={() => updateAnnotation(selectedTextAnnotation.id, (current) => ({ ...current, fontSize: Math.min(28, (current.fontSize ?? DEFAULT_TEXT_FONT_SIZE) + 1) }))} type="button"><Plus size={16} /></button></div></div>
                <label className="document-workbench__width-control">Text box width <output>{Math.round((selectedTextAnnotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO) * 100)}%</output><input aria-label="Text box width" max="88" min="16" onChange={(event) => updateAnnotation(selectedTextAnnotation.id, (current) => resizePdfTextAnnotation(current, Number(event.target.value) / 100))} type="range" value={Math.round((selectedTextAnnotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO) * 100)} /></label>
                <div className="document-workbench__selection-actions"><button className="secondary-button secondary-button--small" onClick={() => { setSelectedAnnotationId(null); setTextValue('') }} type="button"><Type size={16} />Add another text box</button><button className="danger-button danger-button--small" onClick={() => { commitAnnotationSnapshot(annotationsRef.current.filter((item) => item.id !== selectedTextAnnotation.id)); setSelectedAnnotationId(null) }} type="button"><Trash2 size={16} />Remove text box</button></div>
              </section> : null}
            </> : null}
            {tool === 'signature' || selectedSignatureAnnotation ? <div className="document-workbench__signature">
              {selectedSignatureAnnotation ? <section className="document-workbench__text-controls" aria-label="Selected signature controls">
                <div className="document-workbench__selection-heading"><span><Move aria-hidden="true" size={17} /></span><div><strong>Selected signature</strong><small>Drag the signature to move it. Drag its gold corner or use the size control below.</small></div></div>
                <div className="document-workbench__selected-signature"><SignatureImage annotation={selectedSignatureAnnotation} /></div>
                <label className="document-workbench__width-control">Signature size <output>{Math.round((selectedSignatureAnnotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO) * 100)}%</output><input aria-label="Signature size" max="70" min="12" onChange={(event) => updateAnnotation(selectedSignatureAnnotation.id, (current) => resizePdfAnnotation(current, Number(event.target.value) / 100))} type="range" value={Math.round((selectedSignatureAnnotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO) * 100)} /></label>
                <div className="document-workbench__selection-actions"><button className="secondary-button secondary-button--small" onClick={() => { setSelectedAnnotationId(null); setTool('signature') }} type="button"><FileSignature size={16} />Add another signature</button><button className="danger-button danger-button--small" onClick={() => { commitAnnotationSnapshot(annotationsRef.current.filter((item) => item.id !== selectedSignatureAnnotation.id)); setSelectedAnnotationId(null); setTool(null) }} type="button"><Trash2 size={16} />Remove signature</button></div>
              </section> : <>
                <label className="document-workbench__field">Signer name<input maxLength={120} onChange={(event) => setSignatureName(event.target.value)} placeholder="Type the full name" value={signatureName} /></label>
                <div className="document-workbench__signature-preview" style={{ fontFamily: `"${signatureFamily}", cursive` }}>{signatureName || 'Your signature'}</div>
                <div className="document-workbench__signature-styles" aria-label="Signature style">{signatureFamilies.map((family) => <button aria-pressed={signatureFamily === family} className={signatureFamily === family ? 'active' : ''} key={family} onClick={() => setSignatureFamily(family)} style={{ fontFamily: `"${family}", cursive` }} type="button">{signatureName || 'Signature'}</button>)}</div>
              </>}
            </div> : null}
            <p className="document-workbench__tip">Tip: select an item to move it. Text boxes can also wrap, resize, and be edited after placement.</p>
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
        {operationError || previewError ? <p className="form-error" role="alert">{previewError ?? friendlyError(operationError, 'The document action could not be completed.')}</p> : null}
        <div><button className="secondary-button" disabled={busy} onClick={onClose} type="button">Close</button><button className="secondary-button" disabled={!sourceBytes || !title.trim() || busy} onClick={() => void openPreview()} type="button"><Eye size={18} />Preview finished PDF</button><button className="primary-action" disabled={!sourceBytes || !title.trim() || busy} onClick={() => void download()} type="button"><Download size={18} />Download PDF</button></div>
      </footer>
      {preview ? <ModalDialog className="document-workbench-preview" description="This is the exact completed PDF that will be downloaded, filed, or sent." onClose={closePreview} title={`Review ${title}`}><div className="document-workbench-preview__body" data-output-fingerprint={preview.fingerprint}><SecurePdfViewer bytes={preview.bytes} title={`Finished ${title}`} /><footer><button className="secondary-button" onClick={closePreview} type="button">Back to editing</button><button className="primary-action" onClick={() => void download()} type="button"><Download size={18} />Download this PDF</button></footer></div></ModalDialog> : null}
    </div>}
  </ModalDialog>
}
