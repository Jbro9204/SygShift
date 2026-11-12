import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } }, error: null }) } }) }))
vi.mock('../lib/identityVerificationCoordinator', () => ({ fetchWithIdentityVerification: (action: () => unknown) => action() }))
import { notificationProcessSummary, processNotificationBatch, type NotificationProcessResult } from './operations'

const id = '10000000-0000-4000-8000-000000000001'
const base: NotificationProcessResult = { delivered: [], suppressed: [], held: [], failed: [], processed: 0, requestId: 'test', requestedBy: 'admin' }
beforeEach(() => { mocks.fetch.mockReset(); vi.stubGlobal('fetch', mocks.fetch) })
describe('operational email result truthfulness', () => {
  it('keeps a zero-job result distinct from delivery', () => {
    expect(notificationProcessSummary(base)).toBe('No queued email jobs were waiting to process.')
  })
  it('identifies held jobs as not resent, without counting them delivered', () => {
    const text = notificationProcessSummary({ ...base, held: [id], processed: 1 })
    expect(text).toContain('0 delivered')
    expect(text).toContain('1 held for review (not automatically resent)')
  })
  it('separates accepted, suppressed, held and failed partial outcomes', () => {
    const text = notificationProcessSummary({ ...base, delivered: [id], held: [id], suppressed: [id], failed: [{ id, error: 'Safe failure' }], processed: 4 })
    expect(text).toContain('1 delivered, 1 suppressed (not sent), 1 held for review (not automatically resent), 1 failed')
  })
  it('preserves new API outcome arrays through the browser schema', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ...base, held: [id], suppressed: [id], processed: 2 })))
    const result = await processNotificationBatch()
    expect(result.held).toEqual([id])
    expect(result.suppressed).toEqual([id])
    expect(result.delivered).toEqual([])
  })
  it('accepts older responses without inventing delivery for unclassified outcomes', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ delivered: [], failed: [], processed: 1, requestId: 'test', requestedBy: 'admin' })))
    const result = await processNotificationBatch()
    expect(result.held).toEqual([])
    expect(notificationProcessSummary(result)).toContain('1 additional outcomes; review delivery history')
    expect(notificationProcessSummary(result)).toContain('0 delivered')
  })
})
