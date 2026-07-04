import { describe, expect, it, vi } from 'vitest'
import worker, { validateSuppliedTemporaryPassword } from '../worker'

function environment(response: Response = new Response('asset'), values: Record<string, string> = {}) {
  return { ASSETS: { fetch: vi.fn().mockResolvedValue(response) }, ...values }
}

const configuredEnvironment = {
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  SUPABASE_URL: 'https://example.supabase.co',
}

describe('Cloudflare Worker boundary', () => {
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

  it('validates admin-supplied temporary passwords before sending them to authentication', () => {
    expect(validateSuppliedTemporaryPassword('short', 'jbrown')).toContain('Use at least 12 characters.')
    expect(validateSuppliedTemporaryPassword('jbrownStrong!234', 'jbrown')).toContain('Do not include the username.')
    expect(validateSuppliedTemporaryPassword('Strong!Pass234', 'jbrown')).toEqual([])
  })
})
