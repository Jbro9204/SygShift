import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readSphereDraft, sphereDraftKey, spherePath, sphereUnread, writeSphereDraft } from './sygsphere'
vi.mock('../lib/supabase', () => ({ getSupabaseClient: vi.fn() }))
describe('SygSphere navigation and drafts', () => {
  beforeEach(() => localStorage.clear())
  it('keeps message and thread destinations together', () => { expect(spherePath('conversation', 'message', 'parent')).toBe('/sygsphere?conversation=conversation&message=message&thread=parent') })
  it('keeps unsent text and its retry identifier through reload', () => {
    const key = sphereDraftKey('a', 'conversation', null); const value = { body: 'Please review the handoff', clientId: crypto.randomUUID() }
    expect(writeSphereDraft(key, value)).toBe(true); expect(readSphereDraft(key)).toEqual(value)
  })
  it('isolates drafts by employee and thread', () => {
    writeSphereDraft(sphereDraftKey('a', 'c', null), { body: 'Private draft', clientId: crypto.randomUUID() })
    expect(readSphereDraft(sphereDraftKey('b', 'c', null)).body).toBe(''); expect(readSphereDraft(sphereDraftKey('a', 'c', 't')).body).toBe('')
  })
  it('handles unavailable and malformed stored drafts safely', () => { localStorage.setItem('broken', '{'); expect(readSphereDraft('broken').body).toBe('') })
  it('does not add any system notification count', () => { expect(sphereUnread()).toBe(0) })
})
