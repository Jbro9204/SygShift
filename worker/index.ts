interface AssetBinding {
  fetch(request: Request): Promise<Response>
}

interface Environment {
  ASSETS: AssetBinding
  SUPABASE_URL?: string
  SUPABASE_PUBLISHABLE_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string
}

interface SessionContext {
  employee_id: string
  username: string
  display_name: string
  role: 'guard' | 'supervisor' | 'admin'
  has_mfa: boolean
}

interface AuthTarget {
  employeeId: string
  username: string
  authEmail: string
  displayName: string
  role: 'guard' | 'supervisor' | 'admin'
  employmentType: 'hourly' | 'salary'
  status: 'active' | 'leave' | 'inactive' | 'separated'
  existingAuthUserId: string | null
}

interface AuthUser {
  id: string
  email?: string
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

function errorJson(error: string, requestId: string, status: number, detail?: string): Response {
  return json(detail ? { error, detail, requestId } : { error, requestId }, status)
}

function configuredSupabase(environment: Environment) {
  const url = environment.SUPABASE_URL?.trim() || environment.VITE_SUPABASE_URL?.trim()
  const publishableKey = environment.SUPABASE_PUBLISHABLE_KEY?.trim() || environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url || !publishableKey || !serviceRoleKey) return null
  return { publishableKey, serviceRoleKey, url: url.replace(/\/+$/, '') }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {}
  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Request body must be a JSON object.')
  }
  return payload as Record<string, unknown>
}

async function supabaseJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  let payload: unknown = null

  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { message: text }
    }
  }

  if (!response.ok) {
    const data = payload as { error?: string; error_description?: string; message?: string; msg?: string }
    throw new Error(data.message || data.msg || data.error_description || data.error || `Supabase request failed with ${response.status}.`)
  }

  return payload as T
}

async function callRpc<T>(
  config: { publishableKey?: string; serviceRoleKey?: string; url: string },
  name: string,
  body: Record<string, unknown>,
  token: string,
): Promise<T> {
  return supabaseJson<T>(`${config.url}/rest/v1/rpc/${name}`, {
    body: JSON.stringify(body),
    headers: {
      apikey: config.publishableKey ?? token,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  })
}

async function requireAdminMfa(request: Request, environment: Environment): Promise<{
  config: NonNullable<ReturnType<typeof configuredSupabase>>
  context: SessionContext
}> {
  const config = configuredSupabase(environment)
  if (!config) {
    throw new Response(JSON.stringify({ error: 'server_not_configured' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      status: 503,
    })
  }

  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) {
    throw new Response(JSON.stringify({ error: 'auth_required' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      status: 401,
    })
  }

  const payload = await callRpc<SessionContext[] | SessionContext>(
    { publishableKey: config.publishableKey, url: config.url },
    'get_session_context',
    {},
    authorization.slice('Bearer '.length),
  )
  const context = Array.isArray(payload) ? payload[0] : payload

  if (!context || context.role !== 'admin' || !context.has_mfa) {
    throw new Response(JSON.stringify({ error: 'admin_mfa_required' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      status: 403,
    })
  }

  return { config, context }
}

function randomFrom(values: string): string {
  const bytes = new Uint32Array(1)
  crypto.getRandomValues(bytes)
  return values[bytes[0] % values.length]
}

function generateTemporaryPassword(): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const digits = '23456789'
  const symbols = '!@#$%*-_+='
  const all = `${lower}${upper}${digits}${symbols}`
  const characters = [
    randomFrom(lower),
    randomFrom(upper),
    randomFrom(digits),
    randomFrom(symbols),
  ]

  while (characters.length < 18) characters.push(randomFrom(all))

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const bytes = new Uint32Array(1)
    crypto.getRandomValues(bytes)
    const swapIndex = bytes[0] % (index + 1)
    const current = characters[index]
    characters[index] = characters[swapIndex]
    characters[swapIndex] = current
  }

  return characters.join('')
}

async function listAuthUsers(config: NonNullable<ReturnType<typeof configuredSupabase>>): Promise<AuthUser[]> {
  const users: AuthUser[] = []
  for (let page = 1; page <= 20; page += 1) {
    const payload = await supabaseJson<{ users?: AuthUser[] }>(`${config.url}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
      },
      method: 'GET',
    })
    const pageUsers = Array.isArray(payload.users) ? payload.users : []
    users.push(...pageUsers)
    if (pageUsers.length < 1000) break
  }
  return users
}

async function createAuthUser(
  config: NonNullable<ReturnType<typeof configuredSupabase>>,
  target: AuthTarget,
  password: string,
): Promise<AuthUser> {
  return supabaseJson<AuthUser>(`${config.url}/auth/v1/admin/users`, {
    body: JSON.stringify({
      app_metadata: {
        employeeId: target.employeeId,
        role: target.role,
        source: 'sygshift-admin',
        username: target.username,
      },
      email: target.authEmail,
      email_confirm: true,
      password,
      user_metadata: {
        displayName: target.displayName,
        employeeId: target.employeeId,
        username: target.username,
      },
    }),
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  })
}

async function updateAuthUser(
  config: NonNullable<ReturnType<typeof configuredSupabase>>,
  target: AuthTarget,
  userId: string,
  password: string,
): Promise<AuthUser> {
  return supabaseJson<AuthUser>(`${config.url}/auth/v1/admin/users/${userId}`, {
    body: JSON.stringify({
      app_metadata: {
        employeeId: target.employeeId,
        role: target.role,
        source: 'sygshift-admin',
        username: target.username,
      },
      email_confirm: true,
      password,
      user_metadata: {
        displayName: target.displayName,
        employeeId: target.employeeId,
        username: target.username,
      },
    }),
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      'content-type': 'application/json',
    },
    method: 'PUT',
  })
}

async function provisionOne(
  config: NonNullable<ReturnType<typeof configuredSupabase>>,
  target: AuthTarget,
  password: string,
  usersByEmail: Map<string, AuthUser>,
) {
  const existing = target.existingAuthUserId
    ? { id: target.existingAuthUserId }
    : usersByEmail.get(target.authEmail.toLowerCase())
  const user = existing
    ? await updateAuthUser(config, target, existing.id, password)
    : await createAuthUser(config, target, password)

  usersByEmail.set(target.authEmail.toLowerCase(), user)
  const linked = await callRpc<unknown>(
    { serviceRoleKey: config.serviceRoleKey, url: config.url },
    'service_link_employee_auth_account',
    {
      target_auth_user_id: user.id,
      target_employee_id: target.employeeId,
      target_must_change_password: true,
    },
    config.serviceRoleKey,
  )

  return {
    action: existing ? 'updated_existing_auth_user' : 'created_auth_user',
    linked,
    password,
    target,
  }
}

async function handleAdminUsersApi(request: Request, environment: Environment, requestId: string): Promise<Response> {
  let admin: Awaited<ReturnType<typeof requireAdminMfa>>
  try {
    admin = await requireAdminMfa(request, environment)
  } catch (error) {
    if (error instanceof Response) {
      const payload = await error.json().catch(() => ({ error: 'auth_failed' })) as { error?: string }
      return errorJson(payload.error ?? 'auth_failed', requestId, error.status)
    }
    throw error
  }

  const url = new URL(request.url)
  const body = await readJsonBody(request)
  const usersByEmail = new Map(
    (await listAuthUsers(admin.config)).map((user) => [String(user.email).toLowerCase(), user]),
  )

  if (url.pathname === '/api/v1/admin/users/provision-missing') {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)

    const targets = await callRpc<AuthTarget[]>(
      { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
      'service_get_employee_auth_targets',
      { target_include_existing: false },
      admin.config.serviceRoleKey,
    )
    const results = []
    const failures = []

    for (const target of targets) {
      try {
        const result = await provisionOne(admin.config, target, generateTemporaryPassword(), usersByEmail)
        results.push({
          action: result.action,
          displayName: target.displayName,
          role: target.role,
          temporaryPassword: result.password,
          username: target.username,
        })
      } catch (error) {
        failures.push({
          displayName: target.displayName,
          error: error instanceof Error ? error.message : 'Provisioning failed.',
          username: target.username,
        })
      }
    }

    return json({
      failures,
      provisioned: results,
      requestId,
      requestedBy: admin.context.username,
    })
  }

  const match = /^\/api\/v1\/admin\/users\/([0-9a-f-]{36})\/account$/i.exec(url.pathname)
  if (!match) return errorJson('not_found', requestId, 404)

  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)

  const target = await callRpc<AuthTarget>(
    { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
    'service_get_employee_auth_target',
    { target_employee_id: match[1] },
    admin.config.serviceRoleKey,
  )
  const suppliedPassword = typeof body.temporaryPassword === 'string' ? body.temporaryPassword.trim() : ''
  const password = suppliedPassword || generateTemporaryPassword()
  const result = await provisionOne(admin.config, target, password, usersByEmail)

  return json({
    action: result.action,
    displayName: target.displayName,
    requestId,
    role: target.role,
    temporaryPassword: result.password,
    username: target.username,
  })
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
    } else if (url.pathname.startsWith('/api/v1/admin/users')) {
      try {
        response = await handleAdminUsersApi(request, environment, requestId)
      } catch (error) {
        response = errorJson(
          'admin_user_request_failed',
          requestId,
          500,
          error instanceof Error ? error.message : 'The admin user request failed.',
        )
      }
    } else if (url.pathname.startsWith('/api/')) {
      response = json({ error: 'not_found', requestId }, 404)
    } else {
      response = await environment.ASSETS.fetch(request)
    }

    return secureResponse(request, response, requestId)
  },
}
