import { describe, expect, it, vi } from 'vitest'
import { boundedSphereUpload, handleSphereFiles } from './sygsphereFiles'

const id = '11111111-1111-4111-8111-111111111111'
const cid = '22222222-2222-4222-8222-222222222222'
function dependencies() {
  return { actorId: id, authorize: vi.fn().mockResolvedValue({ ok: true }), operation: vi.fn(async (action: string, input: Record<string, unknown>) => ({ id, state: action === 'begin' ? 'pending' : input.state, messageId: action === 'begin' ? null : id })), validate: vi.fn().mockReturnValue({ detectedMimeType: 'text/plain', sanitizedFilename: 'note.txt' }), store: vi.fn().mockResolvedValue(undefined), fetch: vi.fn().mockResolvedValue(new Response('hello')) }
}
const upload = () => new Request(`https://app.sygilant.us/api/v1/sygsphere/files/${id}?conversation=${cid}&filename=note.txt`, { method: 'PUT', body: 'hello', headers: { 'content-type': 'text/plain' } })
describe('SygSphere protected files', () => {
  it('authorizes before reading, then makes a checksum-verified protected upload available', async () => {
    const deps = dependencies(); const response = await handleSphereFiles(upload(), deps)
    expect(response.status).toBe(200); expect(deps.authorize).toHaveBeenCalledWith('authorize', { conversationId: cid })
    expect(deps.store).toHaveBeenCalledWith(`${cid}/${id}`, expect.any(Uint8Array), 'text/plain')
    expect(deps.fetch).toHaveBeenCalledWith(`${cid}/${id}`)
    expect(deps.operation).toHaveBeenLastCalledWith('complete', expect.objectContaining({
      checksum: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      state: 'clean',
    }))
  })
  it('rejects nonmember uploads before validation or storage', async () => {
    const deps = dependencies(); deps.authorize.mockRejectedValue(new Error('Denied'))
    await expect(handleSphereFiles(upload(), deps)).rejects.toThrow('Denied'); expect(deps.store).not.toHaveBeenCalled(); expect(deps.validate).not.toHaveBeenCalled()
  })
  it('does not restore an already available retry', async () => {
    const deps = dependencies(); deps.operation.mockResolvedValue({ id, state: 'clean', messageId: id })
    expect((await handleSphereFiles(upload(), deps)).status).toBe(200); expect(deps.store).not.toHaveBeenCalled()
  })
  it('downloads with membership authorization, no caching and sandboxed attachment headers', async () => {
    const deps = dependencies(); deps.authorize.mockResolvedValue({ filename: 'note.txt', mimeType: 'text/plain', sizeBytes: 5, objectKey: `${cid}/${id}` })
    const response = await handleSphereFiles(new Request(`https://app.sygilant.us/api/v1/sygsphere/files/${id}`), deps)
    expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('content-disposition')).toContain('attachment'); expect(response.headers.get('content-security-policy')).toContain('sandbox'); expect(await response.text()).toBe('hello')
  })
  it('streams an approved preview inline with restrictive browser headers', async () => {
    const deps = dependencies(); deps.authorize.mockResolvedValue({ filename: 'note.txt', mimeType: 'text/plain', sizeBytes: 5, objectKey: `${cid}/${id}` })
    const response = await handleSphereFiles(new Request(`https://app.sygilant.us/api/v1/sygsphere/files/${id}?mode=preview`), deps)
    expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toContain('inline')
    expect(response.headers.get('content-type')).toContain('charset=utf-8'); expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin'); expect(await response.text()).toBe('hello')
  })
  it('does not fetch an unsupported or oversized text preview', async () => {
    const deps = dependencies(); deps.authorize.mockResolvedValue({ filename: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 5, objectKey: `${cid}/${id}` })
    expect((await handleSphereFiles(new Request(`https://app.sygilant.us/api/v1/sygsphere/files/${id}?mode=preview`), deps)).status).toBe(415)
    expect(deps.fetch).not.toHaveBeenCalled()
    deps.authorize.mockResolvedValue({ filename: 'large.txt', mimeType: 'text/plain', sizeBytes: 1048577, objectKey: `${cid}/${id}` })
    expect((await handleSphereFiles(new Request(`https://app.sygilant.us/api/v1/sygsphere/files/${id}?mode=preview`), deps)).status).toBe(415)
  })
  it('rejects empty and oversized uploads', async () => {
    await expect(boundedSphereUpload(new Request('https://example.test', { method: 'PUT', body: '' }))).rejects.toThrow('Empty')
    await expect(boundedSphereUpload(new Request('https://example.test', { method: 'PUT', body: 'x', headers: { 'content-length': '26214401' } }))).rejects.toThrow('25 MB')
  })
  it('rejects a changed file on storage conflict', async () => {
    const deps = dependencies(); deps.store.mockRejectedValue(new Error('Exists')); deps.fetch.mockResolvedValue(new Response('different bytes'))
    expect((await handleSphereFiles(upload(), deps)).status).toBe(503); expect(deps.fetch).toHaveBeenCalledWith(`${cid}/${id}`)
    expect(deps.operation).toHaveBeenLastCalledWith('complete', expect.objectContaining({ state: 'error' }))
  })

  it('allows an idempotent conflict only when the stored object read-back matches exactly', async () => {
    const deps = dependencies(); deps.store.mockRejectedValue(new Error('Exists'))
    expect((await handleSphereFiles(upload(), deps)).status).toBe(200)
    expect(deps.operation).toHaveBeenLastCalledWith('complete', expect.objectContaining({ state: 'clean' }))
  })

  it('does not make a file available when the stored object length changes', async () => {
    const deps = dependencies(); deps.fetch.mockResolvedValue(new Response('hell'))
    expect((await handleSphereFiles(upload(), deps)).status).toBe(503)
    expect(deps.operation).toHaveBeenLastCalledWith('complete', expect.objectContaining({ state: 'error' }))
  })

  it('does not make a file available when the stored object checksum changes', async () => {
    const deps = dependencies(); deps.fetch.mockResolvedValue(new Response('HELLO'))
    expect((await handleSphereFiles(upload(), deps)).status).toBe(503)
    expect(deps.operation).toHaveBeenLastCalledWith('complete', expect.objectContaining({ state: 'error' }))
  })
})
