import { describe, expect, it, vi } from 'vitest'
import worker from '../worker'

function environment(response: Response = new Response('asset')) {
  return { ASSETS: { fetch: vi.fn().mockResolvedValue(response) } }
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
})
