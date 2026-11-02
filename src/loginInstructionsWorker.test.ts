import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker'

const employeeId = '10000000-0000-4000-8000-000000000010'
const authUserId = '20000000-0000-4000-8000-000000000010'
const otherAuthUserId = '20000000-0000-4000-8000-000000000099'
const fixturePassword = 'A9!syntheticFixtureXq'
const privateProviderDetail = 'private-provider-detail invitee@private.example A9!not-for-logs'

function loginTarget(overrides: Record<string, unknown> = {}) {
  return {
    employeeId,
    username: 'invitee',
    authEmail: 'invitee@accounts.sygshift.invalid',
    contactEmail: 'invitee@example.net',
    displayName: 'Synthetic Invitee',
    requiresMfa: false,
    role: 'guard',
    employmentType: 'hourly',
    status: 'active',
    existingAuthUserId: null,
    ...overrides,
  }
}

type Stage = 'target_lookup' | 'auth_lookup' | 'auth_create' | 'auth_update' | 'account_link' | 'email'
type ProviderHook = () => Response | Promise<Response>

function harness(options: {
  target?: unknown
  targets?: unknown
  hasMfa?: boolean
  permissions?: string[]
  hooks?: Partial<Record<Stage | 'audit', ProviderHook>>
  sendError?: Error
} = {}) {
  const send = options.sendError ? vi.fn().mockRejectedValue(options.sendError) : vi.fn().mockResolvedValue({ messageId: 'fixture-email' })
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/rpc/get_maintenance_status')) return Response.json({
      active: [], recentlyCompleted: [], upcoming: [], serverTime: '2026-11-02T21:14:59.000Z',
    })
    if (url.includes('/rpc/get_session_context_emergency')) return Response.json({
      accessGeneration: 1,
      active: true,
      authSessionActive: true,
      emergencyAccessEnforced: true,
      emergencyAccessState: 'active',
      employee_id: '10000000-0000-4000-8000-000000000001',
      username: 'fixture-invitation-manager',
      display_name: 'Fixture Invitation Manager',
      role: 'admin',
      has_mfa: options.hasMfa ?? true,
      permissions: options.permissions ?? ['admin.users.invite'],
    })
    if (url.includes('/rpc/service_get_employee_login_email_target')) {
      if (options.hooks?.target_lookup) return options.hooks.target_lookup()
      return Response.json(url.includes('email_targets') ? options.targets ?? [loginTarget()] : options.target === undefined ? loginTarget() : options.target)
    }
    if (url.includes('/auth/v1/admin/users?')) return options.hooks?.auth_lookup?.() ?? Response.json({ users: [] })
    if (url.endsWith('/auth/v1/admin/users') && init?.method === 'POST') return options.hooks?.auth_create?.() ?? Response.json({
      id: authUserId, email: 'invitee@accounts.sygshift.invalid',
    })
    if (url.endsWith(`/auth/v1/admin/users/${authUserId}`) && init?.method === 'PUT') return options.hooks?.auth_update?.() ?? Response.json({
      id: authUserId, email: 'invitee@accounts.sygshift.invalid',
    })
    if (url.includes('/rpc/service_link_employee_auth_account')) return options.hooks?.account_link?.() ?? Response.json({
      id: employeeId, account: { authUserId },
    })
    if (url.includes('/rpc/service_log_email_delivery')) return options.hooks?.audit?.() ?? Response.json({ ok: true })
    throw new Error('Unexpected synthetic provider request.')
  })
  vi.stubGlobal('fetch', fetch)
  const env = {
    ASSETS: { fetch: vi.fn() },
    EMAIL: { send },
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role',
    SYGSHIFT_EMAIL_FROM: 'scheduling@sygilant.us',
    SYGSHIFT_SOURCE_COMMIT: 'a'.repeat(40),
  } as unknown as Parameters<typeof worker.fetch>[1]
  return {
    fetch,
    send,
    async run(bulk = false, body: unknown = { temporaryPassword: fixturePassword }) {
      const response = await worker.fetch(new Request(`https://app.sygshift.example/api/v1/admin/users/${bulk ? 'login-emails' : `${employeeId}/login-email`}`, {
        body: JSON.stringify(body), headers: { authorization: 'Bearer fixture-admin-token' }, method: 'POST',
      }), env)
      return { response, payload: await response.json() as Record<string, unknown> }
    },
  }
}

let warnings: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function expectStageFailure(result: Awaited<ReturnType<ReturnType<typeof harness>['run']>>, stage: Stage, status = 502) {
  expect(result.response.status).toBe(status)
  expect(result.payload).toMatchObject({ error: `login_instructions_${stage}_failed`, stage })
  expect(result.payload.requestId).toBe(result.response.headers.get('x-request-id'))
  expect(result.payload.requestId).toMatch(/^[0-9a-f-]{36}$/)
  expect(result.payload).not.toHaveProperty('accountPrepared')
  expect(JSON.stringify(result.payload)).not.toContain(privateProviderDetail)
  expect(JSON.stringify(warnings.mock.calls)).not.toContain(privateProviderDetail)
  expect(JSON.stringify(warnings.mock.calls)).not.toContain(fixturePassword)
}

describe('login-instructions preparation and sanitized failure contracts', () => {
  it('creates, validates, links and emails one synthetic new login in order', async () => {
    const local = harness()
    const { response, payload } = await local.run()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ action: 'created_auth_user', username: 'invitee' })
    const calls = local.fetch.mock.calls.map(([input]) => String(input))
    expect(calls.findIndex((url) => url.includes('/auth/v1/admin/users?'))).toBeLessThan(calls.findIndex((url) => url.endsWith('/auth/v1/admin/users')))
    expect(calls.findIndex((url) => url.endsWith('/auth/v1/admin/users'))).toBeLessThan(calls.findIndex((url) => url.includes('/rpc/service_link_employee_auth_account')))
    const create = local.fetch.mock.calls.find(([input]) => String(input).endsWith('/auth/v1/admin/users'))
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({ email: 'invitee@accounts.sygshift.invalid', password: fixturePassword, email_confirm: true })
    expect(local.send).toHaveBeenCalledTimes(1)
    expect(local.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'invitee@example.net' }))
    expect(JSON.stringify(payload)).not.toContain(fixturePassword)
    expect(warnings).not.toHaveBeenCalled()
  })

  it('reports the exact Auth-list failure without creating, linking, or sending', async () => {
    const local = harness({ hooks: { auth_lookup: () => Response.json({ code: 500, error_code: 'unexpected_failure', msg: privateProviderDetail }, { status: 500 }) } })
    const result = await local.run()

    expectStageFailure(result, 'auth_lookup')
    expect(local.fetch.mock.calls.filter(([input]) => String(input).includes('/auth/v1/admin/users?'))).toHaveLength(1)
    expect(local.fetch.mock.calls.some(([input]) => String(input).endsWith('/auth/v1/admin/users'))).toBe(false)
    expect(local.fetch.mock.calls.some(([input]) => String(input).includes('/rpc/service_link_employee_auth_account'))).toBe(false)
    expect(local.send).not.toHaveBeenCalled()
    expect(JSON.parse(String(warnings.mock.calls[0]?.[0]))).toMatchObject({ event: 'login_instructions_failed', stage: 'auth_lookup', upstreamCode: 'unexpected_failure', upstreamStatus: 500 })
  })

  it.each([null, { users: null }, { users: [{ id: 'not-an-auth-id' }] }])('rejects a malformed Auth directory before changing an account: %j', async (directory) => {
    const local = harness({ hooks: { auth_lookup: () => Response.json(directory) } })
    const result = await local.run()

    expectStageFailure(result, 'auth_lookup')
    expect(local.send).not.toHaveBeenCalled()
    expect(local.fetch.mock.calls.some(([input]) => String(input).endsWith('/auth/v1/admin/users'))).toBe(false)
  })

  it.each([
    loginTarget({ authEmail: null }),
    loginTarget({ requiresMfa: undefined }),
    loginTarget({ employeeId: '10000000-0000-4000-8000-000000000099' }),
  ])('rejects invalid or mismatched target data before Auth calls', async (target) => {
    const local = harness({ target })
    const result = await local.run()

    expectStageFailure(result, 'target_lookup')
    expect(local.fetch.mock.calls.some(([input]) => String(input).includes('/auth/v1/'))).toBe(false)
    expect(local.send).not.toHaveBeenCalled()
  })

  it.each([
    { status: 422, payload: { code: 422, error_code: 'weak_password', msg: privateProviderDetail } },
    { status: 500, payload: { code: 500, error_code: 'unexpected_failure', msg: privateProviderDetail } },
  ])('classifies an Auth-create rejection without exposing provider detail: $status', async ({ status, payload }) => {
    const local = harness({ hooks: { auth_create: () => Response.json(payload, { status }) } })
    const result = await local.run()

    expectStageFailure(result, 'auth_create')
    expect(local.fetch.mock.calls.some(([input]) => String(input).includes('/rpc/service_link_employee_auth_account'))).toBe(false)
    expect(local.send).not.toHaveBeenCalled()
  })

  it.each([
    { id: 'not-an-auth-id', email: 'invitee@accounts.sygshift.invalid' },
    { id: authUserId, email: 'another@accounts.sygshift.invalid' },
    null,
  ])('does not link an unverified Auth-create response', async (created) => {
    const local = harness({ hooks: { auth_create: () => Response.json(created) } })
    const result = await local.run()

    expectStageFailure(result, 'auth_create')
    expect(local.fetch.mock.calls.some(([input]) => String(input).includes('/rpc/service_link_employee_auth_account'))).toBe(false)
    expect(local.send).not.toHaveBeenCalled()
  })

  it('rejects an existing-account identity mismatch without linking or creating another account', async () => {
    const local = harness({ target: loginTarget({ existingAuthUserId: authUserId }), hooks: { auth_update: () => Response.json({ id: otherAuthUserId }) } })
    const result = await local.run()

    expectStageFailure(result, 'auth_update')
    expect(local.fetch.mock.calls.some(([input]) => String(input).endsWith('/auth/v1/admin/users'))).toBe(false)
    expect(local.fetch.mock.calls.some(([input]) => String(input).includes('/rpc/service_link_employee_auth_account'))).toBe(false)
    expect(local.send).not.toHaveBeenCalled()
  })

  it('preserves a legacy email when the authoritative existing Auth identity matches', async () => {
    const local = harness({ target: loginTarget({ existingAuthUserId: authUserId }), hooks: { auth_update: () => Response.json({ id: authUserId, email: 'another@accounts.sygshift.invalid' }) } })
    const { response, payload } = await local.run()

    expect(response.status).toBe(200)
    expect(payload.action).toBe('updated_existing_auth_user')
    const update = local.fetch.mock.calls.find(([input]) => String(input).endsWith(`/auth/v1/admin/users/${authUserId}`))
    expect(JSON.parse(String(update?.[1]?.body))).not.toHaveProperty('email')
    expect(local.fetch.mock.calls.some(([input]) => String(input).includes('/rpc/service_link_employee_auth_account'))).toBe(true)
    expect(local.send).toHaveBeenCalledTimes(1)
  })

  it('retains the explicit existing-account setup path after verifying the returned identity', async () => {
    const local = harness({ target: loginTarget({ existingAuthUserId: authUserId }) })
    const { response, payload } = await local.run()

    expect(response.status).toBe(200)
    expect(payload.action).toBe('updated_existing_auth_user')
    const updates = local.fetch.mock.calls.filter(([input]) => String(input).endsWith(`/auth/v1/admin/users/${authUserId}`))
    expect(updates).toHaveLength(1)
    expect(JSON.parse(String(updates[0]?.[1]?.body))).not.toHaveProperty('email')
    expect(local.send).toHaveBeenCalledTimes(1)
  })

  it('reports a link failure without retrying Auth or claiming account preparation succeeded', async () => {
    const local = harness({ hooks: { account_link: () => Response.json({ code: '23505', message: privateProviderDetail }, { status: 409 }) } })
    const result = await local.run()

    expectStageFailure(result, 'account_link')
    expect(local.fetch.mock.calls.filter(([input]) => String(input).endsWith('/auth/v1/admin/users'))).toHaveLength(1)
    expect(local.fetch.mock.calls.filter(([input]) => String(input).includes('/rpc/service_link_employee_auth_account'))).toHaveLength(1)
    expect(local.send).not.toHaveBeenCalled()
  })

  it.each(['provider', 'audit'] as const)('does not claim email delivery or automatically resend after an %s failure', async (failure) => {
    const local = harness(failure === 'provider'
      ? { sendError: new Error(privateProviderDetail) }
      : { hooks: { audit: () => Response.json({ code: '42501', message: privateProviderDetail }, { status: 403 }) } })
    const result = await local.run()

    expectStageFailure(result, 'email')
    expect(result.payload.detail).toContain('could not be confirmed')
    expect(local.send).toHaveBeenCalledTimes(1)
    expect(local.fetch.mock.calls.filter(([input]) => String(input).endsWith('/auth/v1/admin/users'))).toHaveLength(1)
  })

  it('attaches the same safe stage contract to bulk item failures', async () => {
    const local = harness({ hooks: { auth_lookup: () => Response.json({ code: 500, error_code: 'unexpected_failure', msg: privateProviderDetail }, { status: 500 }) } })
    const { response, payload } = await local.run(true, {})

    expect(response.status).toBe(200)
    expect(payload.sent).toEqual([])
    expect(payload.failures).toEqual([expect.objectContaining({ code: 'login_instructions_auth_lookup_failed', stage: 'auth_lookup', requestId: payload.requestId, username: 'invitee' })])
    expect(JSON.stringify(payload)).not.toContain(privateProviderDetail)
    expect(local.send).not.toHaveBeenCalled()
  })

  it('memoizes a failed Auth lookup only within each bulk request without repeating the outage for every target', async () => {
    const local = harness({
      targets: [loginTarget(), loginTarget({
        employeeId: '10000000-0000-4000-8000-000000000011',
        username: 'secondinvitee',
        authEmail: 'secondinvitee@accounts.sygshift.invalid',
        contactEmail: 'secondinvitee@example.net',
        displayName: 'Second Synthetic Invitee',
      })],
      hooks: { auth_lookup: () => Response.json({ code: 500, error_code: 'unexpected_failure', msg: privateProviderDetail }, { status: 500 }) },
    })
    const { response, payload } = await local.run(true, {})

    expect(response.status).toBe(200)
    expect(payload.sent).toEqual([])
    expect(payload.failures).toEqual([
      expect.objectContaining({ code: 'login_instructions_auth_lookup_failed', stage: 'auth_lookup', requestId: payload.requestId, username: 'invitee' }),
      expect.objectContaining({ code: 'login_instructions_auth_lookup_failed', stage: 'auth_lookup', requestId: payload.requestId, username: 'secondinvitee' }),
    ])
    expect(JSON.stringify(payload)).not.toContain(privateProviderDetail)
    expect(local.fetch.mock.calls.filter(([input]) => String(input).includes('/auth/v1/admin/users?'))).toHaveLength(1)
    expect(local.fetch.mock.calls.some(([input]) => String(input).endsWith('/auth/v1/admin/users'))).toBe(false)
    expect(local.fetch.mock.calls.some(([input]) => String(input).includes('/rpc/service_link_employee_auth_account'))).toBe(false)
    expect(local.send).not.toHaveBeenCalled()

    await local.run(true, {})
    expect(local.fetch.mock.calls.filter(([input]) => String(input).includes('/auth/v1/admin/users?'))).toHaveLength(2)
    expect(local.send).not.toHaveBeenCalled()
  })

  it('rejects a malformed later bulk target before preparing or emailing the first valid target', async () => {
    const local = harness({ targets: [loginTarget(), loginTarget({ employeeId: 'not-an-employee-id', username: undefined })] })
    const result = await local.run(true, {})

    expectStageFailure(result, 'target_lookup')
    expect(local.fetch.mock.calls.some(([input]) => String(input).includes('/auth/v1/'))).toBe(false)
    expect(local.fetch.mock.calls.some(([input]) => String(input).includes('/rpc/service_link_employee_auth_account'))).toBe(false)
    expect(local.send).not.toHaveBeenCalled()
  })

  it('does not treat an untrusted error-code string as safe log metadata', async () => {
    const local = harness({ hooks: { auth_lookup: () => Response.json({ code: 500, error_code: privateProviderDetail, msg: privateProviderDetail }, { status: 500 }) } })
    const result = await local.run()

    expectStageFailure(result, 'auth_lookup')
    expect(JSON.parse(String(warnings.mock.calls[0]?.[0]))).toMatchObject({ upstreamCode: null })
  })

  it.each([
    { hasMfa: false, permissions: ['admin.users.invite'], error: 'admin_mfa_required' },
    { hasMfa: true, permissions: ['schedule.self.view'], error: 'new_user_invites_permission_required' },
  ])('retains the existing authorization boundary: $error', async ({ hasMfa, permissions, error }) => {
    const local = harness({ hasMfa, permissions })
    const { response, payload } = await local.run()

    expect(response.status).toBe(403)
    expect(payload.error).toBe(error)
    expect(payload).not.toHaveProperty('stage')
    expect(local.fetch).toHaveBeenCalledTimes(1)
    expect(local.send).not.toHaveBeenCalled()
    expect(warnings).not.toHaveBeenCalled()
  })
})
