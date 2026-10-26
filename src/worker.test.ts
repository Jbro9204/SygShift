import { createHash, createHmac } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'
import worker, {
  brandedEmailHtml,
  buildLoginInstructionsEmail,
  buildWelcomeEmail,
  completionFailureMayBeAmbiguous,
  deliverDurableEmailRecipients,
  deriveAdminLoginTemporaryPassword,
  derivePersonalEmailVerificationToken,
  processNotificationJobs,
  recoverClientDocumentAvailability,
  recoverClientDocumentCleanup,
  recoverLicensingDocumentAvailability,
  recoverLicensingDocumentCleanup,
  recoverAdminMfaResetOperations,
  finalizeSignatureEnvelope,
  protectedMaintenanceWindow,
  reconcileAmbiguousUploadCompletion,
  requestHasExactCookie,
  SupabaseRequestError,
  ScheduledSupabaseUnavailableError,
  secureResponse,
  sendAuditedEmail,
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

function emailDispatchCompletionReceipt(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  return new Response(JSON.stringify({
    dispatchId: '40000000-0000-4000-8000-000000000000',
    dispatchToken: body.target_dispatch_token,
    providerReference: body.target_provider_reference ?? null,
    state: body.target_state,
  }), { headers: { 'content-type': 'application/json' } })
}

function knownUnsentEmailReleaseReceipt(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  return new Response(JSON.stringify({
    dispatchId: body.target_dispatch_id,
    dispatchToken: body.target_dispatch_token,
    state: 'retry_approved',
  }), { headers: { 'content-type': 'application/json' } })
}

function employeePasswordResetOperationReceipt(
  init: RequestInit | undefined,
  state: 'prepared' | 'completed',
): Response {
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  return new Response(JSON.stringify({
    actorEmployeeId: body.target_actor_employee_id,
    authUserId: body.target_auth_user_id,
    completedAt: state === 'completed' ? '2026-10-24T12:00:01.000Z' : null,
    deliveryEmailMasked: 'em******@example.com',
    employeeId: body.target_employee_id,
    operationId: body.target_operation_id,
    preparedAt: '2026-10-24T12:00:00.000Z',
    recorded: state === 'completed',
    state,
  }), { headers: { 'content-type': 'application/json' } })
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
  it('matches only the exact non-empty protected shared-session cookie', () => {
    expect(requestHasExactCookie(
      new Request('https://app.sygshift.example', {
        headers: { cookie: '__Host-sygshift-shared-session-old=lookalike; another=value' },
      }),
      '__Host-sygshift-shared-session',
    )).toBe(false)
    expect(requestHasExactCookie(
      new Request('https://app.sygshift.example', {
        headers: { cookie: '__Host-sygshift-shared-session=; another=value' },
      }),
      '__Host-sygshift-shared-session',
    )).toBe(false)
    expect(requestHasExactCookie(
      new Request('https://app.sygshift.example', {
        headers: { cookie: '__Host-sygshift-shared-session=protected-envelope' },
      }),
      '__Host-sygshift-shared-session',
    )).toBe(true)
  })

  it('keeps native session startup independent from an unused misconfigured shared bridge', async () => {
    const misconfiguredBridge = environment(new Response('asset'), {
      ...configuredEnvironment,
      SYGSHIFT_SHARED_IDENTITY_ENABLED: 'true',
    })

    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/auth/shared-identity/session', {
        headers: {
          cookie: '__Host-sygshift-shared-session-old=lookalike',
          origin: 'https://app.sygshift.example',
        },
        method: 'POST',
      }),
      misconfiguredBridge,
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('still fails closed when a protected shared-session cookie needs verification', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/auth/shared-identity/session', {
        headers: {
          cookie: '__Host-sygshift-shared-session=protected-envelope',
          origin: 'https://app.sygshift.example',
        },
        method: 'POST',
      }),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        SYGSHIFT_SHARED_IDENTITY_ENABLED: 'true',
      }),
    )
    const payload = await response.json() as { error: string }

    expect(response.status).toBe(503)
    expect(payload.error).toBe('shared_identity_not_configured')
  })

  it('clears transient bridge cookies on native logout without evaluating unused bridge config', async () => {
    const response = await worker.fetch(
      new Request('https://app.sygshift.example/api/v1/auth/shared-identity/session/logout', {
        headers: { origin: 'https://app.sygshift.example' },
        method: 'POST',
      }),
      environment(new Response('asset'), {
        ...configuredEnvironment,
        SYGSHIFT_SHARED_IDENTITY_ENABLED: 'true',
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain('__Host-sygshift-shared-session=')
    expect(response.headers.get('set-cookie')).toContain('__Host-sygshift-shared-bootstrap=')
    expect(response.headers.get('set-cookie')).toContain('__Host-sygshift-shared-ticket=')
    expect(response.headers.get('set-cookie')).toContain('__Host-sygshift-shared-launch=')
  })

  it('reconciles only failures whose completion outcome can be ambiguous', () => {
    expect(completionFailureMayBeAmbiguous(new SupabaseRequestError(
      'The action is no longer available.',
      409,
      'P0001',
      'service_record_signature_action',
    ))).toBe(false)
    expect(completionFailureMayBeAmbiguous(new SupabaseRequestError(
      'The upstream response was unavailable.',
      503,
      null,
      'service_record_signature_action',
    ))).toBe(true)
    expect(completionFailureMayBeAmbiguous(new TypeError('fetch failed'))).toBe(true)
    expect(completionFailureMayBeAmbiguous(new Error('business rule rejected'))).toBe(false)
  })

  it('reconciles an upload whose completion committed before its response was lost', async () => {
    const pending = { id: 'document-1', state: 'pending' }
    const stored = { id: 'document-1', state: 'stored' }
    const readOperation = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(stored)
    const retryCompletion = vi.fn().mockRejectedValue(new Error('response lost'))
    const inspectObject = vi.fn().mockResolvedValue('match')

    const result = await reconcileAmbiguousUploadCompletion<{ id: string, state: string }>({
      completedStates: ['stored'],
      inspectObject,
      operationMatches: (operation) => operation.id === pending.id,
      readOperation,
      retryCompletion,
      retryableStates: ['pending'],
    })

    expect(result).toEqual({ outcome: 'confirmed' })
    expect(retryCompletion).toHaveBeenCalledTimes(1)
    expect(readOperation).toHaveBeenCalledTimes(2)
  })

  it('preserves a checksum-matched object while authoritative completion remains unavailable', async () => {
    const operation = { id: 'document-1', state: 'pending' }
    const readOperation = vi.fn()
      .mockResolvedValueOnce(operation)
      .mockRejectedValueOnce(new Error('database unavailable'))
    const retryCompletion = vi.fn().mockRejectedValue(new Error('completion unavailable'))

    const result = await reconcileAmbiguousUploadCompletion<{ id: string, state: string }>({
      completedStates: ['stored'],
      inspectObject: vi.fn().mockResolvedValue('match'),
      operationMatches: (candidate) => candidate.id === operation.id,
      readOperation,
      retryCompletion,
      retryableStates: ['pending'],
    })

    expect(result).toEqual({ outcome: 'preserved', reason: 'state_unavailable' })
  })

  it('marks only a definitively absent pending upload as failed', async () => {
    const retryCompletion = vi.fn()
    const result = await reconcileAmbiguousUploadCompletion({
      completedStates: ['stored'],
      inspectObject: vi.fn().mockResolvedValue('missing'),
      operationMatches: () => true,
      readOperation: vi.fn().mockResolvedValue({ state: 'pending' }),
      retryCompletion,
      retryableStates: ['pending'],
    })

    expect(result).toEqual({ outcome: 'definitive_failure', reason: 'missing' })
    expect(retryCompletion).not.toHaveBeenCalled()
  })

  it('does not relabel an accepted email when inline audit persistence fails', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const rpc = vi.fn().mockRejectedValue(new Error('audit database unavailable'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const result = await sendAuditedEmail(
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send },
          SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
        }) as Env,
        'employee@example.com',
        { subject: 'Schedule updated', text: 'Review your schedule.' },
        { notificationType: 'schedule_updated' },
        undefined,
        rpc,
      )

      expect(result).toEqual({ failed: [], sent: ['employee@example.com'], suppressed: [] })
      expect(send).toHaveBeenCalledTimes(1)
      expect(rpc).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls.some(([value]) => (
        String(value).includes('"event":"email_delivery_audit_deferred"')
        && String(value).includes('"status":"sent"')
      ))).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('fences an accepted inline email when its atomic audit completion is unavailable', async () => {
    const sourceId = '10000000-0000-4000-8000-000000000099'
    const dispatchId = '20000000-0000-4000-8000-000000000099'
    const dispatchToken = '30000000-0000-4000-8000-000000000099'
    let prepared = false
    const rpc = vi.fn(async (_config: unknown, name: string) => {
      if (name === 'service_prepare_email_recipient_dispatch_batch') {
        const first = !prepared
        prepared = true
        return [{
          dispatchId,
          dispatchToken,
          intendedRecipient: 'employee@example.com',
          sendAllowed: first,
          state: 'dispatching',
        }]
      }
      throw new Error('audit completion unavailable')
    })
    const send = vi.fn().mockResolvedValue({ messageId: 'accepted-message' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runtime = environment(new Response('asset'), {
      ...configuredEnvironment,
      EMAIL: { send },
      SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
    }) as Env

    try {
      const first = await sendAuditedEmail(
        runtime,
        'employee@example.com',
        { subject: 'Password reset', text: 'Use the protected reset link.' },
        { notificationType: 'password_reset' },
        undefined,
        rpc as never,
        'deferred',
        sourceId,
      )
      const retry = await sendAuditedEmail(
        runtime,
        'employee@example.com',
        { subject: 'Password reset', text: 'Use the protected reset link.' },
        { notificationType: 'password_reset' },
        undefined,
        rpc as never,
        'deferred',
        sourceId,
      )

      expect(first).toEqual({ failed: [], sent: ['employee@example.com'], suppressed: [] })
      expect(retry.sent).toEqual([])
      expect(retry.failed).toEqual([{
        error: 'This recipient has an unresolved provider outcome that requires reconciliation.',
        recipient: 'employee@example.com',
      }])
      expect(send).toHaveBeenCalledTimes(1)
      expect(rpc.mock.calls.filter(([, name]) => name === 'service_complete_email_recipient_dispatch'))
        .toHaveLength(3)
    } finally {
      errorSpy.mockRestore()
    }
  })

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

  it('rejects an owner-mismatched password request before any Auth mutation', async () => {
    const employeeId = '10000000-0000-4000-8000-000000000001'
    const otherEmployeeId = '10000000-0000-4000-8000-000000000002'
    const authUserId = '20000000-0000-4000-8000-000000000001'
    const token = `header.${btoa(JSON.stringify({ session_id: crypto.randomUUID(), sub: authUserId })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}.signature`
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          display_name: 'Owner',
          employee_id: employeeId,
          has_mfa: true,
          permissions: [],
          role: 'guard',
          username: 'owner',
        }), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const response = await worker.fetch(new Request('https://app.sygshift.example/api/v1/account/password', {
        body: JSON.stringify({
          expectedAuthUserId: authUserId,
          expectedEmployeeId: otherEmployeeId,
          password: 'NightFalcon123!',
        }),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        method: 'POST',
      }), environment(new Response('asset'), configuredEnvironment))

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'account_context_changed' })
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/auth/v1/user'))).toBe(false)
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/rest/v1/rpc/mark_password_changed'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries password finalization with the same bearer after the password is already current', async () => {
    const employeeId = '10000000-0000-4000-8000-000000000001'
    const authUserId = '20000000-0000-4000-8000-000000000001'
    const sessionId = '30000000-0000-4000-8000-000000000001'
    const token = `header.${btoa(JSON.stringify({ session_id: sessionId, sub: authUserId })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}.signature`
    const password = 'NightFalcon123!'
    let authUpdates = 0
    let finalizations = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          display_name: 'Owner',
          employee_id: employeeId,
          has_mfa: true,
          permissions: [],
          role: 'guard',
          username: 'owner',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/auth/v1/user')) {
        authUpdates += 1
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
        expect(JSON.parse(String(init?.body))).toEqual({ password })
        return authUpdates === 1
          ? new Response(JSON.stringify({ id: authUserId }), { headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ message: 'New password should be different from the old password.' }), {
            headers: { 'content-type': 'application/json' },
            status: 422,
          })
      }
      if (url.includes('/rest/v1/rpc/mark_password_changed')) {
        finalizations += 1
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
        return finalizations === 1
          ? new Response(JSON.stringify({ message: 'commit response lost' }), {
            headers: { 'content-type': 'application/json' },
            status: 503,
          })
          : new Response('true', { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const makeRequest = () => new Request('https://app.sygshift.example/api/v1/account/password', {
        body: JSON.stringify({ expectedAuthUserId: authUserId, expectedEmployeeId: employeeId, password }),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        method: 'POST',
      })
      const first = await worker.fetch(makeRequest(), environment(new Response('asset'), configuredEnvironment))
      expect(first.status).toBe(503)
      expect(await first.json()).toMatchObject({ error: 'password_change_finalization_pending' })

      const retry = await worker.fetch(makeRequest(), environment(new Response('asset'), configuredEnvironment))
      expect(retry.status).toBe(200)
      expect(await retry.json()).toMatchObject({
        authUserId,
        employeeId,
        passwordAlreadyCurrent: true,
        saved: true,
      })
      expect(authUpdates).toBe(2)
      expect(finalizations).toBe(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('recovers a committed email-verification RPC response and never resends the durable email', async () => {
    const employeeId = '10000000-0000-4000-8000-000000000001'
    const verificationId = '40000000-0000-4000-8000-000000000001'
    const operationId = '50000000-0000-4000-8000-000000000001'
    const dispatchId = '60000000-0000-4000-8000-000000000001'
    const dispatchToken = '70000000-0000-4000-8000-000000000001'
    const email = 'employee@example.com'
    const bearer = 'signed-in-session'
    const createBodies: Array<Record<string, unknown>> = []
    const prepareSourceIds: string[] = []
    let committedExpiresAt = ''
    let accepted = false
    const send = vi.fn(async (_message: unknown) => ({ messageId: 'provider-one' }))
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          display_name: 'Email Owner',
          employee_id: employeeId,
          has_mfa: false,
          permissions: [],
          role: 'guard',
          username: 'emailowner',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/get_maintenance_status')) {
        return new Response(JSON.stringify({ active: [] }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_create_email_verification_operation')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        createBodies.push(body)
        committedExpiresAt ||= String(body.target_expires_at)
        if (createBodies.length === 1) {
          return new Response(JSON.stringify({ code: 'PGRST000', message: 'commit response lost' }), {
            headers: { 'content-type': 'application/json' },
            status: 503,
          })
        }
        return new Response(JSON.stringify({
          employeeId,
          expiresAt: committedExpiresAt,
          operationId,
          purpose: 'personal_email_verification',
          replayed: true,
          requestedEmail: email,
          verificationId,
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_email_recipient_dispatch_batch')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        prepareSourceIds.push(String(body.target_source_id))
        return new Response(JSON.stringify([{
          dispatchId,
          dispatchToken,
          intendedRecipient: email,
          sendAllowed: !accepted,
          state: accepted ? 'accepted' : 'dispatching',
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_complete_email_recipient_dispatch')) {
        accepted = true
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const runtime = environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'system@example.com',
      })
      const makeRequest = () => new Request('https://app.sygshift.example/api/v1/account/email-verification/request', {
        body: JSON.stringify({ email, operationId }),
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        method: 'POST',
      })
      const first = await worker.fetch(makeRequest(), runtime)
      expect(first.status).toBe(200)
      expect(await first.json()).toMatchObject({ expiresAt: committedExpiresAt, operationId, sent: true })

      const replay = await worker.fetch(makeRequest(), runtime)
      expect(replay.status).toBe(200)
      expect(await replay.json()).toMatchObject({ expiresAt: committedExpiresAt, operationId, sent: true })

      expect(createBodies).toHaveLength(3)
      expect(new Set(createBodies.map((body) => body.target_operation_id))).toEqual(new Set([operationId]))
      expect(new Set(createBodies.map((body) => body.target_employee_id))).toEqual(new Set([employeeId]))
      expect(new Set(createBodies.map((body) => body.target_email))).toEqual(new Set([email]))
      expect(new Set(createBodies.map((body) => body.target_purpose))).toEqual(new Set(['personal_email_verification']))
      expect(new Set(createBodies.map((body) => body.target_token_hash)).size).toBe(1)
      const expectedToken = await derivePersonalEmailVerificationToken(
        configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY,
        operationId,
        employeeId,
        email,
      )
      expect(createBodies[0]?.target_token_hash).toBe(createHash('sha256').update(expectedToken).digest('hex'))
      expect(prepareSourceIds).toEqual([verificationId, verificationId])
      expect(send).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(send.mock.calls[0]?.[0])).toContain(encodeURIComponent(expectedToken))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects mismatched durable email-verification evidence before provider delivery', async () => {
    const employeeId = '10000000-0000-4000-8000-000000000001'
    const operationId = '50000000-0000-4000-8000-000000000001'
    const email = 'employee@example.com'
    const send = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          display_name: 'Email Owner', employee_id: employeeId, has_mfa: false,
          permissions: [], role: 'guard', username: 'emailowner',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/get_maintenance_status')) {
        return new Response(JSON.stringify({ active: [] }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_create_email_verification_operation')) {
        return new Response(JSON.stringify({
          employeeId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          operationId,
          purpose: 'personal_email_verification',
          requestedEmail: 'different@example.com',
          verificationId: '40000000-0000-4000-8000-000000000001',
        }), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const response = await worker.fetch(new Request('https://app.sygshift.example/api/v1/account/email-verification/request', {
        body: JSON.stringify({ email, operationId }),
        headers: { authorization: 'Bearer signed-in-session', 'content-type': 'application/json' },
        method: 'POST',
      }), environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'system@example.com',
      }))

      expect(response.status).toBe(500)
      expect(send).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('service_prepare_email_recipient_dispatch_batch'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
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

  it('does not report ready while required-lane failure history remains uncleared', async () => {
    const snapshot = {
      ...healthyScheduledRuntimeSnapshot(),
      consecutiveFailures: 2,
      healthyCycles: 2,
      lastFailureAtMs: Date.now() - 30_000,
      lastFailureOperation: 'required_lane_failure',
      // A newly successful cycle does not clear the durable counter until the
      // configured healthy-cycle threshold is reached.
      lastFullSuccessAtMs: Date.now(),
      lastSuccessAtMs: Date.now(),
      mode: 'closed' as const,
    }
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
      checks: { scheduledRuntimeFresh: boolean; scheduledRuntimeNoFailures: boolean }
      ready: boolean
      scheduledRuntime: { consecutiveFailures: number; mode: string }
      status: string
    }

    expect(response.status).toBe(503)
    expect(payload).toMatchObject({
      checks: {
        scheduledRuntimeFresh: false,
        scheduledRuntimeNoFailures: false,
      },
      ready: false,
      scheduledRuntime: { consecutiveFailures: 2, mode: 'closed' },
      status: 'degraded',
    })
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

  it('does not let an unauthenticated caller run the privileged document-pipeline canary', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    try {
      const response = await worker.fetch(
        new Request('https://app.sygshift.example/api/v1/internal/document-pipeline/canary', { method: 'POST' }),
        environment(new Response('asset'), configuredEnvironment),
      )
      const payload = await response.json() as { error: string; requestId: string }

      expect(response.status).toBe(401)
      expect(payload.error).toBe('auth_required')
      expect(payload.requestId).toBe(response.headers.get('x-request-id'))
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('requires current AAL2 and the security-management permission before the document-pipeline canary', async () => {
    const sessionContext = {
      employee_id: '10000000-0000-4000-8000-000000000001',
      username: 'admin',
      display_name: 'Admin User',
      role: 'admin',
      has_mfa: true,
      permissions: ['admin.security.manage'],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(sessionContext), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const token = `header.${btoa(JSON.stringify({ aal: 'aal1' }))}.signature`

    try {
      const response = await worker.fetch(
        new Request('https://app.sygshift.example/api/v1/internal/document-pipeline/canary', {
          headers: { authorization: `Bearer ${token}` },
          method: 'POST',
        }),
        environment(new Response('asset'), configuredEnvironment),
      )
      const payload = await response.json() as { error: string }

      expect(response.status).toBe(403)
      expect(payload.error).toBe('document_pipeline_canary_mfa_required')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/rest/v1/rpc/get_session_context')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects an AAL2 user without security-management permission before canary storage access', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      employee_id: '10000000-0000-4000-8000-000000000001',
      username: 'supervisor',
      display_name: 'Supervisor User',
      role: 'supervisor',
      has_mfa: true,
      permissions: [],
    }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const token = `header.${btoa(JSON.stringify({ aal: 'aal2' }))}.signature`

    try {
      const response = await worker.fetch(
        new Request('https://app.sygshift.example/api/v1/internal/document-pipeline/canary', {
          headers: { authorization: `Bearer ${token}` },
          method: 'POST',
        }),
        environment(new Response('asset'), configuredEnvironment),
      )
      const payload = await response.json() as { error: string }

      expect(response.status).toBe(403)
      expect(payload.error).toBe('permission_required')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/rest/v1/rpc/get_session_context')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('exposes stale email-provider outcomes only through an MFA-protected admin review workflow', async () => {
    const dispatchId = '40000000-0000-4000-8000-000000000099'
    const operationId = '60000000-0000-4000-8000-000000000099'
    const reviewToken = '50000000-0000-4000-8000-000000000099'
    const resolutions: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: '10000000-0000-4000-8000-000000000001',
          username: 'admin',
          display_name: 'Admin User',
          role: 'admin',
          has_mfa: true,
          permissions: ['admin.users.manage'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_list_email_recipient_dispatch_review')) {
        return new Response(JSON.stringify([{
          dispatchId,
          intendedRecipient: 'employee@example.com',
          notificationType: 'schedule_updated',
          sourceId: '20000000-0000-4000-8000-000000000099',
          sourceKind: 'notification_outbox',
          state: 'uncertain',
          reviewToken,
          retryAllowed: true,
          allowedResolutions: ['accepted', 'suppressed', 'retry_verified_unsent'],
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_resolve_email_recipient_dispatch_review')) {
        const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        resolutions.push(requestBody)
        return new Response(JSON.stringify({ dispatchId, state: 'retry_approved' }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const runtime = environment(new Response('asset'), configuredEnvironment)
      const listed = await worker.fetch(
        new Request('https://app.sygshift.example/api/v1/admin/users/email-dispatch-review?limit=25', {
          headers: { authorization: 'Bearer admin-token' },
        }),
        runtime,
      )
      const listPayload = await listed.json() as { items: Array<{ dispatchId: string }> }
      expect(listed.status).toBe(200)
      expect(listPayload.items).toEqual([expect.objectContaining({ dispatchId })])

      const resolved = await worker.fetch(
        new Request(`https://app.sygshift.example/api/v1/admin/users/email-dispatch-review/${dispatchId}`, {
          body: JSON.stringify({
            failureDetail: 'Provider search confirmed no accepted message.',
            operationId,
            resolution: 'retry_verified_unsent',
            reviewToken,
          }),
          headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
          method: 'POST',
        }),
        runtime,
      )
      expect(resolved.status).toBe(200)
      expect(resolutions).toEqual([expect.objectContaining({
        target_actor_employee_id: '10000000-0000-4000-8000-000000000001',
        target_dispatch_id: dispatchId,
        target_operation_id: operationId,
        target_review_token: reviewToken,
        target_resolution: 'retry_verified_unsent',
      })])
    } finally {
      vi.unstubAllGlobals()
    }
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
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        dispatchId: '40000000-0000-4000-8000-000000000010',
        dispatchToken: '50000000-0000-4000-8000-000000000010',
        intendedRecipient: 'employee@example.com',
        sendAllowed: true,
        state: 'dispatching',
      }]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => emailDispatchCompletionReceipt(init))
    const send = vi.fn().mockResolvedValue({ messageId: 'welcome-message' })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/welcome-email`, {
        body: JSON.stringify({ idempotencyKey: '60000000-0000-4000-8000-000000000001' }),
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
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
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: 'employee@example.com' })
    vi.unstubAllGlobals()
  })

  it('keeps an admin welcome-email operation stable when a new HTTP request retries it', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000002'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const idempotencyKey = '60000000-0000-4000-8000-000000000010'
    const sourceIds: string[] = []
    let prepareCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: actorEmployeeId,
          username: 'invitemanager',
          display_name: 'Invite Manager',
          role: 'scheduler',
          has_mfa: true,
          permissions: ['admin.users.invite'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) {
        return new Response(JSON.stringify({
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
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_email_recipient_dispatch_batch')) {
        const requestBody = JSON.parse(String(init?.body)) as { target_source_id: string }
        sourceIds.push(requestBody.target_source_id)
        prepareCount += 1
        return new Response(JSON.stringify([{
          dispatchId: '40000000-0000-4000-8000-000000000010',
          dispatchToken: '50000000-0000-4000-8000-000000000010',
          intendedRecipient: 'employee@example.com',
          sendAllowed: prepareCount === 1,
          state: prepareCount === 1 ? 'dispatching' : 'accepted',
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    const send = vi.fn().mockResolvedValue({ messageId: 'welcome-message' })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const makeRequest = () => new Request(
        `https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/welcome-email`,
        {
          body: JSON.stringify({ idempotencyKey }),
          headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
          method: 'POST',
        },
      )
      const first = await worker.fetch(makeRequest(), environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      }))
      const second = await worker.fetch(makeRequest(), environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      }))

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'))
      expect(sourceIds).toHaveLength(2)
      expect(sourceIds[0]).toBe(sourceIds[1])
      expect(sourceIds[0]).not.toBe(first.headers.get('x-request-id'))
      expect(sourceIds[1]).not.toBe(second.headers.get('x-request-id'))
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a blocked company-domain login email before changing the employee account', async () => {
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: '10000000-0000-4000-8000-000000000002',
          username: 'invitemanager',
          display_name: 'Invite Manager',
          role: 'scheduler',
          has_mfa: true,
          permissions: ['admin.users.invite'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_admin_login_instruction_operation')) {
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_find_active_admin_login_instruction_operations')) {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) {
        return new Response(JSON.stringify({
          employeeId: targetEmployeeId,
          username: 'employee',
          authEmail: 'employee@accounts.sygshift.invalid',
          contactEmail: 'employee@guardianshipsecurity.net',
          displayName: 'Example Employee',
          role: 'guard',
          employmentType: 'hourly',
          status: 'active',
          existingAuthUserId: null,
        }), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    const send = vi.fn()
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/login-email`, {
        body: JSON.stringify({ idempotencyKey: '60000000-0000-4000-8000-000000000030' }),
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
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
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(send).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does not let invite-only login instructions reset an already linked account', async () => {
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: '10000000-0000-4000-8000-000000000002',
          username: 'invitemanager',
          display_name: 'Invite Manager',
          role: 'scheduler',
          has_mfa: true,
          permissions: ['admin.users.invite'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_admin_login_instruction_operation')) {
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_find_active_admin_login_instruction_operations')) {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) {
        return new Response(JSON.stringify({
          employeeId: targetEmployeeId,
          username: 'employee',
          authEmail: 'employee@accounts.sygshift.invalid',
          contactEmail: 'employee@example.com',
          displayName: 'Example Employee',
          role: 'guard',
          employmentType: 'hourly',
          status: 'active',
          existingAuthUserId: targetAuthUserId,
          requiresMfa: false,
        }), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    const send = vi.fn()
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const response = await worker.fetch(
        new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/login-email`, {
          body: JSON.stringify({ idempotencyKey: '60000000-0000-4000-8000-000000000044' }),
          headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
          method: 'POST',
        }),
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send },
          SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
        }),
      )
      const payload = await response.json() as { error: string }

      expect(response.status).toBe(409)
      expect(payload.error).toBe('existing_account_requires_password_reset')
      expect(send).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/auth/v1/admin/users'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not mutate Auth when login-instruction email runtime configuration is unavailable', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000002'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const operationId = '30000000-0000-4000-8000-000000000030'
    const operation = {
      operationId,
      actorEmployeeId,
      mode: 'single',
      state: 'prepared',
      items: [{
        employeeId: targetEmployeeId,
        ordinal: 0,
        employeeNumber: null,
        jobTitle: null,
        username: 'employee',
        authEmail: 'employee@accounts.sygshift.invalid',
        contactEmail: 'employee@example.com',
        displayName: 'Example Employee',
        role: 'guard',
        employmentType: 'hourly',
        status: 'active',
        existingAuthUserId: null,
        requiresMfa: false,
        credentialFingerprint: 'a'.repeat(64),
        state: 'prepared',
        authUserId: null,
        action: null,
        errorCode: null,
        errorStatus: null,
        errorDetail: null,
      }],
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: actorEmployeeId,
          username: 'invitemanager',
          display_name: 'Invite Manager',
          role: 'scheduler',
          has_mfa: true,
          permissions: ['admin.users.invite'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_admin_login_instruction_operation')) {
        return new Response(JSON.stringify(operation), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const response = await worker.fetch(
        new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/login-email`, {
          body: JSON.stringify({ idempotencyKey: '60000000-0000-4000-8000-000000000031' }),
          headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
          method: 'POST',
        }),
        environment(new Response('asset'), configuredEnvironment),
      )
      const payload = await response.json() as { error: string }

      expect(response.status).toBe(503)
      expect(payload.error).toBe('email_not_configured')
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/auth/v1/admin/users'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects an unlinked Auth-by-email candidate owned by another employee before mutation', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000002'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const foreignEmployeeId = '10000000-0000-4000-8000-000000000099'
    let beginCalls = 0
    const send = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: actorEmployeeId,
          username: 'invitemanager',
          display_name: 'Invite Manager',
          role: 'scheduler',
          has_mfa: true,
          permissions: ['admin.users.invite'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_admin_login_instruction_operation')) {
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_find_active_admin_login_instruction_operations')) {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) {
        return new Response(JSON.stringify({
          employeeId: targetEmployeeId,
          username: 'employee',
          authEmail: 'employee@accounts.sygshift.invalid',
          contactEmail: 'employee@example.com',
          displayName: 'Example Employee',
          role: 'guard',
          employmentType: 'hourly',
          status: 'active',
          existingAuthUserId: null,
          requiresMfa: false,
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/auth/v1/admin/users?page=')) {
        return new Response(JSON.stringify({ users: [{
          id: '20000000-0000-4000-8000-000000000099',
          email: 'employee@accounts.sygshift.invalid',
          app_metadata: { employeeId: foreignEmployeeId },
        }] }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_begin_admin_login_instruction_operation')) {
        beginCalls += 1
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const response = await worker.fetch(
        new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/login-email`, {
          body: JSON.stringify({ idempotencyKey: '60000000-0000-4000-8000-000000000039' }),
          headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
          method: 'POST',
        }),
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send },
          SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
        }),
      )
      const payload = await response.json() as { error: string }

      expect(response.status).toBe(409)
      expect(payload.error).toBe('login_instruction_auth_identity_conflict')
      expect(beginCalls).toBe(0)
      expect(send).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.some(([input, init]) => (
        String(input).includes('/auth/v1/admin/users')
        && ['POST', 'PUT'].includes((init as RequestInit | undefined)?.method ?? '')
      ))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    ['separated employee', null],
    ['changed recipient', { contactEmail: 'changed@example.com' }],
    ['changed account link', { existingAuthUserId: '20000000-0000-4000-8000-000000000099' }],
  ])('fails a stale login-instruction replay before Auth or email for a %s', async (_label, targetChange) => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000002'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const operationId = '30000000-0000-4000-8000-000000000031'
    const password = await deriveAdminLoginTemporaryPassword(
      configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY,
      operationId,
      targetEmployeeId,
      'employee',
    )
    const fingerprint = createHmac('sha256', configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY)
      .update(`sygshift-admin-login-fingerprint-v1\u001f${operationId}\u001f${targetEmployeeId}\u001f${password}`)
      .digest('hex')
    const item = {
      employeeId: targetEmployeeId,
      ordinal: 0,
      employeeNumber: null,
      jobTitle: null,
      username: 'employee',
      authEmail: 'employee@accounts.sygshift.invalid',
      contactEmail: 'employee@example.com',
      displayName: 'Example Employee',
      role: 'guard',
      employmentType: 'hourly',
      status: 'active',
      existingAuthUserId: null,
      candidateAuthUserId: null,
      requiresMfa: false,
      credentialFingerprint: fingerprint,
      state: 'prepared' as string,
      authUserId: null as string | null,
      action: null as string | null,
      errorCode: null,
      errorStatus: null,
      errorDetail: null,
    }
    const failedOperation = {
      operationId,
      actorEmployeeId,
      mode: 'single',
      state: 'completed_with_failures',
      items: [{
        ...item,
        state: 'failed',
        errorCode: 'login_instruction_target_changed',
        errorStatus: 409,
        errorDetail: 'The employee target changed.',
      }],
    }
    const send = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: actorEmployeeId,
          username: 'invitemanager',
          display_name: 'Invite Manager',
          role: 'scheduler',
          has_mfa: true,
          permissions: ['admin.users.invite'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_admin_login_instruction_operation')) {
        return new Response(JSON.stringify({
          operationId,
          actorEmployeeId,
          mode: 'single',
          purpose: 'admin_login_instructions',
          state: 'prepared',
          items: [item],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_admin_login_instruction_dispatches')) {
        return new Response(JSON.stringify([{
          dispatchId: '40000000-0000-4000-8000-000000000031',
          dispatchToken: '50000000-0000-4000-8000-000000000031',
          intendedRecipient: item.contactEmail,
          sendAllowed: true,
          state: 'dispatching',
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) {
        return new Response(JSON.stringify(targetChange ? { ...item, ...targetChange } : null), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/auth/v1/admin/users?page=')) {
        const changedAuthUserId = targetChange && 'existingAuthUserId' in targetChange
          ? targetChange.existingAuthUserId
          : null
        return new Response(JSON.stringify({
          users: changedAuthUserId ? [{
            id: changedAuthUserId,
            email: item.authEmail,
            app_metadata: { employeeId: targetEmployeeId },
          }] : [],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_release_known_unsent_email_dispatch')) {
        return knownUnsentEmailReleaseReceipt(_init)
      }
      if (url.includes('/rest/v1/rpc/service_record_admin_login_instruction_outcome')) {
        return new Response(JSON.stringify(failedOperation), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const response = await worker.fetch(
        new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/login-email`, {
          body: JSON.stringify({ idempotencyKey: '60000000-0000-4000-8000-000000000032' }),
          headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
          method: 'POST',
        }),
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send },
          SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
        }),
      )
      const payload = await response.json() as { error: string }
      expect(response.status).toBe(409)
      expect(payload.error).toBe('login_instruction_target_changed')
      expect(send).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.some(([input, init]) => (
        String(input).includes('/auth/v1/admin/users')
        && ['POST', 'PUT'].includes((init as RequestInit | undefined)?.method ?? '')
      ))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('recovers an accepted login email after finalization response loss and browser/account change without resending', async () => {
    const originalActorId = '10000000-0000-4000-8000-000000000002'
    const recoveryActorId = '10000000-0000-4000-8000-000000000003'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const initialKey = '30000000-0000-4000-8000-000000000033'
    const retryKey = '60000000-0000-4000-8000-000000000034'
    const operationDigest = createHash('sha256')
      .update(['admin-email-idempotency', 'login-instructions', originalActorId, targetEmployeeId, initialKey].join('\u001f'))
      .digest('hex')
    const operationId = `${operationDigest.slice(0, 8)}-${operationDigest.slice(8, 12)}-5${operationDigest.slice(13, 16)}-8${operationDigest.slice(17, 20)}-${operationDigest.slice(20, 32)}`
    const password = await deriveAdminLoginTemporaryPassword(
      configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY,
      operationId,
      targetEmployeeId,
      'employee',
    )
    const fingerprint = createHmac('sha256', configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY)
      .update(`sygshift-admin-login-fingerprint-v1\u001f${operationId}\u001f${targetEmployeeId}\u001f${password}`)
      .digest('hex')
    const baseItem = {
      employeeId: targetEmployeeId,
      ordinal: 0,
      employeeNumber: 'SYG-1100',
      jobTitle: 'Guard',
      username: 'employee',
      authEmail: 'employee@accounts.sygshift.invalid',
      contactEmail: 'employee@example.com',
      displayName: 'Example Employee',
      role: 'guard',
      employmentType: 'hourly',
      status: 'active',
      existingAuthUserId: null as string | null,
      candidateAuthUserId: null as string | null,
      requiresMfa: false,
      credentialFingerprint: fingerprint,
      state: 'prepared' as string,
      authUserId: null as string | null,
      action: null as string | null,
      errorCode: null,
      errorStatus: null,
      errorDetail: null,
    }
    let storedOperation = {
      operationId,
      actorEmployeeId: originalActorId,
      mode: 'single',
      state: 'prepared',
      items: [baseItem],
    }
    let prepareCount = 0
    let outcomeCount = 0
    let claimCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        const authorization = new Headers(init?.headers).get('authorization')
        const employeeId = authorization === 'Bearer admin-b' ? recoveryActorId : originalActorId
        return new Response(JSON.stringify({
          employee_id: employeeId,
          username: employeeId === recoveryActorId ? 'recoveringadmin' : 'originaladmin',
          display_name: employeeId === recoveryActorId ? 'Recovering Admin' : 'Original Admin',
          role: 'admin',
          has_mfa: true,
          permissions: ['admin.users.invite'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_admin_login_instruction_operation')) {
        return new Response(JSON.stringify(body.target_operation_id === operationId ? storedOperation : null), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/rest/v1/rpc/service_find_active_admin_login_instruction_operations')) {
        return new Response(JSON.stringify([storedOperation]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_claim_admin_login_instruction_operation')) {
        claimCount += 1
        expect(body.target_recovery_actor_employee_id).toBe(recoveryActorId)
        return new Response(JSON.stringify(storedOperation), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_admin_login_instruction_dispatches')) {
        prepareCount += 1
        return new Response(JSON.stringify([{
          dispatchId: '40000000-0000-4000-8000-000000000033',
          dispatchToken: '50000000-0000-4000-8000-000000000033',
          intendedRecipient: baseItem.contactEmail,
          sendAllowed: prepareCount === 1,
          state: prepareCount === 1 ? 'dispatching' : 'accepted',
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) {
        return new Response(JSON.stringify(baseItem), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/auth/v1/admin/users?page=')) {
        return new Response(JSON.stringify({ users: [{
          id: targetAuthUserId,
          email: baseItem.authEmail,
          app_metadata: { employeeId: targetEmployeeId, loginInstructionOperationId: operationId },
        }] }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith(`/auth/v1/admin/users/${targetAuthUserId}`)) {
        return new Response(JSON.stringify({ id: targetAuthUserId, email: baseItem.authEmail }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/rest/v1/rpc/service_link_employee_auth_account')) {
        return new Response(JSON.stringify({ linked: true }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_mark_admin_login_instruction_provisioned')) {
        storedOperation = {
          ...storedOperation,
          items: [{
            ...baseItem,
            state: 'provisioned',
            authUserId: targetAuthUserId,
            action: 'updated_existing_auth_user',
          }],
        }
        return new Response(JSON.stringify(storedOperation), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
      }
      if (url.includes('/rest/v1/rpc/service_record_admin_login_instruction_outcome')) {
        outcomeCount += 1
        if (outcomeCount === 1) {
          return new Response(JSON.stringify({ message: 'response lost after completion write' }), {
            headers: { 'content-type': 'application/json' },
            status: 503,
          })
        }
        storedOperation = {
          ...storedOperation,
          state: 'completed',
          items: storedOperation.items.map((item) => ({ ...item, state: 'completed' })),
        }
        return new Response(JSON.stringify(storedOperation), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    const send = vi.fn().mockResolvedValue({ messageId: 'login-instruction-message' })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const runtime = environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      })
      const makeRequest = (idempotencyKey: string, token: string) => new Request(
        `https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/login-email`,
        {
          body: JSON.stringify({ idempotencyKey }),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          method: 'POST',
        },
      )
      const first = await worker.fetch(makeRequest(initialKey, 'admin-a'), runtime)
      const firstPayload = await first.json() as { error: string }
      const recovered = await worker.fetch(makeRequest(retryKey, 'admin-b'), runtime)
      const recoveredPayload = await recovered.json() as { operationId: string }

      expect(first.status, JSON.stringify({
        calls: fetchMock.mock.calls.map(([input]) => String(input)),
        payload: firstPayload,
      })).toBe(409)
      expect(firstPayload.error).toBe('login_instruction_finalization_pending')
      expect(recovered.status).toBe(200)
      expect(recoveredPayload.operationId).toBe(operationId)
      expect(send).toHaveBeenCalledTimes(1)
      expect(claimCount).toBe(1)
      expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(`/auth/v1/admin/users/${targetAuthUserId}`)))
        .toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('redacts a credential echoed by the email provider before persisting or returning the failure', async () => {
    const credential = 'NeverPersist-Me9!'
    const recipient = 'employee@example.com'
    const sourceId = '30000000-0000-4000-8000-000000000035'
    const rpc = vi.fn(async <T>(
      _config: unknown,
      name: string,
      body: Record<string, unknown>,
    ): Promise<T> => {
      expect(name).toBe('service_complete_email_recipient_dispatch')
      expect(JSON.stringify(body)).not.toContain(credential)
      expect(body.target_failure_detail).toBe('The login-instruction email provider outcome is unknown. Credential content was redacted.')
      return {
        dispatchToken: body.target_dispatch_token,
        state: 'uncertain',
      } as T
    })
    const send = vi.fn().mockRejectedValue(new Error(`Provider echoed outbound body: ${credential}`))
    const result = await deliverDurableEmailRecipients(
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      }) as Env,
      'inline_email',
      sourceId,
      [recipient],
      { subject: 'Login instructions', text: `Temporary password: ${credential}` },
      {
        notificationType: 'login_instructions',
        relatedRecordId: sourceId,
        relatedRecordType: 'admin_login_instruction_operation',
      },
      rpc as Parameters<typeof deliverDurableEmailRecipients>[6],
      undefined,
      new Map([[recipient, {
        dispatchId: '40000000-0000-4000-8000-000000000035',
        dispatchToken: '50000000-0000-4000-8000-000000000035',
        sendAllowed: true,
        state: 'dispatching',
      }]]),
      'The login-instruction email provider outcome is unknown. Credential content was redacted.',
    )

    expect(result.uncertain).toEqual([{
      error: 'The login-instruction email provider outcome is unknown. Credential content was redacted.',
      recipient,
    }])
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(credential)
  })

  it('recovers a newly created Auth user after response loss using exact operation provenance and the same credential', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000002'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const authUserId = '20000000-0000-4000-8000-000000000036'
    const idempotencyKey = '60000000-0000-4000-8000-000000000036'
    const operationDigest = createHash('sha256')
      .update(['admin-email-idempotency', 'login-instructions', actorEmployeeId, targetEmployeeId, idempotencyKey].join('\u001f'))
      .digest('hex')
    const operationId = `${operationDigest.slice(0, 8)}-${operationDigest.slice(8, 12)}-5${operationDigest.slice(13, 16)}-8${operationDigest.slice(17, 20)}-${operationDigest.slice(20, 32)}`
    const password = await deriveAdminLoginTemporaryPassword(
      configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY,
      operationId,
      targetEmployeeId,
      'employee',
    )
    const fingerprint = createHmac('sha256', configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY)
      .update(`sygshift-admin-login-fingerprint-v1\u001f${operationId}\u001f${targetEmployeeId}\u001f${password}`)
      .digest('hex')
    const baseItem = {
      employeeId: targetEmployeeId,
      ordinal: 0,
      employeeNumber: null,
      jobTitle: 'Guard',
      username: 'employee',
      authEmail: 'employee@accounts.sygshift.invalid',
      contactEmail: 'employee@example.com',
      displayName: 'Example Employee',
      role: 'guard',
      employmentType: 'hourly',
      status: 'active',
      existingAuthUserId: null,
      candidateAuthUserId: null,
      requiresMfa: false,
      credentialFingerprint: fingerprint,
      state: 'prepared',
      authUserId: null as string | null,
      action: null as string | null,
      errorCode: null,
      errorStatus: null,
      errorDetail: null,
    }
    let operation = {
      operationId,
      actorEmployeeId,
      mode: 'single',
      purpose: 'admin_login_instructions',
      state: 'prepared',
      items: [baseItem],
    }
    let created = false
    let createCalls = 0
    let updateCalls = 0
    let outcomeCalls = 0
    const persistedBodies: Array<{ body: string, url: string }> = []
    const send = vi.fn().mockResolvedValue({ messageId: 'provider-accepted' })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const bodyText = typeof init?.body === 'string' ? init.body : ''
      if (bodyText) persistedBodies.push({ body: bodyText, url })
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: actorEmployeeId,
          username: 'invitemanager',
          display_name: 'Invite Manager',
          role: 'scheduler',
          has_mfa: true,
          permissions: ['admin.users.invite'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_admin_login_instruction_operation')) {
        return new Response(JSON.stringify(operation), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_admin_login_instruction_dispatches')) {
        return new Response(JSON.stringify([{
          dispatchId: '40000000-0000-4000-8000-000000000036',
          dispatchToken: '50000000-0000-4000-8000-000000000036',
          intendedRecipient: baseItem.contactEmail,
          sendAllowed: true,
          state: created ? 'retry_approved' : 'dispatching',
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) {
        return new Response(JSON.stringify({ ...baseItem, existingAuthUserId: null }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/auth/v1/admin/users?page=')) {
        return new Response(JSON.stringify({
          users: created ? [{
            id: authUserId,
            email: baseItem.authEmail,
            app_metadata: { employeeId: targetEmployeeId, loginInstructionOperationId: operationId },
          }] : [],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/auth/v1/admin/users') && init?.method === 'POST') {
        createCalls += 1
        created = true
        expect(bodyText).toContain(password)
        expect(bodyText).toContain(operationId)
        return new Response(JSON.stringify({ message: `Auth response lost after accepting ${password}` }), {
          headers: { 'content-type': 'application/json' },
          status: 503,
        })
      }
      if (url.endsWith(`/auth/v1/admin/users/${authUserId}`)) {
        updateCalls += 1
        expect(bodyText).toContain(password)
        expect(bodyText).toContain(operationId)
        return new Response(JSON.stringify({
          id: authUserId,
          email: baseItem.authEmail,
          app_metadata: { employeeId: targetEmployeeId, loginInstructionOperationId: operationId },
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_link_employee_auth_account')) {
        return new Response(JSON.stringify({ linked: true }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_mark_admin_login_instruction_provisioned')) {
        operation = {
          ...operation,
          items: [{ ...baseItem, state: 'provisioned', authUserId, action: 'created_auth_user' }],
        }
        return new Response(JSON.stringify(operation), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_release_known_unsent_email_dispatch')) {
        return knownUnsentEmailReleaseReceipt(init)
      }
      if (url.includes('/rest/v1/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
      }
      if (url.includes('/rest/v1/rpc/service_record_admin_login_instruction_outcome')) {
        outcomeCalls += 1
        const body = JSON.parse(bodyText) as { target_state: string }
        if (body.target_state === 'completed') {
          operation = {
            ...operation,
            state: 'completed',
            items: [{ ...operation.items[0], state: 'completed' }],
          }
        } else {
          operation = { ...operation, items: [{ ...baseItem, state: 'unresolved' }] }
        }
        return new Response(JSON.stringify(operation), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))
    const runtime = environment(new Response('asset'), {
      ...configuredEnvironment,
      EMAIL: { send },
      SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
    })
    const request = () => new Request(
      `https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/login-email`,
      {
        body: JSON.stringify({ idempotencyKey }),
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        method: 'POST',
      },
    )

    try {
      const first = await worker.fetch(request(), runtime)
      const firstText = await first.text()
      const retry = await worker.fetch(request(), runtime)

      expect(first.status).toBe(503)
      expect(firstText).not.toContain(password)
      expect(retry.status).toBe(200)
      expect(createCalls).toBe(1)
      expect(updateCalls).toBe(0)
      expect(send).toHaveBeenCalledTimes(1)
      expect(outcomeCalls).toBe(2)
      expect(persistedBodies
        .filter((request) => !request.url.includes('/auth/v1/'))
        .map((request) => request.body)
        .join('\n')).not.toContain(password)
    } finally {
      vi.unstubAllGlobals()
    }
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
      .mockResolvedValueOnce(new Response(JSON.stringify('30000000-0000-4000-8000-000000000020'), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        dispatchId: '40000000-0000-4000-8000-000000000020',
        dispatchToken: '50000000-0000-4000-8000-000000000020',
        intendedRecipient: 'employee@example.com',
        sendAllowed: true,
        state: 'dispatching',
      }]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => emailDispatchCompletionReceipt(init))
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
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/rest/v1/rpc/service_get_username_recovery_claim_source')
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      target_intended_recipients: ['employee@example.com'],
      target_notification_type: 'username_recovery_self_service',
      target_related_record_id: targetEmployeeId,
      target_source_id: '30000000-0000-4000-8000-000000000020',
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
      .mockResolvedValueOnce(new Response(JSON.stringify('30000000-0000-4000-8000-000000000021'), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        dispatchId: '40000000-0000-4000-8000-000000000021',
        dispatchToken: '50000000-0000-4000-8000-000000000021',
        sendAllowed: true,
        state: 'dispatching',
      }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action_link: 'https://example.supabase.co/auth/v1/verify?token=self-service-token&type=recovery',
        hashed_token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'accepted' }), {
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
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/rest/v1/rpc/service_get_password_reset_claim_source')
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      target_notification_type: 'password_reset_self_service',
      target_related_record_id: targetEmployeeId,
      target_source_id: '30000000-0000-4000-8000-000000000021',
    })
    vi.unstubAllGlobals()
  })

  it('coalesces a new-request self-service password retry before minting another recovery link', async () => {
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const claimSourceId = '30000000-0000-4000-8000-000000000024'
    const transportRequestIds: string[] = []
    let prepareCount = 0
    let recoveryLinkCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/service_claim_self_service_password_reset')) {
        const requestBody = JSON.parse(String(init?.body)) as { target_request_id: string }
        transportRequestIds.push(requestBody.target_request_id)
        return new Response(JSON.stringify({
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
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_password_reset_claim_source')) {
        return new Response(JSON.stringify(claimSourceId), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_email_recipient_dispatch')) {
        prepareCount += 1
        return new Response(JSON.stringify({
          dispatchId: '40000000-0000-4000-8000-000000000024',
          dispatchToken: '50000000-0000-4000-8000-000000000024',
          sendAllowed: prepareCount === 1,
          state: prepareCount === 1 ? 'dispatching' : 'accepted',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/auth/v1/admin/generate_link')) {
        recoveryLinkCount += 1
        return new Response(JSON.stringify({
          action_link: 'https://example.supabase.co/auth/v1/verify?token=coalesced&type=recovery',
          hashed_token: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    const send = vi.fn().mockResolvedValue({ messageId: 'self-service-reset-message' })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const runtime = environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      })
      const makeRequest = () => new Request('https://app.sygshift.example/api/v1/auth/password-reset/request', {
        body: JSON.stringify({ username: 'Employee' }),
        headers: { 'cf-connecting-ip': '192.0.2.25', 'content-type': 'application/json' },
        method: 'POST',
      })
      const first = await worker.fetch(makeRequest(), runtime)
      const second = await worker.fetch(makeRequest(), runtime)

      expect(first.status).toBe(202)
      expect(second.status).toBe(202)
      expect(transportRequestIds).toHaveLength(2)
      expect(transportRequestIds[0]).not.toBe(transportRequestIds[1])
      expect(recoveryLinkCount).toBe(1)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('releases a self-service password-reset dispatch when link generation fails before provider delivery', async () => {
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const sourceId = '30000000-0000-4000-8000-000000000025'
    let linkAttempts = 0
    let releaseCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/service_claim_self_service_password_reset')) {
        return new Response(JSON.stringify({
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
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_password_reset_claim_source')) {
        return new Response(JSON.stringify(sourceId), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_email_recipient_dispatch')) {
        return new Response(JSON.stringify({
          dispatchId: '40000000-0000-4000-8000-000000000025',
          dispatchToken: '50000000-0000-4000-8000-000000000025',
          sendAllowed: true,
          state: 'dispatching',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/auth/v1/admin/generate_link')) {
        linkAttempts += 1
        if (linkAttempts === 1) {
          return new Response(JSON.stringify({ message: 'Auth link service unavailable' }), {
            headers: { 'content-type': 'application/json' },
            status: 503,
          })
        }
        return new Response(JSON.stringify({
          action_link: 'https://example.supabase.co/auth/v1/verify?token=retry&type=recovery',
          hashed_token: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_release_known_unsent_email_dispatch')) {
        releaseCalls += 1
        return knownUnsentEmailReleaseReceipt(init)
      }
      if (url.includes('/rest/v1/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    const send = vi.fn().mockResolvedValue({ messageId: 'self-service-reset-message' })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const runtime = environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      })
      const makeRequest = () => new Request('https://app.sygshift.example/api/v1/auth/password-reset/request', {
        body: JSON.stringify({ username: 'Employee' }),
        headers: { 'cf-connecting-ip': '192.0.2.26', 'content-type': 'application/json' },
        method: 'POST',
      })
      const first = await worker.fetch(makeRequest(), runtime)
      const second = await worker.fetch(makeRequest(), runtime)

      expect(first.status).toBe(202)
      expect(second.status).toBe(202)
      expect(linkAttempts).toBe(2)
      expect(releaseCalls).toBe(1)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
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
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => (
        employeePasswordResetOperationReceipt(init, 'prepared')
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        dispatchId: '40000000-0000-4000-8000-000000000022',
        dispatchToken: '50000000-0000-4000-8000-000000000022',
        sendAllowed: true,
        state: 'dispatching',
      }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action_link: 'https://example.supabase.co/auth/v1/verify?token=single-use-token&type=recovery',
        hashed_token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }), { headers: { 'content-type': 'application/json' } }))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => emailDispatchCompletionReceipt(init))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => (
        employeePasswordResetOperationReceipt(init, 'completed')
      ))
    const send = vi.fn().mockResolvedValue({ messageId: 'password-reset-message' })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/password-reset`, {
        body: JSON.stringify({ idempotencyKey: '60000000-0000-4000-8000-000000000002' }),
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
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

    const preparedOperationRequest = fetchMock.mock.calls.find(([input]) => (
      String(input).includes('/rest/v1/rpc/service_prepare_employee_password_reset_operation')
    ))
    const preparedOperationId = (JSON.parse(String(preparedOperationRequest?.[1]?.body)) as {
      target_operation_id: string
    }).target_operation_id
    const completionRequest = fetchMock.mock.calls.at(-1)
    expect(String(completionRequest?.[0])).toContain('/rest/v1/rpc/service_complete_employee_password_reset_operation')
    expect(JSON.parse(String(completionRequest?.[1]?.body))).toMatchObject({
      target_actor_employee_id: actorEmployeeId,
      target_auth_user_id: targetAuthUserId,
      target_employee_id: targetEmployeeId,
      target_operation_id: preparedOperationId,
      target_recipient_email: 'employee@example.com',
    })
    vi.unstubAllGlobals()
  })

  it('retries an admin password-reset operation without minting a second recovery link', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000001'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const idempotencyKey = '60000000-0000-4000-8000-000000000020'
    const sourceIds: string[] = []
    const completionOperationIds: string[] = []
    let prepareCount = 0
    let recoveryLinkCount = 0
    let requestCount = 0
    let resetState: 'prepared' | 'completed' = 'prepared'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        requestCount += 1
        return new Response(JSON.stringify({
          employee_id: actorEmployeeId,
          username: 'admin',
          display_name: 'Admin User',
          role: 'admin',
          has_mfa: true,
          permissions: ['admin.users.password_reset'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) {
        return new Response(JSON.stringify({
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
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_employee_password_reset_operation')) {
        if (resetState === 'completed' && requestCount === 1) {
          return new Response(JSON.stringify({ message: 'response lost after operation commit' }), {
            headers: { 'content-type': 'application/json' },
            status: 503,
          })
        }
        return employeePasswordResetOperationReceipt(init, resetState)
      }
      if (url.includes('/rest/v1/rpc/service_prepare_email_recipient_dispatch')) {
        const requestBody = JSON.parse(String(init?.body)) as { target_source_id: string }
        sourceIds.push(requestBody.target_source_id)
        prepareCount += 1
        return new Response(JSON.stringify({
          dispatchId: '40000000-0000-4000-8000-000000000023',
          dispatchToken: '50000000-0000-4000-8000-000000000023',
          sendAllowed: prepareCount === 1,
          state: prepareCount === 1 ? 'dispatching' : 'accepted',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/auth/v1/admin/generate_link')) {
        recoveryLinkCount += 1
        return new Response(JSON.stringify({
          action_link: 'https://example.supabase.co/auth/v1/verify?token=retry-safe&type=recovery',
          hashed_token: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
      }
      if (url.includes('/rest/v1/rpc/service_complete_employee_password_reset_operation')) {
        const requestBody = JSON.parse(String(init?.body)) as { target_operation_id: string }
        completionOperationIds.push(requestBody.target_operation_id)
        resetState = 'completed'
        return new Response(JSON.stringify({ message: 'response lost after operation commit' }), {
          headers: { 'content-type': 'application/json' },
          status: 503,
        })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    const send = vi.fn().mockResolvedValue({ messageId: 'password-reset-message' })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const makeRequest = () => new Request(
        `https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/password-reset`,
        {
          body: JSON.stringify({ idempotencyKey }),
          headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
          method: 'POST',
        },
      )
      const runtime = environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
        SYGSHIFT_PUBLIC_APP_URL: 'https://app.sygilant.us',
      })
      const first = await worker.fetch(makeRequest(), runtime)
      const second = await worker.fetch(makeRequest(), runtime)

      expect(first.status).toBe(503)
      expect(second.status).toBe(200)
      expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'))
      expect(sourceIds).toHaveLength(1)
      expect(completionOperationIds.length).toBeGreaterThan(0)
      expect(new Set(completionOperationIds)).toEqual(new Set([sourceIds[0]]))
      expect(prepareCount).toBe(1)
      expect(recoveryLinkCount).toBe(1)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('releases an admin password-reset dispatch when link generation fails before provider delivery', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000001'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const operationId = '60000000-0000-4000-8000-000000000026'
    let linkAttempts = 0
    let releaseCalls = 0
    let auditCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: actorEmployeeId,
          username: 'admin',
          display_name: 'Admin User',
          role: 'admin',
          has_mfa: true,
          permissions: ['admin.users.password_reset'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_login_email_target')) {
        return new Response(JSON.stringify({
          employeeId: targetEmployeeId,
          username: 'employee',
          authEmail: 'employee@accounts.sygshift.invalid',
          contactEmail: 'employee@example.com',
          displayName: 'Example Employee',
          role: 'guard',
          employmentType: 'hourly',
          status: 'active',
          existingAuthUserId: targetAuthUserId,
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_employee_password_reset_operation')) {
        return employeePasswordResetOperationReceipt(init, 'prepared')
      }
      if (url.includes('/rest/v1/rpc/service_prepare_email_recipient_dispatch')) {
        return new Response(JSON.stringify({
          dispatchId: '40000000-0000-4000-8000-000000000026',
          dispatchToken: '50000000-0000-4000-8000-000000000026',
          sendAllowed: true,
          state: 'dispatching',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/auth/v1/admin/generate_link')) {
        linkAttempts += 1
        if (linkAttempts === 1) {
          return new Response(JSON.stringify({ message: 'Auth link service unavailable' }), {
            headers: { 'content-type': 'application/json' },
            status: 503,
          })
        }
        return new Response(JSON.stringify({
          action_link: 'https://example.supabase.co/auth/v1/verify?token=retry&type=recovery',
          hashed_token: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_release_known_unsent_email_dispatch')) {
        releaseCalls += 1
        return knownUnsentEmailReleaseReceipt(init)
      }
      if (url.includes('/rest/v1/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
      }
      if (url.includes('/rest/v1/rpc/service_complete_employee_password_reset_operation')) {
        auditCalls += 1
        return employeePasswordResetOperationReceipt(init, 'completed')
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    const send = vi.fn().mockResolvedValue({ messageId: 'admin-reset-message' })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const runtime = environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      })
      const makeRequest = () => new Request(
        `https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/password-reset`,
        {
          body: JSON.stringify({ idempotencyKey: operationId }),
          headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
          method: 'POST',
        },
      )
      const first = await worker.fetch(makeRequest(), runtime)
      const second = await worker.fetch(makeRequest(), runtime)

      expect(first.status).toBe(502)
      expect(second.status).toBe(200)
      expect(linkAttempts).toBe(2)
      expect(releaseCalls).toBe(1)
      expect(auditCalls).toBe(1)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
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

  it('retires one-time-code MFA recovery before consuming the code or reading Auth factors', async () => {
    const employeeId = '10000000-0000-4000-8000-000000000010'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: employeeId,
          username: 'employee',
          display_name: 'Example Employee',
          role: 'guard',
          has_mfa: true,
          permissions: [],
        }), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Recovery must fail before this request: ${url}`)
    })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const response = await worker.fetch(
        new Request('https://app.sygshift.example/api/v1/account/mfa-recovery', {
          body: JSON.stringify({ code: 'SYG-ABCD-2345' }),
          headers: { authorization: 'Bearer employee-token', 'content-type': 'application/json' },
          method: 'POST',
        }),
        environment(new Response('asset'), configuredEnvironment),
      )
      const payload = await response.json() as { error: string }

      expect(response.status).toBe(409)
      expect(payload.error).toBe('mfa_recovery_combined_reset_required')
      const requestUrls = fetchMock.mock.calls.map(([input]) => String(input))
      expect(requestUrls.some((requestUrl) => requestUrl.includes('service_consume_mfa_recovery_code'))).toBe(false)
      expect(requestUrls.some((requestUrl) => requestUrl.includes('service_get_employee_auth_target'))).toBe(false)
      expect(requestUrls.some((requestUrl) => requestUrl.includes('/auth/v1/admin/users/'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not issue replacement MFA recovery codes while safe consumption is retired', async () => {
    const employeeId = '10000000-0000-4000-8000-000000000010'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: employeeId,
          username: 'employee',
          display_name: 'Example Employee',
          role: 'guard',
          has_mfa: true,
          permissions: [],
        }), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Recovery-code issuance must fail before this request: ${url}`)
    })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const response = await worker.fetch(
        new Request('https://app.sygshift.example/api/v1/account/mfa-recovery-codes', {
          body: '{}',
          headers: { authorization: 'Bearer employee-token', 'content-type': 'application/json' },
          method: 'POST',
        }),
        environment(new Response('asset'), configuredEnvironment),
      )
      const payload = await response.json() as { error: string }

      expect(response.status).toBe(409)
      expect(payload.error).toBe('mfa_recovery_code_issuance_paused')
      const requestUrls = fetchMock.mock.calls.map(([input]) => String(input))
      expect(requestUrls.some((requestUrl) => requestUrl.includes('service_replace_mfa_recovery_codes'))).toBe(false)
      expect(requestUrls.some((requestUrl) => requestUrl.includes('service_get_employee_auth_target'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retires administrative factor-only MFA reset before target lookup or Auth mutation', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000001'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const factorId = '30000000-0000-4000-8000-000000000010'
    let operationId = ''
    let factorsListed = 0
    const operation = (state: 'prepared' | 'deleting' | 'completed') => ({
      operationId,
      employeeId: targetEmployeeId,
      authUserId: targetAuthUserId,
      actorEmployeeId,
      factorIds: [factorId],
      factorCount: 1,
      state,
      recoveryCodesRevoked: state === 'completed' ? 3 : null,
      trustedDevicesRevoked: state === 'completed' ? 2 : null,
      securityKeysRevoked: state === 'completed' ? 0 : null,
      securityKeySessionsRevoked: state === 'completed' ? 0 : null,
      preparedAt: '2026-10-24T12:00:00.000Z',
      authMutationStartedAt: state === 'prepared' ? null : '2026-10-24T12:00:01.000Z',
      completedAt: state === 'completed' ? '2026-10-24T12:00:02.000Z' : null,
      recoveryAttempts: 0,
      recoveryNextAttemptAt: '2026-10-24T12:00:00.000Z',
      recoveryLastError: null,
      recoveryQuarantinedAt: null,
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: actorEmployeeId,
          username: 'admin',
          display_name: 'Admin User',
          role: 'admin',
          has_mfa: true,
          permissions: ['admin.users.manage'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_auth_target')) {
        return new Response(JSON.stringify({
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
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_admin_mfa_reset_operation')) {
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(`/auth/v1/admin/users/${targetAuthUserId}/factors`)) {
        factorsListed += 1
        return new Response(JSON.stringify(factorsListed === 1 ? [{
          id: factorId,
          factor_type: 'totp',
          status: 'verified',
        }] : []), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_begin_admin_mfa_reset_operation')) {
        const body = JSON.parse(String(init?.body)) as { target_operation_id: string }
        operationId = body.target_operation_id
        return new Response(JSON.stringify(operation('prepared')), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_mark_admin_mfa_reset_deleting')) {
        return new Response(JSON.stringify(operation('deleting')), { headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(`/auth/v1/admin/users/${targetAuthUserId}/factors/${factorId}`)) {
        return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_complete_admin_mfa_reset_operation')) {
        return new Response(JSON.stringify(operation('completed')), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    const response = await worker.fetch(
      new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/mfa-reset`, {
        body: JSON.stringify({ idempotencyKey: '60000000-0000-4000-8000-000000000003' }),
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        method: 'POST',
      }),
      environment(new Response('asset'), configuredEnvironment),
    )
    const payload = await response.json() as { error: string; detail: string }

    expect(response.status).toBe(409)
    expect(payload).toMatchObject({
      error: 'mfa_reset_combined_recovery_required',
    })
    const requestUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestUrls.some((requestUrl) => requestUrl.includes('service_get_employee_auth_target'))).toBe(false)
    expect(requestUrls.some((requestUrl) => requestUrl.includes('/auth/v1/admin/users/'))).toBe(false)
    vi.unstubAllGlobals()
  })

  it('does not delete an Auth factor when durable MFA mutation state cannot be recorded', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000001'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const factorId = '30000000-0000-4000-8000-000000000010'
    let operationId = ''
    const operation = (state: 'prepared' | 'deleting') => ({
      operationId,
      employeeId: targetEmployeeId,
      authUserId: targetAuthUserId,
      actorEmployeeId,
      factorIds: [factorId],
      factorCount: 1,
      state,
      recoveryCodesRevoked: null,
      trustedDevicesRevoked: null,
      securityKeysRevoked: null,
      securityKeySessionsRevoked: null,
      preparedAt: '2026-10-24T12:00:00.000Z',
      authMutationStartedAt: state === 'deleting' ? '2026-10-24T12:00:01.000Z' : null,
      completedAt: null,
      recoveryAttempts: 0,
      recoveryNextAttemptAt: '2026-10-24T12:00:00.000Z',
      recoveryLastError: null,
      recoveryQuarantinedAt: null,
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: actorEmployeeId,
          username: 'admin',
          display_name: 'Admin User',
          role: 'admin',
          has_mfa: true,
          permissions: ['admin.users.manage'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_auth_target')) {
        return new Response(JSON.stringify({
          employeeId: targetEmployeeId,
          username: 'employee',
          authEmail: 'employee@accounts.sygshift.invalid',
          displayName: 'Example Employee',
          role: 'guard',
          employmentType: 'hourly',
          status: 'active',
          existingAuthUserId: targetAuthUserId,
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_admin_mfa_reset_operation')) {
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(`/auth/v1/admin/users/${targetAuthUserId}/factors`)) {
        return new Response(JSON.stringify([{ id: factorId }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_begin_admin_mfa_reset_operation')) {
        operationId = (JSON.parse(String(init?.body)) as { target_operation_id: string }).target_operation_id
        return new Response(JSON.stringify(operation('prepared')), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_mark_admin_mfa_reset_deleting')) {
        return new Response(JSON.stringify({ message: 'database unavailable' }), {
          headers: { 'content-type': 'application/json' },
          status: 503,
        })
      }
      if (url.includes(`/auth/v1/admin/users/${targetAuthUserId}/factors/${factorId}`)) {
        throw new Error('Auth deletion must not run before durable deleting state.')
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const response = await worker.fetch(
        new Request(`https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/mfa-reset`, {
          body: JSON.stringify({ idempotencyKey: '60000000-0000-4000-8000-000000000030' }),
          headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
          method: 'POST',
        }),
        environment(new Response('asset'), configuredEnvironment),
      )

      expect(response.status).toBe(409)
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/factors/${factorId}`))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('resumes a partially deleted MFA reset and reconciles a lost completion response without duplicate completion', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000001'
    const targetEmployeeId = '10000000-0000-4000-8000-000000000010'
    const targetAuthUserId = '20000000-0000-4000-8000-000000000010'
    const factorA = '30000000-0000-4000-8000-000000000011'
    const factorB = '30000000-0000-4000-8000-000000000012'
    let operationId = ''
    let durableState: 'absent' | 'deleting' | 'completed' = 'absent'
    let factorADeletes = 0
    let factorBDeletes = 0
    let beginCalls = 0
    let markCalls = 0
    let completeCalls = 0
    const operation = () => ({
      operationId,
      employeeId: targetEmployeeId,
      authUserId: targetAuthUserId,
      actorEmployeeId,
      factorIds: [factorA, factorB],
      factorCount: 2,
      state: durableState === 'completed' ? 'completed' : 'deleting',
      recoveryCodesRevoked: durableState === 'completed' ? 4 : null,
      trustedDevicesRevoked: durableState === 'completed' ? 2 : null,
      securityKeysRevoked: durableState === 'completed' ? 0 : null,
      securityKeySessionsRevoked: durableState === 'completed' ? 0 : null,
      preparedAt: '2026-10-24T12:00:00.000Z',
      authMutationStartedAt: '2026-10-24T12:00:01.000Z',
      completedAt: durableState === 'completed' ? '2026-10-24T12:00:02.000Z' : null,
      recoveryAttempts: 0,
      recoveryNextAttemptAt: '2026-10-24T12:00:00.000Z',
      recoveryLastError: null,
      recoveryQuarantinedAt: null,
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
          employee_id: actorEmployeeId,
          username: 'admin',
          display_name: 'Admin User',
          role: 'admin',
          has_mfa: true,
          permissions: ['admin.users.manage'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_employee_auth_target')) {
        return new Response(JSON.stringify({
          employeeId: targetEmployeeId,
          username: 'employee',
          authEmail: 'employee@accounts.sygshift.invalid',
          displayName: 'Example Employee',
          role: 'guard',
          employmentType: 'hourly',
          status: 'active',
          existingAuthUserId: targetAuthUserId,
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_admin_mfa_reset_operation')) {
        return new Response(JSON.stringify(durableState === 'absent' ? null : operation()), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith(`/auth/v1/admin/users/${targetAuthUserId}/factors`)) {
        return new Response(JSON.stringify(durableState === 'absent' ? [{ id: factorA }, { id: factorB }] : []), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/rest/v1/rpc/service_begin_admin_mfa_reset_operation')) {
        beginCalls += 1
        operationId = (JSON.parse(String(init?.body)) as { target_operation_id: string }).target_operation_id
        return new Response(JSON.stringify({ ...operation(), state: 'prepared', authMutationStartedAt: null }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/rest/v1/rpc/service_mark_admin_mfa_reset_deleting')) {
        markCalls += 1
        durableState = 'deleting'
        return new Response(JSON.stringify(operation()), { headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(`/auth/v1/admin/users/${targetAuthUserId}/factors/${factorA}`)) {
        factorADeletes += 1
        if (factorADeletes > 1) {
          return new Response(JSON.stringify({ message: 'Factor not found' }), {
            headers: { 'content-type': 'application/json' },
            status: 404,
          })
        }
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith(`/auth/v1/admin/users/${targetAuthUserId}/factors/${factorB}`)) {
        factorBDeletes += 1
        if (factorBDeletes === 1) {
          return new Response(JSON.stringify({ message: 'Auth temporarily unavailable' }), {
            headers: { 'content-type': 'application/json' },
            status: 503,
          })
        }
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_complete_admin_mfa_reset_operation')) {
        completeCalls += 1
        durableState = 'completed'
        return new Response(JSON.stringify({ message: 'response lost after commit' }), {
          headers: { 'content-type': 'application/json' },
          status: 503,
        })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', withClearMaintenanceStatus(fetchMock))

    try {
      const makeRequest = () => new Request(
        `https://app.sygshift.example/api/v1/admin/users/${targetEmployeeId}/mfa-reset`,
        {
          body: JSON.stringify({ idempotencyKey: '60000000-0000-4000-8000-000000000031' }),
          headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
          method: 'POST',
        },
      )
      const runtime = environment(new Response('asset'), configuredEnvironment)
      const first = await worker.fetch(makeRequest(), runtime)
      const second = await worker.fetch(makeRequest(), runtime)
      const replay = await worker.fetch(makeRequest(), runtime)

      expect(first.status).toBe(409)
      expect(second.status).toBe(409)
      expect(replay.status).toBe(409)
      expect(beginCalls).toBe(0)
      expect(markCalls).toBe(0)
      expect(completeCalls).toBe(0)
      expect(factorADeletes).toBe(0)
      expect(factorBDeletes).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps scheduled factor-only MFA recovery inert until combined recovery is available', async () => {
    const actorEmployeeId = '10000000-0000-4000-8000-000000000001'
    const poisonEmployeeId = '10000000-0000-4000-8000-000000000011'
    const healthyEmployeeId = '10000000-0000-4000-8000-000000000012'
    const poisonAuthUserId = '20000000-0000-4000-8000-000000000011'
    const healthyAuthUserId = '20000000-0000-4000-8000-000000000012'
    const poisonFactorId = '30000000-0000-4000-8000-000000000011'
    const operation = (
      operationId: string,
      employeeId: string,
      authUserId: string,
      factorIds: string[],
      state: 'deleting' | 'completed' = 'deleting',
    ) => ({
      operationId,
      employeeId,
      authUserId,
      actorEmployeeId,
      factorIds,
      factorCount: factorIds.length,
      state,
      recoveryCodesRevoked: state === 'completed' ? 0 : null,
      trustedDevicesRevoked: state === 'completed' ? 0 : null,
      securityKeysRevoked: state === 'completed' ? 0 : null,
      securityKeySessionsRevoked: state === 'completed' ? 0 : null,
      preparedAt: '2026-10-24T12:00:00.000Z',
      authMutationStartedAt: '2026-10-24T12:00:01.000Z',
      completedAt: state === 'completed' ? '2026-10-24T12:00:02.000Z' : null,
      recoveryAttempts: 0,
      recoveryNextAttemptAt: '2026-10-24T12:00:00.000Z',
      recoveryLastError: null,
      recoveryQuarantinedAt: null,
    })
    const poison = operation(
      '60000000-0000-4000-8000-000000000041',
      poisonEmployeeId,
      poisonAuthUserId,
      [poisonFactorId],
    )
    const healthy = operation(
      '60000000-0000-4000-8000-000000000042',
      healthyEmployeeId,
      healthyAuthUserId,
      [],
    )
    const rpc = vi.fn(async (_config: unknown, name: string, body: Record<string, unknown>) => {
      if (name === 'service_list_admin_mfa_reset_recovery') return [poison, healthy]
      if (name === 'service_defer_admin_mfa_reset_recovery') {
        expect(body.target_operation_id).toBe(poison.operationId)
        return { ...poison, recoveryAttempts: 1 }
      }
      if (name === 'service_complete_admin_mfa_reset_operation') {
        expect(body.target_operation_id).toBe(healthy.operationId)
        return operation(healthy.operationId, healthyEmployeeId, healthyAuthUserId, [], 'completed')
      }
      throw new Error(`Unexpected RPC: ${name}`)
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith(`/auth/v1/admin/users/${poisonAuthUserId}/factors/${poisonFactorId}`)) {
        return new Response(JSON.stringify({ message: 'Auth provider unavailable' }), {
          headers: { 'content-type': 'application/json' },
          status: 503,
        })
      }
      if (url.endsWith(`/auth/v1/admin/users/${healthyAuthUserId}/factors`)) {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await recoverAdminMfaResetOperations(
        environment(new Response('asset'), configuredEnvironment),
        rpc as never,
        10,
      )

      expect(result).toEqual({ failed: 0, recovered: 0 })
      expect(rpc).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
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
    const notificationId = '20000000-0000-4000-8000-000000000001'
    const claimToken = '70000000-0000-4000-8000-000000000001'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
        employee_id: '10000000-0000-4000-8000-000000000002',
        username: 'scheduler',
        display_name: 'Schedule User',
        role: 'scheduler',
        has_mfa: true,
        permissions: ['announcements.send'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_claim_notification_batch')) {
        return new Response(JSON.stringify([{
        id: notificationId,
        claimToken,
        recipients: ['jbrown@example.com'],
        aggregateId: '30000000-0000-4000-8000-000000000001',
        aggregateType: 'announcement',
        messageType: 'announcement_email',
        message: {
          subject: 'Open shift available',
          text: 'A shift is available.',
        },
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_claim_')) {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_email_recipient_dispatch_manifest')) {
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_announcement_email_recipients')
        || url.includes('/rest/v1/rpc/service_filter_notification_recipients')) {
        return new Response(JSON.stringify(['jbrown@example.com']), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_email_recipient_dispatch_batch')) {
        return new Response(JSON.stringify([{
        dispatchId: '40000000-0000-4000-8000-000000000001',
        dispatchToken: '50000000-0000-4000-8000-000000000001',
        intendedRecipient: 'jbrown@example.com',
        sendAllowed: true,
        state: 'dispatching',
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
      }
      if (url.includes('/rest/v1/rpc/service_mark_notification_result')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        expect(body.target_claim_token).toBe(claimToken)
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
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

  it('delivers a frozen schedule notice without re-resolving current recipient preferences', async () => {
    const notificationId = '20000000-0000-4000-8000-000000000081'
    const claimToken = '70000000-0000-4000-8000-000000000081'
    const recipient = 'frozen-recipient@example.com'
    const rpc = vi.fn(async (_config: unknown, name: string, body?: Record<string, unknown>) => {
      if (name === 'service_claim_timekeeping_notification_batch'
        || name === 'service_claim_time_off_notification_batch'
        || name === 'service_claim_support_ticket_notification_batch'
        || name === 'service_claim_employee_notification_batch') return []
      if (name === 'service_claim_notification_batch') {
        return [{
          aggregateId: '30000000-0000-4000-8000-000000000081',
          aggregateType: 'schedule',
           claimToken,
          id: notificationId,
          message: {
            subject: 'Frozen schedule snapshot',
            text: 'This message was rendered when the scheduler queued it.',
          },
          messageType: 'schedule_published',
          recipientManifestFrozen: true,
          recipients: [recipient],
        }]
      }
      if (name === 'service_prepare_email_recipient_dispatch_batch') {
        return [{
          dispatchId: '40000000-0000-4000-8000-000000000081',
          dispatchToken: '50000000-0000-4000-8000-000000000081',
          intendedRecipient: recipient,
          sendAllowed: true,
          state: 'dispatching',
        }]
      }
      if (name === 'service_get_email_recipient_dispatch_manifest') return null
      if (name === 'service_complete_email_recipient_dispatch') {
        return { dispatchToken: body?.target_dispatch_token, state: body?.target_state }
      }
      if (name === 'service_mark_notification_result') {
        expect(body?.target_claim_token).toBe(claimToken)
        return { ok: true }
      }
      if (name === 'service_filter_notification_recipients') {
        throw new Error('A frozen schedule manifest must not be re-filtered against current preferences.')
      }
      throw new Error(`Unexpected RPC: ${name}`)
    })
    const emailSend = vi.fn().mockResolvedValue({ messageId: 'frozen-schedule-message' })

    const result = await processNotificationJobs(
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: emailSend },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      }),
      10,
      rpc as never,
      'all',
    )

    expect(result).toMatchObject({ delivered: [notificationId], failed: [], processed: 1 })
    expect(emailSend).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Frozen schedule snapshot',
      to: recipient,
    }))
    expect(rpc.mock.calls.some(([, name]) => name === 'service_filter_notification_recipients')).toBe(false)
  })

  it('suppresses blocked company-domain recipients and records the attempted delivery', async () => {
    const notificationId = '20000000-0000-4000-8000-000000000002'
    const claimToken = '70000000-0000-4000-8000-000000000002'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/rpc/get_session_context')) {
        return new Response(JSON.stringify({
        employee_id: '10000000-0000-4000-8000-000000000002',
        username: 'scheduler',
        display_name: 'Schedule User',
        role: 'scheduler',
        has_mfa: true,
        permissions: ['announcements.send'],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_claim_timekeeping_notification_batch')) {
        return new Response(JSON.stringify([{
        id: notificationId,
        claimToken,
        recipients: ['OPS@GUARDIANSHIPSECURITY.NET'],
        aggregateId: '30000000-0000-4000-8000-000000000002',
        aggregateType: 'call_off_report',
        messageType: 'call_off_supervisor_alert',
        message: {
          subject: 'Employee call-off reported',
          text: 'A call-off requires attention.',
        },
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_claim_')) {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_get_email_recipient_dispatch_manifest')) {
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_prepare_email_recipient_dispatch_batch')) {
        return new Response(JSON.stringify([{
        dispatchId: '40000000-0000-4000-8000-000000000002',
        dispatchToken: '50000000-0000-4000-8000-000000000002',
        intendedRecipient: 'ops@guardianshipsecurity.net',
        sendAllowed: true,
        state: 'dispatching',
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rest/v1/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
      }
      if (url.includes('/rest/v1/rpc/service_mark_notification_suppressed')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        expect(body.target_claim_token).toBe(claimToken)
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected test request: ${url}`)
    })
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
      target_intended_recipient: 'ops@guardianshipsecurity.net',
      target_state: 'suppressed',
    }))
    expect(requestBodies).toContainEqual(expect.objectContaining({
      target_notification_id: '20000000-0000-4000-8000-000000000002',
      target_reason: 'Suppressed - Blocked Domain',
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
                : url.includes('/rpc/service_reconcile_employee_push_provider_outcomes')
                  ? { reconciled: 0, disabledSubscriptions: 0, completionPending: 0, reviewRequired: 0 }
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
    expect(fetchMock).toHaveBeenCalledTimes(26)
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
      'service_reconcile_employee_push_provider_outcomes',
      'service_list_hr_document_availability_recovery',
      'service_list_client_document_upload_recovery',
      'service_list_client_document_cleanup_recovery',
      'service_list_licensing_document_availability_recovery',
      'service_list_licensing_document_cleanup_recovery',
      'service_reconcile_stale_employee_photo_uploads_v2',
      'service_reconcile_stale_signature_appearances_v2',
      'service_list_protected_storage_cleanup_v2',
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
      expect(calledUrls.some((url) => url.includes('/rpc/service_list_protected_storage_cleanup_v2')))
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      let payload: Record<string, unknown> | Record<string, unknown>[] = []
      if (url.includes('/rpc/service_run_timekeeping_automation')) {
        payload = { status: 'completed' }
      } else if (url.includes('/rpc/service_reconcile_employee_push_provider_outcomes')) {
        payload = { reconciled: 0, disabledSubscriptions: 0, completionPending: 0, reviewRequired: 0 }
      } else if (url.includes('/rpc/service_claim_timekeeping_notification_batch') && !notificationClaimed) {
        notificationClaimed = true
        payload = [{
          aggregateId: '30000000-0000-4000-8000-000000000099',
          aggregateType: 'timekeeping_event',
          claimToken: '70000000-0000-4000-8000-000000000099',
          id: notificationId,
          message: { subject: 'Timekeeping notice', text: 'Review your timecard.' },
          messageType: 'automatic_clock_out',
          recipients: ['employee@example.com'],
        }]
      } else if (url.includes('/rpc/service_prepare_email_recipient_dispatch_batch')) {
        payload = [{
          dispatchId: '40000000-0000-4000-8000-000000000099',
          dispatchToken: '50000000-0000-4000-8000-000000000099',
          intendedRecipient: 'employee@example.com',
          sendAllowed: true,
          state: 'dispatching',
        }]
      } else if (url.includes('/rpc/service_get_email_recipient_dispatch_manifest')) {
        payload = null as unknown as Record<string, unknown>
      } else if (url.includes('/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
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

  it('persists an unexpected scheduled-cycle exception before releasing the lease', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rpc/service_reconcile_patrol_obligations')) {
        throw new Error('unexpected application failure')
      }
      if (url.includes('/rpc/service_claim_')) {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: 'completed' }), { headers: { 'content-type': 'application/json' } })
    })
    const scheduledWork: Promise<unknown>[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { coordinator, namespace } = scheduledCoordinatorBinding()
    vi.stubGlobal('fetch', fetchMock)

    try {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 19, 15, 11) },
        environment(new Response('asset'), {
          ...configuredEnvironment,
          EMAIL: { send: vi.fn() },
          SCHEDULE_COORDINATOR: namespace,
        }),
        { waitUntil: (promise: Promise<unknown>) => { scheduledWork.push(promise) } },
      )
      await expect(Promise.all(scheduledWork)).resolves.toBeDefined()

      expect(coordinator.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'scheduled_cycle_unexpected',
        status: null,
        timedOut: false,
      }))
      expect(coordinator.recordFullSuccess).not.toHaveBeenCalled()
      expect(coordinator.releaseCycle).not.toHaveBeenCalled()
      expect(errorSpy.mock.calls.some(([value]) => (
        String(value).includes('"event":"scheduled_work_failed"')
        && String(value).includes('unexpected application failure')
      ))).toBe(true)
    } finally {
      errorSpy.mockRestore()
      vi.unstubAllGlobals()
    }
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rpc/service_claim_timekeeping_notification_batch')) {
        return new Response(JSON.stringify([{
          id: notificationId,
          claimToken: '70000000-0000-4000-8000-000000000098',
          messageType: 'automatic_clock_out',
          aggregateType: 'timekeeping_event',
          aggregateId: '30000000-0000-4000-8000-000000000099',
          recipients: ['employee@example.com'],
          message: { subject: 'Automatic clock-out recorded', text: 'Review your timecard.' },
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rpc/service_prepare_email_recipient_dispatch_batch')) {
        return new Response(JSON.stringify([{
          dispatchId: '40000000-0000-4000-8000-000000000099',
          dispatchToken: '50000000-0000-4000-8000-000000000099',
          intendedRecipient: 'employee@example.com',
          sendAllowed: true,
          state: 'dispatching',
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rpc/service_get_email_recipient_dispatch_manifest')) {
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
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
          claimToken: '70000000-0000-4000-8000-000000000077',
          messageType: 'automatic_clock_out',
          aggregateType: 'timekeeping_event',
          aggregateId: '30000000-0000-4000-8000-000000000077',
          recipients: ['employee@example.com'],
          message: { subject: 'Automatic clock-out recorded', text: 'Review your timecard.' },
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rpc/service_prepare_email_recipient_dispatch_batch')) {
        return new Response(JSON.stringify([{
          dispatchId: '40000000-0000-4000-8000-000000000077',
          dispatchToken: '50000000-0000-4000-8000-000000000077',
          intendedRecipient: 'employee@example.com',
          sendAllowed: true,
          state: 'dispatching',
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rpc/service_get_email_recipient_dispatch_manifest')) {
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/rpc/service_complete_email_recipient_dispatch')) {
        return emailDispatchCompletionReceipt(init)
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
      expect(coordinator.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'required_lane_failure',
        status: null,
        timedOut: false,
      }))
      expect(coordinator.releaseCycle).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('does not resend an accepted email when source-job completion fails and is retried', async () => {
    const notificationId = '20000000-0000-4000-8000-000000000088'
    let delivered = false
    let dispatchState: 'accepted' | 'dispatching' = 'dispatching'
    let dispatchCreated = false
    let markAttempts = 0
    const rpcCalls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const rpcName = url.split('/rpc/')[1] ?? ''
      rpcCalls.push(rpcName)
      if (rpcName === 'service_claim_timekeeping_notification_batch') {
        return new Response(JSON.stringify(delivered ? [] : [{
          id: notificationId,
          claimToken: '70000000-0000-4000-8000-000000000088',
          messageType: 'automatic_clock_out',
          aggregateType: 'timekeeping_event',
          aggregateId: '30000000-0000-4000-8000-000000000088',
          recipients: ['employee@example.com'],
          message: { subject: 'Automatic clock-out recorded', text: 'Review your timecard.' },
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (rpcName === 'service_prepare_email_recipient_dispatch_batch') {
        const result = {
          dispatchId: '40000000-0000-4000-8000-000000000088',
          dispatchToken: '50000000-0000-4000-8000-000000000088',
          intendedRecipient: 'employee@example.com',
          sendAllowed: !dispatchCreated,
          state: dispatchState,
        }
        dispatchCreated = true
        return new Response(JSON.stringify([result]), { headers: { 'content-type': 'application/json' } })
      }
      if (rpcName === 'service_complete_email_recipient_dispatch') {
        dispatchState = 'accepted'
        return emailDispatchCompletionReceipt(init)
      }
      if (rpcName === 'service_get_email_recipient_dispatch_manifest') {
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (rpcName === 'service_mark_notification_result') {
        const body = JSON.parse(String(init?.body)) as { delivered?: boolean }
        if (body.delivered === true && markAttempts++ === 0) {
          return new Response(JSON.stringify({ message: 'temporary completion outage' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (body.delivered === true) delivered = true
        return new Response('null', { headers: { 'content-type': 'application/json' } })
      }
      if (rpcName.startsWith('service_claim_')) {
        return new Response('[]', { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: 'completed' }), { headers: { 'content-type': 'application/json' } })
    })
    const emailSend = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', fetchMock)

    try {
      const runtime = environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: emailSend },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      })
      const first = await processNotificationJobs(runtime, 25, undefined, 'timekeeping')
      const second = await processNotificationJobs(runtime, 25, undefined, 'timekeeping')

      expect(delivered).toBe(true)
      expect(emailSend).toHaveBeenCalledTimes(1)
      expect(rpcCalls.filter((name) => name === 'service_claim_timekeeping_notification_batch')).toHaveLength(2)
      expect(first.outcomes[0]).toMatchObject({ id: notificationId, status: 'pending' })
      expect(second.outcomes[0]).toMatchObject({ id: notificationId, status: 'delivered' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not resend recipients after a partial multi-recipient provider outcome', async () => {
    const notificationId = '20000000-0000-4000-8000-000000000089'
    const states = new Map<string, 'accepted' | 'dispatching' | 'uncertain'>()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rpcName = String(input).split('/rpc/')[1] ?? ''
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (rpcName === 'service_claim_timekeeping_notification_batch') {
        return new Response(JSON.stringify([{
          id: notificationId,
          claimToken: '70000000-0000-4000-8000-000000000089',
          messageType: 'automatic_clock_out',
          aggregateType: 'timekeeping_event',
          aggregateId: '30000000-0000-4000-8000-000000000089',
          recipients: ['one@example.com', 'two@example.com'],
          message: { subject: 'Automatic clock-out recorded', text: 'Review your timecard.' },
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (rpcName === 'service_prepare_email_recipient_dispatch_batch') {
        const recipients = body.target_intended_recipients as string[]
        const decisions = recipients.map((recipient) => {
          const existing = states.get(recipient)
          if (!existing) states.set(recipient, 'dispatching')
          return {
            dispatchId: recipient.startsWith('one')
              ? '40000000-0000-4000-8000-000000000089'
              : '40000000-0000-4000-8000-000000000090',
            dispatchToken: recipient.startsWith('one')
              ? '50000000-0000-4000-8000-000000000089'
              : '50000000-0000-4000-8000-000000000090',
            intendedRecipient: recipient,
            sendAllowed: !existing,
            state: existing ?? 'dispatching',
          }
        })
        return new Response(JSON.stringify(decisions), { headers: { 'content-type': 'application/json' } })
      }
      if (rpcName === 'service_complete_email_recipient_dispatch') {
        states.set(String(body.target_intended_recipient), String(body.target_state) as 'accepted' | 'uncertain')
        return emailDispatchCompletionReceipt(init)
      }
      return new Response('null', { headers: { 'content-type': 'application/json' } })
    })
    const emailSend = vi.fn(async (message: { to: string }) => {
      expect(states.size).toBe(2)
      if (message.to === 'two@example.com') throw new TypeError('provider connection closed')
      return { messageId: 'accepted-one' }
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const runtime = environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: emailSend },
        SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
      })
      const first = await processNotificationJobs(runtime, 25, undefined, 'timekeeping')
      const second = await processNotificationJobs(runtime, 25, undefined, 'timekeeping')

      expect(first.outcomes[0]).toMatchObject({
        status: 'pending',
        recipients: { accepted: 1, uncertain: 1 },
      })
      expect(second.outcomes[0]).toMatchObject({
        status: 'pending',
        recipients: { accepted: 1, uncertain: 1 },
      })
      expect(emailSend).toHaveBeenCalledTimes(2)
      expect(emailSend.mock.calls.filter(([message]) => message.to === 'one@example.com')).toHaveLength(1)
      expect(emailSend.mock.calls.filter(([message]) => message.to === 'two@example.com')).toHaveLength(1)
    } finally {
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
    expect(coordinator.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'required_lane_failure',
      status: null,
      timedOut: false,
    }))
    expect(coordinator.releaseCycle).not.toHaveBeenCalled()

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

  it('reconciles only exact stale client upload objects and preserves mismatches', async () => {
    const exactBytes = new TextEncoder().encode('exact client document')
    const exactChecksum = createHash('sha256').update(exactBytes).digest('hex')
    const missingChecksum = 'b'.repeat(64)
    const mismatchChecksum = 'c'.repeat(64)
    const rpcCalls: Array<{ body: Record<string, unknown>, name: string }> = []
    const rpc = vi.fn(async (_config: unknown, name: string, body: Record<string, unknown>) => {
      rpcCalls.push({ body, name })
      if (name === 'service_list_client_document_upload_recovery') {
        return [
          {
            actorId: '10000000-0000-4000-8000-000000000001',
            bucket: 'client-documents',
            checksum: exactChecksum,
            documentId: '20000000-0000-4000-8000-000000000001',
            objectKey: 'client/exact.pdf',
            sizeBytes: exactBytes.byteLength,
          },
          {
            actorId: '10000000-0000-4000-8000-000000000002',
            bucket: 'client-documents',
            checksum: missingChecksum,
            documentId: '20000000-0000-4000-8000-000000000002',
            objectKey: 'client/missing.pdf',
            sizeBytes: 12,
          },
          {
            actorId: '10000000-0000-4000-8000-000000000003',
            bucket: 'client-documents',
            checksum: mismatchChecksum,
            documentId: '20000000-0000-4000-8000-000000000003',
            objectKey: 'client/mismatch.pdf',
            sizeBytes: 8,
          },
        ]
      }
      if (name === 'service_reconcile_client_document_upload_failure') {
        return {
          bucket: 'client-documents',
          byteSize: 12,
          checksum: missingChecksum,
          cleanupAllowed: true,
          documentId: '20000000-0000-4000-8000-000000000002',
          objectKey: 'client/missing.pdf',
          state: 'failed',
        }
      }
      return { state: 'stored' }
    }) as unknown as Parameters<typeof recoverClientDocumentAvailability>[1]
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      expect(init?.method ?? 'GET').toBe('GET')
      if (url.endsWith('/client/exact.pdf')) return new Response(exactBytes)
      if (url.endsWith('/client/missing.pdf')) return new Response('missing', { status: 404 })
      if (url.endsWith('/client/mismatch.pdf')) return new Response('mismatch')
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await recoverClientDocumentAvailability(
        environment(new Response('asset'), configuredEnvironment),
        rpc,
      )

      expect(result).toEqual({ deferred: 1, failed: 1, recovered: 1 })
      expect(rpcCalls.filter(({ name }) => name === 'service_complete_client_document_upload')).toHaveLength(1)
      expect(rpcCalls.filter(({ name }) => name === 'service_reconcile_client_document_upload_failure')).toHaveLength(1)
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries only exact cleanup-pending client objects and confirms missing cleanup', async () => {
    const exactBytes = new TextEncoder().encode('rejected client document')
    const exactChecksum = createHash('sha256').update(exactBytes).digest('hex')
    const missingChecksum = 'd'.repeat(64)
    const mismatchChecksum = 'e'.repeat(64)
    const rpcCalls: Array<{ body: Record<string, unknown>, name: string }> = []
    const rpc = vi.fn(async (_config: unknown, name: string, body: Record<string, unknown>) => {
      rpcCalls.push({ body, name })
      if (name === 'service_list_client_document_cleanup_recovery') {
        return [
          {
            actorId: '10000000-0000-4000-8000-000000000011',
            bucket: 'client-documents',
            checksum: exactChecksum,
            documentId: '20000000-0000-4000-8000-000000000011',
            objectKey: 'client/exact-cleanup.pdf',
            sizeBytes: exactBytes.byteLength,
          },
          {
            actorId: '10000000-0000-4000-8000-000000000012',
            bucket: 'client-documents',
            checksum: missingChecksum,
            documentId: '20000000-0000-4000-8000-000000000012',
            objectKey: 'client/missing-cleanup.pdf',
            sizeBytes: 12,
          },
          {
            actorId: '10000000-0000-4000-8000-000000000013',
            bucket: 'client-documents',
            checksum: mismatchChecksum,
            documentId: '20000000-0000-4000-8000-000000000013',
            objectKey: 'client/mismatch-cleanup.pdf',
            sizeBytes: 8,
          },
          {
            actorId: '10000000-0000-4000-8000-000000000014',
            bucket: 'client-documents',
            checksum: exactChecksum,
            documentId: '20000000-0000-4000-8000-000000000014',
            objectKey: '../invalid-client-cleanup.pdf',
            sizeBytes: exactBytes.byteLength,
          },
        ]
      }
      return { state: 'failed' }
    }) as unknown as Parameters<typeof recoverClientDocumentCleanup>[1]
    const deleted: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE') {
        deleted.push(url)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/client/exact-cleanup.pdf')) return new Response(exactBytes)
      if (url.endsWith('/client/missing-cleanup.pdf')) return new Response('missing', { status: 404 })
      if (url.endsWith('/client/mismatch-cleanup.pdf')) return new Response('mismatch')
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await recoverClientDocumentCleanup(
        environment(new Response('asset'), configuredEnvironment),
        rpc,
      )

      expect(result).toEqual({ cleaned: 2, deferred: 2, failed: 1 })
      expect(deleted).toHaveLength(1)
      expect(deleted[0]).toContain('/client/exact-cleanup.pdf')
      expect(rpcCalls.filter(({ name }) => name === 'service_complete_client_document_cleanup')).toHaveLength(2)
      expect(rpcCalls.filter(({ name }) => name === 'service_defer_client_document_cleanup')).toHaveLength(2)
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('invalid-client-cleanup'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('recovers credential and submission uploads only after exact scheduled storage verification', async () => {
    const exactBytes = new TextEncoder().encode('verified licensing document')
    const exactChecksum = createHash('sha256').update(exactBytes).digest('hex')
    const credentialDocumentId = '20000000-0000-4000-8000-000000000031'
    const submissionDocumentId = '20000000-0000-4000-8000-000000000032'
    const missingDocumentId = '20000000-0000-4000-8000-000000000033'
    const mismatchDocumentId = '20000000-0000-4000-8000-000000000034'
    const unknownDocumentId = '20000000-0000-4000-8000-000000000035'
    const invalidDocumentId = '20000000-0000-4000-8000-000000000036'
    const policyRejectedDocumentId = '20000000-0000-4000-8000-000000000037'
    const candidate = (documentId: string, objectKey: string, checksum = exactChecksum, sizeBytes = exactBytes.byteLength) => ({
      actorId: '10000000-0000-4000-8000-000000000031',
      bucket: 'credential-documents',
      checksum,
      documentId,
      objectKey,
      sizeBytes,
    })
    const rpcCalls: Array<{ body: Record<string, unknown>, name: string }> = []
    const rpc = vi.fn(async (_config: unknown, name: string, body: Record<string, unknown>) => {
      rpcCalls.push({ body, name })
      if (name === 'service_list_licensing_document_availability_recovery') {
        return [
          candidate(credentialDocumentId, `employee/credential/${credentialDocumentId}.pdf`),
          candidate(submissionDocumentId, `employee/submissions/submission/${submissionDocumentId}.png`),
          candidate(missingDocumentId, `employee/credential/${missingDocumentId}.pdf`, 'a'.repeat(64), 12),
          candidate(mismatchDocumentId, `employee/credential/${mismatchDocumentId}.pdf`, 'b'.repeat(64), 8),
          candidate(unknownDocumentId, `employee/credential/${unknownDocumentId}.pdf`, 'c'.repeat(64), 8),
          { ...candidate(invalidDocumentId, `employee/credential/${invalidDocumentId}.pdf`), bucket: 'unexpected-bucket' },
          candidate(policyRejectedDocumentId, `employee/submissions/closed/${policyRejectedDocumentId}.pdf`),
        ]
      }
      if (name === 'service_complete_licensing_document_upload_recovery'
        && body.target_document_id === policyRejectedDocumentId) {
        return {
          bucket: 'credential-documents',
          byteSize: exactBytes.byteLength,
          checksum: exactChecksum,
          cleanupAllowed: true,
          documentId: policyRejectedDocumentId,
          objectKey: `employee/submissions/closed/${policyRejectedDocumentId}.pdf`,
          state: 'failed',
        }
      }
      return { state: name.includes('complete') ? 'stored' : 'failed' }
    }) as unknown as Parameters<typeof recoverLicensingDocumentAvailability>[1]
    const deleted: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE') {
        deleted.push(url)
        return new Response(null, { status: 204 })
      }
      if (url.includes(credentialDocumentId) || url.includes(submissionDocumentId) || url.includes(policyRejectedDocumentId)) return new Response(exactBytes)
      if (url.includes(missingDocumentId)) return new Response('missing', { status: 404 })
      if (url.includes(mismatchDocumentId)) return new Response('mismatch')
      if (url.includes(unknownDocumentId)) return new Response('unavailable', { status: 503 })
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await recoverLicensingDocumentAvailability(
        environment(new Response('asset'), configuredEnvironment),
        rpc,
      )

      expect(result).toEqual({ cleaned: 3, deferred: 1, failed: 2, recovered: 2 })
      expect(rpcCalls.filter(({ name }) => name === 'service_complete_licensing_document_upload_recovery')).toHaveLength(3)
      expect(rpcCalls.filter(({ name }) => name === 'service_fail_licensing_document_upload_recovery')).toHaveLength(2)
      expect(rpcCalls.filter(({ name }) => name === 'service_complete_licensing_document_cleanup')).toHaveLength(3)
      expect(deleted).toHaveLength(2)
      expect(deleted.some((url) => url.includes(mismatchDocumentId))).toBe(true)
      expect(deleted.some((url) => url.includes(policyRejectedDocumentId))).toBe(true)
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes(invalidDocumentId))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries only exact cleanup-pending licensing objects and confirms missing cleanup', async () => {
    const exactBytes = new TextEncoder().encode('rejected licensing document')
    const exactChecksum = createHash('sha256').update(exactBytes).digest('hex')
    const missingChecksum = 'a'.repeat(64)
    const mismatchChecksum = 'b'.repeat(64)
    const rpcCalls: Array<{ body: Record<string, unknown>, name: string }> = []
    const rpc = vi.fn(async (_config: unknown, name: string, body: Record<string, unknown>) => {
      rpcCalls.push({ body, name })
      if (name === 'service_list_licensing_document_cleanup_recovery') {
        return [
          {
            actorId: '10000000-0000-4000-8000-000000000021',
            bucket: 'credential-documents',
            checksum: exactChecksum,
            documentId: '20000000-0000-4000-8000-000000000021',
            objectKey: 'licensing/exact-cleanup.pdf',
            sizeBytes: exactBytes.byteLength,
          },
          {
            actorId: '10000000-0000-4000-8000-000000000022',
            bucket: 'credential-documents',
            checksum: missingChecksum,
            documentId: '20000000-0000-4000-8000-000000000022',
            objectKey: 'licensing/missing-cleanup.pdf',
            sizeBytes: 12,
          },
          {
            actorId: '10000000-0000-4000-8000-000000000023',
            bucket: 'credential-documents',
            checksum: mismatchChecksum,
            documentId: '20000000-0000-4000-8000-000000000023',
            objectKey: 'licensing/mismatch-cleanup.pdf',
            sizeBytes: 8,
          },
          {
            actorId: '10000000-0000-4000-8000-000000000024',
            bucket: 'unexpected-bucket',
            checksum: exactChecksum,
            documentId: '20000000-0000-4000-8000-000000000024',
            objectKey: 'licensing/wrong-bucket.pdf',
            sizeBytes: exactBytes.byteLength,
          },
        ]
      }
      return { state: 'failed' }
    }) as unknown as Parameters<typeof recoverLicensingDocumentCleanup>[1]
    const deleted: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE') {
        deleted.push(url)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/licensing/exact-cleanup.pdf')) return new Response(exactBytes)
      if (url.endsWith('/licensing/missing-cleanup.pdf')) return new Response('missing', { status: 404 })
      if (url.endsWith('/licensing/mismatch-cleanup.pdf')) return new Response('mismatch')
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await recoverLicensingDocumentCleanup(
        environment(new Response('asset'), configuredEnvironment),
        rpc,
      )

      expect(result).toEqual({ cleaned: 2, deferred: 2, failed: 1 })
      expect(deleted).toHaveLength(1)
      expect(deleted[0]).toContain('/licensing/exact-cleanup.pdf')
      expect(rpcCalls.filter(({ name }) => name === 'service_complete_licensing_document_cleanup')).toHaveLength(2)
      expect(rpcCalls.filter(({ name }) => name === 'service_defer_licensing_document_cleanup')).toHaveLength(2)
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('wrong-bucket'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
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
