interface AssetBinding {
  fetch(request: Request): Promise<Response>
}

interface Environment {
  ASSETS: AssetBinding
}

const jsonHeaders = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
} as const

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: jsonHeaders })
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/v1/health' && request.method === 'GET') {
      return json({ status: 'ok', service: 'sygshift', version: 'v1' })
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'not_found' }, 404)
    }

    return environment.ASSETS.fetch(request)
  },
}
