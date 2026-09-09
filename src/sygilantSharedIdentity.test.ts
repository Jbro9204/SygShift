import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleSygilantSharedIdentityRequest,
  type SygilantSharedIdentityEnvironment,
} from '../worker/sygilantSharedIdentity'

const authUserId = 'cc65cc0f-1715-4c58-9a86-001731f67376'
const employeeId = 'a25a5f5f-45b6-4e43-87a6-79298ed9347f'
const apiRequestId = 'eacdc293-e7ff-4d14-8f8e-38340e26a2c5'
const authSessionId = '7c21701a-56ed-4c64-8c47-c9dc516e4398'
const environment: SygilantSharedIdentityEnvironment = {
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_URL: 'https://project.supabase.co',
  SYGSHIFT_PUBLIC_APP_URL: 'https://app.sygilant.us',
  SYGILANT_SHARED_IDENTITY_APPLICATION_URL: 'https://sygilant.us',
  SYGILANT_SHARED_IDENTITY_AUDIENCE: 'https://sygilant.us',
  SYGILANT_SHARED_IDENTITY_CONSUMER_SECRET: 'consumer-secret-with-enough-entropy-0001',
  SYGILANT_SHARED_IDENTITY_ENABLED: 'true',
  SYGILANT_SHARED_IDENTITY_ISSUER: 'https://app.sygilant.us',
  SYGILANT_SHARED_IDENTITY_SIGNING_SECRET: 'signing-secret-with-enough-entropy-00001',
  SYGILANT_SHARED_IDENTITY_TOKEN_TTL_SECONDS: '60',
}

afterEach(() => vi.unstubAllGlobals())

describe('SygShift to Sygilant protected platform launch', () => {
  it('fails closed when disabled and enforces the exact SygShift origin', async () => {
    const disabled = await handleSygilantSharedIdentityRequest(launchRequest(), {
      ...environment,
      SYGILANT_SHARED_IDENTITY_ENABLED: 'false',
    }, apiRequestId)
    expect(disabled?.status).toBe(503)
    await expect(disabled?.json()).resolves.toMatchObject({ error: 'sygilant_shared_identity_disabled' })

    const denied = await handleSygilantSharedIdentityRequest(launchRequest('https://attacker.example'), environment, apiRequestId)
    expect(denied?.status).toBe(403)
    await expect(denied?.json()).resolves.toMatchObject({ error: 'sygilant_launch_origin_denied' })
  })

  it('fails closed before any upstream request when the signing and consumer keys match', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)
    const response = await handleSygilantSharedIdentityRequest(launchRequest(), {
      ...environment,
      SYGILANT_SHARED_IDENTITY_SIGNING_SECRET: environment.SYGILANT_SHARED_IDENTITY_CONSUMER_SECRET,
    }, apiRequestId)

    expect(response?.status).toBe(503)
    await expect(response?.json()).resolves.toMatchObject({ error: 'sygilant_shared_identity_not_configured' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('identifies an unavailable session-context stage without exposing upstream details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('private upstream failure')))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const response = await handleSygilantSharedIdentityRequest(launchRequest(), environment, apiRequestId)

      expect(response?.status).toBe(503)
      await expect(response?.json()).resolves.toEqual({
        detail: 'The active SygShift security context could not be confirmed.',
        error: 'sygilant_launch_session_context_unavailable',
        requestId: apiRequestId,
      })
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('sygilant_launch_session_context_unavailable'))
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('"diagnostic":"type_error"'))
      expect(errorLog).not.toHaveBeenCalledWith(expect.stringContaining('private upstream failure'))
    } finally {
      errorLog.mockRestore()
    }
  })

  it('follows one same-origin upstream redirect without changing the protected request', async () => {
    const requests: Array<{ body: BodyInit | null | undefined, url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = String(input)
      requests.push({ body: init.body, url })
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (url.endsWith('/rest/v1/rpc/get_session_context')) {
        return new Response(null, {
          headers: { location: '/rest/v1/rpc/get_session_context?canonical=true' },
          status: 307,
        })
      }
      if (url.includes('/rest/v1/rpc/get_session_context?canonical=true')) {
        return json({ employee_id: employeeId, has_mfa: true, permissions: ['apps.sygilant.access'], role: 'admin', username: 'jordan' })
      }
      if (url.includes('/auth/v1/user')) return json({ id: authUserId })
      if (url.includes('/rest/v1/rpc/service_issue_sygilant_shared_launch')) {
        return json({ requestId: (body.target_payload as Record<string, unknown>).requestId })
      }
      return json({ error: 'unhandled' }, 500)
    }))

    const response = await handleSygilantSharedIdentityRequest(launchRequest(), environment, apiRequestId)

    expect(response?.status).toBe(201)
    expect(requests.slice(0, 2)).toEqual([
      { body: '{}', url: 'https://project.supabase.co/rest/v1/rpc/get_session_context' },
      { body: '{}', url: 'https://project.supabase.co/rest/v1/rpc/get_session_context?canonical=true' },
    ])
  })

  it('rejects a cross-origin upstream redirect before forwarding protected headers', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response(null, {
      headers: { location: 'https://attacker.example/collect' },
      status: 307,
    }))
    vi.stubGlobal('fetch', upstream)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const response = await handleSygilantSharedIdentityRequest(launchRequest(), environment, apiRequestId)

      expect(response?.status).toBe(502)
      await expect(response?.json()).resolves.toMatchObject({ error: 'shared_identity_upstream_redirect_rejected' })
      expect(upstream).toHaveBeenCalledTimes(1)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('issues a short-lived signed assertion only for a permissioned MFA session', async () => {
    const rpcBodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return json({ employee_id: employeeId, has_mfa: true, permissions: ['apps.sygilant.access'], role: 'admin', username: 'jordan' })
      }
      if (url.includes('/auth/v1/user')) return json({ id: authUserId })
      if (url.includes('/rest/v1/rpc/service_issue_sygilant_shared_launch')) {
        rpcBodies.push(body)
        return json({ requestId: (body.target_payload as Record<string, unknown>).requestId })
      }
      return json({ error: 'unhandled' }, 500)
    }))

    const response = await handleSygilantSharedIdentityRequest(launchRequest(), environment, apiRequestId)
    expect(response?.status).toBe(201)
    const payload = await response?.json() as { launch: Record<string, string> }
    expect(payload.launch).toMatchObject({
      applicationId: 'sygilant',
      applicationUrl: 'https://sygilant.us',
      destination: '/dashboard',
    })
    expect(payload.launch.assertion).toMatch(/^ssli_v1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/)
    expect(payload.launch.assertion).not.toContain(authUserId)
    expect(rpcBodies[0]?.target_payload).toMatchObject({
      applicationId: 'sygilant',
      audience: 'https://sygilant.us',
      externalEmployeeId: employeeId,
      externalSubjectId: authUserId,
      externalUsername: 'jordan',
      issuer: 'https://app.sygilant.us',
      sourceAuthSessionId: authSessionId,
    })
    const assertionPayload = decodeAssertion(payload.launch.assertion)
    expect(assertionPayload).not.toHaveProperty('sourceAuthSessionId')
  })

  it.each(['revoked', 'expired', 'mismatched'])(
    'does not issue an assertion when the source auth session is %s',
    async (sourceSessionState) => {
      vi.stubGlobal('fetch', vi.fn(async (input) => {
        const url = String(input)
        if (url.includes('/rest/v1/rpc/get_session_context')) {
          return json({ employee_id: employeeId, has_mfa: true, permissions: ['apps.sygilant.access'], role: 'admin', username: 'jordan' })
        }
        if (url.includes('/auth/v1/user')) return json({ id: authUserId })
        if (url.includes('/rest/v1/rpc/service_issue_sygilant_shared_launch')) {
          return json({ message: `Source auth session is ${sourceSessionState}.` }, 403)
        }
        return json({ error: 'unhandled' }, 500)
      }))

      const response = await handleSygilantSharedIdentityRequest(launchRequest(), environment, apiRequestId)
      expect(response?.status).toBe(502)
      await expect(response?.json()).resolves.toMatchObject({ error: 'shared_identity_upstream_rejected' })
    },
  )

  it('revalidates and atomically consumes an issued assertion for the authorized Sygilant server', async () => {
    let issuedPayload: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return json({ employee_id: employeeId, has_mfa: true, permissions: ['apps.sygilant.access'], role: 'admin', username: 'jordan' })
      }
      if (url.includes('/auth/v1/user')) return json({ id: authUserId })
      if (url.includes('/rest/v1/rpc/service_issue_sygilant_shared_launch')) {
        issuedPayload = body.target_payload as Record<string, unknown>
        return json({ requestId: issuedPayload.requestId })
      }
      if (url.includes('/rest/v1/rpc/service_consume_sygilant_shared_launch')) {
        const consumed = body.target_payload as Record<string, unknown>
        return json({
          assuranceLevel: consumed.assuranceLevel,
          authUserId: consumed.externalSubjectId,
          destination: consumed.destination,
          employeeId: consumed.externalEmployeeId,
          expiresAt: consumed.expiresAt,
          requestId: consumed.requestId,
          roleId: consumed.roleId,
          username: consumed.externalUsername,
        })
      }
      return json({ error: 'unhandled' }, 500)
    }))

    const issued = await handleSygilantSharedIdentityRequest(launchRequest(), environment, apiRequestId)
    if (!issued) throw new Error('The Sygilant launch route was not handled.')
    const assertion = ((await issued.json()) as { launch: { assertion: string } }).launch.assertion
    expect(issuedPayload).not.toBeNull()

    const introspected = await handleSygilantSharedIdentityRequest(new Request(
      'https://app.sygilant.us/api/v1/apps/sygilant/introspect',
      {
        body: JSON.stringify({ assertion }),
        headers: {
          authorization: `Bearer ${environment.SYGILANT_SHARED_IDENTITY_CONSUMER_SECRET}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      },
    ), environment, apiRequestId)
    expect(introspected?.status).toBe(200)
    await expect(introspected?.json()).resolves.toMatchObject({
      identity: {
        applicationId: 'sygilant',
        destination: '/dashboard',
        externalEmployeeId: employeeId,
        externalSubjectId: authUserId,
        externalUsername: 'jordan',
      },
    })
  })

  it.each(['revoked', 'expired', 'mismatched'])(
    'does not consume an assertion when its source auth session is %s',
    async (sourceSessionState) => {
      let issuedPayload: Record<string, unknown> | null = null
      vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
        const url = String(input)
        const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
        if (url.includes('/rest/v1/rpc/get_session_context')) {
          return json({ employee_id: employeeId, has_mfa: true, permissions: ['apps.sygilant.access'], role: 'admin', username: 'jordan' })
        }
        if (url.includes('/auth/v1/user')) return json({ id: authUserId })
        if (url.includes('/rest/v1/rpc/service_issue_sygilant_shared_launch')) {
          issuedPayload = body.target_payload as Record<string, unknown>
          return json({ requestId: issuedPayload.requestId })
        }
        if (url.includes('/rest/v1/rpc/service_consume_sygilant_shared_launch')) {
          return json({ message: `Source auth session is ${sourceSessionState}.` }, 403)
        }
        return json({ error: 'unhandled' }, 500)
      }))

      const issued = await handleSygilantSharedIdentityRequest(launchRequest(), environment, apiRequestId)
      if (!issued) throw new Error('The Sygilant launch route was not handled.')
      const assertion = ((await issued.json()) as { launch: { assertion: string } }).launch.assertion
      const introspected = await handleSygilantSharedIdentityRequest(introspectionRequest(assertion), environment, apiRequestId)

      expect(introspected?.status).toBe(502)
      await expect(introspected?.json()).resolves.toMatchObject({ error: 'shared_identity_upstream_rejected' })
    },
  )
})

function launchRequest(origin = 'https://app.sygilant.us') {
  return new Request('https://app.sygilant.us/api/v1/apps/sygilant/launch', {
    headers: { authorization: `Bearer ${accessToken()}`, origin },
    method: 'POST',
  })
}

function accessToken() {
  const claims = btoa(JSON.stringify({
    aal: 'aal2',
    exp: Math.floor(Date.now() / 1000) + 3600,
    session_id: authSessionId,
    sub: authUserId,
  })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return `header.${claims}.signature`
}

function introspectionRequest(assertion: string) {
  return new Request('https://app.sygilant.us/api/v1/apps/sygilant/introspect', {
    body: JSON.stringify({ assertion }),
    headers: {
      authorization: `Bearer ${environment.SYGILANT_SHARED_IDENTITY_CONSUMER_SECRET}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  })
}

function decodeAssertion(assertion: string) {
  const encoded = assertion.split('.')[1] ?? ''
  const normalized = encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=')
  return JSON.parse(atob(normalized)) as Record<string, unknown>
}

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status })
}
