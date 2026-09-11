import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, RotateCw, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

type SecurePdfViewerSource =
  | { bytes: Uint8Array; url?: never }
  | { bytes?: never; url: string }

type SecurePdfViewerProps = SecurePdfViewerSource & {
  title: string
  page?: number
  onPageChange?: (page: number) => void
}

function stablePdfBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy
}

export function SecurePdfViewer({ bytes, title, url, page: controlledPage, onPageChange }: SecurePdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const initialPageRef = useRef(controlledPage)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [page, setPage] = useState(controlledPage ?? 1)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [fitWidth, setFitWidth] = useState(true)
  const [search, setSearch] = useState('')
  const [matches, setMatches] = useState<number[]>([])
  const [rendering, setRendering] = useState(false)
  const [renderedPage, setRenderedPage] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceAttempt, setSourceAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let loadingTask: ReturnType<typeof getDocument> | null = null
    setPdfDocument(null)
    setError(null)
    setRendering(false)
    setRenderedPage(null)
    setMatches([])

    void (async () => {
      try {
        // Completed and protected PDFs can be supplied as bytes so PDF.js does
        // not need to fetch a temporary blob URL. That keeps previews within
        // the production connect-src policy and avoids short-lived URL races.
        let data: Uint8Array
        if (bytes) {
          data = stablePdfBytes(bytes)
        } else {
          const response = await fetch(url, { cache: 'no-store' })
          if (!response.ok) throw new Error(`PDF request failed with ${response.status}`)
          data = new Uint8Array(await response.arrayBuffer())
        }
        if (cancelled) return
        loadingTask = getDocument({ data })
        const loaded = await loadingTask.promise
        if (cancelled) return
        setPdfDocument(loaded)
        setPage(Math.min(Math.max(initialPageRef.current ?? 1, 1), loaded.numPages))
      } catch {
        if (!cancelled) setError('This PDF could not be opened. Download the file or try the preview again.')
      }
    })()

    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      void loadingTask?.destroy()
    }
  }, [bytes, sourceAttempt, url])

  useEffect(() => {
    if (controlledPage === undefined || !pdfDocument) return
    setPage(Math.min(Math.max(controlledPage, 1), pdfDocument.numPages))
  }, [controlledPage, pdfDocument])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateWidth = () => setContainerWidth(Math.floor(container.clientWidth))
    updateWidth()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => window.removeEventListener('resize', updateWidth)
    }
    const observer = new ResizeObserver(updateWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current || containerWidth <= 0) return
    let cancelled = false
    let activeTask: RenderTask | null = null
    setRendering(true)
    setError(null)

    void (async () => {
      try {
        const previousTask = renderTaskRef.current
        if (previousTask) {
          previousTask.cancel()
          await previousTask.promise.catch(() => undefined)
        }
        if (cancelled || !canvasRef.current) return

        const pdfPage = await pdfDocument.getPage(page)
        if (cancelled || !canvasRef.current) return
        const base = pdfPage.getViewport({ rotation, scale: 1 })
        const available = Math.max(160, containerWidth - 28)
        const scale = fitWidth ? available / base.width : zoom
        const viewport = pdfPage.getViewport({ rotation, scale })
        const buffer = document.createElement('canvas')
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        buffer.width = Math.max(1, Math.floor(viewport.width * ratio))
        buffer.height = Math.max(1, Math.floor(viewport.height * ratio))
        const context = buffer.getContext('2d', { alpha: false })
        if (!context) throw new Error('Canvas is unavailable')
        context.save()
        context.fillStyle = '#fff'
        context.fillRect(0, 0, buffer.width, buffer.height)
        context.restore()
        activeTask = pdfPage.render({ canvas: buffer, canvasContext: context, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0], viewport })
        renderTaskRef.current = activeTask
        await activeTask.promise
        if (cancelled || !canvasRef.current) return

        // PDF.js paints into a detached buffer. The visible canvas keeps the
        // last completed page until this synchronous copy, so resize, zoom,
        // rotation, and page changes cannot expose partially painted frames.
        const canvas = canvasRef.current
        canvas.width = buffer.width
        canvas.height = buffer.height
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const visibleContext = canvas.getContext('2d', { alpha: false })
        if (!visibleContext) throw new Error('Canvas is unavailable')
        visibleContext.drawImage(buffer, 0, 0)
        setRenderedPage(page)
        setRendering(false)
      } catch (reason) {
        if (!cancelled && (reason as { name?: string } | null)?.name !== 'RenderingCancelledException') {
          setRendering(false)
          setError('This PDF page could not be displayed. Download the file or try the preview again.')
        }
      } finally {
        if (renderTaskRef.current === activeTask) renderTaskRef.current = null
      }
    })()

    return () => {
      cancelled = true
      activeTask?.cancel()
    }
  }, [containerWidth, fitWidth, page, pdfDocument, rotation, zoom])

  function goToPage(nextPage: number) {
    if (!pdfDocument || !Number.isFinite(nextPage)) return
    const bounded = Math.max(1, Math.min(pdfDocument.numPages, nextPage))
    setPage(bounded)
    onPageChange?.(bounded)
  }

  async function searchPdf() {
    const term = search.trim().toLocaleLowerCase()
    if (!pdfDocument || !term) { setMatches([]); return }
    const found: number[] = []
    for (let index = 1; index <= pdfDocument.numPages; index += 1) {
      const content = await (await pdfDocument.getPage(index)).getTextContent()
      const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').toLocaleLowerCase()
      if (text.includes(term)) found.push(index)
    }
    setMatches(found)
    if (found[0]) goToPage(found[0])
  }

  return (
    <section aria-busy={rendering} aria-label={`PDF viewer for ${title}`} className={`secure-pdf-viewer${fitWidth ? ' is-fit-width' : ''}`}>
      <div className="secure-pdf-viewer__toolbar">
        <div className="secure-pdf-viewer__paging">
          <button aria-label="Previous page" disabled={page <= 1} onClick={() => goToPage(page - 1)} title="Previous page" type="button"><ChevronLeft size={17} /></button>
          <label><span>Page</span><input aria-label="Page number" max={pdfDocument?.numPages ?? 1} min={1} onChange={(event) => goToPage(Number(event.target.value))} type="number" value={page} /></label>
          <span>of {pdfDocument?.numPages ?? '—'}</span>
          <button aria-label="Next page" disabled={!pdfDocument || page >= pdfDocument.numPages} onClick={() => goToPage(page + 1)} title="Next page" type="button"><ChevronRight size={17} /></button>
        </div>
        <div className="secure-pdf-viewer__controls">
          <button aria-label="Zoom out" onClick={() => { setFitWidth(false); setZoom((value) => Math.max(.5, value - .15)) }} title="Zoom out" type="button"><ZoomOut size={17} /></button>
          <button aria-label="Fit page width" className={fitWidth ? 'active' : ''} onClick={() => setFitWidth(true)} title="Fit to width" type="button"><Maximize2 size={17} /></button>
          <button aria-label="Zoom in" onClick={() => { setFitWidth(false); setZoom((value) => Math.min(2.5, value + .15)) }} title="Zoom in" type="button"><ZoomIn size={17} /></button>
          <button aria-label="Rotate clockwise" onClick={() => setRotation((value) => (value + 90) % 360)} title="Rotate clockwise" type="button"><RotateCw size={17} /></button>
        </div>
        <form className="secure-pdf-viewer__search" onSubmit={(event) => { event.preventDefault(); void searchPdf() }}>
          <Search size={16} /><input aria-label="Search this PDF" onChange={(event) => setSearch(event.target.value)} placeholder="Search document" value={search} /><button type="submit">Find</button>
        </form>
      </div>
      {matches.length ? <div className="secure-pdf-viewer__matches"><span>{matches.length} matching pages</span>{matches.slice(0, 10).map((match) => <button className={match === page ? 'active' : ''} key={match} onClick={() => goToPage(match)} type="button">{match}</button>)}</div> : null}
      {error ? <div className="secure-pdf-viewer__error" role="alert"><p className="form-error">{error}</p><button className="secondary-button secondary-button--small" onClick={() => setSourceAttempt((attempt) => attempt + 1)} type="button"><RotateCw aria-hidden="true" size={16} />Try preview again</button></div> : null}
      <div className="secure-pdf-viewer__canvas" ref={containerRef}>
        {!pdfDocument && !error ? <p className="secure-pdf-viewer__status" role="status">Opening PDF…</p> : null}
        {pdfDocument && rendering && renderedPage === null && !error ? <p className="secure-pdf-viewer__status" role="status">Rendering page {page}…</p> : null}
        <canvas aria-label={`${title}, page ${renderedPage ?? page}`} hidden={!pdfDocument || renderedPage === null || Boolean(error)} ref={canvasRef} />
      </div>
    </section>
  )
}
