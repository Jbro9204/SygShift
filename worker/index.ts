interface AssetBinding {
  fetch(request: Request): Promise<Response>
}

interface Environment {
  ASSETS: AssetBinding
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "img-src 'self' data: blob: https://*.supabase.co",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  'upgrade-insecure-requests',
].join('; ')

const baseSecurityHeaders = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'x-robots-tag': 'noindex, nofollow, noarchive',
} as const

function isLocalDevelopment(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function json(payload: unknown, status = 200, additionalHeaders?: HeadersInit): Response {
  const headers = new Headers(additionalHeaders)
  headers.set('cache-control', 'no-store')
  headers.set('content-type', 'application/json; charset=utf-8')
  return Response.json(payload, { status, headers })
}

export function secureResponse(request: Request, response: Response, requestId: string): Response {
  const headers = new Headers(response.headers)
  const url = new URL(request.url)

  for (const [name, value] of Object.entries(baseSecurityHeaders)) headers.set(name, value)
  headers.set('x-request-id', requestId)

  if (!isLocalDevelopment(url.hostname)) {
    headers.set('content-security-policy', contentSecurityPolicy)
    if (url.protocol === 'https:') {
      headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload')
    }
  }

  if (headers.get('content-type')?.includes('text/html')) {
    headers.set('cache-control', 'no-store')
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url)
    const requestId = crypto.randomUUID()
    let response: Response

    if (url.pathname === '/api/v1/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response = json(
          { error: 'method_not_allowed', requestId },
          405,
          { allow: 'GET, HEAD' },
        )
      } else {
        response = json({ status: 'ok', service: 'sygshift', version: 'v1' })
        if (request.method === 'HEAD') {
          response = new Response(null, { headers: response.headers, status: response.status })
        }
      }
    } else if (url.pathname.startsWith('/api/')) {
      response = json({ error: 'not_found', requestId }, 404)
    } else {
      response = await environment.ASSETS.fetch(request)
    }

    return secureResponse(request, response, requestId)
  },
}
