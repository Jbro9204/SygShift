interface AssetBinding {
  fetch(request: Request): Promise<Response>
}

interface EmailBinding {
  send(message: {
    to: string | string[]
    from: { email: string, name?: string }
    replyTo?: string
    subject: string
    html?: string
    text: string
  }): Promise<unknown>
}

interface Environment {
  ASSETS: AssetBinding
  EMAIL?: EmailBinding
  SYGSHIFT_PUBLIC_APP_URL?: string
  SYGSHIFT_EMAIL_FROM?: string
  SYGSHIFT_EMAIL_FROM_NAME?: string
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
  role: 'guard' | 'dispatcher' | 'scheduler' | 'supervisor' | 'admin'
  has_mfa: boolean
}

interface AuthTarget {
  employeeId: string
  employeeNumber?: string | null
  jobTitle?: string | null
  username: string
  authEmail: string
  displayName: string
  role: 'guard' | 'dispatcher' | 'scheduler' | 'supervisor' | 'admin'
  employmentType: 'hourly' | 'salary' | 'flex'
  status: 'active' | 'leave' | 'inactive' | 'separated'
  existingAuthUserId: string | null
}

interface LoginEmailTarget extends AuthTarget {
  contactEmail: string | null
}

interface AuthUser {
  id: string
  email?: string
}

interface NotificationJob {
  id: string
  recipients: string[]
  message: {
    subject: string
    text: string
    html?: string
  }
}

const maxJsonBodyBytes = 4096
const defaultAppUrl = 'https://app.sygilant.us'
const defaultSupportEmail = 'jbrown@guardianshipsecurity.net'
const notificationProcessorRoles = new Set<SessionContext['role']>([
  'dispatcher',
  'scheduler',
  'supervisor',
  'admin',
])

class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, detail: string) {
    super(detail)
    this.code = code
    this.status = status
  }
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

  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > maxJsonBodyBytes) {
    throw new ApiError('request_body_too_large', 413, 'The request body is too large.')
  }

  const text = await request.text()
  if (new TextEncoder().encode(text).length > maxJsonBodyBytes) {
    throw new ApiError('request_body_too_large', 413, 'The request body is too large.')
  }
  if (!text.trim()) return {}

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new ApiError('invalid_json', 400, 'The request body must be valid JSON.')
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError('invalid_json', 400, 'The request body must be a JSON object.')
  }
  return payload as Record<string, unknown>
}

export function validateSuppliedTemporaryPassword(password: string, username: string): string[] {
  const failures: string[] = []
  const lowerPassword = password.toLowerCase()
  const normalizedUsername = username.trim().toLowerCase()

  if (password.length < 12) failures.push('Use at least 12 characters.')
  if (!/[a-z]/.test(password)) failures.push('Add a lowercase letter.')
  if (!/[A-Z]/.test(password)) failures.push('Add an uppercase letter.')
  if (!/[0-9]/.test(password)) failures.push('Add a number.')
  if (!/[^A-Za-z0-9]/.test(password)) failures.push('Add a symbol.')
  if (normalizedUsername && lowerPassword.includes(normalizedUsername)) failures.push('Do not include the username.')

  for (const blockedTerm of ['password', 'sygshift', 'sygilant', 'security', 'welcome', 'temporary']) {
    if (lowerPassword.includes(blockedTerm)) {
      failures.push('Avoid common or company-related words.')
      break
    }
  }

  return failures
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
  additionalHeaders?: Record<string, string>,
): Promise<T> {
  return supabaseJson<T>(`${config.url}/rest/v1/rpc/${name}`, {
    body: JSON.stringify(body),
    headers: {
      ...additionalHeaders,
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
  const result = await requireVerifiedOperationsSession(request, environment, null, 'admin_mfa_required')
  if (result.context.role !== 'admin') {
    throw new Response(JSON.stringify({ error: 'admin_mfa_required' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      status: 403,
    })
  }

  return result
}

async function requireVerifiedOperationsSession(
  request: Request,
  environment: Environment,
  allowedRoles: ReadonlySet<SessionContext['role']> | null = notificationProcessorRoles,
  mfaError = 'operations_mfa_required',
): Promise<{
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
    request.headers.get('x-sygshift-trusted-device')
      ? { 'x-sygshift-trusted-device': request.headers.get('x-sygshift-trusted-device')! }
      : undefined,
  )
  const context = Array.isArray(payload) ? payload[0] : payload

  if (!context || !context.has_mfa || (allowedRoles && !allowedRoles.has(context.role))) {
    throw new Response(JSON.stringify({ error: mfaError }), {
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
        employeeNumber: target.employeeNumber ?? null,
        jobTitle: target.jobTitle ?? null,
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
        employeeNumber: target.employeeNumber ?? null,
        jobTitle: target.jobTitle ?? null,
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

function buildLoginInstructionsEmail(target: LoginEmailTarget, temporaryPassword: string, appUrl: string): NotificationJob['message'] {
  const normalizedAppUrl = appUrl.replace(/\/+$/, '')
  const safeName = escapeHtml(target.displayName)
  const safeUsername = escapeHtml(target.username)
  const safePassword = escapeHtml(temporaryPassword)
  const safeUrl = escapeHtml(normalizedAppUrl)

  return {
    subject: 'Your SygShift login is ready',
    text: [
      `Hello ${target.displayName},`,
      'Your SygShift account is ready.',
      `Site: ${normalizedAppUrl}`,
      `Username: ${target.username}`,
      `Temporary password: ${temporaryPassword}`,
      'Getting started:',
      '1. Open the SygShift site link above.',
      '2. Sign in with your username and temporary password.',
      '3. Create your permanent password when prompted.',
      '4. Review your schedule, open shifts, requests, and time clock.',
      'For security, do not share this temporary password. If it does not work, contact a supervisor or administrator so they can reset your access from SygShift.',
    ].join('\n\n'),
    html: `
      <p>Hello ${safeName},</p>
      <p>Your SygShift account is ready.</p>
      <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin:18px 0; width:100%; max-width:520px;">
        <tr><td style="padding:10px 12px; border:1px solid #e4ddcf; background:#f8f3e9; font-weight:700;">Site</td><td style="padding:10px 12px; border:1px solid #e4ddcf;"><a href="${safeUrl}">${safeUrl}</a></td></tr>
        <tr><td style="padding:10px 12px; border:1px solid #e4ddcf; background:#f8f3e9; font-weight:700;">Username</td><td style="padding:10px 12px; border:1px solid #e4ddcf;">${safeUsername}</td></tr>
        <tr><td style="padding:10px 12px; border:1px solid #e4ddcf; background:#f8f3e9; font-weight:700;">Temporary password</td><td style="padding:10px 12px; border:1px solid #e4ddcf; font-family:Consolas, Menlo, monospace;">${safePassword}</td></tr>
      </table>
      <p><strong>Getting started:</strong></p>
      <ol>
        <li>Open the SygShift site link above.</li>
        <li>Sign in with your username and temporary password.</li>
        <li>Create your permanent password when prompted.</li>
        <li>Review your schedule, open shifts, requests, and time clock.</li>
      </ol>
      <p>For security, do not share this temporary password. If it does not work, contact a supervisor or administrator so they can reset your access from SygShift.</p>
    `,
  }
}

function greetingName(displayName: string): string {
  const firstToken = displayName.trim().split(/\s+/)[0]
  return firstToken || 'there'
}

export function buildWelcomeEmail(target: LoginEmailTarget, appUrl: string, supportEmail = defaultSupportEmail): NotificationJob['message'] {
  const normalizedAppUrl = appUrl.replace(/\/+$/, '')
  const firstName = greetingName(target.displayName)
  const safeFirstName = escapeHtml(firstName)
  const safeUrl = escapeHtml(normalizedAppUrl)
  const safeSupportEmail = escapeHtml(supportEmail)

  return {
    subject: 'Welcome to SygShift',
    text: [
      `Hello ${firstName},`,
      'Welcome to SygShift, our new scheduling, time, and workforce coordination system.',
      `Site link: ${normalizedAppUrl}`,
      'What SygShift will help with:',
      '- Viewing current schedules in one easy-to-read place.',
      '- Seeing open shifts, overtime opportunities, and event coverage needs.',
      '- Requesting time off and tracking schedule-related requests.',
      '- Using time clock and attendance tools as rollout continues.',
      '- Receiving company scheduling announcements in one consistent format.',
      `We are still testing and polishing the system before full rollout. If you notice a bug, missing information, confusing screen, or anything that does not look right, please email Jordan Brown at ${supportEmail}.`,
      'Thank you for helping us make this stronger and easier for everyone to use.',
      'Jordan Brown',
      'Chief Systems and Automation Officer',
    ].join('\n\n'),
    html: `
      <p>Hello ${safeFirstName},</p>
      <p>Welcome to <strong>SygShift</strong>, our new scheduling, time, and workforce coordination system.</p>
      <p><strong>Site link:</strong> <a href="${safeUrl}">${safeUrl}</a></p>
      <p><strong>What SygShift will help with:</strong></p>
      <ul>
        <li>Viewing current schedules in one easy-to-read place.</li>
        <li>Seeing open shifts, overtime opportunities, and event coverage needs.</li>
        <li>Requesting time off and tracking schedule-related requests.</li>
        <li>Using time clock and attendance tools as rollout continues.</li>
        <li>Receiving company scheduling announcements in one consistent format.</li>
      </ul>
      <p>We are still testing and polishing the system before full rollout. If you notice a bug, missing information, confusing screen, or anything that does not look right, please email Jordan Brown at <a href="mailto:${safeSupportEmail}">${safeSupportEmail}</a>.</p>
      <p>Thank you for helping us make this stronger and easier for everyone to use.</p>
      <p><strong>Jordan Brown</strong><br>Chief Systems and Automation Officer</p>
    `,
  }
}

async function sendLoginInstructions(
  environment: Environment,
  target: LoginEmailTarget,
  temporaryPassword: string,
) {
  if (!environment.EMAIL) {
    throw new ApiError('email_not_configured', 503, 'Cloudflare Email Sending is not configured for this Worker.')
  }
  const fromEmail = environment.SYGSHIFT_EMAIL_FROM?.trim()
  if (!fromEmail) {
    throw new ApiError('email_sender_not_configured', 503, 'The email sender address is not configured.')
  }
  const to = target.contactEmail?.trim().toLowerCase()
  if (!to) {
    throw new ApiError('employee_email_missing', 422, `${target.displayName} does not have an on-file email address.`)
  }

  const appUrl = environment.SYGSHIFT_PUBLIC_APP_URL?.trim() || defaultAppUrl
  const message = buildLoginInstructionsEmail(target, temporaryPassword, appUrl)
  await environment.EMAIL.send({
    from: { email: fromEmail, name: environment.SYGSHIFT_EMAIL_FROM_NAME?.trim() || 'SygShift' },
    html: brandedEmailHtml(message, appUrl),
    subject: message.subject,
    text: message.text,
    to,
  })
}

async function sendWelcomeEmail(
  environment: Environment,
  target: LoginEmailTarget,
): Promise<unknown> {
  if (!environment.EMAIL) {
    throw new ApiError('email_not_configured', 503, 'Cloudflare Email Sending is not configured for this Worker.')
  }
  const fromEmail = environment.SYGSHIFT_EMAIL_FROM?.trim()
  if (!fromEmail) {
    throw new ApiError('email_sender_not_configured', 503, 'The email sender address is not configured.')
  }
  const to = target.contactEmail?.trim().toLowerCase()
  if (!to) {
    throw new ApiError('employee_email_missing', 422, `${target.displayName} does not have an on-file email address.`)
  }

  const appUrl = environment.SYGSHIFT_PUBLIC_APP_URL?.trim() || defaultAppUrl
  const message = buildWelcomeEmail(target, appUrl)
  return environment.EMAIL.send({
    from: { email: fromEmail, name: environment.SYGSHIFT_EMAIL_FROM_NAME?.trim() || 'SygShift' },
    html: brandedEmailHtml(message, appUrl),
    replyTo: defaultSupportEmail,
    subject: message.subject,
    text: message.text,
    to,
  })
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

  if (url.pathname === '/api/v1/admin/users/login-emails') {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)

    const targets = await callRpc<LoginEmailTarget[]>(
      { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
      'service_get_employee_login_email_targets',
      { target_include_existing: false },
      admin.config.serviceRoleKey,
    )
    const sent = []
    const failures = []

    for (const target of targets) {
      try {
        const result = await provisionOne(admin.config, target, generateTemporaryPassword(), usersByEmail)
        await sendLoginInstructions(environment, target, result.password)
        sent.push({
          displayName: target.displayName,
          email: target.contactEmail,
          username: target.username,
        })
      } catch (error) {
        failures.push({
          displayName: target.displayName,
          error: error instanceof Error ? error.message : 'Login email failed.',
          username: target.username,
        })
      }
    }

    return json({
      failures,
      requestId,
      requestedBy: admin.context.username,
      sent,
    })
  }

  const emailMatch = /^\/api\/v1\/admin\/users\/([0-9a-f-]{36})\/login-email$/i.exec(url.pathname)
  if (emailMatch) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)

    const target = await callRpc<LoginEmailTarget>(
      { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
      'service_get_employee_login_email_target',
      { target_employee_id: emailMatch[1] },
      admin.config.serviceRoleKey,
    )
    if (!target) throw new ApiError('employee_not_found', 404, 'The employee record was not found.')

    if ('temporaryPassword' in body && body.temporaryPassword !== null && typeof body.temporaryPassword !== 'string') {
      throw new ApiError('invalid_temporary_password', 400, 'Temporary password must be text.')
    }

    const suppliedPassword = typeof body.temporaryPassword === 'string' ? body.temporaryPassword.trim() : ''
    if (suppliedPassword) {
      const passwordFailures = validateSuppliedTemporaryPassword(suppliedPassword, target.username)
      if (passwordFailures.length > 0) {
        throw new ApiError('temporary_password_rejected', 422, passwordFailures.join(' '))
      }
    }

    const result = await provisionOne(admin.config, target, suppliedPassword || generateTemporaryPassword(), usersByEmail)
    await sendLoginInstructions(environment, target, result.password)

    return json({
      action: result.action,
      displayName: target.displayName,
      email: target.contactEmail,
      requestId,
      role: target.role,
      username: target.username,
    })
  }

  const welcomeEmailMatch = /^\/api\/v1\/admin\/users\/([0-9a-f-]{36})\/welcome-email$/i.exec(url.pathname)
  if (welcomeEmailMatch) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)

    const target = await callRpc<LoginEmailTarget>(
      { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
      'service_get_employee_login_email_target',
      { target_employee_id: welcomeEmailMatch[1] },
      admin.config.serviceRoleKey,
    )
    if (!target) throw new ApiError('employee_not_found', 404, 'The active employee record was not found.')

    const delivery = await sendWelcomeEmail(environment, target)

    return json({
      delivery,
      displayName: target.displayName,
      email: target.contactEmail,
      requestId,
      username: target.username,
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

  if ('temporaryPassword' in body && body.temporaryPassword !== null && typeof body.temporaryPassword !== 'string') {
    throw new ApiError('invalid_temporary_password', 400, 'Temporary password must be text.')
  }

  const suppliedPassword = typeof body.temporaryPassword === 'string' ? body.temporaryPassword.trim() : ''
  if (suppliedPassword) {
    const passwordFailures = validateSuppliedTemporaryPassword(suppliedPassword, target.username)
    if (passwordFailures.length > 0) {
      throw new ApiError('temporary_password_rejected', 422, passwordFailures.join(' '))
    }
  }

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

function chunkRecipients(recipients: string[], size = 50): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < recipients.length; index += size) {
    chunks.push(recipients.slice(index, index + size))
  }
  return chunks
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function textToHtml(value: string): string {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
    .join('')
}

export function brandedEmailHtml(message: NotificationJob['message'], appUrl = defaultAppUrl): string {
  const normalizedAppUrl = appUrl.replace(/\/+$/, '')
  const body = message.html?.trim() || textToHtml(message.text)
  const title = escapeHtml(message.subject)
  const logoUrl = `${normalizedAppUrl}/brand/sygshift-email-logo.png`

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
  </head>
  <body style="margin:0; padding:0; background:#f3f0ea; color:#1b1814; font-family:Arial, Helvetica, sans-serif; -webkit-text-size-adjust:100%;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
      ${escapeHtml(message.text).slice(0, 180)}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse; background:#f3f0ea;">
      <tr>
        <td align="center" style="padding:22px 12px 64px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%; max-width:640px; border-collapse:collapse; table-layout:fixed;">
            <tr>
              <td align="center" style="padding:24px 18px 20px; background-color:#070706; background-image:linear-gradient(135deg, #171511 0%, #080706 42%, #242018 43%, #0b0a08 64%, #15130f 100%); border-radius:16px 16px 0 0; border-bottom:3px solid #d6b15f;">
                <img src="${logoUrl}" width="280" alt="SygShift" style="display:block; width:280px; max-width:88%; height:auto; margin:0 auto; border:0;">
                <div style="margin-top:14px; color:#d6b15f; font-size:11px; line-height:1.4; letter-spacing:1.8px; text-transform:uppercase; font-weight:800; text-align:center;">
                  Smart schedules. Stronger coverage.
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:26px 22px 10px; background:#fffdf8; border-left:1px solid #e4ddcf; border-right:1px solid #e4ddcf; word-break:break-word;">
                <div style="color:#7b5a1e; font-size:12px; line-height:1.4; letter-spacing:1.5px; text-transform:uppercase; font-weight:800;">
                  SygShift notification
                </div>
                <h1 style="margin:8px 0 18px; color:#181511; font-size:26px; line-height:1.18; font-weight:800; letter-spacing:-0.02em;">
                  ${title}
                </h1>
                <div style="color:#29241d; font-size:16px; line-height:1.6;">
                  ${body}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 22px 52px; background:#fffdf8; border-left:1px solid #e4ddcf; border-right:1px solid #e4ddcf; border-bottom:1px solid #e4ddcf; border-radius:0 0 16px 16px;">
                <a href="${normalizedAppUrl}" style="display:inline-block; padding:12px 18px; color:#11100e; background:#d6b15f; border-radius:10px; font-size:15px; line-height:1; font-weight:800; text-decoration:none;">
                  Open SygShift
                </a>
                <p style="margin:18px 0 0; color:#6d665c; font-size:13px; line-height:1.5;">
                  This operational message was sent by SygShift for Sygilant scheduling and workforce coordination.
                </p>
                <div style="height:24px; line-height:24px; font-size:24px;">&nbsp;</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

async function handleNotificationProcessApi(request: Request, environment: Environment, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)

  let operator: Awaited<ReturnType<typeof requireVerifiedOperationsSession>>
  try {
    operator = await requireVerifiedOperationsSession(request, environment)
  } catch (error) {
    if (error instanceof Response) {
      const payload = await error.json().catch(() => ({ error: 'auth_failed' })) as { error?: string }
      return errorJson(payload.error ?? 'auth_failed', requestId, error.status)
    }
    throw error
  }

  if (!environment.EMAIL) {
    return errorJson('email_not_configured', requestId, 503, 'Cloudflare Email Sending is not configured for this Worker.')
  }

  const fromEmail = environment.SYGSHIFT_EMAIL_FROM?.trim()
  if (!fromEmail) {
    return errorJson('email_sender_not_configured', requestId, 503, 'The email sender address is not configured.')
  }

  const jobs = await callRpc<NotificationJob[]>(
    { serviceRoleKey: operator.config.serviceRoleKey, url: operator.config.url },
    'service_claim_notification_batch',
    { target_limit: 10 },
    operator.config.serviceRoleKey,
  )
  const delivered: string[] = []
  const failed: Array<{ id: string, error: string }> = []

  for (const job of jobs) {
    try {
      const recipients = [...new Set(job.recipients.map((recipient) => recipient.trim().toLowerCase()).filter(Boolean))]
      if (recipients.length === 0) throw new Error('No deliverable recipients were found.')

      for (const to of chunkRecipients(recipients)) {
        await environment.EMAIL.send({
          from: { email: fromEmail, name: environment.SYGSHIFT_EMAIL_FROM_NAME?.trim() || 'SygShift' },
          html: brandedEmailHtml(job.message, environment.SYGSHIFT_PUBLIC_APP_URL),
          subject: job.message.subject,
          text: job.message.text,
          to,
        })
      }

      await callRpc<unknown>(
        { serviceRoleKey: operator.config.serviceRoleKey, url: operator.config.url },
        'service_mark_notification_result',
        { delivered: true, delivery_error: null, target_notification_id: job.id },
        operator.config.serviceRoleKey,
      )
      delivered.push(job.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Email delivery failed.'
      await callRpc<unknown>(
        { serviceRoleKey: operator.config.serviceRoleKey, url: operator.config.url },
        'service_mark_notification_result',
        { delivered: false, delivery_error: message, target_notification_id: job.id },
        operator.config.serviceRoleKey,
      )
      failed.push({ id: job.id, error: message })
    }
  }

  return json({
    delivered,
    failed,
    processed: delivered.length + failed.length,
    requestId,
    requestedBy: operator.context.username,
  })
}

function readiness(environment: Environment, requestId: string): Response {
  const config = configuredSupabase(environment)
  const checks = {
    assetsBinding: Boolean(environment.ASSETS),
    supabasePublishableKey: Boolean(
      environment.SUPABASE_PUBLISHABLE_KEY?.trim() || environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim(),
    ),
    supabaseServiceRoleKey: Boolean(environment.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    supabaseUrl: Boolean(environment.SUPABASE_URL?.trim() || environment.VITE_SUPABASE_URL?.trim()),
  }
  const ready = Boolean(config && checks.assetsBinding)

  return json({
    checks,
    ready,
    requestId,
    status: ready ? 'ready' : 'misconfigured',
  }, ready ? 200 : 503)
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
    } else if (url.pathname === '/api/v1/ready') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response = json(
          { error: 'method_not_allowed', requestId },
          405,
          { allow: 'GET, HEAD' },
        )
      } else {
        response = readiness(environment, requestId)
        if (request.method === 'HEAD') {
          response = new Response(null, { headers: response.headers, status: response.status })
        }
      }
    } else if (url.pathname.startsWith('/api/v1/admin/users')) {
      try {
        response = await handleAdminUsersApi(request, environment, requestId)
      } catch (error) {
        response = error instanceof ApiError
          ? errorJson(error.code, requestId, error.status, error.message)
          : errorJson('admin_user_request_failed', requestId, 500, 'The admin user request failed.')
      }
    } else if (url.pathname === '/api/v1/admin/notifications/process') {
      try {
        response = await handleNotificationProcessApi(request, environment, requestId)
      } catch {
        response = errorJson('notification_process_failed', requestId, 500, 'The notification delivery request failed.')
      }
    } else if (url.pathname.startsWith('/api/')) {
      response = json({ error: 'not_found', requestId }, 404)
    } else {
      response = await environment.ASSETS.fetch(request)
    }

    return secureResponse(request, response, requestId)
  },
}
