import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquirePersonalEmailVerificationIntent,
  clearPersonalEmailVerificationIntent,
  personalEmailVerificationFailureIsAmbiguous,
  requestPersonalEmailVerification,
} from './myAccount'

const supabaseMock = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn(async () => ({
      data: { session: { access_token: 'signed-in-session' } },
      error: null,
    })),
  },
}))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => supabaseMock,
}))

const ownerA = '10000000-0000-4000-8000-000000000001'
const ownerB = '10000000-0000-4000-8000-000000000002'

describe('personal-email verification operation lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.sessionStorage.clear()
    supabaseMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'signed-in-session' } },
      error: null,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists an account-and-recipient-bound intent before dispatch and restores it after remount or reload', () => {
    const initial = acquirePersonalEmailVerificationIntent(ownerA, ' Person@Example.com ', 1_000)
    expect(window.sessionStorage.length).toBe(1)

    const restored = acquirePersonalEmailVerificationIntent(ownerA, 'person@example.com', 2_000)
    expect(restored).toEqual(initial)

    const changedRecipient = acquirePersonalEmailVerificationIntent(ownerA, 'other@example.com', 2_000)
    expect(changedRecipient.operationId).not.toBe(initial.operationId)
    expect(window.sessionStorage.length).toBe(1)

    const changedAccount = acquirePersonalEmailVerificationIntent(ownerB, 'other@example.com', 2_000)
    expect(changedAccount.operationId).not.toBe(changedRecipient.operationId)
    expect(window.sessionStorage.length).toBe(1)
  })

  it('clears a confirmed operation so a deliberate later send receives a new identity', () => {
    const confirmed = acquirePersonalEmailVerificationIntent(ownerA, 'person@example.com', 1_000)
    clearPersonalEmailVerificationIntent()

    const next = acquirePersonalEmailVerificationIntent(ownerA, 'person@example.com', 2_000)
    expect(next.operationId).not.toBe(confirmed.operationId)
    expect(window.sessionStorage.length).toBe(1)
  })

  it('retains the operation across teardown while the dispatch response is still pending', async () => {
    let rejectFetch: ((reason?: unknown) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject
    })))

    const intent = acquirePersonalEmailVerificationIntent(ownerA, 'person@example.com', 1_000)
    const pending = requestPersonalEmailVerification(intent.email, intent.operationId)
    await vi.waitFor(() => expect(rejectFetch).toBeTypeOf('function'))

    const restoredAfterTeardown = acquirePersonalEmailVerificationIntent(
      ownerA,
      'person@example.com',
      2_000,
    )
    expect(restoredAfterTeardown.operationId).toBe(intent.operationId)
    expect(window.sessionStorage.length).toBe(1)

    rejectFetch?.(new TypeError('tab closed before the response arrived'))
    const result = await pending.catch((error: unknown) => error)
    expect(personalEmailVerificationFailureIsAmbiguous(result)).toBe(true)
  })

  it('classifies lost and server-uncertain outcomes as replayable but terminal rejection as new work', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('network response lost')))
    const networkFailure = await requestPersonalEmailVerification(
      'person@example.com',
      '50000000-0000-4000-8000-000000000001',
    ).catch((error: unknown) => error)
    expect(personalEmailVerificationFailureIsAmbiguous(networkFailure)).toBe(true)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      detail: 'The request is not allowed.',
      error: 'company_email_not_allowed',
    }), { headers: { 'content-type': 'application/json' }, status: 422 })))
    const terminalFailure = await requestPersonalEmailVerification(
      'person@example.com',
      '50000000-0000-4000-8000-000000000002',
    ).catch((error: unknown) => error)
    expect(personalEmailVerificationFailureIsAmbiguous(terminalFailure)).toBe(false)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      detail: 'The verification request was preserved.',
      error: 'email_verification_finalization_pending',
    }), { headers: { 'content-type': 'application/json' }, status: 503 })))
    const committedUnknown = await requestPersonalEmailVerification(
      'person@example.com',
      '50000000-0000-4000-8000-000000000003',
    ).catch((error: unknown) => error)
    expect(personalEmailVerificationFailureIsAmbiguous(committedUnknown)).toBe(true)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      expiresAt: '2026-10-24T18:00:00.000Z',
      operationId: '50000000-0000-4000-8000-000000000099',
      sent: true,
    }), { headers: { 'content-type': 'application/json' }, status: 200 })))
    const mismatchedSuccess = await requestPersonalEmailVerification(
      'person@example.com',
      '50000000-0000-4000-8000-000000000004',
    ).catch((error: unknown) => error)
    expect(personalEmailVerificationFailureIsAmbiguous(mismatchedSuccess)).toBe(true)
  })
})
