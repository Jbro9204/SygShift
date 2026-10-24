import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientDocumentApiError, shouldReuseClientDocumentUploadRequest, uploadClientDocument } from './clients'

const supabaseData = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: supabaseData.getSession } }),
}))

type RequestEvent = 'abort' | 'error' | 'load' | 'timeout'

class FakeUploadTarget {
  addEventListener = vi.fn()
}

class FakeXMLHttpRequest {
  static latest: FakeXMLHttpRequest | null = null

  readonly upload = new FakeUploadTarget()
  readonly listeners = new Map<RequestEvent, EventListener>()
  responseText = ''
  status = 0
  timeout = 0

  constructor() { FakeXMLHttpRequest.latest = this }

  addEventListener(type: RequestEvent, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener)
    this.listeners.set(type, callback)
  }

  emit(type: RequestEvent) { this.listeners.get(type)?.(new Event(type)) }
  open = vi.fn()
  send = vi.fn()
  setRequestHeader = vi.fn()
}

const originalXMLHttpRequest = globalThis.XMLHttpRequest

describe('client document upload retry classification', () => {
  it.each([408, 425, 429])('preserves the request key for ambiguous HTTP %s responses', (status) => {
    expect(shouldReuseClientDocumentUploadRequest(new ClientDocumentApiError('Retry later', 'temporary_response', status))).toBe(true)
  })

  it('preserves the request key for transport failures and retryable server outcomes', () => {
    expect(shouldReuseClientDocumentUploadRequest(new Error('Network interrupted'))).toBe(true)
    expect(shouldReuseClientDocumentUploadRequest(new ClientDocumentApiError('No response', null, 0))).toBe(true)
    expect(shouldReuseClientDocumentUploadRequest(new ClientDocumentApiError('Finalization pending', 'client_document_finalization_pending', 409))).toBe(true)
    expect(shouldReuseClientDocumentUploadRequest(new ClientDocumentApiError('Server unavailable', null, 503))).toBe(true)
  })

  it('rotates the request key only for deterministic client and storage failures', () => {
    expect(shouldReuseClientDocumentUploadRequest(new ClientDocumentApiError('Invalid metadata', 'invalid_request', 400))).toBe(false)
    expect(shouldReuseClientDocumentUploadRequest(new ClientDocumentApiError('Storage rejected the file', 'client_document_storage_failed', 500))).toBe(false)
  })
})

describe('client document upload transport ambiguity', () => {
  beforeEach(() => {
    FakeXMLHttpRequest.latest = null
    globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest
    supabaseData.getSession.mockReset().mockResolvedValue({ data: { session: { access_token: 'client-upload-token' } }, error: null })
  })

  afterEach(() => { globalThis.XMLHttpRequest = originalXMLHttpRequest })

  async function startUpload() {
    const promise = uploadClientDocument({
      accessClassification: 'confidential',
      category: 'contract',
      clientId: '10000000-0000-4000-8000-000000000001',
      description: '',
      effectiveOn: null,
      expiresOn: null,
      file: new File(['client record'], 'record.pdf', { type: 'application/pdf' }),
      idempotencyKey: 'safe-request-key',
      portalState: 'internal_only',
      title: 'Client record',
    }, vi.fn())
    await vi.waitFor(() => expect(FakeXMLHttpRequest.latest).not.toBeNull())
    return { promise, request: FakeXMLHttpRequest.latest! }
  }

  it('sets a finite transport timeout and reports timeout as an ambiguous outcome', async () => {
    const { promise, request } = await startUpload()
    expect(request.timeout).toBe(600_000)
    request.emit('timeout')
    await expect(promise).rejects.toThrow('The upload response timed out. You can retry safely.')
  })

  it('reports an aborted request as ambiguous instead of rotating its request key', async () => {
    const { promise, request } = await startUpload()
    request.emit('abort')
    await expect(promise).rejects.toThrow('The upload was interrupted before its result was confirmed. You can retry safely.')
  })
})
