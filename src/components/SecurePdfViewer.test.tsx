import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pdf = vi.hoisted(() => {
  const render = vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() }))
  const page = {
    getTextContent: vi.fn(async () => ({ items: [] })),
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ height: 800 * scale, width: 600 * scale })),
    render,
  }
  const loaded = { getPage: vi.fn(async () => page), numPages: 1 }
  const destroy = vi.fn(async () => undefined)
  const getDocument = vi.fn(() => ({ destroy, promise: Promise.resolve(loaded) }))
  return { destroy, getDocument, loaded, page, render }
})

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: pdf.getDocument }))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.test.mjs' }))

import { SecurePdfViewer } from './SecurePdfViewer'

const canvasContext = {
  fillRect: vi.fn(),
  fillStyle: '',
  drawImage: vi.fn(),
  restore: vi.fn(),
  save: vi.fn(),
}

describe('SecurePdfViewer', () => {
  beforeEach(() => {
    pdf.destroy.mockClear()
    pdf.getDocument.mockClear()
    pdf.loaded.getPage.mockClear()
    pdf.page.getViewport.mockClear()
    pdf.render.mockClear()
    canvasContext.drawImage.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 })))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(760)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('loads stable PDF bytes and only reveals the canvas after the page paints', async () => {
    render(<SecurePdfViewer title="Test file" url="blob:test-file" />)

    expect(screen.getByText('Opening PDF…')).toBeInTheDocument()
    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('Rendering page 1…')).not.toBeInTheDocument())

    expect(pdf.getDocument).toHaveBeenCalledWith({ data: new Uint8Array([37, 80, 68, 70]) })
    expect(screen.getByLabelText('Test file, page 1')).not.toHaveAttribute('hidden')
    expect(canvasContext.drawImage).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })

  it('opens supplied PDF bytes without fetching a temporary blob URL', async () => {
    const supplied = new Uint8Array([37, 80, 68, 70, 45, 49])
    render(<SecurePdfViewer bytes={supplied} title="Completed form" />)

    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(1))
    expect(fetch).not.toHaveBeenCalled()
    expect(pdf.getDocument).toHaveBeenCalledWith({ data: supplied })
    expect(screen.getByLabelText('Completed form, page 1')).not.toHaveAttribute('hidden')
  })

  it('keeps the last completed page visible while a replacement frame renders', async () => {
    render(<SecurePdfViewer title="Stable file" url="blob:stable-file" />)
    const canvas = await screen.findByLabelText('Stable file, page 1')
    await waitFor(() => expect(canvas).not.toHaveAttribute('hidden'))

    let finishRender: () => void = () => undefined
    pdf.render.mockImplementationOnce(() => ({
      cancel: vi.fn(),
      promise: new Promise<void>((resolve) => { finishRender = resolve }),
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(2))
    expect(canvas).not.toHaveAttribute('hidden')
    expect(screen.queryByText('Rendering page 1…')).not.toBeInTheDocument()
    expect(canvasContext.drawImage).toHaveBeenCalledTimes(1)

    finishRender()
    await waitFor(() => expect(canvasContext.drawImage).toHaveBeenCalledTimes(2))
    expect(canvas).not.toHaveAttribute('hidden')
  })

  it('shows a usable fallback instead of a permanent blank page when the file cannot load', async () => {
    const fetchPdf = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }))
    vi.stubGlobal('fetch', fetchPdf)
    render(<SecurePdfViewer title="Missing file" url="blob:missing-file" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('This PDF could not be opened')
    expect(screen.getByLabelText('Missing file, page 1')).toHaveAttribute('hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Try preview again' }))
    await waitFor(() => expect(fetchPdf).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByLabelText('Missing file, page 1')).not.toHaveAttribute('hidden'))
  })
})
