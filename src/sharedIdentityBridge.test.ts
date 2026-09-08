import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleSharedIdentityRequest, type SharedIdentityEnvironment } from '../worker/sharedIdentity'

const authUserId = 'cc65cc0f-1715-4c58-9a86-001731f67376'
const employeeId = 'a25a5f5f-45b6-4e43-87a6-79298ed9347f'
const requestId = 'eacdc293-e7ff-4d14-8f8e-38340e26a2c5'
const assertion = `glsi_v1.${'a'.repeat(80)}.${'b'.repeat(64)}`
const environment: SharedIdentityEnvironment = {
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_URL: 'https://project.supabase.co',
  SYGSHIFT_PUBLIC_APP_URL: 'https://app.sygilant.us',
  SYGSHIFT_SHARED_IDENTITY_CONSUMER_SECRET: 'consumer-secret-with-enough-entropy-0001',
  SYGSHIFT_SHARED_IDENTITY_ENABLED: 'true',
  SYGSHIFT_SHARED_IDENTITY_INTROSPECTION_URL: 'https://sygilant.us/api/apps/sygshift/introspect',
  SYGSHIFT_SHARED_IDENTITY_ISSUER: 'https://sygilant.us',
  SYGSHIFT_SHARED_IDENTITY_SESSION_SECRET: 'session-secret-with-enough-entropy-00001',
}

afterEach(() => vi.unstubAllGlobals())

describe('Sygilant to SygSphere shared session bridge', () => {
  it('fails closed when the integration is disabled', async () => {
    const response = await handleSharedIdentityRequest(launchRequest(), {
      ...environment,
      SYGSHIFT_SHARED_IDENTITY_ENABLED: 'false',
    }, requestId)
    expect(response?.status).toBe(503)
    await expect(response?.json()).resolves.toMatchObject({ error: 'shared_identity_disabled' })
  })

  it('accepts only an exact origin, POST form, and SygSphere destination', async () => {
    expect((await handleSharedIdentityRequest(new Request('https://app.sygilant.us/api/v1/auth/shared-identity/launch'), environment, requestId))?.status).toBe(405)
    expect((await handleSharedIdentityRequest(launchRequest({ origin: 'https://wrong.sygilant.us' }), environment, requestId))?.status).toBe(403)
    expect((await handleSharedIdentityRequest(launchRequest({ destination: '/schedule' }), environment, requestId))?.status).toBe(400)

    const accepted = await handleSharedIdentityRequest(launchRequest(), environment, requestId)
    expect(accepted?.status).toBe(303)
    expect(accepted?.headers.get('location')).toBe('/api/v1/auth/shared-identity/complete')
    expect(accepted?.headers.get('set-cookie')).toContain('__Host-sygshift-shared-launch=')
    expect(accepted?.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('revalidates locally, creates the existing user session, and binds inherited MFA to it', async () => {
    const calls: Array<{ body: Record<string, unknown> | null, url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
      calls.push({ body, url })
      if (url.includes('/api/apps/sygshift/introspect')) return json({ identity: sharedIdentity() })
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) return json(localIdentity())
      if (url.includes('/auth/v1/admin/generate_link')) {
        return json({ action_link: 'https://project.supabase.co/auth/v1/verify?token=opaque&type=magiclink&redirect_to=https%3A%2F%2Fapp.sygilant.us%2Fauth%2Fshared-identity%2Fcallback' })
      }
      if (url.includes('/auth/v1/user')) return json({ id: authUserId })
      if (url.includes('/rest/v1/rpc/service_issue_shared_identity_session')) return json({ id: crypto.randomUUID() })
      return json({ error: 'unhandled' }, 500)
    }))

    const received = await handleSharedIdentityRequest(launchRequest(), environment, requestId)
    const launchCookie = cookieValue(received?.headers.get('set-cookie') ?? '', '__Host-sygshift-shared-launch')
    const completed = await handleSharedIdentityRequest(new Request(
      'https://app.sygilant.us/api/v1/auth/shared-identity/complete',
      { headers: { cookie: `__Host-sygshift-shared-launch=${launchCookie}` } },
    ), environment, requestId)
    expect(completed?.status).toBe(303)
    expect(completed?.headers.get('location')).toMatch(/^https:\/\/project\.supabase\.co\/auth\/v1\/verify/)

    const ticket = cookieValue(completed?.headers.get('set-cookie') ?? '', '__Host-sygshift-shared-ticket')
    const finalized = await handleSharedIdentityRequest(new Request(
      'https://app.sygilant.us/api/v1/auth/shared-identity/finalize',
      {
        headers: {
          authorization: `Bearer ${accessToken()}`,
          cookie: `__Host-sygshift-shared-ticket=${ticket}`,
          origin: 'https://app.sygilant.us',
        },
        method: 'POST',
      },
    ), environment, requestId)
    const payload = await finalized?.json() as { destination: string, persistent: boolean, sharedIdentityToken: string }
    expect(finalized?.status).toBe(200)
    expect(payload).toMatchObject({ destination: '/sygsphere', persistent: true })
    expect(payload.sharedIdentityToken).toMatch(/^[A-Za-z0-9_-]{64}$/)
    const issuance = calls.find((call) => call.url.includes('service_issue_shared_identity_session'))?.body
    expect(issuance).toMatchObject({
      target_assurance_level: 'trusted_device',
      target_auth_user_id: authUserId,
      target_employee_id: employeeId,
      target_launch_request_id: requestId,
    })
  })

  it('denies an identity that no longer matches the active SygShift account', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input)
      if (url.includes('/api/apps/sygshift/introspect')) return json({ identity: sharedIdentity() })
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) {
        return json({ ...localIdentity(), existingAuthUserId: '714c216e-1dba-4201-aa3b-495923e26ad0' })
      }
      return json({ error: 'unhandled' }, 500)
    }))
    const received = await handleSharedIdentityRequest(launchRequest(), environment, requestId)
    const launchCookie = cookieValue(received?.headers.get('set-cookie') ?? '', '__Host-sygshift-shared-launch')
    const response = await handleSharedIdentityRequest(new Request(
      'https://app.sygilant.us/api/v1/auth/shared-identity/complete',
      { headers: { cookie: `__Host-sygshift-shared-launch=${launchCookie}` } },
    ), environment, requestId)
    expect(response?.status).toBe(403)
    await expect(response?.json()).resolves.toMatchObject({ error: 'shared_identity_subject_mismatch' })
  })
})

function launchRequest(overrides: { destination?: string, origin?: string } = {}) {
  return new Request('https://app.sygilant.us/api/v1/auth/shared-identity/launch', {
    body: new URLSearchParams({ assertion, destination: overrides.destination ?? '/sygsphere' }),
    headers: { origin: overrides.origin ?? 'https://sygilant.us' },
    method: 'POST',
  })
}

function sharedIdentity() {
  return {
    applicationId: 'sygshift',
    assuranceLevel: 'trusted_device',
    destination: '/sygsphere',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    externalEmployeeId: employeeId,
    externalSubjectId: authUserId,
    externalUsername: 'lucius',
    profileId: authUserId,
    requestId,
  }
}

function localIdentity() {
  return {
    authEmail: 'lucius@accounts.sygshift.invalid',
    employeeId,
    existingAuthUserId: authUserId,
    username: 'lucius',
  }
}

function accessToken() {
  const claims = btoa(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    session_id: '7c21701a-56ed-4c64-8c47-c9dc516e4398',
    sub: authUserId,
  })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return `header.${claims}.signature`
}

function cookieValue(header: string, name: string): string {
  return header.match(new RegExp(`${name}=([^;,]+)`))?.[1] ?? ''
}

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status })
}
