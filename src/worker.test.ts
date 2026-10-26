import { createHash } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'
import worker, {
  brandedEmailHtml,
  buildLoginInstructionsEmail,
  buildWelcomeEmail,
  finalizeSignatureEnvelope,
  protectedMaintenanceWindow,
  ScheduledSupabaseUnavailableError,
  secureResponse,
  validateSuppliedTemporaryPassword,
} from '../worker'

const sourceCommit = 'a'.repeat(40)

function healthyScheduledRuntimeSnapshot() {
  return {
    consecutiveFailures: 0,
    cooldownRemainingMs: 0,
    healthyCycles: 1,
    lastFailureAtMs: null,
    lastFailureOperation: null,
    lastFailureStatus: null,
    lastFailureTimedOut: false,
    lastFullSuccessAtMs: Date.now(),
    lastFullSuccessSourceCommit: sourceCommit,
    lastScheduledTimeMs: Date.now(),
    lastSuccessAtMs: Date.now(),
    leaseActive: false,
    leaseExpiresAtMs: null,
    mode: 'closed' as const,
    nextProbeAtMs: null,
    openedAtMs: null,
    recoverySuccesses: 0,
    updatedAtMs: Date.now(),
  }
}

function scheduledCoordinatorBinding() {
  const snapshot = healthyScheduledRuntimeSnapshot()
  const coordinator = {
    acquireCycle: vi.fn(async () => ({
      decision: 'run_full' as const,
      leaseExpiresAtMs: Date.now() + 75_000,
      leaseId: crypto.randomUUID(),
      state: snapshot,
    })),
    getSnapshot: vi.fn(async () => snapshot),
    recordFailure: vi.fn(async () => ({ applied: true, state: snapshot })),
    recordFullSuccess: vi.fn(async () => ({ applied: true, state: snapshot })),
    recordRecoverySuccess: vi.fn(async () => ({ applied: true, state: snapshot })),
    releaseCycle: vi.fn(async () => ({ applied: true, state: snapshot })),
    renewCycle: vi.fn(async () => ({ applied: true, state: snapshot })),
  }
  return { coordinator, namespace: { getByName: vi.fn(() => coordinator) } }
}

function environment(
  response: Response = new Response('asset'),
  values: Record<string, unknown> = {},
): Partial<Env> & { ASSETS: Fetcher } {
  return {
    ASSETS: { fetch: vi.fn().mockResolvedValue(response) },
    SCHEDULE_COORDINATOR: scheduledCoordinatorBinding().namespace,
    ...values,
  } as unknown as Partial<Env> & { ASSETS: Fetcher }
}

const configuredEnvironmentWithoutSourceCommit = {
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  SUPABASE_URL: 'https://example.supabase.co',
}

const configuredEnvironment = {
  ...configuredEnvironmentWithoutSourceCommit,
  SYGSHIFT_SOURCE_COMMIT: sourceCommit,
}

async function bridgeRecoveryHeaders(
  secret: string,
  username: string,
  fingerprint = 'c'.repeat(64),
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const nonce = crypto.randomUUID()
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const result = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`v1\n${timestamp}\n${nonce}\n${fingerprint}\n${username}`),
  )
  const signature = [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return {
    fingerprint,
    headers: {
      'x-sygilant-password-recovery-fingerprint': fingerprint,
      'x-sygilant-password-recovery-nonce': nonce,
      'x-sygilant-password-recovery-signature': signature,
      'x-sygilant-password-recovery-timestamp': timestamp,
    },
  }
}

function withClearMaintenanceStatus(
  fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/rest/v1/rpc/get_maintenance_status')) {
      return Promise.resolve(new Response(JSON.stringify({
        active: [],
        recentlyCompleted: [],
        serverTime: '2026-08-25T19:00:00.000Z',
        upcoming: [],
      }), { headers: { 'content-type': 'application/json' } }))
    }
    return fetchMock(input, init)
  })
}

describe('Cloudflare Worker boundary', () => {
  it('protects service-role writes only for active read-only or unavailable feature windows', () => {
    const status = {
      active: [
        {
          accessMode: 'notice' as const,
          endsAt: '2026-08-25T20:00:00.000Z',
          featureCodes: ['communications'],
          title: 'Communication notice',
        },
        {
          accessMode: 'read_only' as const,
          endsAt: '2026-08-25T20:00:00.000Z',
          featureCodes: ['user_accounts'],
          title: 'Account maintenance',
        },
      ],
    }

    expect(protectedMaintenanceWindow(status, 'communications')).toBeNull()
    expect(protectedMaintenanceWindow(status, 'user_accounts')?.title).toBe('Account maintenance')
    expect(protectedMaintenanceWindow(status, 'schedule')).toBeNull()
  })

  it('returns a no-store health response with request tracing and production security headers', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/health'),
      environment(),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', service: 'sygshift', version: 'v1' })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/)
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('strict-transport-security')).toContain('max-age=63072000')
    expect(response.headers.get('permissions-policy')).toContain('camera=(self)')
    expect(response.headers.get('permissions-policy')).toContain('microphone=(self)')
  })

  it('passes a Communications WebSocket upgrade response through without trying to reconstruct status 101', () => {
    const upgrade = {
      body: null,
      headers: new Headers({ upgrade: 'websocket' }),
      status: 101,
      statusText: 'Switching Protocols',
    } as unknown as Response

    expect(secureResponse(
      new Request('https://app.sygilant.us/api/comms/v1/connect'),
      upgrade,
      crypto.randomUUID(),
    )).toBe(upgrade)
  })

  it('returns method guidance without reflecting request details', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/health', { method: 'POST' }),
      environment(),
    )
    const payload = await response.json() as { error: string; requestId: string }

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(payload.error).toBe('method_not_allowed')
    expect(payload.requestId).toBe(response.headers.get('x-request-id'))
  })

  it('supports bodyless health checks', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/health', { method: 'HEAD' }),
      environment(),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('does not expose retired SygSphere upload status or retry routes', async () => {
    const uploadId = '10000000-0000-4000-8000-000000000001'
    for (const request of [
      new Request(`https://app.sygshift.example/api/v1/sygsphere/uploads/${uploadId}`),
      new Request(`https://app.sygshift.example/api/v1/sygsphere/uploads/${uploadId}/retry`, { method: 'POST' }),
    ]) {
      const assets = environment()
      const response = await worker.fetch(request, assets)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: 'not_found' })
      expect(assets.ASSETS.fetch).not.toHaveBeenCalled()
    }
  })

  it('keeps the protected Communications ingress unavailable while its runtime flag is closed', async () => {
    const assets = environment(new Response('asset'), configuredEnvironment)
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/comms/v1/bootstrap', { method: 'POST' }),
      assets,
    )
    const payload = await response.json() as { detail: string; error: string; requestId: string }

    expect(response.status).toBe(503)
    expect(payload.error).toBe('communications_unavailable')
    expect(payload.detail).toContain('SygSphere messages and Dispatch')
    expect(payload.requestId).toBe(response.headers.get('x-request-id'))
    expect(assets.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('keeps the internal provider smoke probe behind an authenticated MFA administrator boundary', async () => {
    const runtimeEnvironment = environment(new Response('asset'), {
      ...configuredEnvironment,
      SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED: 'true',
    })
    const unauthenticated = await worker.fetch(
      new Request('https://app.sygshift.example/api/comms/v1/internal/provider-smoke', { method: 'POST' }),
      runtimeEnvironment,
    )
    expect(unauthenticated.status).toBe(401)
    expect((await unauthenticated.json() as { error: string }).error).toBe('auth_required')

    const authUserId = '20000000-0000-4000-8000-000000000001'
    const token = `header.${btoa(JSON.stringify({ sub: authUserId })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}.signature`
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      employee_id: '10000000-0000-4000-8000-000000000001',
      has_mfa: false,
      permissions: ['admin.security.manage'],
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const withoutMfa = await worker.fetch(
        new Request('https://app.sygshift.example/api/comms/v1/internal/provider-smoke', {
          headers: { authorization: `Bearer ${token}` },
          method: 'POST',
        }),
        runtimeEnvironment,
      )
      expect(withoutMfa.status).toBe(403)
      expect((await withoutMfa.json() as { error: string }).error).toBe('communications_provider_probe_mfa_required')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        employee_id: '10000000-0000-4000-8000-000000000001',
        has_mfa: true,
        permissions: [],
      }), { headers: { 'content-type': 'application/json' } }))
      const withoutSecurityPermission = await worker.fetch(
        new Request('https://app.sygshift.example/api/comms/v1/internal/provider-smoke', {
          headers: { authorization: `Bearer ${token}` },
          method: 'POST',
        }),
        runtimeEnvironment,
      )
      expect(withoutSecurityPermission.status).toBe(403)
      expect((await withoutSecurityPermission.json() as { error: string }).error).toBe('permission_required')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('permits the exact first-party Worker origin through the narrow Communications CORS boundary', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygilant.us/api/comms/v1/bootstrap', {
        headers: { origin: 'https://sygshift.sygilant.workers.dev' },
        method: 'OPTIONS',
      }),
      environment(),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://sygshift.sygilant.workers.dev')
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(response.headers.get('vary')).toBe('Origin')
  })

  it('reports production readiness without exposing secret values', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/ready'),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as {
      checks: Record<string, boolean>
      ready: boolean
      requestId: string
      status: string
    }

    expect(response.status).toBe(200)
    expect(payload.ready).toBe(true)
    expect(payload.status).toBe('ready')
    expect(payload.checks.supabaseServiceRoleKey).toBe(true)
    expect(JSON.stringify(payload)).not.toContain('service-role')
  })

  it('proves readiness with a fresh full scheduler cycle owned by the configured source commit', async () => {
    const snapshot = {
      ...healthyScheduledRuntimeSnapshot(),
      lastFullSuccessSourceCommit: sourceCommit,
    }
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/ready'),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        SCHEDULE_COORDINATOR: {
          getByName: () => ({ getSnapshot: vi.fn(async () => snapshot) }),
        },
        SYGSHIFT_SOURCE_COMMIT: sourceCommit.toUpperCase(),
      }),
    )
    const payload = await response.json() as {
      checks: { scheduledRuntimeFresh: boolean; scheduledRuntimeSourceCommit: boolean }
      ready: boolean
      scheduledRuntime: {
        lastFullSuccessAt: string | null
        lastFullSuccessSourceCommit: string | null
      }
    }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      checks: {
        scheduledRuntimeFresh: true,
        scheduledRuntimeSourceCommit: true,
      },
      ready: true,
      scheduledRuntime: {
        lastFullSuccessSourceCommit: sourceCommit,
      },
    })
    expect(payload.scheduledRuntime.lastFullSuccessAt).toBe(new Date(snapshot.lastFullSuccessAtMs).toISOString())
  })

  it('stays degraded until the deployed source commit owns a complete scheduler cycle', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/ready'),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        SCHEDULE_COORDINATOR: {
          getByName: () => ({
            getSnapshot: vi.fn(async () => ({
              ...healthyScheduledRuntimeSnapshot(),
              lastFullSuccessSourceCommit: 'b'.repeat(40),
            })),
          }),
        },
        SYGSHIFT_SOURCE_COMMIT: sourceCommit,
      }),
    )
    const payload = await response.json() as {
      checks: { scheduledRuntimeFresh: boolean; scheduledRuntimeSourceCommit: boolean }
      ready: boolean
      status: string
    }

    expect(response.status).toBe(503)
    expect(payload).toMatchObject({
      checks: {
        scheduledRuntimeFresh: false,
        scheduledRuntimeSourceCommit: true,
      },
      ready: false,
      status: 'degraded',
    })
  })

  it('fails readiness configuration for a malformed source commit', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/ready'),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        SYGSHIFT_SOURCE_COMMIT: 'not-a-git-commit',
      }),
    )
    const payload = await response.json() as {
      checks: { scheduledRuntimeSourceCommit: boolean }
      ready: boolean
      status: string
    }

    expect(response.status).toBe(503)
    expect(payload).toMatchObject({
      checks: { scheduledRuntimeSourceCommit: false },
      ready: false,
      status: 'misconfigured',
    })
  })

  it('fails readiness configuration when the source commit is missing', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/ready'),
      environment(new Response('asset'), configuredEnvironmentWithoutSourceCommit),
    )
    const payload = await response.json() as {
      checks: { scheduledRuntimeFresh: boolean; scheduledRuntimeSourceCommit: boolean }
      ready: boolean
      status: string
    }

    expect(response.status).toBe(503)
    expect(payload).toMatchObject({
      checks: {
        scheduledRuntimeFresh: false,
        scheduledRuntimeSourceCommit: false,
      },
      ready: false,
      status: 'misconfigured',
    })
  })

  it('reports missing production configuration as not ready', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/ready'),
      environment(),
    )
    const payload = await response.json() as { ready: boolean; status: string }

    expect(response.status).toBe(503)
    expect(payload.ready).toBe(false)
    expect(payload.status).toBe('misconfigured')
  })

  it('reports degraded readiness from durable scheduler state without probing Supabase', async () => {
    const fetchMock = vi.fn()
    const snapshot = {
      ...healthyScheduledRuntimeSnapshot(),
      consecutiveFailures: 2,
      lastFailureAtMs: Date.now(),
      lastFullSuccessAtMs: Date.now() - 5 * 60_000,
      lastSuccessAtMs: Date.now() - 5 * 60_000,
      mode: 'open' as const,
      nextProbeAtMs: Date.now() + 60_000,
    }
    vi.stubGlobal('fetch', fetchMock)

    try {
      const response = await worker.fetch(
        new Request('https://app.sygshift.example/api/v1/ready'),
        environment(new Response('asset'), {
          ...configuredEnvironment,
          SCHEDULE_COORDINATOR: {
            getByName: () => ({ getSnapshot: vi.fn(async () => snapshot) }),
          },
        }),
      )
      const payload = await response.json() as {
        checks: { scheduledRuntimeFresh: boolean }
        ready: boolean
        scheduledRuntime: { consecutiveFailures: number; mode: string }
        status: string
      }

      expect(response.status).toBe(503)
      expect(payload).toMatchObject({
        checks: { scheduledRuntimeFresh: false },
        ready: false,
        scheduledRuntime: { consecutiveFailures: 2, mode: 'open' },
        status: 'degraded',
      })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps readiness degraded until a new scheduler state records its first successful cron', async () => {
    const now = Date.now()
    const bootstrapSnapshot = {
      ...healthyScheduledRuntimeSnapshot(),
      healthyCycles: 0,
      lastFullSuccessAtMs: null,
      lastFullSuccessSourceCommit: null,
      lastSuccessAtMs: null,
      updatedAtMs: now,
    }
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/ready'),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        SCHEDULE_COORDINATOR: {
          getByName: () => ({ getSnapshot: vi.fn(async () => bootstrapSnapshot) }),
        },
      }),
    )
    const payload = await response.json() as {
      checks: { scheduledRuntimeFresh: boolean }
      ready: boolean
      status: string
    }

    expect(response.status).toBe(503)
    expect(payload).toMatchObject({
      checks: { scheduledRuntimeFresh: false },
      ready: false,
      status: 'degraded',
    })
  })

  it('keeps stale unconfirmed scheduler state degraded', async () => {
    const staleBootstrapSnapshot = {
      ...healthyScheduledRuntimeSnapshot(),
      healthyCycles: 0,
      lastFullSuccessAtMs: null,
      lastFullSuccessSourceCommit: null,
      lastSuccessAtMs: null,
      updatedAtMs: Date.now() - 2 * 60_000 - 1,
    }
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/ready'),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        SCHEDULE_COORDINATOR: {
          getByName: () => ({ getSnapshot: vi.fn(async () => staleBootstrapSnapshot) }),
        },
      }),
    )
    const payload = await response.json() as {
      checks: { scheduledRuntimeFresh: boolean }
      ready: boolean
      status: string
    }

    expect(response.status).toBe(503)
    expect(payload).toMatchObject({
      checks: { scheduledRuntimeFresh: false },
      ready: false,
      status: 'degraded',
    })
  })

  it.each([
    {
      label: 'missing signing secret',
      values: {
        SYGILANT_SHARED_IDENTITY_CONSUMER_SECRET: 'consumer-secret-with-enough-entropy-0001',
      },
    },
    {
      label: 'short consumer secret',
      values: {
        SYGILANT_SHARED_IDENTITY_CONSUMER_SECRET: 'too-short',
        SYGILANT_SHARED_IDENTITY_SIGNING_SECRET: 'signing-secret-with-enough-entropy-00001',
      },
    },
    {
      label: 'identical signing and consumer secrets',
      values: {
        SYGILANT_SHARED_IDENTITY_CONSUMER_SECRET: 'one-shared-secret-with-enough-entropy',
        SYGILANT_SHARED_IDENTITY_SIGNING_SECRET: 'one-shared-secret-with-enough-entropy',
      },
    },
  ])('reports the enabled Sygilant identity bridge as not ready with $label', async ({ values }) => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/ready'),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        ...values,
        SYGILANT_SHARED_IDENTITY_ENABLED: 'true',
      }),
    )
    const payload = await response.json() as { checks: Record<string, boolean>; ready: boolean; status: string }

    expect(response.status).toBe(503)
    expect(payload.ready).toBe(false)
    expect(payload.status).toBe('misconfigured')
  })

  it('reports the enabled Sygilant identity bridge ready only with distinct strong secrets', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/ready'),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        SYGILANT_SHARED_IDENTITY_CONSUMER_SECRET: 'consumer-secret-with-enough-entropy-0001',
        SYGILANT_SHARED_IDENTITY_ENABLED: 'true',
        SYGILANT_SHARED_IDENTITY_SIGNING_SECRET: 'signing-secret-with-enough-entropy-00001',
      }),
    )
    const payload = await response.json() as { checks: Record<string, boolean>; ready: boolean; status: string }

    expect(response.status).toBe(200)
    expect(payload.ready).toBe(true)
    expect(payload.checks.sygilantSharedIdentityConsumerSecret).toBe(true)
    expect(payload.checks.sygilantSharedIdentityKeySeparation).toBe(true)
    expect(payload.checks.sygilantSharedIdentitySigningSecret).toBe(true)
  })

  it('hardens asset responses and prevents HTML caching', async () => {
    const assets = environment(new Response('<!doctype html>', {
      headers: { 'cache-control': 'public, max-age=3600', 'content-type': 'text/html' },
    }))
    const request = new Request('https://app.sygshift.example/schedule')
    const response = await worker.fetch(request, assets)

    expect(assets.ASSETS.fetch).toHaveBeenCalledWith(request)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
  })

  it('omits production-only transport policy during local development', async () => {
    const response = await worker.fetch(
      new Request('http://127.0.0.1:4173/api/v1/health'),
      environment(),
    )

    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(response.headers.get('strict-transport-security')).toBeNull()
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('requires an authenticated admin session before user provisioning', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/admin/users/provision-missing', { method: 'POST' }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as { error: string; requestId: string }

    expect(response.status).toBe(401)
    expect(payload.error).toBe('auth_required')
    expect(payload.requestId).toBe(response.headers.get('x-request-id'))
  })

  it.each([
    '/api/v1/admin/users/login-emails',
    '/api/v1/admin/users/10000000-0000-4000-8000-000000000010/login-email',
    '/api/v1/admin/users/10000000-0000-4000-8000-000000000010/welcome-email',
  ])('requires the effective New User Invites permission for %s', async (pathname) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      employee_id: '10000000-0000-4000-8000-000000000001',
      username: 'admin',
      display_name: 'Admin User',
      role: 'admin',
      has_mfa: true,
      permissions: ['admin.users.manage', 'notifications.manage'],
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request(`https://app.sygshift.example${pathname}`, {
        body: '{}',
        headers: { authorization: 'Bearer token' },
        method: 'POST',
      }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as { error: string }

    expect(response.status).toBe(403)
    expect(payload.error).toBe('new_user_invites_permission_required')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('allows an MFA-verified invitation manager to send the approved welcome email', async () => {
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        employee_id: '10000000-0000-4000-8000-000000000002',
        username: 'invitemanager',
        display_name: 'Invite Manager',
        role: 'scheduler',
        has_mfa: true,
        permissions: ['admin.users.invite'],
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        employeeId: targetEmployeeId,
        employeeNumber: 'SYG-1100',
        jobTitle: 'Guard',
        username: 'employee',
        authEmail: 'employee@sygilant.us',
        contactEmail: 'employee@example.com',
        displayName: 'Example Employee',
        role: 'guard',
        employmentType: 'hourly',
        status: 'active',
        existingAuthUserId: null,
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
    const send = vi.fn().mockResolvedValue({ messageId: 'welcome-message' })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/welcome-email`, {
        body: '{}',
        headers: { authorization: 'Bearer token' },
        method: 'POST',
      }),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      }),
    )
    const payload = await response.json() as { email: string; username: string }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ email: 'employee@example.com', username: 'employee' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: 'employee@example.com' })
    vi.unstubAllGlobals()
  })

  it('rejects a blocked company-domain login email before changing the employee account', async () => {
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        employee_id: '10000000-0000-4000-8000-000000000002',
        username: 'invitemanager',
        display_name: 'Invite Manager',
        role: 'scheduler',
        has_mfa: true,
        permissions: ['admin.users.invite'],
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        employeeId: targetEmployeeId,
        username: 'employee',
        authEmail: 'employee@accounts.sygshift.invalid',
        contactEmail: 'employee@guardianshipsecurity.net',
        displayName: 'Example Employee',
        role: 'guard',
        employmentType: 'hourly',
        status: 'active',
        existingAuthUserId: null,
      }), { headers: { 'content-type': 'application/json' } }))
    const send = vi.fn()
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/login-email`, {
        body: '{}',
        headers: { authorization: 'Bearer token' },
        method: 'POST',
      }),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_BLOCKED_EMAIL_DOMAINS: 'guardianshipsecurity.net',
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      }),
    )
    const payload = await response.json() as { detail: string; error: string }

    expect(response.status).toBe(409)
    expect(payload.error).toBe('email_recipient_suppressed')
    expect(payload.detail).toContain('Add a personal email')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(send).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does not let invitation-only access mutate account security controls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      employee_id: '10000000-0000-4000-8000-000000000002',
      username: 'invitemanager',
      display_name: 'Invite Manager',
      role: 'scheduler',
      has_mfa: true,
      permissions: ['admin.users.invite'],
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/admin/users/10000000-0000-4000-8000-000000000010/account', {
        body: '{}',
        headers: { authorization: 'Bearer token' },
        method: 'POST',
      }),
      environment(new Response('asset'), configuredEnvironment),
    )

    expect(response.status).toBe(403)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('requires an authenticated admin session before resetting employee MFA', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/admin/users/10000000-0000-4000-8000-000000000010/mfa-reset', {
        body: '{}',
        method: 'POST',
      }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as { error: string; requestId: string }

    expect(response.status).toBe(401)
    expect(payload.error).toBe('auth_required')
    expect(payload.requestId).toBe(response.headers.get('x-request-id'))
  })

  it('requires an authenticated admin session before sending an employee password reset', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/admin/users/10000000-0000-4000-8000-000000000010/password-reset', {
        body: '{}',
        method: 'POST',
      }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as { error: string; requestId: string }

    expect(response.status).toBe(401)
    expect(payload.error).toBe('auth_required')
    expect(payload.requestId).toBe(response.headers.get('x-request-id'))
  })

  it('accepts an unknown self-service password-reset username without revealing account state', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ eligible: false }), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/auth/password-reset/request', {
        body: JSON.stringify({ username: 'unknownperson' }),
        headers: { 'cf-connecting-ip': '192.0.2.10', 'content-type': 'application/json' },
        method: 'POST',
      }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as { accepted: boolean; message: string }

    expect(response.status).toBe(202)
    expect(payload.accepted).toBe(true)
    expect(payload.message).toContain('If an active SygShift account')
    expect(JSON.stringify(payload)).not.toContain('unknownperson')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/rest/v1/rpc/service_claim_self_service_password_reset')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      target_username: 'unknownperson',
    })
    vi.unstubAllGlobals()
  })

  it('accepts an unknown self-service username-recovery email without revealing account state', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ eligible: false }), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/auth/username-recovery/request', {
        body: JSON.stringify({ email: 'unknown@example.com' }),
        headers: { 'cf-connecting-ip': '192.0.2.20', 'content-type': 'application/json' },
        method: 'POST',
      }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as { accepted: boolean; message: string }

    expect(response.status).toBe(202)
    expect(payload.accepted).toBe(true)
    expect(payload.message).toContain('If an active SygShift account')
    expect(JSON.stringify(payload)).not.toContain('unknown@example.com')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/rest/v1/rpc/service_claim_self_service_username')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      target_email: 'unknown@example.com',
    })
    vi.unstubAllGlobals()
  })

  it('emails active usernames without changing password or MFA settings', async () => {
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        eligible: true,
        employeeId: targetEmployeeId,
        contactEmail: 'employee@example.com',
        displayName: 'Example Employee',
        usernames: ['employee', 'employee2'],
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ logged: true }), {
        headers: { 'content-type': 'application/json' },
      }))
    const send = vi.fn().mockResolvedValue({ messageId: 'username-reminder-message' })
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/auth/username-recovery/request', {
        body: JSON.stringify({ email: 'Employee@Example.com' }),
        headers: { 'cf-connecting-ip': '192.0.2.21', 'content-type': 'application/json' },
        method: 'POST',
      }),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
        SYGSHIFT_PUBLIC_APP_URL: 'https://app.sygshift.com',
      }),
    )
    const payload = await response.json() as { accepted: boolean; message: string }

    expect(response.status).toBe(202)
    expect(payload.accepted).toBe(true)
    expect(JSON.stringify(payload)).not.toContain('employee@example.com')
    expect(JSON.stringify(payload)).not.toContain('employee2')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: 'employee@example.com' })
    expect(send.mock.calls[0]?.[0].subject).toBe('Your SygShift username')
    expect(send.mock.calls[0]?.[0].html).toContain('<strong>employee</strong>')
    expect(send.mock.calls[0]?.[0].html).toContain('<strong>employee2</strong>')
    expect(send.mock.calls[0]?.[0].html).not.toContain('password-recovery')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      target_notification_type: 'username_recovery_self_service',
      target_related_record_id: targetEmployeeId,
    })
    vi.unstubAllGlobals()
  })

  it('sends an enumeration-safe self-service password-reset email to the approved personal address', async () => {
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        eligible: true,
        employeeId: targetEmployeeId,
        username: 'employee',
        authEmail: 'employee@accounts.sygshift.invalid',
        contactEmail: 'employee@example.com',
        displayName: 'Example Employee',
        role: 'guard',
        employmentType: 'hourly',
        status: 'active',
        existingAuthUserId: targetAuthUserId,
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action_link: 'https://example.supabase.co/auth/v1/verify?token=self-service-token&type=recovery',
        hashed_token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ logged: true }), {
        headers: { 'content-type': 'application/json' },
      }))
    const send = vi.fn().mockResolvedValue({ messageId: 'self-service-reset-message' })
    vi.stubGlobal('fetch', fetchMock)

    const bridgeSecret = 'recovery-bridge-secret-that-is-at-least-32-characters'
    const bridge = await bridgeRecoveryHeaders(bridgeSecret, 'employee')
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/auth/password-reset/request', {
        body: JSON.stringify({ username: 'Employee' }),
        headers: {
          'content-type': 'application/json',
          ...bridge.headers,
        },
        method: 'POST',
      }),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
        SYGSHIFT_PASSWORD_RECOVERY_BRIDGE_SECRET: bridgeSecret,
        SYGSHIFT_PUBLIC_APP_URL: 'https://app.sygilant.us',
      }),
    )
    const payload = await response.json() as { accepted: boolean; message: string }

    expect(response.status).toBe(202)
    expect(payload.accepted).toBe(true)
    expect(JSON.stringify(payload)).not.toContain('employee@example.com')
    expect(JSON.stringify(payload)).not.toContain('employee@accounts.sygshift.invalid')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: 'employee@example.com' })
    expect(send.mock.calls[0]?.[0].html).toContain('https://app.sygilant.us/password-recovery#token_hash=aaaaaaaa')
    expect(send.mock.calls[0]?.[0].html).not.toContain('example.supabase.co/auth/v1/verify')
    expect(send.mock.calls[0]?.[0].html).toContain('We received a request')
    const fingerprintBytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`password-reset-request:sygilant:${bridge.fingerprint}`),
    )
    const expectedFingerprintHash = [...new Uint8Array(fingerprintBytes)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      target_request_fingerprint_hash: expectedFingerprintHash,
    })
    vi.unstubAllGlobals()
  })

  it('rejects stale or invalid Sygilant bridge signatures before querying identity data', async () => {
    const bridgeSecret = 'recovery-bridge-secret-that-is-at-least-32-characters'
    const stale = await bridgeRecoveryHeaders(
      bridgeSecret,
      'employee',
      'd'.repeat(64),
      String(Math.floor(Date.now() / 1000) - 300),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(
      new Request('https://app.sygilant.us/api/v1/auth/password-reset/request', {
        body: JSON.stringify({ username: 'employee' }),
        headers: { 'content-type': 'application/json', ...stale.headers },
        method: 'POST',
      }),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        SYGSHIFT_PASSWORD_RECOVERY_BRIDGE_SECRET: bridgeSecret,
      }),
    )
    const payload = await response.json() as { error: string }

    expect(response.status).toBe(401)
    expect(payload.error).toBe('password_recovery_bridge_authentication_failed')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('sends an audited password-recovery link without exposing the employee email', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000001'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        employee_id: actorEmployeeId,
        username: 'admin',
        display_name: 'Admin User',
        role: 'admin',
        has_mfa: true,
        permissions: ['admin.users.password_reset'],
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        employeeId: targetEmployeeId,
        employeeNumber: 'SYG-1050',
        jobTitle: 'Supervisor',
        username: 'employee',
        authEmail: 'employee@accounts.sygshift.invalid',
        contactEmail: 'employee@example.com',
        displayName: 'Example Employee',
        role: 'supervisor',
        employmentType: 'salary',
        status: 'active',
        existingAuthUserId: targetAuthUserId,
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action_link: 'https://example.supabase.co/auth/v1/verify?token=single-use-token&type=recovery',
        hashed_token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ logged: true }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ recorded: true }), {
        headers: { 'content-type': 'application/json' },
      }))
    const send = vi.fn().mockResolvedValue({ messageId: 'password-reset-message' })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/password-reset`, {
        body: '{}',
        headers: { authorization: 'Bearer admin-token' },
        method: 'POST',
      }),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
        SYGSHIFT_PUBLIC_APP_URL: 'https://app.sygilant.us',
      }),
    )
    const payload = await response.json() as { email: string; username: string }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ email: 'em******@example.com', username: 'employee' })
    expect(JSON.stringify(payload)).not.toContain('employee@example.com')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: 'employee@example.com' })
    expect(send.mock.calls[0]?.[0].html).toContain('https://app.sygilant.us/password-recovery#token_hash=bbbbbbbb')
    expect(send.mock.calls[0]?.[0].html).not.toContain('example.supabase.co/auth/v1/verify')

    const generateRequest = fetchMock.mock.calls.find(([input]) => String(input).includes('/auth/v1/admin/generate_link'))
    expect(generateRequest).toBeDefined()
    expect(JSON.parse(String(generateRequest?.[1]?.body))).toEqual({
      email: 'employee@accounts.sygshift.invalid',
      redirect_to: 'https://app.sygilant.us/password-recovery',
      type: 'recovery',
    })

    const auditRequest = fetchMock.mock.calls.at(-1)
    expect(String(auditRequest?.[0])).toContain('/rest/v1/rpc/service_record_employee_password_reset')
    expect(JSON.parse(String(auditRequest?.[1]?.body))).toMatchObject({
      target_actor_employee_id: actorEmployeeId,
      target_auth_user_id: targetAuthUserId,
      target_delivery_email_masked: 'em******@example.com',
      target_employee_id: targetEmployeeId,
    })
    vi.unstubAllGlobals()
  })

  it('does not let password-reset assistance change MFA or security keys', async () => {
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      employee_id: '10000000-0000-4000-8000-000000000001',
      username: 'operations-manager',
      display_name: 'Operations Manager',
      role: 'supervisor',
      has_mfa: true,
      permissions: ['admin.users.password_reset'],
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(
      new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/mfa-reset`, {
        body: '{}',
        headers: { authorization: 'Bearer operations-manager-token' },
        method: 'POST',
      }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as { error: string }

    expect(response.status).toBe(403)
    expect(payload.error).toBe('admin_mfa_required')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('resets employee MFA factors and records the audited reset after authorization', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000001'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const factorId = '30000000-0000-4000-8000-000000000010'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        employee_id: actorEmployeeId,
        username: 'admin',
        display_name: 'Admin User',
        role: 'admin',
        has_mfa: true,
        permissions: ['admin.users.manage'],
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        employeeId: targetEmployeeId,
        employeeNumber: 'SYG-1050',
        jobTitle: null,
        username: 'mswinney',
        authEmail: 'opsmanager@guardianshipsecurity.net',
        displayName: 'Matthew Swinney',
        role: 'supervisor',
        employmentType: 'salary',
        status: 'active',
        existingAuthUserId: targetAuthUserId,
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: factorId,
        factor_type: 'totp',
        status: 'verified',
      }]), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(0), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ trustedDevicesRevoked: 2 }), {
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/mfa-reset`, {
        body: '{}',
        headers: { authorization: 'Bearer admin-token' },
        method: 'POST',
      }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as {
      displayName: string
      factorsRemoved: number
      trustedDevicesRevoked: number
      username: string
    }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      displayName: 'Matthew Swinney',
      factorsRemoved: 1,
      trustedDevicesRevoked: 2,
      username: 'mswinney',
    })
    const requestUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestUrls).toContain(`https://example.supabase.co/auth/v1/admin/users/${targetAuthUserId}/factors`)
    expect(requestUrls).toContain(`https://example.supabase.co/auth/v1/admin/users/${targetAuthUserId}/factors/${factorId}`)
    const auditRequest = fetchMock.mock.calls.at(-1)
    expect(String(auditRequest?.[0])).toContain('/rest/v1/rpc/service_record_employee_mfa_reset')
    expect(JSON.parse(String(auditRequest?.[1]?.body))).toMatchObject({
      target_actor_employee_id: actorEmployeeId,
      target_auth_user_id: targetAuthUserId,
      target_employee_id: targetEmployeeId,
      target_factor_count: 1,
    })
    vi.unstubAllGlobals()
  })

  it('requires an authenticated admin session before notification delivery', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/admin/notifications/process', { method: 'POST' }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as { error: string; requestId: string }

    expect(response.status).toBe(401)
    expect(payload.error).toBe('auth_required')
    expect(payload.requestId).toBe(response.headers.get('x-request-id'))
  })

  it('does not claim notification work until email sending is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      employee_id: '10000000-0000-4000-8000-000000000001',
      username: 'admin',
      display_name: 'Admin User',
      role: 'admin',
      has_mfa: true,
      permissions: ['notifications.manage'],
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/admin/notifications/process', {
        headers: { authorization: 'Bearer user-token' },
        method: 'POST',
      }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as { error: string }

    expect(response.status).toBe(503)
    expect(payload.error).toBe('email_not_configured')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('allows MFA-verified schedulers to process queued announcement emails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        employee_id: '10000000-0000-4000-8000-000000000002',
        username: 'scheduler',
        display_name: 'Schedule User',
        role: 'scheduler',
        has_mfa: true,
        permissions: ['announcements.send'],
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: '20000000-0000-4000-8000-000000000001',
        recipients: ['jbrown@example.com'],
        aggregateId: '30000000-0000-4000-8000-000000000001',
        aggregateType: 'announcement',
        messageType: 'announcement_email',
        message: {
          subject: 'Open shift available',
          text: 'A shift is available.',
        },
      }]), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(['jbrown@example.com']), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
    const emailSend = vi.fn().mockResolvedValue({ messageId: 'test-message' })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/admin/notifications/process', {
        headers: { authorization: 'Bearer scheduler-token' },
        method: 'POST',
      }),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: emailSend },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      }),
    )
    const payload = await response.json() as { delivered: string[]; failed: unknown[]; processed: number; requestedBy: string }

    expect(response.status, JSON.stringify(payload)).toBe(200)
    expect(payload).toMatchObject({
      delivered: ['20000000-0000-4000-8000-000000000001'],
      failed: [],
      processed: 1,
      requestedBy: 'scheduler',
    })
    expect(emailSend).toHaveBeenCalledWith(expect.objectContaining({
      from: { email: 'scheduling@sygilant.us', name: 'SygShift' },
      subject: 'Open shift available',
      to: 'jbrown@example.com',
    }))
    vi.unstubAllGlobals()
  })

  it('suppresses blocked company-domain recipients and records the attempted delivery', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        employee_id: '10000000-0000-4000-8000-000000000002',
        username: 'scheduler',
        display_name: 'Schedule User',
        role: 'scheduler',
        has_mfa: true,
        permissions: ['announcements.send'],
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: '20000000-0000-4000-8000-000000000002',
        recipients: ['OPS@GUARDIANSHIPSECURITY.NET'],
        aggregateId: '30000000-0000-4000-8000-000000000002',
        aggregateType: 'call_off_report',
        messageType: 'call_off_supervisor_alert',
        message: {
          subject: 'Employee call-off reported',
          text: 'A call-off requires attention.',
        },
      }]), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
    const emailSend = vi.fn()
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/admin/notifications/process', {
        headers: { authorization: 'Bearer scheduler-token' },
        method: 'POST',
      }),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: emailSend },
        SYGSHIFT_BLOCKED_EMAIL_DOMAINS: 'guardianshipsecurity.net',
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      }),
    )
    const payload = await response.json() as { delivered: string[]; failed: unknown[]; processed: number; suppressed: string[] }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      delivered: [],
      failed: [],
      processed: 1,
      suppressed: ['20000000-0000-4000-8000-000000000002'],
    })
    expect(emailSend).not.toHaveBeenCalled()
    const requestBodies = fetchMock.mock.calls
      .map(([, init]) => typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null)
      .filter(Boolean)
    expect(requestBodies).toContainEqual(expect.objectContaining({
      target_delivery_status: 'suppressed_blocked_domain',
      target_intended_recipient: 'ops@guardianshipsecurity.net',
    }))
    expect(requestBodies).toContainEqual(expect.objectContaining({
      target_notification_id: '20000000-0000-4000-8000-000000000002',
      target_reason: 'Suppressed — Blocked Domain',
    }))
    vi.unstubAllGlobals()
  })

  it('runs one coordinated scheduled pipeline with timekeeping first', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      const payload = url.includes('/rpc/service_run_timekeeping_automation')
        ? { jobRunId: 'generated-by-worker', status: 'completed' }
        : url.includes('/rpc/service_refresh_attendance_alert_schedule_state')
          ? { status: 'completed', fullReconciliation: false }
        : url.includes('/rpc/service_reconcile_operational_alert_lifecycle')
          ? { status: 'completed', fullReconciliation: false }
          : url.includes('/rpc/service_reconcile_patrol_obligations')
            ? { updated: 0 }
            : url.includes('/rpc/service_publish_due_announcement_work_items')
              ? { published: 0 }
              : url.includes('/rpc/service_process_due_sygtasks_reminders')
                ? { processed: 0, triggered: 0, cancelled: 0 }
                : url.includes('/rpc/service_process_due_sygtasks_recurring_series')
                  ? { processed: 0, created: 0, paused: 0, canceled: 0 }
                : url.includes('/rpc/service_refresh_hr_offboarding_due_cases')
                  ? { dueCases: 0, notificationsCreated: 0 }
                : []
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
    })
    const emailSend = vi.fn()
    const scheduledWork: Promise<unknown>[] = []
    vi.stubGlobal('fetch', fetchMock)

    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.UTC(2026, 7, 18, 18, 0) },
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: emailSend },
        SYGSHIFT_SYGSPHERE_RESUMABLE_UPLOADS_ENABLED: 'true',
      }),
      { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
    )

    expect(scheduledWork).toHaveLength(1)
    await Promise.all(scheduledWork)
    expect(fetchMock).toHaveBeenCalledTimes(18)
    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input))
    for (const rpc of [
      'service_process_due_sygtasks_reminders',
      'service_process_due_sygtasks_recurring_series',
      'service_run_timekeeping_automation',
      'service_refresh_attendance_alert_schedule_state',
      'service_reconcile_operational_alert_lifecycle',
      'service_reconcile_patrol_obligations',
      'service_publish_due_announcement_work_items',
      'service_refresh_hr_offboarding_due_cases',
      'service_process_shift_coverage_notification_waves',
      'service_claim_timekeeping_notification_batch',
      'service_claim_time_off_notification_batch',
      'service_claim_notification_batch',
      'service_claim_support_ticket_notification_batch',
      'service_claim_employee_notification_batch',
      'service_list_hr_document_availability_recovery',
      'service_list_sygsphere_file_availability_recovery',
      'service_list_sygsphere_resumable_availability_recovery',
      'service_list_sygsphere_resumable_purge',
    ]) expect(calledUrls.some((url) => url.includes(`/rpc/${rpc}`))).toBe(true)
    const automationCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/rpc/service_run_timekeeping_automation'))!
    const scheduleRefreshCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/rpc/service_refresh_attendance_alert_schedule_state'))!
    const lifecycleCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/rpc/service_reconcile_operational_alert_lifecycle'))!
    const automationBody = JSON.parse(String(automationCall[1]?.body)) as { target_job_run_id: string }
    const scheduleRefreshBody = JSON.parse(String(scheduleRefreshCall[1]?.body)) as { target_full_reconciliation: boolean }
    const lifecycleBody = JSON.parse(String(lifecycleCall[1]?.body)) as { target_full_reconciliation: boolean }
    expect(automationBody.target_job_run_id).toMatch(/^[a-f0-9-]{36}$/)
    expect(scheduleRefreshBody.target_full_reconciliation).toBe(false)
    expect(lifecycleBody.target_full_reconciliation).toBe(false)
    expect(emailSend).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it.each([
    {
      attendanceFull: true,
      cleanupDue: false,
      label: 'attendance full reconciliation at 02:00 Mountain',
      lifecycleFull: false,
      scheduledTime: Date.UTC(2026, 9, 26, 8, 0),
    },
    {
      attendanceFull: false,
      cleanupDue: false,
      label: 'alert lifecycle full reconciliation at 02:10 Mountain',
      lifecycleFull: true,
      scheduledTime: Date.UTC(2026, 9, 26, 8, 10),
    },
    {
      attendanceFull: false,
      cleanupDue: true,
      label: 'deferred cleanup and recovery at 02:15 Mountain',
      lifecycleFull: false,
      scheduledTime: Date.UTC(2026, 9, 26, 8, 15),
    },
    {
      attendanceFull: true,
      cleanupDue: false,
      label: 'spring-forward attendance fallback at 03:00 Mountain',
      lifecycleFull: false,
      scheduledTime: Date.UTC(2026, 2, 8, 9, 0),
    },
    {
      attendanceFull: false,
      cleanupDue: false,
      label: 'spring-forward alert lifecycle fallback at 03:10 Mountain',
      lifecycleFull: true,
      scheduledTime: Date.UTC(2026, 2, 8, 9, 10),
    },
    {
      attendanceFull: false,
      cleanupDue: true,
      label: 'spring-forward deferred cleanup at 03:15 Mountain',
      lifecycleFull: false,
      scheduledTime: Date.UTC(2026, 2, 8, 9, 15),
    },
    {
      attendanceFull: false,
      cleanupDue: true,
      label: 'first fall-back 01:00 Mountain does not run a full lane',
      lifecycleFull: false,
      scheduledTime: Date.UTC(2026, 10, 1, 7, 0),
    },
    {
      attendanceFull: false,
      cleanupDue: true,
      label: 'repeated fall-back 01:00 Mountain does not run a full lane',
      lifecycleFull: false,
      scheduledTime: Date.UTC(2026, 10, 1, 8, 0),
    },
    {
      attendanceFull: true,
      cleanupDue: false,
      label: 'fall-back 02:00 Mountain runs attendance exactly once',
      lifecycleFull: false,
      scheduledTime: Date.UTC(2026, 10, 1, 9, 0),
    },
    {
      attendanceFull: false,
      cleanupDue: false,
      label: 'first fall-back 01:10 Mountain does not run the lifecycle full lane',
      lifecycleFull: false,
      scheduledTime: Date.UTC(2026, 10, 1, 7, 10),
    },
    {
      attendanceFull: false,
      cleanupDue: false,
      label: 'repeated fall-back 01:10 Mountain does not run the lifecycle full lane',
      lifecycleFull: false,
      scheduledTime: Date.UTC(2026, 10, 1, 8, 10),
    },
    {
      attendanceFull: false,
      cleanupDue: false,
      label: 'fall-back 02:10 Mountain runs the lifecycle full lane exactly once',
      lifecycleFull: true,
      scheduledTime: Date.UTC(2026, 10, 1, 9, 10),
    },
  ])('stages the daily database-wide lanes: $label', async ({
    attendanceFull,
    cleanupDue,
    lifecycleFull,
    scheduledTime,
  }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      const payload = url.includes('/rpc/service_reconcile_employee_push_provider_outcomes')
        ? { reconciled: 0, disabledSubscriptions: 0, completionPending: 0, reviewRequired: 0 }
        : url.includes('/rpc/service_process_due_sygtasks_reminders')
          ? { processed: 0, triggered: 0, cancelled: 0 }
          : url.includes('/rpc/service_process_due_sygtasks_recurring_series')
            ? { processed: 0, created: 0, paused: 0, canceled: 0 }
            : []
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
    })
    const scheduledWork: Promise<unknown>[] = []
    vi.stubGlobal('fetch', fetchMock)

    try {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime },
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send: vi.fn() },
          SYGSHIFT_SYGSPHERE_RESUMABLE_UPLOADS_ENABLED: 'true',
        }),
        { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
      )
      await expect(Promise.all(scheduledWork)).resolves.toBeDefined()

      const attendanceCall = fetchMock.mock.calls.find(([input]) => (
        String(input).includes('/rpc/service_refresh_attendance_alert_schedule_state')
      ))
      const lifecycleCall = fetchMock.mock.calls.find(([input]) => (
        String(input).includes('/rpc/service_reconcile_operational_alert_lifecycle')
      ))
      expect(attendanceCall).toBeDefined()
      expect(lifecycleCall).toBeDefined()
      expect(JSON.parse(String(attendanceCall?.[1]?.body))).toMatchObject({
        target_full_reconciliation: attendanceFull,
      })
      expect(JSON.parse(String(lifecycleCall?.[1]?.body))).toMatchObject({
        target_full_reconciliation: lifecycleFull,
      })

      const calledUrls = fetchMock.mock.calls.map(([input]) => String(input))
      expect(calledUrls.some((url) => url.includes('/rpc/service_list_sygsphere_file_availability_recovery')))
        .toBe(cleanupDue)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renews the scheduler lease while a scheduled cycle is still delivering work', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 19, 15, 0)))
    const notificationId = '20000000-0000-4000-8000-000000000099'
    let releaseEmail: (() => void) | undefined
    const emailPending = new Promise<void>((resolve) => { releaseEmail = resolve })
    const emailSend = vi.fn(() => emailPending)
    let notificationClaimed = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      let payload: Record<string, unknown> | Record<string, unknown>[] = []
      if (url.includes('/rpc/service_run_timekeeping_automation')) {
        payload = { status: 'completed' }
      } else if (url.includes('/rpc/service_claim_timekeeping_notification_batch') && !notificationClaimed) {
        notificationClaimed = true
        payload = [{
          aggregateId: '30000000-0000-4000-8000-000000000099',
          aggregateType: 'timekeeping_event',
          id: notificationId,
          message: { subject: 'Timekeeping notice', text: 'Review your timecard.' },
          messageType: 'automatic_clock_out',
          recipients: ['employee@example.com'],
        }]
      }
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
    })
    const snapshot = healthyScheduledRuntimeSnapshot()
    const renewCycle = vi.fn(async () => ({ applied: true, state: snapshot }))
    const recordFullSuccess = vi.fn(async () => ({ applied: true, state: snapshot }))
    const coordinator = {
      acquireCycle: vi.fn(async () => ({
        decision: 'run_full' as const,
        leaseExpiresAtMs: Date.now() + 75_000,
        leaseId: '10000000-0000-4000-8000-000000000099',
        state: snapshot,
      })),
      getSnapshot: vi.fn(async () => snapshot),
      recordFailure: vi.fn(async () => ({ applied: true, state: snapshot })),
      recordFullSuccess,
      recordRecoverySuccess: vi.fn(async () => ({ applied: true, state: snapshot })),
      releaseCycle: vi.fn(async () => ({ applied: true, state: snapshot })),
      renewCycle,
    }
    const scheduledWork: Promise<unknown>[] = []
    vi.stubGlobal('fetch', fetchMock)

    try {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.now() },
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send: emailSend },
          SCHEDULE_COORDINATOR: { getByName: () => coordinator },
          SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
          SYGSHIFT_SOURCE_COMMIT: sourceCommit,
        }),
        { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
      )

      await vi.waitFor(() => expect(emailSend).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(15_000)
      expect(renewCycle).toHaveBeenCalledTimes(1)
      expect(recordFullSuccess).not.toHaveBeenCalled()

      releaseEmail?.()
      await expect(Promise.all(scheduledWork)).resolves.toBeDefined()
      expect(recordFullSuccess).toHaveBeenCalledTimes(1)
      expect(recordFullSuccess).toHaveBeenCalledWith({
        leaseId: '10000000-0000-4000-8000-000000000099',
        sourceCommit,
      })
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it.each([
    {
      label: 'missing',
      runtimeConfiguration: configuredEnvironmentWithoutSourceCommit,
    },
    {
      label: 'malformed',
      runtimeConfiguration: {
        ...configuredEnvironmentWithoutSourceCommit,
        SYGSHIFT_SOURCE_COMMIT: 'not-a-git-commit',
      },
    },
  ])('fails scheduled work closed when the source commit is $label', async ({ runtimeConfiguration }) => {
    const fetchMock = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { coordinator, namespace } = scheduledCoordinatorBinding()
    const scheduledWork: Promise<unknown>[] = []
    vi.stubGlobal('fetch', fetchMock)

    try {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 19, 15, 0) },
        environment(new Response('asset'), {
          ...runtimeConfiguration,
          EMAIL: { send: vi.fn() },
          SCHEDULE_COORDINATOR: namespace,
        }),
        { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
      )
      await expect(Promise.all(scheduledWork)).resolves.toBeDefined()

      expect(coordinator.acquireCycle).not.toHaveBeenCalled()
      expect(coordinator.recordFullSuccess).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(errorSpy.mock.calls.some(([value]) => (
        String(value).includes('"event":"scheduled_work_misconfigured"')
        && String(value).includes('"reason":"source_commit_missing_or_invalid"')
      ))).toBe(true)
    } finally {
      errorSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('contains noncritical scheduled work when the database pool is transiently unavailable', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(JSON.stringify({ message: 'Timed out acquiring connection from connection pool' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    })
    const scheduledWork: Promise<unknown>[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 11, 15, 0) },
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: vi.fn() },
      }),
      { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
    )

    await expect(Promise.all(scheduledWork)).resolves.toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/rpc/service_run_timekeeping_automation')
    const containment = errorSpy.mock.calls
      .map(([value]) => {
        try {
          return JSON.parse(String(value)) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .find((value) => value?.event === 'scheduled_work_contained')
    expect(containment).toMatchObject({
      failedOperation: 'service_run_timekeeping_automation',
      status: 503,
      timedOut: false,
    })

    errorSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('persists scheduler containment across minute triggers and makes no new database request during cooldown', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: 'Timed out acquiring connection from connection pool',
    }), {
      headers: { 'content-type': 'application/json' },
      status: 503,
    }))
    const snapshot = healthyScheduledRuntimeSnapshot()
    let circuitOpen = false
    const coordinator = {
      acquireCycle: vi.fn(async () => circuitOpen
        ? {
            decision: 'skip' as const,
            reason: 'cooldown' as const,
            retryAtMs: Date.now() + 60_000,
            state: { ...snapshot, consecutiveFailures: 1, mode: 'open' as const },
          }
        : {
            decision: 'run_full' as const,
            leaseExpiresAtMs: Date.now() + 50_000,
            leaseId: '10000000-0000-4000-8000-000000000001',
            state: snapshot,
          }),
      getSnapshot: vi.fn(async () => snapshot),
      recordFailure: vi.fn(async () => {
        circuitOpen = true
        return { applied: true, state: { ...snapshot, consecutiveFailures: 1, mode: 'open' as const } }
      }),
      recordFullSuccess: vi.fn(async () => ({ applied: true, state: snapshot })),
      recordRecoverySuccess: vi.fn(async () => ({ applied: true, state: snapshot })),
      releaseCycle: vi.fn(async () => ({ applied: true, state: snapshot })),
      renewCycle: vi.fn(async () => ({ applied: true, state: snapshot })),
    }
    const runtime = environment(new Response('asset'), {
      ...configuredEnvironment,
      EMAIL: { send: vi.fn() },
      SCHEDULE_COORDINATOR: { getByName: () => coordinator },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    try {
      for (const minute of [0, 1]) {
        const scheduledWork: Promise<unknown>[] = []
        await worker.scheduled(
          { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 19, 15, minute) },
          runtime,
          { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
        )
        await expect(Promise.all(scheduledWork)).resolves.toBeDefined()
      }

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(coordinator.recordFailure).toHaveBeenCalledTimes(1)
      expect(infoSpy.mock.calls.some(([value]) => String(value).includes('"event":"scheduled_work_skipped"'))).toBe(true)
    } finally {
      errorSpy.mockRestore()
      infoSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('uses only one read-only request during a half-open recovery probe', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rpc/get_maintenance_status')) {
        return new Response(JSON.stringify({ active: [], recentlyCompleted: [], upcoming: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/rpc/service_run_timekeeping_automation')) {
        return new Response(JSON.stringify({ status: 'completed' }), { headers: { 'content-type': 'application/json' } })
      }
      return new Response('[]', { headers: { 'content-type': 'application/json' } })
    })
    const snapshot = healthyScheduledRuntimeSnapshot()
    const recordRecoverySuccess = vi.fn(async () => ({
      applied: true,
      state: { ...snapshot, mode: 'recovering' as const, recoverySuccesses: 1 },
    }))
    const recordFullSuccess = vi.fn(async () => ({ applied: true, state: snapshot }))
    const coordinator = {
      acquireCycle: vi.fn(async () => ({
        decision: 'run_recovery_probe' as const,
        leaseExpiresAtMs: Date.now() + 50_000,
        leaseId: '10000000-0000-4000-8000-000000000002',
        state: { ...snapshot, mode: 'open' as const },
      })),
      getSnapshot: vi.fn(async () => snapshot),
      recordFailure: vi.fn(async () => ({ applied: true, state: snapshot })),
      recordFullSuccess,
      recordRecoverySuccess,
      releaseCycle: vi.fn(async () => ({ applied: true, state: snapshot })),
      renewCycle: vi.fn(async () => ({ applied: true, state: snapshot })),
    }
    const scheduledWork: Promise<unknown>[] = []
    vi.stubGlobal('fetch', fetchMock)

    try {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 19, 15, 2) },
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send: vi.fn() },
          SCHEDULE_COORDINATOR: { getByName: () => coordinator },
        }),
        { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
      )
      await expect(Promise.all(scheduledWork)).resolves.toBeDefined()

      const calledUrls = fetchMock.mock.calls.map(([input]) => String(input))
      expect(calledUrls).toHaveLength(1)
      expect(calledUrls[0]).toContain('/rpc/get_maintenance_status')
      expect(calledUrls.some((url) => url.includes('/rpc/service_run_timekeeping_automation'))).toBe(false)
      expect(calledUrls.some((url) => url.includes('/rpc/service_claim_timekeeping_notification_batch'))).toBe(false)
      expect(recordRecoverySuccess).toHaveBeenCalledTimes(1)
      expect(recordFullSuccess).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    { label: 'a network TypeError', failure: new TypeError('fetch failed'), status: null },
    { label: 'a reset socket', failure: new Error('socket hang up: ECONNRESET'), status: null },
    { label: 'an upstream 520 response', failure: null, status: 520 },
    { label: 'an upstream 530 response', failure: null, status: 530 },
  ])('contains scheduled fan-out after $label', async ({ failure, status }) => {
    const fetchMock = vi.fn(async () => {
      if (failure) throw failure
      return new Response(JSON.stringify({ message: 'Upstream database service unavailable' }), {
        status: status ?? 503,
        headers: { 'content-type': 'application/json' },
      })
    })
    const scheduledWork: Promise<unknown>[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    try {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 11, 15, 2) },
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send: vi.fn() },
        }),
        { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
      )

      await expect(Promise.all(scheduledWork)).resolves.toBeDefined()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls.some(([value]) => (
        String(value).includes('"event":"scheduled_work_contained"')
        && String(value).includes('"failedOperation":"service_run_timekeeping_automation"')
      ))).toBe(true)
    } finally {
      errorSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('delivers critical timekeeping notices before a transient noncritical failure can stop the cycle', async () => {
    const notificationId = '20000000-0000-4000-8000-000000000099'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rpc/service_claim_timekeeping_notification_batch')) {
        return new Response(JSON.stringify([{
          id: notificationId,
          messageType: 'automatic_clock_out',
          aggregateType: 'timekeeping_event',
          aggregateId: '30000000-0000-4000-8000-000000000099',
          recipients: ['employee@example.com'],
          message: { subject: 'Automatic clock-out recorded', text: 'Review your timecard.' },
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rpc/service_reconcile_patrol_obligations')) {
        return new Response(JSON.stringify({ message: 'Timed out acquiring connection from connection pool' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ status: 'completed' }), { headers: { 'content-type': 'application/json' } })
    })
    const emailSend = vi.fn().mockResolvedValue(undefined)
    const scheduledWork: Promise<unknown>[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 11, 15, 3) },
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: emailSend },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      }),
      { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
    )

    await expect(Promise.all(scheduledWork)).resolves.toBeDefined()
    expect(emailSend).toHaveBeenCalledTimes(1)
    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input))
    const callIndex = (rpc: string) => calledUrls.findIndex((url) => url.includes(`/rpc/${rpc}`))
    expect(callIndex('service_run_timekeeping_automation')).toBeGreaterThanOrEqual(0)
    expect(callIndex('service_claim_timekeeping_notification_batch')).toBeGreaterThan(callIndex('service_run_timekeeping_automation'))
    expect(callIndex('service_mark_notification_result')).toBeGreaterThan(callIndex('service_claim_timekeeping_notification_batch'))
    expect(callIndex('service_reconcile_patrol_obligations')).toBeGreaterThan(callIndex('service_mark_notification_result'))
    expect(calledUrls.filter((url) => url.includes('/rpc/service_claim_timekeeping_notification_batch'))).toHaveLength(1)
    expect(calledUrls.some((url) => url.includes('/rpc/service_claim_time_off_notification_batch'))).toBe(false)
    expect(errorSpy.mock.calls.some(([value]) => (
      String(value).includes('"event":"scheduled_work_contained"')
      && String(value).includes('"failedOperation":"service_reconcile_patrol_obligations"')
    ))).toBe(true)

    errorSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('withholds full-cycle success when a critical timekeeping notification returns a delivery failure', async () => {
    const notificationId = '20000000-0000-4000-8000-000000000077'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rpc/service_claim_timekeeping_notification_batch')) {
        return new Response(JSON.stringify([{
          id: notificationId,
          messageType: 'automatic_clock_out',
          aggregateType: 'timekeeping_event',
          aggregateId: '30000000-0000-4000-8000-000000000077',
          recipients: ['employee@example.com'],
          message: { subject: 'Automatic clock-out recorded', text: 'Review your timecard.' },
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rpc/service_mark_notification_result')) {
        const body = JSON.parse(String(init?.body)) as { delivered?: boolean }
        expect(body.delivered).toBe(false)
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rpc/service_claim_')) {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: 'completed' }), { headers: { 'content-type': 'application/json' } })
    })
    const emailSend = vi.fn().mockRejectedValue(new Error('provider rejected message'))
    const scheduledWork: Promise<unknown>[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { coordinator, namespace } = scheduledCoordinatorBinding()
    vi.stubGlobal('fetch', fetchMock)

    try {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 19, 15, 11) },
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send: emailSend },
          SCHEDULE_COORDINATOR: namespace,
          SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
        }),
        { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
      )
      await expect(Promise.all(scheduledWork)).resolves.toBeDefined()

      const calledUrls = fetchMock.mock.calls.map(([input]) => String(input))
      expect(emailSend).toHaveBeenCalledTimes(1)
      expect(calledUrls.some((url) => url.includes('/rpc/service_mark_notification_result'))).toBe(true)
      expect(calledUrls.some((url) => url.includes('/rpc/service_claim_notification_batch'))).toBe(true)
      expect(errorSpy.mock.calls.some(([value]) => (
        String(value).includes('"event":"timekeeping_notification_delivery_failed"')
        && String(value).includes('"failureCount":1')
      ))).toBe(true)
      expect(errorSpy.mock.calls.some(([value]) => (
        String(value).includes('"event":"scheduled_runtime_full_success_withheld"')
        && String(value).includes('"timekeeping_notification_delivery"')
      ))).toBe(true)
      expect(coordinator.recordFullSuccess).not.toHaveBeenCalled()
      expect(coordinator.releaseCycle).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('durably completes an accepted email before a deferred audit outage so the next cycle cannot resend it', async () => {
    const notificationId = '20000000-0000-4000-8000-000000000088'
    let delivered = false
    const rpcCalls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const rpcName = url.split('/rpc/')[1] ?? ''
      rpcCalls.push(rpcName)
      if (rpcName === 'service_claim_timekeeping_notification_batch') {
        return new Response(JSON.stringify(delivered ? [] : [{
          id: notificationId,
          messageType: 'automatic_clock_out',
          aggregateType: 'timekeeping_event',
          aggregateId: '30000000-0000-4000-8000-000000000088',
          recipients: ['employee@example.com'],
          message: { subject: 'Automatic clock-out recorded', text: 'Review your timecard.' },
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (rpcName === 'service_mark_notification_result') {
        const body = JSON.parse(String(init?.body)) as { delivered?: boolean }
        if (body.delivered === true) delivered = true
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (rpcName === 'service_log_email_delivery') {
        return new Response(JSON.stringify({ message: 'Timed out acquiring connection from connection pool' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (rpcName.startsWith('service_claim_')) {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: 'completed' }), { headers: { 'content-type': 'application/json' } })
    })
    const emailSend = vi.fn().mockResolvedValue(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)

    try {
      for (const minute of [3, 4]) {
        const scheduledWork: Promise<unknown>[] = []
        await worker.scheduled(
          { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 11, 15, minute) },
          environment(new Response('asset'), {
            ...configuredEnvironment,
            EMAIL: { send: emailSend },
            SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
          }),
          { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
        )
        await expect(Promise.all(scheduledWork)).resolves.toBeDefined()
      }

      expect(delivered).toBe(true)
      expect(emailSend).toHaveBeenCalledTimes(1)
      expect(rpcCalls.filter((name) => name === 'service_claim_timekeeping_notification_batch')).toHaveLength(2)
      expect(rpcCalls.indexOf('service_mark_notification_result')).toBeLessThan(rpcCalls.indexOf('service_log_email_delivery'))
      expect(errorSpy.mock.calls.some(([value]) => String(value).includes('"event":"scheduled_work_contained"'))).toBe(true)
    } finally {
      errorSpy.mockRestore()
      infoSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('aborts a stalled scheduled database request before the next minute trigger', async () => {
    vi.useFakeTimers()
    const scheduledWork: Promise<unknown>[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let requestAborted = false
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      expect(signal).toBeInstanceOf(AbortSignal)
      signal?.addEventListener('abort', () => {
        requestAborted = true
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }, { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)

    try {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 11, 15, 1) },
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send: vi.fn() },
        }),
        { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
      )

      const completion = Promise.all(scheduledWork)
      await vi.advanceTimersByTimeAsync(8_000)
      await expect(completion).resolves.toBeDefined()
      expect(requestAborted).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls.some(([value]) => (
        String(value).includes('"event":"scheduled_work_contained"')
        && String(value).includes('"timedOut":true')
      ))).toBe(true)
    } finally {
      errorSpy.mockRestore()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('preserves uploaded signature artifacts when the commit outcome is ambiguous', async () => {
    const envelopeId = '10000000-0000-4000-8000-000000000010'
    const source = await PDFDocument.create()
    source.addPage([612, 792])
    const sourceBytes = await source.save({ useObjectStreams: false })
    const sourceChecksum = createHash('sha256').update(sourceBytes).digest('hex')
    const storedObjects = new Map<string, Uint8Array>()
    const deletedObjects: string[] = []
    const originalDigestStream = (crypto as Crypto & { DigestStream?: unknown }).DigestStream

    class TestDigestStream extends WritableStream<Uint8Array> {
      declare readonly bytesWritten: number
      readonly digest: Promise<ArrayBuffer>

      constructor() {
        let bytesWritten = 0
        const hash = createHash('sha256')
        let resolveDigest!: (value: ArrayBuffer) => void
        const digest = new Promise<ArrayBuffer>((resolve) => { resolveDigest = resolve })
        super({
          write(chunk) {
            bytesWritten += chunk.byteLength
            hash.update(chunk)
          },
          close() {
            const value = hash.digest()
            resolveDigest(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)
          },
        })
        Object.defineProperty(this, 'bytesWritten', { get: () => bytesWritten })
        this.digest = digest
      }
    }

    Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: TestDigestStream })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        const bytes = new Uint8Array(init?.body as ArrayBuffer)
        storedObjects.set(url, bytes)
        return new Response(null, { status: 200 })
      }
      if (method === 'DELETE') {
        deletedObjects.push(url)
        return new Response(null, { status: 200 })
      }
      const bytes = url.endsWith('/hr-general/source/source.pdf') ? sourceBytes : storedObjects.get(url)
      if (!bytes) return new Response(null, { status: 404 })
      const body = new Uint8Array(bytes).buffer as ArrayBuffer
      return new Response(body, { headers: { 'content-length': String(bytes.byteLength) } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const rpc = vi.fn(async (_config: unknown, name: string) => {
      if (name === 'service_get_signature_finalization_payload') {
        return {
          state: 'processing',
          jobId: '10000000-0000-4000-8000-000000000011',
          envelopeId,
          documentId: '10000000-0000-4000-8000-000000000012',
          documentTitle: 'Test document',
          sourceBucket: 'hr-general',
          sourceObjectKey: 'source/source.pdf',
          sourceMimeType: 'application/pdf',
          sourceChecksum,
          recipients: [],
          events: [],
        }
      }
      if (name === 'service_commit_signature_finalization') {
        throw new ScheduledSupabaseUnavailableError(name, 504, 'Commit response timed out.')
      }
      return null
    }) as unknown as Parameters<typeof finalizeSignatureEnvelope>[3]

    try {
      await expect(finalizeSignatureEnvelope(
        { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
        envelopeId,
        'signature-test',
        rpc,
      )).rejects.toBeInstanceOf(ScheduledSupabaseUnavailableError)
      expect(storedObjects.size).toBe(2)
      expect(deletedObjects).toHaveLength(0)
      expect((rpc as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([, name]) => name === 'service_fail_signature_finalization')).toBe(false)
    } finally {
      if (originalDigestStream === undefined) delete (crypto as Crypto & { DigestStream?: unknown }).DigestStream
      else Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: originalDigestStream })
      vi.unstubAllGlobals()
    }
  })

  it('aborts a never-resolving scheduled signature storage read at the run deadline', async () => {
    const envelopeId = '10000000-0000-4000-8000-000000000020'
    const abortController = new AbortController()
    let storageAborted = false
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        storageAborted = true
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }, { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const rpc = vi.fn(async (_config: unknown, name: string) => {
      if (name === 'service_get_signature_finalization_payload') {
        return {
          state: 'processing',
          jobId: '10000000-0000-4000-8000-000000000021',
          envelopeId,
          documentId: '10000000-0000-4000-8000-000000000022',
          documentTitle: 'Stalled document',
          sourceBucket: 'hr-general',
          sourceObjectKey: 'source/stalled.pdf',
          sourceMimeType: 'application/pdf',
          sourceChecksum: 'a'.repeat(64),
          recipients: [],
          events: [],
        }
      }
      return null
    }) as unknown as Parameters<typeof finalizeSignatureEnvelope>[3]

    try {
      const completion = finalizeSignatureEnvelope(
        { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
        envelopeId,
        'signature-storage-timeout-test',
        rpc,
        abortController.signal,
      )
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      abortController.abort()
      await expect(completion).rejects.toMatchObject({
        name: 'ScheduledSupabaseUnavailableError',
        operation: 'signature_finalization_storage',
        status: 504,
      })
      expect(storageAborted).toBe(true)
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    {
      failedRpc: 'service_run_timekeeping_automation',
      expectedEvent: 'timekeeping_automation_failed',
      expectedLane: 'timekeeping_automation',
      expectedSummaryKey: 'automation',
    },
    {
      failedRpc: 'service_refresh_attendance_alert_schedule_state',
      expectedEvent: 'attendance_alert_schedule_refresh_failed',
      expectedLane: 'attendance_alert_schedule_refresh',
      expectedSummaryKey: 'attendanceScheduleRefresh',
    },
    {
      failedRpc: 'service_reconcile_operational_alert_lifecycle',
      expectedEvent: 'operational_alert_lifecycle_reconciliation_failed',
      expectedLane: 'operational_alert_lifecycle',
      expectedSummaryKey: 'alertLifecycle',
    },
    {
      failedRpc: 'service_refresh_hr_offboarding_due_cases',
      expectedEvent: 'offboarding_due_refresh_failed',
      expectedLane: 'hr_offboarding_due_cases',
      expectedSummaryKey: 'offboardingDue',
    },
    {
      failedRpc: 'service_process_shift_coverage_notification_waves',
      expectedEvent: 'shift_coverage_notifications_failed',
      expectedLane: 'shift_coverage_notifications',
      expectedSummaryKey: 'coverageNotifications',
    },
    {
      failedRpc: 'service_process_due_sygtasks_recurring_series',
      expectedEvent: 'sygtasks_scheduled_work_failed',
      expectedLane: 'sygtasks_scheduled_work',
      expectedSummaryKey: 'sygtasksScheduledWork',
    },
  ])('continues call-off lifecycle and delivery safeguards when $failedRpc fails', async ({
    expectedEvent,
    expectedLane,
    expectedSummaryKey,
    failedRpc,
  }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes(`/rpc/${failedRpc}`)) {
        return new Response(JSON.stringify({ message: `${failedRpc} failed` }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
    })
    const scheduledWork: Promise<unknown>[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { coordinator, namespace } = scheduledCoordinatorBinding()
    vi.stubGlobal('fetch', fetchMock)

    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 5, 15, 10) },
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: vi.fn() },
        SCHEDULE_COORDINATOR: namespace,
      }),
      { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
    )

    await expect(Promise.all(scheduledWork)).resolves.toBeDefined()
    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input))
    const callIndex = (rpc: string) => calledUrls.findIndex((url) => url.includes(`/rpc/${rpc}`))
    expect(callIndex('service_run_timekeeping_automation')).toBeGreaterThanOrEqual(0)
    expect(callIndex('service_reconcile_operational_alert_lifecycle')).toBeGreaterThan(callIndex('service_run_timekeeping_automation'))
    expect(callIndex('service_process_shift_coverage_notification_waves')).toBeGreaterThan(callIndex('service_reconcile_operational_alert_lifecycle'))
    expect(callIndex('service_claim_notification_batch')).toBeGreaterThan(callIndex('service_process_shift_coverage_notification_waves'))
    expect(errorSpy.mock.calls.some(([value]) => String(value).includes(`"event":"${expectedEvent}"`))).toBe(true)
    expect(errorSpy.mock.calls.some(([value]) => (
      String(value).includes('"event":"scheduled_runtime_full_success_withheld"')
      && String(value).includes(`"${expectedLane}"`)
    ))).toBe(true)
    expect(coordinator.recordFullSuccess).not.toHaveBeenCalled()
    expect(coordinator.releaseCycle).toHaveBeenCalledTimes(1)

    const scheduledSummary = infoSpy.mock.calls
      .map(([value]) => {
        try {
          return JSON.parse(String(value)) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .find((value) => value && value.cron === '* * * * *')
    expect(scheduledSummary?.[expectedSummaryKey]).toEqual(expect.objectContaining({ status: 'failed' }))

    errorSpy.mockRestore()
    infoSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('leaves legacy HR uploads unavailable when recovery cannot re-read their private object', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rpc/service_list_hr_document_availability_recovery')) {
        return new Response(JSON.stringify([{
          bucket: 'hr-general',
          checksum: 'a'.repeat(64),
          objectKey: '10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002',
          operationId: '30000000-0000-4000-8000-000000000003',
          sizeBytes: 4,
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/storage/v1/object/hr-general/')) return new Response('missing', { status: 404 })
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
    })
    const scheduledWork: Promise<unknown>[] = []
    vi.stubGlobal('fetch', fetchMock)

    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.UTC(2026, 7, 18, 18, 15) },
      environment(new Response('asset'), { ...configuredEnvironment, EMAIL: { send: vi.fn() } }),
      { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
    )

    await Promise.all(scheduledWork)
    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(calledUrls.some((url) => url.includes('/rpc/service_list_hr_document_availability_recovery'))).toBe(true)
    expect(calledUrls.some((url) => url.includes('/storage/v1/object/hr-general/'))).toBe(true)
    expect(calledUrls.some((url) => url.includes('/rpc/service_mark_hr_document_upload_stored'))).toBe(false)
    vi.unstubAllGlobals()
  })

  it('keeps minute-by-minute automation running while the attendance safety scan waits for its five-minute interval', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const payload = url.includes('/rpc/service_run_timekeeping_automation')
        ? { status: 'completed' }
        : url.includes('/rpc/service_reconcile_operational_alert_lifecycle')
          ? { status: 'completed' }
          : url.includes('/rpc/service_reconcile_patrol_obligations')
            ? { updated: 0 }
            : url.includes('/rpc/service_publish_due_announcement_work_items')
              ? { published: 0 }
              : url.includes('/rpc/service_process_due_sygtasks_reminders')
                ? { processed: 0 }
                : url.includes('/rpc/service_process_due_sygtasks_recurring_series')
                  ? { processed: 0 }
                  : url.includes('/rpc/service_refresh_hr_offboarding_due_cases')
                    ? { dueCases: 0 }
                    : []
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
    })
    const scheduledWork: Promise<unknown>[] = []
    vi.stubGlobal('fetch', fetchMock)

    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.UTC(2026, 7, 18, 18, 3) },
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: vi.fn() },
      }),
      { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
    )

    await Promise.all(scheduledWork)
    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(calledUrls.some((url) => url.includes('/rpc/service_run_timekeeping_automation'))).toBe(true)
    expect(calledUrls.some((url) => url.includes('/rpc/service_reconcile_operational_alert_lifecycle'))).toBe(true)
    expect(calledUrls.some((url) => url.includes('/rpc/service_refresh_attendance_alert_schedule_state'))).toBe(false)
    vi.unstubAllGlobals()
  })

  it('validates admin-supplied temporary passwords before sending them to authentication', () => {
    expect(validateSuppliedTemporaryPassword('short', 'jbrown')).toContain('Use at least 12 characters.')
    expect(validateSuppliedTemporaryPassword('jbrownStrong!234', 'jbrown')).toContain('Do not include the username.')
    expect(validateSuppliedTemporaryPassword('Strong!Pass234', 'jbrown')).toEqual([])
  })

  it('wraps notification email content in the SygShift brand shell', () => {
    const html = brandedEmailHtml({
      subject: 'Open shift available',
      text: 'A shift is available.\nPlease review it.',
    }, 'https://shift.sygilant.us/')

    expect(html).toContain('https://shift.sygilant.us/brand/sygshift-email-logo.png')
    expect(html).toContain('align="center"')
    expect(html).toContain('background-image:linear-gradient')
    expect(html).toContain('SygShift notification')
    expect(html).toContain('Open SygShift')
    expect(html).toContain('A shift is available.<br>Please review it.')
  })

  it('builds personalized welcome email content without login credentials', () => {
    const message = buildWelcomeEmail({
      authEmail: 'lhill@accounts.sygshift.invalid',
      contactEmail: 'lorinda@example.com',
      displayName: 'Lorinda Hood',
      employeeId: '10000000-0000-4000-8000-000000000001',
      employmentType: 'hourly',
      existingAuthUserId: null,
      role: 'dispatcher',
      requiresMfa: true,
      status: 'active',
      username: 'lhood',
    }, 'https://shift.sygilant.us/')

    expect(message.subject).toBe('Welcome to SygShift')
    expect(message.text).toContain('Hello Lorinda,')
    expect(message.text).toContain('Guardianship Security’s scheduling and timekeeping system')
    expect(message.text).toContain('You will receive a separate Login Instructions email')
    expect(message.text).toContain('IT and Business Development Engineer')
    expect(message.text).toContain('jbrown@guardianshipsecurity.net')
    expect(message.text).not.toContain('still testing')
    expect(message.text).not.toContain('Temporary password:')
    expect(message.html).toContain('Hello Lorinda,')
    expect(message.html).toContain('mailto:jbrown@guardianshipsecurity.net')
  })

  it('builds standard login instructions without MFA language for employees who do not require it', () => {
    const message = buildLoginInstructionsEmail({
      authEmail: 'guard@accounts.sygshift.invalid',
      contactEmail: 'guard@example.com',
      displayName: 'Taylor Guard',
      employeeId: '10000000-0000-4000-8000-000000000011',
      employmentType: 'hourly',
      existingAuthUserId: null,
      requiresMfa: false,
      role: 'guard',
      status: 'active',
      username: 'tguard',
    }, 'Temporary!234', 'https://app.sygilant.us/')

    expect(message.subject).toBe('Your SygShift Login Is Ready')
    expect(message.text).toContain('Hello Taylor,')
    expect(message.text).toContain('Confirm that the SygShift Home page opens.')
    expect(message.text).toContain('Temporary password: Temporary!234')
    expect(message.text).not.toContain('Authenticator')
    expect(message.text).not.toContain('multi-factor')
    expect(message.html).not.toContain('Authenticator')
  })

  it('builds authenticator setup instructions only for employees whose effective access requires MFA', () => {
    const message = buildLoginInstructionsEmail({
      authEmail: 'scheduler@accounts.sygshift.invalid',
      contactEmail: 'scheduler@example.com',
      displayName: 'Morgan Scheduler',
      employeeId: '10000000-0000-4000-8000-000000000012',
      employmentType: 'salary',
      existingAuthUserId: null,
      requiresMfa: true,
      role: 'scheduler',
      status: 'active',
      username: 'mscheduler',
    }, 'Temporary!234', 'https://app.sygilant.us/')

    expect(message.subject).toBe('Your SygShift Login Is Ready — Authenticator Setup Required')
    expect(message.text).toContain('Microsoft Authenticator or Google Authenticator')
    expect(message.text).toContain('It is not sent by email or text message.')
    expect(message.text).toContain('Do not scan it with your regular phone camera.')
    expect(message.text).toContain('use your phone’s app switcher')
    expect(message.html).toContain('Start Authenticator Setup')
    expect(message.html).toContain('mailto:jbrown@guardianshipsecurity.net')
  })
})
