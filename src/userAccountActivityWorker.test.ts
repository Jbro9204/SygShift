import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker'
import { userAccountActivityReportFixture } from './test/userAccountActivityFixtures'

const employeeId = '10000000-0000-4000-8000-000000000001'
const sessionId = '20000000-0000-4000-8000-000000000001'
const token = `header.${btoa(JSON.stringify({ session_id: sessionId }))}.signature`
const configuration: Record<string, unknown> = {
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  SUPABASE_URL: 'https://example.supabase.co',
}
const environment = { ASSETS: { fetch: vi.fn() }, ...configuration }
const catalog = [
  { name: 'Guard', base_app_role: 'guard', system_role: true, active: true, protected: true },
  { name: 'Recruiting Licensing', base_app_role: 'recruiting_licensing', system_role: true, active: true, protected: true },
  { name: 'Chief', base_app_role: 'supervisor', system_role: false, active: true, protected: true },
  { name: 'Human Resources Manager', base_app_role: null, system_role: false, active: true, protected: true },
  { name: 'Audit & QA', base_app_role: null, system_role: false, active: true, protected: false },
  { name: 'Retired role', base_app_role: null, system_role: false, active: false, protected: false },
]
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function mockApi({ permissions = ['reports.account_activity.view'], mfa = true, reportAllowed = true, roles = catalog } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/get_session_context')) return json({ employee_id: employeeId, role: 'guard', has_mfa: true, permissions })
    if (url.pathname.endsWith('/service_verify_recent_hr_mfa')) return json(mfa ? { method: 'security_key', verifiedAt: new Date().toISOString() } : null)
    if (url.pathname.endsWith('/service_get_user_account_activity_report')) return reportAllowed ? json(userAccountActivityReportFixture({ roleOptions: undefined })) : json({ message: 'Report permission denied.' }, 403)
    if (url.pathname === '/rest/v1/access_roles') {
      expect(url.searchParams.get('select')).toBe('name,base_app_role,system_role')
      expect(url.searchParams.get('active')).toBe('eq.true')
      expect(url.searchParams.has('protected')).toBe(false)
      const offset = Number(url.searchParams.get('offset'))
      const limit = Number(url.searchParams.get('limit'))
      return json(roles.filter((role) => role.active).slice(offset, offset + limit).map(({ name, base_app_role, system_role }) => ({ name, base_app_role, system_role })))
    }
    throw new Error(`Unexpected test request: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function request(query = '', authenticated = true) {
  return new Request(`https://app.sygshift.example/api/v1/reports/user-account-activity${query}`, {
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('User Account Activity protected role options', () => {
  it('gives report-only viewers active Chief, custom, and protected roles without access-control privileges', async () => {
    const fetchMock = mockApi()
    const response = await worker.fetch(request('?role=Chief'), environment)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json() as { roleOptions: unknown }).roleOptions).toEqual([
      { value: 'Guard', label: 'Guard', baseRole: 'guard' },
      { value: 'Recruiting Licensing', label: 'Recruiting Licensing', baseRole: 'recruiting_licensing' },
      { value: 'Chief', label: 'Chief', baseRole: null },
      { value: 'Human Resources Manager', label: 'Human Resources Manager', baseRole: null },
      { value: 'Audit & QA', label: 'Audit & QA', baseRole: null },
    ])
    const reportCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/service_get_user_account_activity_report'))
    const catalogCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/rest/v1/access_roles?'))
    expect(reportCall).toBeDefined()
    expect(catalogCall).toBeDefined()
    expect(fetchMock.mock.calls.indexOf(reportCall!)).toBeLessThan(fetchMock.mock.calls.indexOf(catalogCall!))
  })

  it('pages the role catalog independently of employee results', async () => {
    const roles = Array.from({ length: 101 }, (_, index) => ({ name: `Custom ${index}`, base_app_role: null, system_role: false, active: true, protected: false }))
    const fetchMock = mockApi({ roles })
    const response = await worker.fetch(request(), environment)
    const payload = await response.json() as { roleOptions: Array<{ value: string }>; rows: unknown[] }
    expect(payload.rows).toEqual([])
    expect(payload.roleOptions).toHaveLength(101)
    expect(payload.roleOptions[100].value).toBe('Custom 100')
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/rest/v1/access_roles?'))).toHaveLength(2)
  })

  it('uses exact system-role names so one filter includes primary and additional memberships', async () => {
    const fetchMock = mockApi()
    const response = await worker.fetch(request('?role=Recruiting+Licensing'), environment)
    expect(response.status).toBe(200)
    const reportCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/service_get_user_account_activity_report'))
    expect(JSON.parse(String(reportCall?.[1]?.body))).toMatchObject({ target_role: 'Recruiting Licensing' })
    const payload = await response.json() as { roleOptions: Array<{ value: string; baseRole: string | null }> }
    expect(payload.roleOptions).toContainEqual({
      value: 'Recruiting Licensing',
      label: 'Recruiting Licensing',
      baseRole: 'recruiting_licensing',
    })
  })

  it('deduplicates colliding role names case-insensitively before rendering', async () => {
    const roles = [
      ...catalog,
      { name: 'chief', base_app_role: null, system_role: false, active: true, protected: false },
      { name: 'Chief', base_app_role: null, system_role: false, active: true, protected: false },
    ]
    mockApi({ roles })
    const response = await worker.fetch(request(), environment)
    expect(response.status).toBe(200)
    const payload = await response.json() as { roleOptions: Array<{ value: string }> }
    expect(payload.roleOptions.filter((option) => option.value.toLowerCase() === 'chief')).toHaveLength(1)
  })

  it.each([
    { label: 'unauthenticated', authenticated: false, permissions: ['reports.account_activity.view'], mfa: true, reportAllowed: true },
    { label: 'missing report permission', authenticated: true, permissions: ['admin.roles.view'], mfa: true, reportAllowed: true },
    { label: 'expired MFA', authenticated: true, permissions: ['reports.account_activity.view'], mfa: false, reportAllowed: true },
    { label: 'database report rejection', authenticated: true, permissions: ['reports.account_activity.view'], mfa: true, reportAllowed: false },
  ])('does not read or expose the catalog when $label', async ({ authenticated, ...options }) => {
    const fetchMock = mockApi(options)
    const response = await worker.fetch(request('', authenticated), environment)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.json()).not.toHaveProperty('roleOptions')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/access_roles?'))).toBe(false)
  })

  it('retains the separate export permission boundary', async () => {
    const fetchMock = mockApi()
    expect((await worker.fetch(request('?export=true&role=Chief'), environment)).status).toBe(403)
    expect(fetchMock.mock.calls.some(([url]) => /service_get_user_account_activity_report|access_roles/.test(String(url)))).toBe(false)
  })

  it('exports the exact selected role through the existing audited RPC without an extra catalog dependency', async () => {
    const fetchMock = mockApi({ permissions: ['reports.account_activity.view', 'reports.account_activity.export'] })
    const response = await worker.fetch(request('?export=true&role=Audit+%26+QA'), environment)
    expect(response.status).toBe(200)
    const reportCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/service_get_user_account_activity_report'))
    expect(JSON.parse(String(reportCall?.[1]?.body))).toMatchObject({ target_role: 'Audit & QA', target_export: true, target_actor_id: employeeId })
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/access_roles?'))).toBe(false)
  })
})
