import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker'

const employeeId = '20000000-0000-4000-8000-000000000002'
const operationId = '40000000-0000-4000-8000-000000000001'
const authUserId = '10000000-0000-4000-8000-000000000002'
const actorId = '20000000-0000-4000-8000-000000000001'
const password = 'A9!onlySyntheticPass'
const operation = { operationId, employeeId, authUserId, username: 'testguard', status: 'prepared', providerWriteAllowed: true, requireChangeAtNextLogin: true, expiresAt: null }
const input = { confirmationUsername: 'testguard', password, requireChangeAtNextLogin: true, reason: 'Approved individual password assignment.' }
const token = (age = 0) => `test.${btoa(JSON.stringify({ sub: actorId, session_id: '30000000-0000-4000-8000-000000000001', aal: 'aal2', exp: Math.floor(Date.now() / 1000) + 3600, amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) - age }] }))}.test`

function fixture(options: { enabled?: boolean, canaryId?: string, permission?: boolean, mfa?: boolean, providerStatus?: number, repeat?: boolean, existing?: boolean, missingReader?: boolean, readFailure?: boolean } = {}) {
  const send = vi.fn()
  const rpcPayloads: Record<string, unknown>[] = []
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    if (path.includes('/rpc/get_session_context_emergency')) return Response.json({
      employee_id: actorId, username: 'testadmin', role: 'admin', has_mfa: options.mfa !== false,
      active: true, emergencyAccessEnforced: true, emergencyAccessState: 'active', authSessionActive: true, accessGeneration: 1,
      permissions: options.permission === false ? ['admin.users.invite'] : ['admin.users.password_reset'],
    })
    if (path.includes('/rpc/get_maintenance_status')) return Response.json({ active: [], upcoming: [], recentlyCompleted: [] })
    if (path.includes('/rpc/service_begin_employee_password_set')) {
      rpcPayloads.push(JSON.parse(String(init?.body)))
      return Response.json(options.repeat ? { ...operation, status: 'confirmed', providerWriteAllowed: false } : operation)
    }
    if (path.endsWith(`/auth/v1/admin/users/${authUserId}`)) return options.providerStatus
      ? Response.json({ message: `Synthetic private detail ${password}` }, { status: options.providerStatus })
      : Response.json({ id: authUserId, app_metadata: { sygshift_password_set_operation_id: operationId } })
    if (path.includes('/rpc/service_finish_employee_password_set')) {
      const body = JSON.parse(String(init?.body))
      rpcPayloads.push(body)
      return Response.json({ ...operation, providerWriteAllowed: false, status: body.target_payload.outcome === 'confirmed' ? 'confirmed' : body.target_payload.outcome === 'known_failed' ? 'known_failed' : 'uncertain' })
    }
    if (path.includes('/rpc/service_get_employee_password_set')) {
      if (options.missingReader) return Response.json({ code: 'PGRST202', message: 'Synthetic missing reader' }, { status: 404 })
      if (options.readFailure) return Response.json({ code: '57014', message: 'Synthetic query timeout' }, { status: 500 })
      return Response.json(options.existing ? { ...operation, status: 'uncertain', providerWriteAllowed: false, providerUpdateVerified: true } : null)
    }
    if (path.includes('/rpc/service_cancel_employee_password_set')) {
      rpcPayloads.push(JSON.parse(String(init?.body)))
      return Response.json({ ...operation, status: 'canceled', providerWriteAllowed: false })
    }
    if (path.includes('/rpc/service_verify_security_key_document_mfa')) return Response.json({ method: 'security_key', verifiedAt: new Date(Date.now() - 10 * 60_000).toISOString() })
    throw new Error('Unexpected synthetic request')
  })
  vi.stubGlobal('fetch', fetch)
  const env = { ASSETS: { fetch: vi.fn() }, EMAIL: { send }, SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ...(options.enabled !== false ? { SYGSHIFT_ADMIN_SET_PASSWORD_ENABLED: 'true' } : {}), ...(options.canaryId ? { SYGSHIFT_ADMIN_SET_PASSWORD_CANARY_EMPLOYEE_ID: options.canaryId } : {}) } as unknown as Parameters<typeof worker.fetch>[1]
  return { fetch, send, rpcPayloads, run: (method = 'POST', body: unknown = input, age = 0) => worker.fetch(new Request(`https://app.sygshift.example/api/v1/admin/users/${employeeId}/password`, { method, headers: { authorization: `Bearer ${token(age)}`, 'content-type': 'application/json', 'idempotency-key': operationId, ...(age ? { 'x-sygshift-security-key': 'synthetic-expired-proof' } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) }), env) }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('canonical Admin-set password endpoint', () => {
  it('sets exactly the selected password without unban, factor changes, expiry or email', async () => {
    const local = fixture()
    const response = await local.run()
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ passwordChanged: true, noEmailSent: true, operation: { expiresAt: null } })
    expect(JSON.stringify(result)).not.toContain(password)
    const call = local.fetch.mock.calls.find(([url]) => String(url).endsWith(`/auth/v1/admin/users/${authUserId}`))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ password, app_metadata: { sygshift_password_set_operation_id: operationId } })
    expect(local.rpcPayloads.length).toBe(2)
    expect(JSON.stringify(local.rpcPayloads)).not.toContain(password)
    expect(local.send).not.toHaveBeenCalled()
  })
  it('keeps disabled feature and reads nonmutating', async () => {
    const local = fixture({ enabled: false })
    expect((await local.run('GET')).status).toBe(200)
    expect((await local.run()).status).toBe(503)
    expect(local.fetch.mock.calls.some(([url]) => String(url).includes('/auth/v1/admin/'))).toBe(false)
    expect(local.rpcPayloads).toHaveLength(0)
  })

  it('narrows new assignments and enabled status to the configured canary employee', async () => {
    for (const canaryId of ['20000000-0000-4000-8000-000000000099', 'invalid-canary']) {
      const denied = fixture({ canaryId })
      expect(await (await denied.run('GET')).json()).toMatchObject({ enabled: false })
      expect((await denied.run()).status).toBe(503)
      expect(denied.fetch.mock.calls.some(([url]) => String(url).includes('/auth/v1/admin/'))).toBe(false)
      expect(denied.rpcPayloads).toHaveLength(0)
    }
    const allowed = fixture({ canaryId: employeeId })
    expect(await (await allowed.run('GET')).json()).toMatchObject({ enabled: true })
    expect((await allowed.run()).status).toBe(200)
  })

  it('keeps resolution available for a prior request outside the current canary', async () => {
    const local = fixture({ canaryId: '20000000-0000-4000-8000-000000000099', existing: true })
    const response = await local.run('POST', { action: 'confirm', operationId, confirmationUsername: 'testguard', reason: input.reason })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ enabled: false, passwordChanged: true })
    expect(local.fetch.mock.calls.some(([url]) => String(url).includes('/auth/v1/admin/'))).toBe(false)
  })

  it('keeps existing status and explicit completion available when new assignments are disabled', async () => {
    const local = fixture({ enabled: false, existing: true })
    const read = await local.run('GET')
    expect(await read.json()).toMatchObject({ enabled: false, latestOperation: { status: 'uncertain' } })
    const confirmed = await local.run('POST', { action: 'confirm', operationId, confirmationUsername: 'testguard', reason: input.reason })
    expect(confirmed.status).toBe(200)
    expect(await confirmed.json()).toMatchObject({ enabled: false, passwordChanged: true })
    expect(local.fetch.mock.calls.some(([url]) => String(url).includes('/auth/v1/admin/'))).toBe(false)
  })

  it('keeps protected cancellation available while new assignments are disabled', async () => {
    const local = fixture({ enabled: false })
    const result = await local.run('POST', { action: 'cancel', operationId, confirmationUsername: 'testguard', reason: input.reason })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ enabled: false, passwordChanged: false, operation: { status: 'canceled' } })
    expect(local.fetch.mock.calls.some(([url]) => String(url).includes('/auth/v1/admin/'))).toBe(false)
  })

  it('tolerates only a missing staged reader while disabled, never a real read failure', async () => {
    const absent = fixture({ enabled: false, missingReader: true })
    expect(await (await absent.run('GET')).json()).toMatchObject({ enabled: false, latestOperation: null })
    const failure = fixture({ enabled: false, readFailure: true })
    expect((await failure.run('GET')).status).toBe(500)
  })
  it('denies missing dedicated permission and MFA without touching credentials', async () => {
    const local = fixture({ permission: false })
    expect((await local.run()).status).toBe(403)
    expect(local.rpcPayloads).toHaveLength(0)
    expect(local.fetch.mock.calls.some(([url]) => String(url).includes('/auth/v1/admin/'))).toBe(false)
  })
  it('rejects stale verification before creating an operation', async () => {
    const local = fixture()
    expect((await local.run('POST', input, 600)).status).toBe(403)
    expect(local.rpcPayloads).toHaveLength(0)
  })
  it('does not retry a completed request or send a different supplied password', async () => {
    const local = fixture({ repeat: true })
    expect((await local.run()).status).toBe(200)
    expect(local.fetch.mock.calls.some(([url]) => String(url).includes('/auth/v1/admin/'))).toBe(false)
  })
  it('preserves truthful uncertain and known-rejected outcomes without provider detail', async () => {
    for (const status of [500, 422]) {
      const local = fixture({ providerStatus: status })
      const response = await local.run()
      expect(response.status).toBe(409)
      const result = await response.text()
      expect(result).not.toContain(password)
      expect(result).toContain(status === 500 ? 'uncertain' : 'known_failed')
      expect(local.send).not.toHaveBeenCalled()
    }
  })
})
