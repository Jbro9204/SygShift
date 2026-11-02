import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminEmailRequestError, adminEmailRequestReference, sendEmployeeLoginEmail, sendEmployeeWelcomeEmail } from './adminUsers'

vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: 'local-test-token' } }, error: null }),
} }) }))
vi.mock('../lib/identityVerificationCoordinator', async (original) => ({
  ...await original<typeof import('../lib/identityVerificationCoordinator')>(),
  fetchWithIdentityVerification: (request: () => Promise<Response>) => request(),
}))

const id = '10000000-0000-4000-8000-000000000001'
const requestId = '20000000-0000-4000-8000-000000000001'
const fetch = vi.fn()
beforeEach(() => { fetch.mockReset(); vi.stubGlobal('fetch', fetch) })
afterEach(() => vi.unstubAllGlobals())

describe('employee email request results', () => {
  it('retains the exact valid request reference without exposing raw failure detail', async () => {
    fetch.mockResolvedValue(Response.json({ error: 'admin_user_request_failed', detail: 'SQL private credentials and provider body MUST NOT DISPLAY', requestId }, { status: 500 }))
    const error = await sendEmployeeLoginEmail(id).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(AdminEmailRequestError)
    expect(error).toMatchObject({ requestId, code: 'admin_user_request_failed', status: 500 })
    expect((error as Error).message).toContain(`Request ${requestId}.`)
    expect((error as Error).message).not.toContain('SQL')
    expect((error as Error).message).not.toContain('provider body')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('uses a valid response-header reference when JSON has no valid reference', async () => {
    fetch.mockResolvedValue(Response.json({ error: 'provider_secret_do_not_display', detail: 'private payload', requestId: '<script>bad</script>' }, { status: 502, headers: { 'x-request-id': requestId } }))
    const error = await sendEmployeeLoginEmail(id).catch((failure: unknown) => failure) as AdminEmailRequestError
    expect(error.requestId).toBe(requestId)
    expect(error.code).toBeNull()
    expect(error.message).not.toMatch(/script|provider_secret|private payload/)
  })
  it.each(['', 'not-an-id', '<img src=x>', 'a'.repeat(1000)])('does not surface invalid request reference %s', async (bad) => {
    expect(adminEmailRequestReference(bad)).toBeNull()
    fetch.mockResolvedValue(Response.json({ error: 'admin_user_request_failed', requestId: bad }, { status: 500 }))
    const error = await sendEmployeeLoginEmail(id).catch((failure: unknown) => failure) as AdminEmailRequestError
    expect(error.requestId).toBeNull()
    expect(error.message).not.toContain('Request ')
  })
  it.each([
    ['employee_personal_email_required', 'approved personal email'],
    ['email_recipient_suppressed', 'delivery safeguards'],
    ['invalid_temporary_password', 'must be text'],
    ['temporary_password_rejected', 'security requirements'],
    ['admin_mfa_required', 'Verify MFA'],
    ['new_user_invites_permission_required', 'New User Invites permission'],
  ])('keeps known safe validation and verification response %s readable', async (code, message) => {
    fetch.mockResolvedValue(Response.json({ error: code, detail: 'untrusted replacement body', requestId }, { status: 403 }))
    await expect(sendEmployeeLoginEmail(id)).rejects.toThrow(message)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['target_lookup', 'auth_lookup', 'auth_create', 'auth_update', 'account_link', 'email'])(
    'retains the approved safe stage code %s without claiming account preparation or delivery', async (stage) => {
      const code = `login_instructions_${stage}_failed`
      fetch.mockResolvedValue(Response.json({ error: code, stage, detail: 'provider says token=SECRET', requestId }, { status: 502 }))
      const error = await sendEmployeeLoginEmail(id).catch((failure: unknown) => failure) as AdminEmailRequestError
      expect(error.code).toBe(code)
      expect(error.requestId).toBe(requestId)
      expect(error.message).not.toMatch(/SECRET|provider says|successfully|was created|was delivered/)
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )
  it('preserves the single-employee endpoint and requested password without adding implicit retries or identity writes', async () => {
    fetch.mockResolvedValue(Response.json({ requestId, action: 'created_auth_user', username: 'local.test', displayName: 'Local Test', email: 'local@example.invalid' }))
    await expect(sendEmployeeLoginEmail(id, ' approved existing input ')).resolves.toMatchObject({ requestId, username: 'local.test' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [path, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(`/api/v1/admin/users/${id}/login-email`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ temporaryPassword: 'approved existing input' })
  })
  it('keeps a malformed successful response uncertain rather than reporting confirmed acceptance', async () => {
    fetch.mockResolvedValue(Response.json({ unrecognized: true }, { headers: { 'x-request-id': requestId } }))
    const error = await sendEmployeeLoginEmail(id).catch((failure: unknown) => failure) as AdminEmailRequestError
    expect(error).toBeInstanceOf(AdminEmailRequestError)
    expect(error.message).toContain('Email acceptance could not be verified')
    expect(error.requestId).toBe(requestId)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('does not mistake a request reference alone for accepted email delivery', async () => {
    fetch.mockResolvedValue(Response.json({ requestId }))
    await expect(sendEmployeeLoginEmail(id)).rejects.toThrow('Email acceptance could not be verified')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves only the exact published temporary-password validation messages', async () => {
    fetch.mockResolvedValueOnce(Response.json({ requestId, error: 'temporary_password_rejected', detail: 'Use at least 12 characters. Add a symbol.' }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ requestId, error: 'temporary_password_rejected', detail: 'Provider token=SECRET' }, { status: 422 }))
    await expect(sendEmployeeLoginEmail(id)).rejects.toThrow('Use at least 12 characters. Add a symbol.')
    await expect(sendEmployeeLoginEmail(id)).rejects.not.toThrow('SECRET')
  })
  it('keeps welcome delivery separate and applies the same safe request-reference handling', async () => {
    fetch.mockResolvedValueOnce(Response.json({ requestId, username: 'local.test', displayName: 'Local Test', email: 'local@example.invalid' }))
      .mockResolvedValueOnce(Response.json({ error: 'email_delivery_failed', detail: 'raw provider failure', requestId }, { status: 502 }))
    await expect(sendEmployeeWelcomeEmail(id)).resolves.toMatchObject({ requestId })
    const error = await sendEmployeeWelcomeEmail(id).catch((failure: unknown) => failure) as AdminEmailRequestError
    expect(error.requestId).toBe(requestId)
    expect(error.message).not.toContain('raw provider failure')
    expect(fetch.mock.calls.every(([path]) => path === `/api/v1/admin/users/${id}/welcome-email`)).toBe(true)
  })
})
