import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker'

const actorId = '10000000-0000-4000-8000-000000000001'
const applicationId = '10000000-0000-4000-8000-000000000002'
const sessionId = '10000000-0000-4000-8000-000000000003'
const environment = {
  ASSETS: { fetch: vi.fn() },
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service',
  SUPABASE_URL: 'https://example.supabase.co',
  SYGSHIFT_HR_ONBOARDING_ENABLED: 'true',
  SYGSHIFT_HR_RECRUITING_ENABLED: 'true',
} as unknown as Parameters<typeof worker.fetch>[1]

type WorkforceRole = 'guard' | 'dispatcher' | 'scheduler' | 'recruiting_licensing' | 'supervisor' | 'admin'

function authorizedRequest(path: string, body: Record<string, unknown>) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const claims = {
    aal: 'aal2',
    amr: [{ method: 'totp', timestamp: nowSeconds }],
    session_id: sessionId,
  }
  return new Request(`https://app.sygshift.example${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer test.${btoa(JSON.stringify(claims))}.test`,
      'content-type': 'application/json',
    },
    method: 'POST',
  })
}

function candidateConversion(role: WorkforceRole) {
  return authorizedRequest('/api/v1/hr/recruiting/conversions', {
    applicationId,
    employmentType: 'hourly',
    jobTitle: 'Security Officer',
    reason: 'Convert the accepted candidate.',
    role,
    startDate: '2026-10-15',
    timeZone: 'America/Denver',
  })
}

function onboardingPrehire(role?: WorkforceRole) {
  return authorizedRequest('/api/v1/hr/onboarding/prehires', {
    payload: {
      firstName: 'New',
      lastName: 'Employee',
      personalEmail: 'new.employee@example.invalid',
      positionTitle: 'Security Officer',
      ...(role ? { role } : {}),
      startDate: '2026-10-15',
      timeZone: 'America/Denver',
    },
    reason: 'Create the approved pre-hire.',
  })
}

function installTransport(actorRole: WorkforceRole, permissions: string[]) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const endpoint = String(url)
    if (endpoint.endsWith('/get_session_context')) {
      return Response.json({ employee_id: actorId, has_mfa: true, permissions, role: actorRole })
    }
    if (endpoint.endsWith('/service_has_required_action_checkpoint')) return Response.json(false)
    if (endpoint.endsWith('/service_verify_recent_hr_mfa')) {
      return Response.json({ method: 'authenticator', verifiedAt: new Date().toISOString() })
    }
    if (endpoint.endsWith('/service_request_candidate_conversion')) {
      return Response.json({ conversionRequestId: applicationId, status: 'pending_review' })
    }
    if (endpoint.endsWith('/service_hr_onboarding_create_prehire')) {
      return Response.json({ action: 'launch_case', caseId: applicationId })
    }
    throw new Error(`Unexpected request: ${endpoint}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('alternate workforce-role assignment boundaries', () => {
  it.each([
    ['candidate conversion', candidateConversion('supervisor')],
    ['onboarding pre-hire', onboardingPrehire('supervisor')],
  ])('rejects a non-Guard %s role without Manage roles permission', async (_label, request) => {
    const fetchMock = installTransport('supervisor', ['hr.recruiting.manage', 'hr.onboarding.manage'])

    const response = await worker.fetch(request, environment)

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'permission_required' })
    expect(fetchMock.mock.calls.some(([url]) => /service_(request_candidate_conversion|hr_onboarding_create_prehire)$/.test(String(url)))).toBe(false)
  })

  it.each([
    ['candidate conversion', candidateConversion('admin')],
    ['onboarding pre-hire', onboardingPrehire('admin')],
  ])('reserves the Admin role in %s for an actual primary Admin', async (_label, request) => {
    const fetchMock = installTransport('supervisor', ['hr.recruiting.manage', 'hr.onboarding.manage', 'admin.roles.manage'])

    const response = await worker.fetch(request, environment)

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'primary_admin_required' })
    expect(fetchMock.mock.calls.some(([url]) => /service_(request_candidate_conversion|hr_onboarding_create_prehire)$/.test(String(url)))).toBe(false)
  })

  it.each([
    ['candidate conversion', candidateConversion('guard'), 'service_request_candidate_conversion'],
    ['onboarding pre-hire', onboardingPrehire('guard'), 'service_hr_onboarding_create_prehire'],
  ])('keeps Guard creation available through existing %s permission', async (_label, request, rpcName) => {
    const fetchMock = installTransport('guard', ['hr.recruiting.manage', 'hr.onboarding.manage'])

    const response = await worker.fetch(request, environment)

    expect(response.status).toBeLessThan(300)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/${rpcName}`))).toBe(true)
  })

  it('defaults an omitted onboarding role to Guard without changing a supplied role', async () => {
    const fetchMock = installTransport('guard', ['hr.onboarding.manage'])

    const response = await worker.fetch(onboardingPrehire(), environment)

    expect(response.status).toBe(201)
    const request = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/service_hr_onboarding_create_prehire'))
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ target_payload: { role: 'guard' } })
  })
})
