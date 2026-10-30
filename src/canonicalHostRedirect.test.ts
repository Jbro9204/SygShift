import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import worker from '../worker'

function environment(
  response: Response = new Response('asset'),
  values: Record<string, unknown> = {},
): Partial<Env> & { ASSETS: Fetcher } {
  return {
    ASSETS: { fetch: vi.fn().mockResolvedValue(response) },
    SYGSHIFT_PUBLIC_APP_URL: 'https://app.sygilant.us',
    ...values,
  } as unknown as Partial<Env> & { ASSETS: Fetcher }
}

function documentNavigation(url: string, method: 'GET' | 'HEAD' = 'GET') {
  return new Request(url, {
    headers: {
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
    },
    method,
  })
}

describe('canonical production host redirect', () => {
  it('runs application navigations through the Worker before the SPA asset fallback', () => {
    const configuration = JSON.parse(readFileSync('wrangler.jsonc', 'utf8')) as {
      assets?: { run_worker_first?: string[] }
    }
    const routes = configuration.assets?.run_worker_first

    expect(routes).toContain('/*')
    expect(routes).toContain('!/assets/*')
    expect(routes).toContain('!/notification-sw.js')
  })

  it.each(['GET', 'HEAD'] as const)(
    'moves an exact legacy production %s document navigation to the canonical host without losing path or query',
    async (method) => {
      const runtime = environment()
      const response = await worker.fetch(
        documentNavigation(
          'https://sygshift.sygilant.workers.dev/time/my?from=2026-10-04&through=2026-10-17',
          method,
        ),
        runtime,
      )

      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe(
        'https://app.sygilant.us/time/my?from=2026-10-04&through=2026-10-17',
      )
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('vary')).toContain('Sec-Fetch-Dest')
      expect(response.headers.get('vary')).toContain('Sec-Fetch-Mode')
      expect(runtime.ASSETS.fetch).not.toHaveBeenCalled()
    },
  )

  it('leaves API health probes on the legacy Worker host instead of redirecting them', async () => {
    const runtime = environment()
    const response = await worker.fetch(
      documentNavigation('https://sygshift.sygilant.workers.dev/api/v1/health'),
      runtime,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok', service: 'sygshift', version: 'v1' })
    expect(response.headers.get('location')).toBeNull()
    expect(runtime.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('redirects an older browser document request that only advertises HTML', async () => {
    const runtime = environment()
    const response = await worker.fetch(
      new Request('https://sygshift.sygilant.workers.dev/login', {
        headers: { accept: 'text/html,application/xhtml+xml' },
      }),
      runtime,
    )

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('https://app.sygilant.us/login')
    expect(runtime.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('keeps a protocol-relative-looking path on the canonical host', async () => {
    const runtime = environment()
    const response = await worker.fetch(
      documentNavigation('https://sygshift.sygilant.workers.dev//untrusted.example/login?return=%2Fschedule'),
      runtime,
    )

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe(
      'https://app.sygilant.us//untrusted.example/login?return=%2Fschedule',
    )
    expect(runtime.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['asset request', 'https://sygshift.sygilant.workers.dev/assets/index.js', { 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors' }],
    ['non-navigation release probe', 'https://sygshift.sygilant.workers.dev/', {}],
    ['version-preview navigation', 'https://candidate-sygshift.sygilant.workers.dev/login', { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }],
  ])('keeps the %s on its requested host', async (_name, url, headers) => {
    const runtime = environment(new Response('release-check-asset'))
    const request = new Request(url, { headers })
    const response = await worker.fetch(request, runtime)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('release-check-asset')
    expect(response.headers.get('location')).toBeNull()
    expect(runtime.ASSETS.fetch).toHaveBeenCalledWith(request)
  })

  it.each([
    'http://app.sygilant.us',
    'https://app.sygilant.us:8443',
    'https://app.sygilant.us/redirect-base',
    'https://app.sygilant.us.evil.example',
    'https://user@app.sygilant.us',
  ])('fails closed instead of redirecting through an invalid configured public URL: %s', async (configuredUrl) => {
    const runtime = environment(new Response('asset'), { SYGSHIFT_PUBLIC_APP_URL: configuredUrl })
    const request = documentNavigation('https://sygshift.sygilant.workers.dev/login?return=%2Fschedule')
    const response = await worker.fetch(request, runtime)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('asset')
    expect(response.headers.get('location')).toBeNull()
    expect(runtime.ASSETS.fetch).toHaveBeenCalledWith(request)
  })
})
