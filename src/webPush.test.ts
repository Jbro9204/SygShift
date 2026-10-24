// @vitest-environment node
import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { allowedPushEndpoint, deliverPushBatch, reconcilePushProviderOutcomes, validPushHook } from '../worker/webPush'

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
    expect(rpc.mock.calls.findIndex(([name]) => name === 'service_mark_employee_push_provider_state'))
      .toBeLessThan(rpc.mock.calls.findIndex(([name]) => name === 'service_complete_employee_push'))
    expect(rpc).toHaveBeenCalledWith('service_mark_employee_push_provider_state', {
      target_id: id,
      target_claim_token: id,
      target_provider_state: 'accepted',
      target_provider_outcome: 'delivered',
    })
    expect(rpc).toHaveBeenLastCalledWith('service_complete_employee_push', { target_id: id, target_claim_token: id, target_outcome: 'delivered' })
  })

  it('retries only the idempotent completion write after provider acceptance', async () => {
    const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const keys = await crypto.subtle.exportKey('jwk', vapid.privateKey)
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url')
    const subscriber = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', subscriber.publicKey)).toString('base64url')
    const id = '10000000-0000-4000-8000-000000000011'
    const jobs = [{ id, claimToken: id, notificationId: id, employeeId: id, createdAt: new Date().toISOString(), path: '/notifications', attempt: 1, eligible: true,
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', expirationTime: null, keys: { p256dh, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') } } }]
    let completionAttempts = 0
    const rpc = vi.fn(async (name: string) => {
      if (name === 'service_claim_employee_push') return jobs
      if (name === 'service_mark_employee_push_provider_state') return null
      completionAttempts += 1
      if (completionAttempts < 3) throw new Error('completion response lost')
      return null
    })
    const send = vi.fn(async () => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', send)

    await expect(deliverPushBatch({ publicKey, privateKey: keys.d!, hookSecret: 'test' }, rpc)).resolves.toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(completionAttempts).toBe(3)
    expect(rpc).toHaveBeenLastCalledWith('service_complete_employee_push', {
      target_id: id,
      target_claim_token: id,
      target_outcome: 'delivered',
    })
  })

  it('never relabels a resolved provider response when persistence responses are lost', async () => {
    const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const keys = await crypto.subtle.exportKey('jwk', vapid.privateKey)
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url')
    const subscriber = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', subscriber.publicKey)).toString('base64url')
    const id = '10000000-0000-4000-8000-000000000021'
    const jobs = [{ id, claimToken: id, notificationId: id, employeeId: id, createdAt: new Date().toISOString(), path: '/notifications', attempt: 1, eligible: true,
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', expirationTime: null, keys: { p256dh, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') } } }]
    const providerWrites: Record<string, unknown>[] = []
    const rpc = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'service_claim_employee_push') return jobs
      if (name === 'service_mark_employee_push_provider_state') {
        providerWrites.push(input)
        throw new Error('provider-state response lost')
      }
      return null
    })
    const send = vi.fn(async () => new Response(null, { status: 410 }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', send)

    try {
      await expect(deliverPushBatch({ publicKey, privateKey: keys.d!, hookSecret: 'test' }, rpc))
        .rejects.toThrow('provider-state response lost')
      expect(send).toHaveBeenCalledTimes(1)
      expect(providerWrites).toHaveLength(3)
      expect(providerWrites).toEqual(providerWrites.map(() => ({
        target_id: id,
        target_claim_token: id,
        target_provider_state: 'resolved',
        target_provider_outcome: 'unavailable',
      })))
      expect(rpc.mock.calls.some(([name]) => name === 'service_complete_employee_push')).toBe(false)
    } finally {
      error.mockRestore()
    }
  })

  it('reconciles accepted completion writes and reports uncertain rows without resending', async () => {
    const rpc = vi.fn(async () => ({
      reconciled: 2,
      disabledSubscriptions: 1,
      completionPending: 0,
      reviewRequired: 3,
    }))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const send = vi.fn()
    vi.stubGlobal('fetch', send)

    try {
      await expect(reconcilePushProviderOutcomes(rpc)).resolves.toEqual({
        reconciled: 2,
        disabledSubscriptions: 1,
        completionPending: 0,
        reviewRequired: 3,
      })
      expect(rpc).toHaveBeenCalledWith('service_reconcile_employee_push_provider_outcomes', { target_limit: 100 })
      expect(send).not.toHaveBeenCalled()
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('push_provider_review_required'))
    } finally {
      warning.mockRestore()
    }
  })

  it('does not relabel an accepted push when response-body cleanup fails', async () => {
    const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const keys = await crypto.subtle.exportKey('jwk', vapid.privateKey)
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url')
    const subscriber = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', subscriber.publicKey)).toString('base64url')
    const id = '10000000-0000-4000-8000-000000000012'
    const jobs = [{ id, claimToken: id, notificationId: id, employeeId: id, createdAt: new Date().toISOString(), path: '/notifications', attempt: 1, eligible: true,
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', expirationTime: null, keys: { p256dh, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') } } }]
    const rpc = vi.fn(async (name: string) => name === 'service_claim_employee_push' ? jobs : null)
    const accepted = new Response('accepted', { status: 201 })
    vi.spyOn(accepted.body!, 'cancel').mockRejectedValueOnce(new Error('body cleanup failed'))
    const send = vi.fn(async () => accepted)
    vi.stubGlobal('fetch', send)

    await expect(deliverPushBatch({ publicKey, privateKey: keys.d!, hookSecret: 'test' }, rpc)).resolves.toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenLastCalledWith('service_complete_employee_push', {
      target_id: id,
      target_claim_token: id,
      target_outcome: 'delivered',
    })
  })

  it('fences an unresolved provider fetch without a second send or completion guess', async () => {
    const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const keys = await crypto.subtle.exportKey('jwk', vapid.privateKey)
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url')
    const subscriber = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', subscriber.publicKey)).toString('base64url')
    const id = '10000000-0000-4000-8000-000000000013'
    const jobs = [{ id, claimToken: id, notificationId: id, employeeId: id, createdAt: new Date().toISOString(), path: '/notifications', attempt: 1, eligible: true,
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', expirationTime: null, keys: { p256dh, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') } } }]
    const rpc = vi.fn(async (name: string) => name === 'service_claim_employee_push' ? jobs : null)
    const send = vi.fn().mockRejectedValue(new TypeError('provider result unavailable'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', send)

    try {
      await expect(deliverPushBatch({ publicKey, privateKey: keys.d!, hookSecret: 'test' }, rpc)).resolves.toBe(1)
      expect(send).toHaveBeenCalledTimes(1)
      expect(rpc).toHaveBeenCalledWith('service_mark_employee_push_provider_state', {
        target_id: id,
        target_claim_token: id,
        target_provider_state: 'uncertain',
        target_provider_outcome: null,
      })
      expect(rpc.mock.calls.some(([name]) => name === 'service_complete_employee_push')).toBe(false)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('push_provider_outcome_unknown'))
    } finally {
      warning.mockRestore()
    }
  })

  it('stops the batch when an accepted delivery cannot be durably completed', async () => {
    const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const keys = await crypto.subtle.exportKey('jwk', vapid.privateKey)
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url')
    const subscriber = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', subscriber.publicKey)).toString('base64url')
    const ids = [
      '10000000-0000-4000-8000-000000000014',
      '10000000-0000-4000-8000-000000000015',
    ]
    const jobs = ids.map((id) => ({ id, claimToken: id, notificationId: id, employeeId: id, createdAt: new Date().toISOString(), path: '/notifications', attempt: 1, eligible: true,
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', expirationTime: null, keys: { p256dh, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') } } }))
    const rpc = vi.fn(async (name: string) => {
      if (name === 'service_claim_employee_push') return jobs
      if (name === 'service_mark_employee_push_provider_state') return null
      throw new Error('completion unavailable')
    })
    const send = vi.fn(async () => new Response(null, { status: 201 }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', send)

    try {
      await expect(deliverPushBatch({ publicKey, privateKey: keys.d!, hookSecret: 'test' }, rpc))
        .rejects.toThrow('completion unavailable')
      expect(send).toHaveBeenCalledTimes(1)
      expect(rpc.mock.calls.filter(([name]) => name === 'service_complete_employee_push')).toHaveLength(3)
      expect(error).toHaveBeenCalledWith(expect.stringContaining('push_delivery_completion_unknown'))
    } finally {
      error.mockRestore()
    }
  })
  it('never sends an ineligible job and preserves its lease token', async () => {
    const id = '10000000-0000-4000-8000-000000000001'
    const rpc = vi.fn(async (name: string) => name === 'service_claim_employee_push' ? [{ id, claimToken: id, notificationId: id, employeeId: id, createdAt: new Date().toISOString(), path: '/notifications', attempt: 1, eligible: false, subscription: { endpoint: 'https://fcm.googleapis.com/x', expirationTime: null, keys: { p256dh: '', auth: '' } } }] : null)
    const send = vi.fn(); vi.stubGlobal('fetch', send)
    await deliverPushBatch({ publicKey: '', privateKey: '', hookSecret: '' }, rpc)
    expect(send).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenLastCalledWith('service_complete_employee_push', { target_id: id, target_claim_token: id, target_outcome: 'expired' })
  })

  it('serializes completion RPCs so a stalled pool never receives sibling fan-out', async () => {
    const ids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ]
    const jobs = ids.map((id) => ({
      id,
      claimToken: id,
      notificationId: id,
      employeeId: id,
      createdAt: new Date().toISOString(),
      path: '/notifications',
      attempt: 1,
      eligible: false,
      subscription: { endpoint: 'https://fcm.googleapis.com/x', expirationTime: null, keys: { p256dh: '', auth: '' } },
    }))
    let activeCompletions = 0
    let maximumConcurrentCompletions = 0
    const rpc = vi.fn(async (name: string) => {
      if (name === 'service_claim_employee_push') return jobs
      activeCompletions += 1
      maximumConcurrentCompletions = Math.max(maximumConcurrentCompletions, activeCompletions)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      activeCompletions -= 1
      return null
    })

    expect(await deliverPushBatch({ publicKey: '', privateKey: '', hookSecret: '' }, rpc)).toBe(2)
    expect(maximumConcurrentCompletions).toBe(1)
  })
})
