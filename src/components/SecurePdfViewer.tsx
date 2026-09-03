import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, RotateCw, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

interface SecurePdfViewerProps {
  title: string
  url: string
  page?: number
  onPageChange?: (page: number) => void
}

export function SecurePdfViewer({ title, url, page: controlledPage, onPageChange }: SecurePdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(controlledPage ?? 1)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [fitWidth, setFitWidth] = useState(true)
  const [search, setSearch] = useState('')
  const [matches, setMatches] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const task = getDocument({ url })
    void task.promise.then((loaded) => {
      if (!cancelled) { setDocument(loaded); setPage(Math.min(controlledPage ?? 1, loaded.numPages)); setError(null) }
    }).catch(() => { if (!cancelled) setError('This PDF could not be rendered securely in the browser.') })
    return () => { cancelled = true; void task.destroy() }
  }, [controlledPage, url])

  useEffect(() => {
    if (!document || !canvasRef.current) return
    let cancelled = false
    let renderTask: { cancel: () => void, promise: Promise<unknown> } | null = null
    void document.getPage(page).then((pdfPage) => {
      if (cancelled || !canvasRef.current) return
      const base = pdfPage.getViewport({ rotation, scale: 1 })
      const available = Math.max(320, (containerRef.current?.clientWidth ?? base.width) - 28)
      const scale = fitWidth ? available / base.width : zoom
      const viewport = pdfPage.getViewport({ rotation, scale })
      const canvas = canvasRef.current
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const context = canvas.getContext('2d')
      if (!context) return
      renderTask = pdfPage.render({ canvas, canvasContext: context, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0], viewport })
      return renderTask.promise
    }).catch((reason) => { if (!cancelled && reason?.name !== 'RenderingCancelledException') setError('This PDF page could not be rendered.') })
    return () => { cancelled = true; renderTask?.cancel() }
  }, [document, fitWidth, page, rotation, zoom])

  function goToPage(nextPage: number) {
    if (!document) return
    const bounded = Math.max(1, Math.min(document.numPages, nextPage))
    setPage(bounded)
    onPageChange?.(bounded)
  }

  async function searchPdf() {
    const term = search.trim().toLocaleLowerCase()
    if (!document || !term) { setMatches([]); return }
    const found: number[] = []
    for (let index = 1; index <= document.numPages; index += 1) {
      const content = await (await document.getPage(index)).getTextContent()
      const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').toLocaleLowerCase()
      if (text.includes(term)) found.push(index)
    }
    setMatches(found)
    if (found[0]) goToPage(found[0])
  }

  return (
    <section aria-label={`PDF viewer for ${title}`} className="secure-pdf-viewer">
      <div className="secure-pdf-viewer__toolbar">
        <div className="secure-pdf-viewer__paging">
          <button aria-label="Previous page" disabled={page <= 1} onClick={() => goToPage(page - 1)} type="button"><ChevronLeft size={17} /></button>
          <label><span>Page</span><input aria-label="Page number" max={document?.numPages ?? 1} min={1} onChange={(event) => goToPage(Number(event.target.value))} type="number" value={page} /></label>
          <span>of {document?.numPages ?? '—'}</span>
          <button aria-label="Next page" disabled={!document || page >= document.numPages} onClick={() => goToPage(page + 1)} type="button"><ChevronRight size={17} /></button>
        </div>
        <div className="secure-pdf-viewer__controls">
          <button aria-label="Zoom out" onClick={() => { setFitWidth(false); setZoom((value) => Math.max(.5, value - .15)) }} type="button"><ZoomOut size={17} /></button>
          <button aria-label="Fit page width" className={fitWidth ? 'active' : ''} onClick={() => setFitWidth(true)} type="button"><Maximize2 size={17} /></button>
          <button aria-label="Zoom in" onClick={() => { setFitWidth(false); setZoom((value) => Math.min(2.5, value + .15)) }} type="button"><ZoomIn size={17} /></button>
          <button aria-label="Rotate clockwise" onClick={() => setRotation((value) => (value + 90) % 360)} type="button"><RotateCw size={17} /></button>
        </div>
        <form className="secure-pdf-viewer__search" onSubmit={(event) => { event.preventDefault(); void searchPdf() }}>
          <Search size={16} /><input aria-label="Search this PDF" onChange={(event) => setSearch(event.target.value)} placeholder="Search document" value={search} /><button type="submit">Find</button>
        </form>
      </div>
      {matches.length ? <div className="secure-pdf-viewer__matches"><span>{matches.length} matching pages</span>{matches.slice(0, 10).map((match) => <button className={match === page ? 'active' : ''} key={match} onClick={() => goToPage(match)} type="button">{match}</button>)}</div> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="secure-pdf-viewer__canvas" ref={containerRef}>
        {!document && !error ? <p className="secure-pdf-viewer__status" role="status">Opening protected PDF…</p> : null}
        <canvas aria-label={`${title}, page ${page}`} hidden={!document} ref={canvasRef} />
      </div>
    </section>
  )
}
