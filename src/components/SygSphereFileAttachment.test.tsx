import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SphereFile } from '../data/sygsphere'

const fileApi = vi.hoisted(() => ({
  download: vi.fn(),
  preview: vi.fn(),
}))

vi.mock('../data/sygsphere', () => ({
  sphereCanPreview: (file: Pick<SphereFile, 'mimeType' | 'sizeBytes'>) => (
    ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimeType) && file.sizeBytes <= 26214400
  ) || (file.mimeType === 'text/plain' && file.sizeBytes <= 1048576),
  sphereDownload: fileApi.download,
  spherePreview: fileApi.preview,
}))

import { SygSphereFileAttachment } from './SygSphereFileAttachment'

const imageFile: SphereFile = {
  id: '10000000-0000-4000-8000-000000000001',
  filename: 'incident-photo.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 204800,
  messageId: '20000000-0000-4000-8000-000000000002',
  parentId: null,
  state: 'clean',
  createdAt: '2026-10-08T12:00:00.000Z',
}

let intersectionCallback: IntersectionObserverCallback | undefined

class IntersectionObserverMock implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = '240px 0px'
  readonly scrollMargin = '0px'
  readonly thresholds = [0.01]
  disconnect = vi.fn()
  observe = vi.fn()
  takeRecords = vi.fn(() => [])
  unobserve = vi.fn()

  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback
  }
}

function renderAttachment(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

function intersectAttachment() {
  act(() => {
    intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
  })
}

describe('SygSphereFileAttachment protected inline images', () => {
  const originalIntersectionObserver = Object.getOwnPropertyDescriptor(window, 'IntersectionObserver')
  const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  const revokeObjectUrl = vi.fn()

  beforeEach(() => {
    intersectionCallback = undefined
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: IntersectionObserverMock })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    fileApi.download.mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (originalIntersectionObserver) Object.defineProperty(window, 'IntersectionObserver', originalIntersectionObserver)
    else Reflect.deleteProperty(window, 'IntersectionObserver')
    if (originalRevokeObjectUrl) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl)
    else Reflect.deleteProperty(URL, 'revokeObjectURL')
  })

  it('loads a message image only near the viewport and reuses it in the full viewer', async () => {
    fileApi.preview.mockResolvedValue({ kind: 'image', url: 'blob:protected-image' })
    const view = renderAttachment(<SygSphereFileAttachment file={imageFile} placement="message" />)

    expect(fileApi.preview).not.toHaveBeenCalled()
    expect(screen.getByText('Loads when this attachment is nearby.')).toBeInTheDocument()

    intersectAttachment()

    const thumbnail = await screen.findByRole('img', { name: `Thumbnail of ${imageFile.filename}` })
    expect(thumbnail).toHaveAttribute('src', 'blob:protected-image')
    expect(fileApi.preview).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: `Open full preview of ${imageFile.filename}` }))
    const dialog = screen.getByRole('dialog', { name: imageFile.filename })
    expect(within(dialog).getByRole('img', { name: `Preview of ${imageFile.filename}` })).toHaveAttribute('src', 'blob:protected-image')
    expect(fileApi.preview).toHaveBeenCalledTimes(1)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: imageFile.filename })).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: `Thumbnail of ${imageFile.filename}` })).toBeInTheDocument()
    expect(revokeObjectUrl).not.toHaveBeenCalled()

    view.unmount()
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:protected-image')
  })

  it('keeps Shared Files compact and fetches a preview only after an explicit action', async () => {
    fileApi.preview.mockResolvedValue({ kind: 'image', url: 'blob:shared-file-preview' })
    renderAttachment(<SygSphereFileAttachment file={imageFile} />)

    expect(fileApi.preview).not.toHaveBeenCalled()
    expect(screen.queryByText('Loads when this attachment is nearby.')).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: `Thumbnail of ${imageFile.filename}` })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    expect(await screen.findByRole('dialog', { name: imageFile.filename })).toBeInTheDocument()
    expect(fileApi.preview).toHaveBeenCalledTimes(1)
  })

  it('does not auto-load non-image message previews', () => {
    const pdfFile: SphereFile = { ...imageFile, id: '30000000-0000-4000-8000-000000000003', filename: 'report.pdf', mimeType: 'application/pdf' }
    renderAttachment(<SygSphereFileAttachment file={pdfFile} placement="message" />)

    expect(fileApi.preview).not.toHaveBeenCalled()
    expect(screen.queryByText('Loads when this attachment is nearby.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument()
  })

  it('shows an accessible retry state after an inline fetch failure', async () => {
    fileApi.preview
      .mockRejectedValueOnce(new Error('The protected preview could not be loaded.'))
      .mockResolvedValueOnce({ kind: 'image', url: 'blob:retried-image' })
    renderAttachment(<SygSphereFileAttachment file={imageFile} placement="message" />)

    intersectAttachment()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The protected preview could not be loaded.')
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled()

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry image preview' }))

    await waitFor(() => expect(fileApi.preview).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('img', { name: `Thumbnail of ${imageFile.filename}` })).toHaveAttribute('src', 'blob:retried-image')
  })
})
