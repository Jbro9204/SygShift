import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Download, Eye, Paperclip } from 'lucide-react'
import {
  sphereCanPreview,
  sphereDownload,
  spherePreview,
  type SphereFile,
  type SpherePreview,
} from '../data/sygsphere'
import { ModalDialog } from './ModalDialog'
import { SecurePdfViewer } from './SecurePdfViewer'

const inlineImageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])

function isSphereInlineImage(file: Pick<SphereFile, 'mimeType' | 'sizeBytes'>) {
  return inlineImageMimeTypes.has(file.mimeType.toLowerCase()) && sphereCanPreview(file)
}

function FileError({ error }: { error: unknown }) {
  if (!error) return null
  return <p className="sphere-error" role="alert">{error instanceof Error ? error.message : 'This request could not be completed. Please try again.'}</p>
}

export function SygSphereFileAttachment({ file, placement = 'shared-files' }: { file: SphereFile; placement?: 'message' | 'shared-files' }) {
  const [viewerOpen, setViewerOpen] = useState(false)
  const lazyTarget = useRef<HTMLDivElement>(null)
  const requested = useRef(false)
  const previewInFlight = useRef(false)
  const download = useMutation({ mutationFn: () => sphereDownload(file) })
  const preview = useMutation<SpherePreview, Error, void>({ mutationFn: () => spherePreview(file) })
  const previewData = preview.data
  const mutatePreview = preview.mutate
  const showInlineImage = placement === 'message' && isSphereInlineImage(file)

  const loadPreview = (openWhenReady = false) => {
    if (previewData) {
      if (openWhenReady) setViewerOpen(true)
      return
    }
    if (preview.isPending || previewInFlight.current) return
    requested.current = true
    previewInFlight.current = true
    mutatePreview(undefined, {
      onSuccess: () => { if (openWhenReady) setViewerOpen(true) },
      onSettled: () => { previewInFlight.current = false },
    })
  }

  useEffect(() => {
    if (!showInlineImage || requested.current || previewData) return
    const target = lazyTarget.current
    if (!target) return
    if (typeof window.IntersectionObserver === 'undefined') {
      requested.current = true
      previewInFlight.current = true
      mutatePreview(undefined, { onSettled: () => { previewInFlight.current = false } })
      return
    }
    const observer = new window.IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || requested.current) return
      requested.current = true
      previewInFlight.current = true
      observer.disconnect()
      mutatePreview(undefined, { onSettled: () => { previewInFlight.current = false } })
    }, { rootMargin: '240px 0px', threshold: 0.01 })
    observer.observe(target)
    return () => observer.disconnect()
  }, [mutatePreview, previewData, showInlineImage])

  useEffect(() => () => {
    if (previewData?.kind === 'image') URL.revokeObjectURL(previewData.url)
  }, [previewData])

  const imagePreview = previewData?.kind === 'image' ? previewData : null

  return <div className={`sphere-file-row ${showInlineImage ? 'sphere-file-row--message-image' : ''}`}>
    {showInlineImage ? <div ref={lazyTarget} className="sphere-inline-image" aria-busy={preview.isPending}>
      {imagePreview ? <button className="sphere-inline-image__button" type="button" aria-label={`Open full preview of ${file.filename}`} onClick={() => setViewerOpen(true)}>
        <img src={imagePreview.url} alt={`Thumbnail of ${file.filename}`} />
        <span>Open full preview</span>
      </button> : preview.isError ? <div className="sphere-inline-image__state sphere-inline-image__state--error" role="alert">
        <strong>Image preview unavailable</strong>
        <small>{preview.error.message}</small>
        <button type="button" onClick={() => loadPreview()}>Retry image preview</button>
      </div> : <div className="sphere-inline-image__state" role="status">
        <strong>{preview.isPending ? 'Loading image preview…' : 'Image preview'}</strong>
        <small>{preview.isPending ? 'Fetching this protected attachment.' : 'Loads when this attachment is nearby.'}</small>
      </div>}
    </div> : null}
    <div className="sphere-file"><Paperclip size={19} /><span><strong>{file.filename}</strong><small>{(file.sizeBytes / 1048576).toFixed(2)} MB</small></span><div>
      {sphereCanPreview(file) ? <button type="button" disabled={preview.isPending} onClick={() => loadPreview(true)}><Eye size={17} />{preview.isPending ? 'Loading…' : preview.isError ? 'Try preview again' : 'Preview'}</button> : null}
      <button type="button" disabled={download.isPending} onClick={() => download.mutate()}><Download size={17} />{download.isPending ? 'Downloading…' : 'Download'}</button>
    </div></div>
    <FileError error={download.error || (showInlineImage ? null : preview.error)} />
    {previewData && viewerOpen ? <ModalDialog title={file.filename} description="File preview" className="sphere-modal sphere-preview-modal" onClose={() => setViewerOpen(false)}><div className="sphere-preview">
      {previewData.kind === 'text' ? <pre>{previewData.text}</pre> : previewData.kind === 'image' ? <img src={previewData.url} alt={`Preview of ${file.filename}`} /> : <SecurePdfViewer bytes={previewData.bytes} title={file.filename} />}
      <footer><button type="button" onClick={() => setViewerOpen(false)}>Close</button><button type="button" onClick={() => download.mutate()} disabled={download.isPending}><Download size={17} />Download</button></footer>
    </div></ModalDialog> : null}
  </div>
}
