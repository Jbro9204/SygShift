import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSupabaseClient } from '../lib/supabase'
import { readSphereDraft, sphereCanPreview, sphereCompleteUpload, sphereDraftKey, sphereMentionIds, sphereMessageParts, spherePath, spherePersonMentionLabel, sphereRequest, sphereResolveTypedMentions, sphereUnread, sphereUpload, SphereUploadError, writeSphereDraft } from './sygsphere'
vi.mock('../lib/supabase', () => ({ getSupabaseClient: vi.fn() }))
describe('SygSphere navigation and drafts', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(getSupabaseClient).mockReturnValue({ auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }) } } as never)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  it('keeps message and thread destinations together', () => { expect(spherePath('conversation', 'message', 'parent')).toBe('/sygsphere?conversation=conversation&message=message&thread=parent') })
  it('keeps unsent text and its retry identifier through reload', () => {
    const key = sphereDraftKey('a', 'conversation', null); const value = { body: 'Please review the handoff', clientId: crypto.randomUUID(), mentions: [] }
    expect(writeSphereDraft(key, value)).toBe(true); expect(readSphereDraft(key)).toEqual(value)
  })
  it('isolates drafts by employee and thread', () => {
    writeSphereDraft(sphereDraftKey('a', 'c', null), { body: 'Private draft', clientId: crypto.randomUUID(), mentions: [] })
    expect(readSphereDraft(sphereDraftKey('b', 'c', null)).body).toBe(''); expect(readSphereDraft(sphereDraftKey('a', 'c', 't')).body).toBe('')
  })
  it('handles unavailable and malformed stored drafts safely', () => { localStorage.setItem('broken', '{'); expect(readSphereDraft('broken').body).toBe('') })
  it('keeps pre-mention drafts backward compatible', () => { localStorage.setItem('legacy', JSON.stringify({ body: 'Existing draft', clientId: crypto.randomUUID() })); expect(readSphereDraft('legacy').mentions).toEqual([]) })
  it('does not add any system notification count', () => { expect(sphereUnread()).toBe(0) })
  it('does not expose raw database diagnostics when a message send fails', async () => {
    vi.mocked(getSupabaseClient).mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'invalid regular expression: quantifier operand invalid CONTEXT: SQL function' } }) } as never)
    await expect(sphereRequest('send', {})).rejects.toThrow('SygSphere could not send this message. Your draft is safe. Please retry.')
  })
  it('keeps only selected mention identities that remain in the body', () => {
    const jordan = { id: '11111111-1111-4111-8111-111111111111', name: 'Jordan Brown', username: 'jordan.brown' }
    const zach = { id: '22222222-2222-4222-8222-222222222222', name: 'Zach Ward', username: 'zward' }
    expect(sphereMentionIds('Please review this @jordan.brown', [jordan, zach])).toEqual([jordan.id])
    expect(sphereMessageParts('Hi @jordan.brown: https://example.test', [jordan])).toEqual([
      { kind: 'text', text: 'Hi ' }, { kind: 'mention', text: '@jordan.brown', mention: jordan },
      { kind: 'text', text: ': ' }, { kind: 'link', text: 'https://example.test' },
    ])
  })
  it('resolves a typed human first name to one employee identity without exposing usernames', () => {
    const michelle = { id: '33333333-3333-4333-8333-333333333333', name: 'Chief Hood', firstName: 'Michelle', preferredName: 'Chief', legalName: 'Michelle Hood', username: 'mhood', active: true, photoPath: null, presence: 'available' }
    const jordan = { id: '44444444-4444-4444-8444-444444444444', name: 'Jordan Brown', firstName: 'Jordan', preferredName: null, legalName: 'Jordan Brown', username: 'jbrown', active: true, photoPath: null, presence: 'available' }
    const mentions = sphereResolveTypedMentions('Please review this @michelle', [], [michelle, jordan], jordan.id)
    expect(mentions).toEqual([{ id: michelle.id, name: 'Chief Hood', username: 'mhood', label: 'Michelle' }])
    expect(sphereMentionIds('Please review this @michelle', mentions)).toEqual([michelle.id])
    expect(sphereMessageParts('Please review this @michelle', mentions).at(-1)).toEqual({ kind: 'mention', text: '@michelle', mention: mentions[0] })
    expect(sphereMentionIds('Please review this @michelle.', mentions)).toEqual([michelle.id])
    expect(sphereMessageParts('Please review this @michelle.', mentions).slice(-2)).toEqual([
      { kind: 'mention', text: '@michelle', mention: mentions[0] }, { kind: 'text', text: '.' },
    ])
  })
  it('uses a full human name when a first name is not unique', () => {
    const first = { id: '55555555-5555-4555-8555-555555555555', name: 'Michelle Hood', firstName: 'Michelle', preferredName: null, legalName: 'Michelle Hood', username: 'mhood', active: true, photoPath: null, presence: 'available' }
    const second = { id: '66666666-6666-4666-8666-666666666666', name: 'Michelle Lane', firstName: 'Michelle', preferredName: null, legalName: 'Michelle Lane', username: 'mlane', active: true, photoPath: null, presence: 'available' }
    expect(spherePersonMentionLabel(first, [first, second])).toBe('Michelle Hood')
    expect(sphereResolveTypedMentions('Hello @Michelle', [], [first, second], crypto.randomUUID())).toEqual([])
  })
  it('previews only bounded text and the approved inline media types', () => {
    expect(sphereCanPreview({ mimeType: 'application/pdf', sizeBytes: 26214400 })).toBe(true)
    expect(sphereCanPreview({ mimeType: 'image/png', sizeBytes: 26214401 })).toBe(false)
    expect(sphereCanPreview({ mimeType: 'text/plain', sizeBytes: 1048577 })).toBe(false)
    expect(sphereCanPreview({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 100 })).toBe(false)
  })
  it('waits through transient mobile storage confirmation before completing the upload', async () => {
    const requestId = '33333333-3333-4333-8333-333333333333'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ detail: 'The upload has not finished.', error: 'sygsphere_file_not_stored', requestId }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ state: 'uploaded', uploadId: requestId }, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sphereCompleteUpload(requestId, undefined, [0, 0])).resolves.toMatchObject({ state: 'processing', uploadId: requestId })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('preserves a completion-only recovery action instead of asking mobile users to upload again', async () => {
    const uploadId = '44444444-4444-4444-8444-444444444444'
    const requestId = '55555555-5555-4555-8555-555555555555'
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ detail: 'The upload has not finished.', error: 'sygsphere_file_not_stored', requestId }, { status: 409 })))
    const error = await sphereCompleteUpload(uploadId, undefined, [0, 0]).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(SphereUploadError)
    expect(error).toMatchObject({ code: 'sygsphere_file_not_stored', completionPending: true, requestReference: requestId, uploadId })
  })
  it('keeps the normal upload confirmation window short before offering recovery', async () => {
    vi.useFakeTimers()
    const uploadId = '45454545-4545-4545-8545-454545454545'
    const requestId = '56565656-5656-4565-8565-565656565656'
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ detail: 'The upload has not finished.', error: 'sygsphere_file_not_stored', requestId }, { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)

    const completion = sphereCompleteUpload(uploadId).catch((reason: unknown) => reason)
    await vi.runAllTimersAsync()
    const error = await completion

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(error).toMatchObject({ completionPending: true, uploadId })
  })
  it('uses a signed standard transfer for normal attachments before requesting the security scan', async () => {
    const uploadId = '66666666-6666-4666-8666-666666666666'
    const requestReference = '77777777-7777-4777-8777-777777777777'
    const uploadToSignedUrl = vi.fn().mockResolvedValue({ data: { path: 'conversation/file.pdf' }, error: null })
    vi.mocked(getSupabaseClient).mockReturnValue({
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }) },
      storage: { from: vi.fn().mockReturnValue({ uploadToSignedUrl }) },
    } as never)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        bucket: 'sygsphere-files',
        objectKey: 'conversation/file.pdf',
        requestReference,
        resumableEndpoint: 'https://project.storage.supabase.co/storage/v1/upload/resumable',
        signedUploadToken: 'signed-token',
        state: 'prepared',
        uploadId,
      }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ state: 'uploaded', uploadId }, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'report.pdf', { type: 'application/pdf' })

    await expect(sphereUpload(file, crypto.randomUUID(), crypto.randomUUID(), null)).resolves.toMatchObject({ state: 'processing', uploadId })
    expect(uploadToSignedUrl).toHaveBeenCalledWith('conversation/file.pdf', 'signed-token', file, {
      cacheControl: '3600', contentType: 'application/pdf', upsert: false,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`/api/v1/sygsphere/uploads/${uploadId}/complete`)
  })
  it('keeps the selected normal attachment retryable when its signed transfer fails', async () => {
    const uploadId = '88888888-8888-4888-8888-888888888888'
    const requestReference = '99999999-9999-4999-8999-999999999999'
    vi.mocked(getSupabaseClient).mockReturnValue({
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }) },
      storage: { from: vi.fn().mockReturnValue({ uploadToSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: 'Network failure' } }) }) },
    } as never)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      bucket: 'sygsphere-files', objectKey: 'conversation/file.pdf', requestReference,
      resumableEndpoint: 'https://project.storage.supabase.co/storage/v1/upload/resumable', signedUploadToken: 'signed-token', state: 'prepared', uploadId,
    }, { status: 201 })))

    const error = await sphereUpload(new File(['%PDF'], 'report.pdf', { type: 'application/pdf' }), crypto.randomUUID(), crypto.randomUUID(), null).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(SphereUploadError)
    expect(error).toMatchObject({ code: 'sygsphere_storage_transfer_failed', completionPending: false, requestReference, uploadId })
  })
})
