import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker'
import { responseRequiresIdentityVerification } from './lib/identityVerificationCoordinator'

const actorId = '10000000-0000-4000-8000-000000000001'
const sessionId = '10000000-0000-4000-8000-000000000002'
function environment(values: Record<string, unknown>) {
  return { ASSETS: { fetch: vi.fn() }, ...values }
}
const env = environment({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service',
  SYGSHIFT_DOCUMENT_PIPELINE_ENABLED: 'true' as const,
})
function request(endpoint: string, key: string | null = 'test-key', recentTotp = false) {
  const claims = { session_id: sessionId, aal: recentTotp ? 'aal2' : 'aal1',
    amr: recentTotp ? [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] : [] }
  const headers = new Headers({ authorization: `Bearer test.${btoa(JSON.stringify(claims))}.test` })
  if (key) headers.set('x-sygshift-security-key', key)
  return new Request(`https://app.sygshift.example/api/v1/hr/documents/${endpoint}`, { headers })
}
function installTransport(verification: () => Response, permitted = true, workspace: Record<string, unknown> = { summary: { documents: 537 } }) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/get_session_context')) return Response.json({
      employee_id: actorId, has_mfa: true, role: 'admin',
      permissions: permitted ? ['documents.workspace.view', 'hr.documents.view'] : [],
    })
    if (String(url).endsWith('/service_verify_security_key_document_mfa')) return verification()
    if (String(url).endsWith('/service_verify_recent_hr_mfa')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { target_method?: string, target_verified_at?: string }
      return body.target_method === 'authenticator' && body.target_verified_at
        ? Response.json({ method: 'authenticator', verifiedAt: body.target_verified_at })
        : verification()
    }
    if (String(url).endsWith('/service_get_document_studio_workspace')) return Response.json(workspace)
    if (String(url).endsWith('/service_get_signature_policy_options')) return Response.json([{ id: '10000000-0000-4000-8000-000000000099', active: true }])
    if (String(url).endsWith('/service_get_hr_document_workspace')) return Response.json({ documents: [], pagination: { totalCount: 537 } })
    throw new Error('Unexpected request')
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
afterEach(() => vi.unstubAllGlobals())

describe.each(['studio', 'workspace'])('Document %s verification boundary', (endpoint) => {
  it('turns a stale FIDO denial into the existing verification popup trigger, without reading documents', async () => {
    const fetchMock = installTransport(() => Response.json(null))
    const response = await worker.fetch(request(endpoint), env)
    expect(response.status).toBe(403)
    expect(await responseRequiresIdentityVerification(response)).toBe(true)
    expect(await response.json()).toMatchObject({ error: 'recent_hr_mfa_required' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('accepts fresh FIDO evidence and resumes the authorized read', async () => {
    installTransport(() => Response.json({ method: 'security_key', verifiedAt: new Date().toISOString() }))
    const response = await worker.fetch(request(endpoint), env)
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).toContain('537')
  })
  if (endpoint === 'studio') it('loads active signing-policy choices for an authorized requester', async () => {
    const fetchMock = installTransport(
      () => Response.json({ method: 'security_key', verifiedAt: new Date().toISOString() }),
      true,
      { permissions: { canRequestSignatures: true }, policies: [] },
    )
    const response = await worker.fetch(request(endpoint), env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ policies: [{ active: true }] })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it('accepts recent authenticator evidence without requiring FIDO', async () => {
    const fetchMock = installTransport(() => { throw new Error('FIDO should not be called') })
    expect((await worker.fetch(request(endpoint, null, true), env)).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it('requests verification when no recent factor is supplied', async () => {
    const fetchMock = installTransport(() => Response.json(null))
    const response = await worker.fetch(request(endpoint, null), env)
    expect(await responseRequiresIdentityVerification(response)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it.each([
    [503, 'unavailable', 'Database unavailable'],
    [403, '42501', 'Service role required.'],
  ])('does not disguise infrastructure/configuration failures as MFA (%s)', async (status, code, message) => {
    installTransport(() => Response.json({ code, message }, { status }))
    const response = await worker.fetch(request(endpoint), env)
    expect(response.status).toBe(500)
    expect(await responseRequiresIdentityVerification(response)).toBe(false)
    expect(await response.text()).not.toContain(message)
  })
  it('does not turn missing permissions into a verification opportunity', async () => {
    const fetchMock = installTransport(() => { throw new Error('Not authorized') }, false)
    const response = await worker.fetch(request(endpoint), env)
    expect(response.status).toBe(403)
    expect(await responseRequiresIdentityVerification(response)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('denies unauthenticated requests', async () => {
    expect((await worker.fetch(new Request(`https://app.sygshift.example/api/v1/hr/documents/${endpoint}`), env)).status).toBe(401)
  })
})
