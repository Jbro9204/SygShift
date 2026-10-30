import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker'

const employeeId = 'a25a5f5f-45b6-4e43-87a6-79298ed9347f'
const authUserId = 'cc65cc0f-1715-4c58-9a86-001731f67376'
const authSessionId = '7c21701a-56ed-4c64-8c47-c9dc516e4398'
const operationId = 'c17a05f4-515b-44f0-a175-a54e4db83ed3'

function token(expiresAtSeconds = Math.floor(Date.now() / 1000) + 3_600): string {
  const payload = Buffer.from(JSON.stringify({
    exp: expiresAtSeconds,
    session_id: authSessionId,
    sub: authUserId,
  })).toString('base64url')
  return `header.${payload}.signature`
}

function environment(): Partial<Env> & { ASSETS: Fetcher } {
  return {
    ASSETS: { fetch: vi.fn().mockResolvedValue(new Response('asset')) },
    SUPABASE_PUBLISHABLE_KEY: 'publishable',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    SUPABASE_URL: 'https://example.supabase.co',
  } as unknown as Partial<Env> & { ASSETS: Fetcher }
}

function emergencyContext(accessGeneration = 4) {
  return {
    accessGeneration,
    active: true,
    authSessionActive: true,
    display_name: 'Jordan Brown',
    emergencyAccessEnforced: true,
    emergencyAccessState: 'active',
    employee_id: employeeId,
    has_mfa: true,
    permissions: ['operations.view'],
    role: 'admin',
    username: 'jbrown',
  }
}

describe('SygShift centralized platform session boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers the exact verified Auth session, generation, and JWT expiry', async () => {
    const accessToken = token()
    const providerSessionHash = createHash('sha256').update(authSessionId).digest('hex')
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/rest/v1/rpc/get_session_context_emergency')) {
        return Response.json(emergencyContext(4))
      }
      if (url.endsWith('/rest/v1/rpc/sygilant_service_register_emergency_platform_session')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toEqual({
          target_access_generation: 4,
          target_application: 'sygshift',
          target_auth_user_id: authUserId,
          target_employee_id: employeeId,
          target_expires_at: new Date((JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as { exp: number }).exp * 1000).toISOString(),
          target_provider_session_hash: providerSessionHash,
        })
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-role')
        return Response.json({
          accessGeneration: 4,
          application: 'sygshift',
          expiresAt: body.target_expires_at,
          id: '359c4100-06f1-4e37-8b40-b264ff10f009',
        })
      }
      return Response.json({ error: 'not_found' }, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(new Request(
      'https://app.sygilant.us/api/v1/security/emergency-session/register',
      {
        body: JSON.stringify({ expectedAccessGeneration: 4 }),
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      },
    ), environment())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      accessGeneration: 4,
      application: 'sygshift',
      registered: true,
    })
  })

  it('rejects a changed access generation without registering the session', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/rest/v1/rpc/get_session_context_emergency')) {
        return Response.json(emergencyContext(5))
      }
      return Response.json({ error: 'unexpected' }, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(new Request(
      'https://app.sygilant.us/api/v1/security/emergency-session/register',
      {
        body: JSON.stringify({ expectedAccessGeneration: 4 }),
        headers: {
          authorization: `Bearer ${token()}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      },
    ), environment())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: 'access_generation_changed' })
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('register_emergency_platform_session'))).toBe(false)
  })

  it('uses the revoked JWT to acknowledge and close its exact registry row through the user-bound RPC', async () => {
    const accessToken = token()
    const providerSessionHash = createHash('sha256').update(authSessionId).digest('hex')
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/rest/v1/rpc/acknowledge_emergency_platform_session_revocation')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toEqual({
          target_access_generation: 7,
          target_application: 'sygshift',
          target_operation_id: operationId,
          target_provider_session_hash: providerSessionHash,
        })
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${accessToken}`)
        return Response.json({
          accessGeneration: 7,
          acknowledged: true,
          acknowledgedAt: '2026-10-29T22:15:00.000Z',
          application: 'sygshift',
          closed: true,
          operationId,
        })
      }
      return Response.json({ error: 'not_found' }, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(new Request(
      'https://app.sygilant.us/api/v1/security/emergency-session/revocation-acknowledgement',
      {
        body: JSON.stringify({ accessGeneration: 7, operationId }),
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      },
    ), environment())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      acknowledged: true,
      closed: true,
      operationId,
    })
  })

  it('never uses an unverified JWT identity for acknowledgement', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/rest/v1/rpc/acknowledge_emergency_platform_session_revocation')) {
        return Response.json({ code: 'PGRST301', message: 'JWT verification failed' }, { status: 401 })
      }
      return Response.json({ error: 'unexpected' }, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(new Request(
      'https://app.sygilant.us/api/v1/security/emergency-session/revocation-acknowledgement',
      {
        body: JSON.stringify({ accessGeneration: 7, operationId }),
        headers: {
          authorization: `Bearer ${token()}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      },
    ), environment())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'auth_required' })
  })

  it('rejects a revoked token when its central access generation does not match the forced-logout event', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/rest/v1/rpc/acknowledge_emergency_platform_session_revocation')) {
        return Response.json({ code: 'P0001', message: 'access_generation_mismatch' }, { status: 409 })
      }
      return Response.json({ error: 'unexpected' }, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(new Request(
      'https://app.sygilant.us/api/v1/security/emergency-session/revocation-acknowledgement',
      {
        body: JSON.stringify({ accessGeneration: 7, operationId }),
        headers: {
          authorization: `Bearer ${token()}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      },
    ), environment())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: 'revocation_acknowledgement_rejected' })
  })
})
