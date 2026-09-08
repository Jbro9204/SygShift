import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readSphereDraft, sphereCanPreview, sphereDraftKey, sphereMentionIds, sphereMessageParts, spherePath, sphereUnread, writeSphereDraft } from './sygsphere'
vi.mock('../lib/supabase', () => ({ getSupabaseClient: vi.fn() }))
describe('SygSphere navigation and drafts', () => {
  beforeEach(() => localStorage.clear())
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
  it('keeps only selected mention identities that remain in the body', () => {
    const jordan = { id: '11111111-1111-4111-8111-111111111111', name: 'Jordan Brown', username: 'jordan.brown' }
    const zach = { id: '22222222-2222-4222-8222-222222222222', name: 'Zach Ward', username: 'zward' }
    expect(sphereMentionIds('Please review this @jordan.brown', [jordan, zach])).toEqual([jordan.id])
    expect(sphereMessageParts('Hi @jordan.brown: https://example.test', [jordan])).toEqual([
      { kind: 'text', text: 'Hi ' }, { kind: 'mention', text: '@jordan.brown', mention: jordan },
      { kind: 'text', text: ': ' }, { kind: 'link', text: 'https://example.test' },
    ])
  })
  it('previews only bounded text and the approved inline media types', () => {
    expect(sphereCanPreview({ mimeType: 'application/pdf', sizeBytes: 26214400 })).toBe(true)
    expect(sphereCanPreview({ mimeType: 'image/png', sizeBytes: 26214401 })).toBe(false)
    expect(sphereCanPreview({ mimeType: 'text/plain', sizeBytes: 1048577 })).toBe(false)
    expect(sphereCanPreview({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 100 })).toBe(false)
  })
})
