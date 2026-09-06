// @vitest-environment node
import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { allowedPushEndpoint, deliverPushBatch, validPushHook } from '../worker/webPush'

describe('protected background push', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto))
  it.each(['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/Qabc', 'https://wns2.notify.windows.com/abc'])('accepts browser push endpoint %s', (endpoint) => expect(allowedPushEndpoint(endpoint)).toBe(true))
  it.each(['http://fcm.googleapis.com/abc', 'https://127.0.0.1/abc', 'https://fcm.googleapis.com.evil.example/abc', 'https://user@fcm.googleapis.com/abc', 'https://fcm.googleapis.com:444/abc', 'https://example.com/abc'])('rejects arbitrary outbound target %s', (endpoint) => expect(allowedPushEndpoint(endpoint)).toBe(false))
  it('requires the exact authenticated dispatch secret', async () => {
    expect(await validPushHook('Bearer test-secret', 'test-secret')).toBe(true)
    expect(await validPushHook('Bearer wrong', 'test-secret')).toBe(false)
    expect(await validPushHook(null, 'test-secret')).toBe(false)
    expect(await validPushHook(null, '')).toBe(false)
  })
  it('encrypts a generic alert with real Web Crypto and marks the claimed delivery', async () => {
    const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const keys = await crypto.subtle.exportKey('jwk', vapid.privateKey)
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url')
    const subscriber = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', subscriber.publicKey)).toString('base64url')
    const id = '10000000-0000-4000-8000-000000000001'
    const jobs = [{ id, claimToken: id, notificationId: id, employeeId: id, createdAt: new Date().toISOString(), path: '/support?ticket=test', attempt: 1, eligible: true,
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', expirationTime: null, keys: { p256dh, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') } } }]
    const rpc = vi.fn(async (name: string) => name === 'service_claim_employee_push' ? jobs : null)
    const send = vi.fn(async () => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', send)
    expect(await deliverPushBatch({ publicKey, privateKey: keys.d!, hookSecret: 'test' }, rpc)).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenLastCalledWith('service_complete_employee_push', { target_id: id, target_claim_token: id, target_outcome: 'delivered' })
  })
  it('never sends an ineligible job and preserves its lease token', async () => {
    const id = '10000000-0000-4000-8000-000000000001'
    const rpc = vi.fn(async (name: string) => name === 'service_claim_employee_push' ? [{ id, claimToken: id, notificationId: id, employeeId: id, createdAt: new Date().toISOString(), path: '/notifications', attempt: 1, eligible: false, subscription: { endpoint: 'https://fcm.googleapis.com/x', expirationTime: null, keys: { p256dh: '', auth: '' } } }] : null)
    const send = vi.fn(); vi.stubGlobal('fetch', send)
    await deliverPushBatch({ publicKey: '', privateKey: '', hookSecret: '' }, rpc)
    expect(send).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenLastCalledWith('service_complete_employee_push', { target_id: id, target_claim_token: id, target_outcome: 'expired' })
  })
})
