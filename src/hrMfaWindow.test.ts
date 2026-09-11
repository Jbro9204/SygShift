import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { recentAuthenticatorMfa } from '../worker'
import { responseRequiresIdentityVerification } from './lib/identityVerificationCoordinator'

const actorId = '10000000-0000-4000-8000-000000000001'
const sessionId = '10000000-0000-4000-8000-000000000002'
const env = {
  ASSETS: { fetch: vi.fn() },
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service',
  SUPABASE_URL: 'https://example.supabase.co',
} as unknown as Parameters<typeof worker.fetch>[1]

function hrWindowRequest(ageMinutes: number, aal: 'aal1' | 'aal2' = 'aal2') {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const claims = {
    aal,
    amr: aal === 'aal2' ? [{ method: 'totp', timestamp: nowSeconds - ageMinutes * 60 }] : [],
    session_id: sessionId,
  }
  return new Request('https://app.sygshift.example/api/v1/hr/mfa/window', {
    headers: { authorization: `Bearer test.${btoa(JSON.stringify(claims))}.test` },
  })
}

function installTransport(verification: Record<string, unknown> | null = null) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/get_session_context')) return Response.json({
      employee_id: actorId,
      has_mfa: false,
      permissions: [],
      role: 'admin',
    })
    if (String(url).endsWith('/service_verify_recent_hr_mfa')) {
      if (verification) return Response.json(verification)
      const body = JSON.parse(String(init?.body ?? '{}')) as { target_method?: string, target_verified_at?: string }
      return Response.json(body.target_method === 'authenticator' && body.target_verified_at
        ? { method: 'authenticator', verifiedAt: body.target_verified_at }
        : null)
    }
    throw new Error(`Unexpected request: ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('unified HR MFA window', () => {
  it('keeps the legacy protected-document window at 15 minutes while HR accepts 30 minutes', () => {
    const nowSeconds = 2_000_000_000
    const claims = {
      aal: 'aal2',
      amr: [{ method: 'totp', timestamp: nowSeconds - 20 * 60 }],
    }
    expect(recentAuthenticatorMfa(claims, nowSeconds)).toBeNull()
    expect(recentAuthenticatorMfa(claims, nowSeconds, 30 * 60)).toBe(new Date((nowSeconds - 20 * 60) * 1000).toISOString())
  })

  it('accepts one authenticator verification throughout the fixed 30-minute HR window', async () => {
    const fetchMock = installTransport()
    const response = await worker.fetch(hrWindowRequest(20), env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ method: 'authenticator' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('requires a new verification after the HR window expires', async () => {
    installTransport()
    const response = await worker.fetch(hrWindowRequest(31), env)
    expect(response.status).toBe(403)
    expect(await responseRequiresIdentityVerification(response)).toBe(true)
    expect(await response.json()).toMatchObject({ error: 'recent_hr_mfa_required' })
  })

  it('recognizes a session-bound security-key verification without copying its token between tabs', async () => {
    installTransport({ method: 'security_key', verifiedAt: new Date().toISOString() })
    const response = await worker.fetch(hrWindowRequest(31, 'aal1'), env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ method: 'security_key' })
  })
})
