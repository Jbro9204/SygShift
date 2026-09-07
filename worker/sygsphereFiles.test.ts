import { describe, expect, it, vi } from 'vitest'
import { boundedSphereUpload, handleSphereFiles } from './sygsphereFiles'

const id = '11111111-1111-4111-8111-111111111111'
const cid = '22222222-2222-4222-8222-222222222222'
function dependencies() {
  return { actorId: id, authorize: vi.fn().mockResolvedValue({ ok: true }), operation: vi.fn(async (action: string, input: Record<string, unknown>) => ({ id, state: action === 'begin' ? 'pending' : input.state, messageId: action === 'begin' ? null : id })), validate: vi.fn().mockReturnValue({ detectedMimeType: 'text/plain', sanitizedFilename: 'note.txt' }), scan: vi.fn().mockResolvedValue({ state: 'clean', scannerName: 'ClamAV', scannerVersion: 'test' }), store: vi.fn().mockResolvedValue(undefined), fetch: vi.fn().mockResolvedValue(new Response('hello')) }
}
const upload = () => new Request(`https://app.sygilant.us/api/v1/sygsphere/files/${id}?conversation=${cid}&filename=note.txt`, { method: 'PUT', body: 'hello', headers: { 'content-type': 'text/plain' } })
describe('SygSphere protected files', () => {
  it('authorizes before reading, stores before scan and shares only a clean result', async () => {
    const deps = dependencies(); const response = await handleSphereFiles(upload(), deps)
    expect(response.status).toBe(200); expect(deps.authorize).toHaveBeenCalledWith('authorize', { conversationId: cid })
    expect(deps.scan).toHaveBeenCalledOnce(); expect(deps.operation).toHaveBeenLastCalledWith('complete', expect.objectContaining({ state: 'clean', scanner: 'ClamAV test' }))
    expect(deps.store.mock.invocationCallOrder[0]).toBeLessThan(deps.scan.mock.invocationCallOrder[0]!)
  })
  it('rejects nonmember uploads before scan or storage', async () => {
    const deps = dependencies(); deps.authorize.mockRejectedValue(new Error('Denied'))
    await expect(handleSphereFiles(upload(), deps)).rejects.toThrow('Denied'); expect(deps.store).not.toHaveBeenCalled(); expect(deps.scan).not.toHaveBeenCalled()
  })
  it('never publishes rejected malware', async () => {
    const deps = dependencies(); deps.scan.mockResolvedValue({ state: 'rejected', scannerName: 'ClamAV', scannerVersion: 'test' })
    expect((await handleSphereFiles(upload(), deps)).status).toBe(422)
    expect(deps.operation).toHaveBeenLastCalledWith('complete', expect.objectContaining({ state: 'rejected' }))
  })
  it('fails closed when the scanner is unavailable', async () => {
    const deps = dependencies(); deps.scan.mockRejectedValue(new Error('Unavailable'))
    expect((await handleSphereFiles(upload(), deps)).status).toBe(503)
    expect(deps.operation).toHaveBeenLastCalledWith('complete', expect.objectContaining({ state: 'error' }))
  })
  it('does not reshare or rescan an already completed retry', async () => {
    const deps = dependencies(); deps.operation.mockResolvedValue({ id, state: 'clean', messageId: id })
    expect((await handleSphereFiles(upload(), deps)).status).toBe(200); expect(deps.scan).not.toHaveBeenCalled(); expect(deps.store).not.toHaveBeenCalled()
  })
  it('downloads with membership authorization, no caching and sandboxed attachment headers', async () => {
    const deps = dependencies(); deps.authorize.mockResolvedValue({ filename: 'note.txt', mimeType: 'text/plain', sizeBytes: 5, objectKey: `${cid}/${id}` })
    const response = await handleSphereFiles(new Request(`https://app.sygilant.us/api/v1/sygsphere/files/${id}`), deps)
    expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('content-disposition')).toContain('attachment'); expect(response.headers.get('content-security-policy')).toContain('sandbox'); expect(await response.text()).toBe('hello')
  })
  it('rejects empty and oversized uploads', async () => {
    await expect(boundedSphereUpload(new Request('https://example.test', { method: 'PUT', body: '' }))).rejects.toThrow('Empty')
    await expect(boundedSphereUpload(new Request('https://example.test', { method: 'PUT', body: 'x', headers: { 'content-length': '26214401' } }))).rejects.toThrow('25 MB')
  })
  it('rejects a changed file on storage conflict', async () => {
    const deps = dependencies(); deps.store.mockRejectedValue(new Error('Exists')); deps.fetch.mockResolvedValue(new Response('different bytes'))
    expect((await handleSphereFiles(upload(), deps)).status).toBe(503); expect(deps.scan).not.toHaveBeenCalled()
  })
})
