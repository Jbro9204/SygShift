import { describe, expect, it, vi } from 'vitest'
import worker, {
  brandedEmailHtml,
  buildLoginInstructionsEmail,
  buildWelcomeEmail,
  protectedMaintenanceWindow,
  validateSuppliedTemporaryPassword,
} from '../worker'

function environment(response: Response = new Response('asset'), values: Record<string, unknown> = {}) {
  return { ASSETS: { fetch: vi.fn().mockResolvedValue(response) }, ...values }
}

const configuredEnvironment = {
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  SUPABASE_URL: 'https://example.supabase.co',
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
    expect(response.headers.get('permissions-policy')).toContain('camera=()')
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
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

    expect(response.status).toBe(200)
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

  it('runs the idempotent timekeeping job before processing scheduled notifications', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobRunId: 'generated-by-worker',
        status: 'completed',
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed',
        fullReconciliation: false,
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }))
    const emailSend = vi.fn()
    let scheduledWork: Promise<unknown> | undefined
    vi.stubGlobal('fetch', fetchMock)

    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.UTC(2026, 7, 18, 18, 0) },
      environment(new Response('asset'), {
        ...configuredEnvironment,
        EMAIL: { send: emailSend },
      }),
      { waitUntil: (promise: Promise<unknown>) => { scheduledWork = promise } },
    )

    expect(scheduledWork).toBeDefined()
    await scheduledWork
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/rpc/service_run_timekeeping_automation')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/rpc/service_reconcile_operational_alert_lifecycle')
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/rpc/service_claim_timekeeping_notification_batch')
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/rpc/service_claim_notification_batch')
    const automationBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { target_job_run_id: string }
    const lifecycleBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { target_full_reconciliation: boolean }
    expect(automationBody.target_job_run_id).toMatch(/^[a-f0-9-]{36}$/)
    expect(lifecycleBody.target_full_reconciliation).toBe(false)
    expect(emailSend).not.toHaveBeenCalled()
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
