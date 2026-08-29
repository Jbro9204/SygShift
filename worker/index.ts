/* oxlint-disable typescript/triple-slash-reference -- Wrangler emits global binding declarations. */
/// <reference path="./bindings.d.ts" />
/// <reference path="../worker-configuration.d.ts" />
/* oxlint-enable typescript/triple-slash-reference */

interface WorkerScheduledController {
  cron: string
  scheduledTime: number
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

type Environment = Partial<Env> & {
  ASSETS: Fetcher
  SUPABASE_SERVICE_ROLE_KEY?: string
}

interface SessionContext {
  employee_id: string
  username: string
  display_name: string
  role: 'guard' | 'dispatcher' | 'scheduler' | 'recruiting_licensing' | 'supervisor' | 'admin'
  has_mfa: boolean
  permissions?: string[]
}

interface AuthTarget {
  employeeId: string
  employeeNumber?: string | null
  jobTitle?: string | null
  username: string
  authEmail: string
  displayName: string
  role: 'guard' | 'dispatcher' | 'scheduler' | 'recruiting_licensing' | 'supervisor' | 'admin'
  employmentType: 'hourly' | 'salary' | 'flex'
  status: 'active' | 'leave' | 'inactive' | 'separated'
  existingAuthUserId: string | null
}

interface LoginEmailTarget extends AuthTarget {
  contactEmail: string | null
  requiresMfa: boolean
}

interface AuthUser {
  id: string
  email?: string
}

interface AuthMfaFactor {
  id: string
  factor_type?: string
  status?: string
}

interface MfaRecoveryCodeRecord {
  hash: string
  hint: string
}

interface NotificationJob {
  id: string
  messageType?: string
  aggregateType?: string
  aggregateId?: string
  recipients: string[]
  message: {
    subject: string
    text: string
    html?: string
  }
}

interface EmailAuditContext {
  notificationType: string
  relatedRecordType?: string | null
  relatedRecordId?: string | null
}

interface EmailDeliveryResult {
  sent: string[]
  suppressed: string[]
  failed: Array<{ recipient: string, error: string }>
}

interface AttendanceReportPayload {
  id: string
  callOffId?: string | null
  employeeId: string
  employeeName: string
  username: string
  eventType: 'called_in_sick' | 'call_off'
  status: string
  operationalDate: string
  shiftId: string | null
  startsAt: string | null
  endsAt: string | null
  timeZone: string
  siteName: string | null
  siteCode: string | null
  postName: string | null
  eventName: string | null
  locationName: string
  note: string
  createdAt: string
  dispatchTo: string
}

interface MaintenanceStatusWindow {
  accessMode: 'notice' | 'read_only' | 'unavailable'
  endsAt: string
  featureCodes: string[]
  title: string
}

interface MaintenanceStatusPayload {
  active?: MaintenanceStatusWindow[]
}

const maxJsonBodyBytes = 4096
const defaultAppUrl = 'https://app.sygilant.us'
const defaultSupportEmail = 'jbrown@guardianshipsecurity.net'
const dispatchAlertEmail = 'dispatch@guardianshipsecurity.net'
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

export function protectedMaintenanceWindow(
  status: MaintenanceStatusPayload,
  featureCode: string,
): MaintenanceStatusWindow | null {
  return status.active?.find((window) => (
    window.featureCodes.includes(featureCode)
    && (window.accessMode === 'read_only' || window.accessMode === 'unavailable')
  )) ?? null
}

async function requireMaintenanceWriteAccess(
  config: { serviceRoleKey: string; url: string },
  featureCode: string,
): Promise<void> {
  const status = await callRpc<MaintenanceStatusPayload>(
    config,
    'get_maintenance_status',
    {},
    config.serviceRoleKey,
  )
  const activeWindow = protectedMaintenanceWindow(status, featureCode)
  if (!activeWindow) return

  throw new ApiError(
    'maintenance_write_protected',
    503,
    `${activeWindow.title} is in progress. This area is temporarily read-only and your change was not saved.`,
  )
}

function blockedEmailDomains(environment: Environment): Set<string> {
  return new Set(
    (environment.SYGSHIFT_BLOCKED_EMAIL_DOMAINS?.trim() || 'guardianshipsecurity.net')
      .split(',')
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
  )
}

function isBlockedEmailRecipient(environment: Environment, recipient: string): boolean {
  const domain = recipient.trim().toLowerCase().split('@').at(-1) ?? ''
  return blockedEmailDomains(environment).has(domain)
}

function requireApprovedEmployeeEmail(environment: Environment, target: LoginEmailTarget): string {
  const recipient = target.contactEmail?.trim().toLowerCase()
  if (!recipient) {
    throw new ApiError(
      'employee_personal_email_required',
      422,
      `${target.displayName} needs a personal email before SygShift email can be sent.`,
    )
  }
  if (isBlockedEmailRecipient(environment, recipient)) {
    throw new ApiError(
      'email_recipient_suppressed',
      409,
      'SygShift is not sending to @guardianshipsecurity.net while company delivery is blocked. Add a personal email and try again.',
    )
  }
  return recipient
}

function maskEmailAddress(email: string): string {
  const [localPart, domain] = email.split('@')
  if (!localPart || !domain) return 'the employee’s approved personal email'
  const visible = localPart.slice(0, Math.min(2, localPart.length))
  return `${visible}${'*'.repeat(Math.max(3, localPart.length - visible.length))}@${domain}`
}

async function logEmailDelivery(
  environment: Environment,
  recipient: string,
  status: 'sent' | 'failed' | 'suppressed_blocked_domain',
  context: EmailAuditContext,
  failureDetail?: string | null,
): Promise<void> {
  const config = configuredSupabase(environment)
  if (!config) return
  await callRpc(
    { serviceRoleKey: config.serviceRoleKey, url: config.url },
    'service_log_email_delivery',
    {
      target_delivery_status: status,
      target_failure_detail: failureDetail ?? null,
      target_intended_recipient: recipient,
      target_notification_type: context.notificationType,
      target_provider_reference: null,
      target_related_record_id: context.relatedRecordId ?? null,
      target_related_record_type: context.relatedRecordType ?? null,
    },
    config.serviceRoleKey,
  )
}

async function sendAuditedEmail(
  environment: Environment,
  recipients: string | string[],
  message: NotificationJob['message'],
  context: EmailAuditContext,
  replyTo?: string,
): Promise<EmailDeliveryResult> {
  if (!environment.EMAIL) throw new ApiError('email_not_configured', 503, 'Cloudflare Email Sending is not configured for this Worker.')
  const fromEmail = environment.SYGSHIFT_EMAIL_FROM?.trim()
  if (!fromEmail) throw new ApiError('email_sender_not_configured', 503, 'The email sender address is not configured.')

  const uniqueRecipients = [...new Set((Array.isArray(recipients) ? recipients : [recipients])
    .map((recipient) => recipient.trim().toLowerCase())
    .filter(Boolean))]
  const result: EmailDeliveryResult = { failed: [], sent: [], suppressed: [] }

  for (const recipient of uniqueRecipients) {
    if (isBlockedEmailRecipient(environment, recipient)) {
      result.suppressed.push(recipient)
      await logEmailDelivery(environment, recipient, 'suppressed_blocked_domain', context, 'Suppressed — Blocked Domain')
      continue
    }
    try {
      await environment.EMAIL.send({
        from: { email: fromEmail, name: environment.SYGSHIFT_EMAIL_FROM_NAME?.trim() || 'SygShift' },
        html: brandedEmailHtml(message, environment.SYGSHIFT_PUBLIC_APP_URL),
        replyTo,
        subject: message.subject,
        text: message.text,
        to: recipient,
      })
      result.sent.push(recipient)
      await logEmailDelivery(environment, recipient, 'sent', context)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Email delivery failed.'
      result.failed.push({ error: detail, recipient })
      await logEmailDelivery(environment, recipient, 'failed', context, detail)
    }
  }

  return result
}

async function requireAdminMfa(
  request: Request,
  environment: Environment,
  requiredPermission: 'admin.users.manage' | 'admin.users.invite' = 'admin.users.manage',
): Promise<{
  config: NonNullable<ReturnType<typeof configuredSupabase>>
  context: SessionContext
}> {
  const result = await requireVerifiedOperationsSession(request, environment, 'admin_mfa_required')
  const hasRequiredPermission = result.context.permissions?.includes(requiredPermission) === true

  if (!hasRequiredPermission) {
    const error = requiredPermission === 'admin.users.invite'
      ? 'new_user_invites_permission_required'
      : 'admin_mfa_required'
    throw new Response(JSON.stringify({ error }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      status: 403,
    })
  }

  return result
}

async function requireAuthenticatedSession(request: Request, environment: Environment): Promise<{
  config: NonNullable<ReturnType<typeof configuredSupabase>>
  context: SessionContext
  token: string
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

  const token = authorization.slice('Bearer '.length)
  const payload = await callRpc<SessionContext[] | SessionContext>(
    { publishableKey: config.publishableKey, url: config.url },
    'get_session_context',
    {},
    token,
    request.headers.get('x-sygshift-trusted-device')
      ? { 'x-sygshift-trusted-device': request.headers.get('x-sygshift-trusted-device')! }
      : undefined,
  )
  const context = Array.isArray(payload) ? payload[0] : payload

  if (!context?.employee_id) {
    throw new Response(JSON.stringify({ error: 'auth_required' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      status: 401,
    })
  }

  return { config, context, token }
}

async function requireVerifiedOperationsSession(
  request: Request,
  environment: Environment,
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

  if (!context || !context.has_mfa) {
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

function accessTokenAssuranceLevel(token: string): string | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const normalized = payload.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const decoded = JSON.parse(atob(normalized)) as { aal?: unknown }
    return typeof decoded.aal === 'string' ? decoded.aal : null
  } catch {
    return null
  }
}

function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let value = ''
  for (let index = 0; index < 8; index += 1) value += randomFrom(alphabet)
  return `SYG-${value.slice(0, 4)}-${value.slice(4)}`
}

function normalizeRecoveryCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!/^SYG[A-Z0-9]{8}$/.test(normalized)) return ''
  return `SYG-${normalized.slice(3, 7)}-${normalized.slice(7)}`
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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

async function listAuthUserMfaFactors(
  config: NonNullable<ReturnType<typeof configuredSupabase>>,
  userId: string,
): Promise<AuthMfaFactor[]> {
  return supabaseJson<AuthMfaFactor[]>(`${config.url}/auth/v1/admin/users/${userId}/factors`, {
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
    },
    method: 'GET',
  })
}

async function deleteAuthUserMfaFactor(
  config: NonNullable<ReturnType<typeof configuredSupabase>>,
  userId: string,
  factorId: string,
): Promise<void> {
  await supabaseJson(`${config.url}/auth/v1/admin/users/${userId}/factors/${factorId}`, {
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
    },
    method: 'DELETE',
  })
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

export function buildLoginInstructionsEmail(
  target: LoginEmailTarget,
  temporaryPassword: string,
  appUrl: string,
  supportEmail = defaultSupportEmail,
): NotificationJob['message'] {
  const normalizedAppUrl = appUrl.replace(/\/+$/, '')
  const firstName = greetingName(target.displayName)
  const safeFirstName = escapeHtml(firstName)
  const safeUsername = escapeHtml(target.username)
  const safePassword = escapeHtml(temporaryPassword)
  const safeUrl = escapeHtml(normalizedAppUrl)
  const safeSupportEmail = escapeHtml(supportEmail)

  if (target.requiresMfa) {
    return {
      subject: 'Your SygShift Login Is Ready — Authenticator Setup Required',
      text: [
        `Hello ${firstName},`,
        'Your SygShift account is ready. Because your access includes protected company information or operational tools, you must secure the account with multi-factor authentication (MFA).',
        'Before you begin:',
        'Install Microsoft Authenticator or Google Authenticator on your phone. The six-digit verification code is generated inside the authenticator app. It is not sent by email or text message.',
        `SygShift: ${normalizedAppUrl}`,
        `Username: ${target.username}`,
        `Temporary password: ${temporaryPassword}`,
        'Getting started:',
        '1. Install Microsoft Authenticator or Google Authenticator.',
        '2. Open SygShift and sign in with your username and temporary password.',
        '3. Select Start Authenticator Setup.',
        '4. In the authenticator app, add a new account and scan the QR code shown by SygShift. Do not scan it with your regular phone camera.',
        '5. Enter the six-digit code shown in the authenticator app.',
        '6. Create your permanent password when prompted.',
        'Authenticator codes change about every 30 seconds. Keep the SygShift entry in your authenticator app for future sign-ins.',
        'If you are completing setup on the same phone, keep the SygShift page open and use your phone’s app switcher to move between SygShift and the authenticator app.',
        `If setup does not work, contact Jordan Brown at ${supportEmail}.`,
        'SygShift',
        'Guardianship Security',
      ].join('\n\n'),
      html: `
        <p>Hello ${safeFirstName},</p>
        <p>Your SygShift account is ready. Because your access includes protected company information or operational tools, you must secure the account with <strong>multi-factor authentication (MFA)</strong>.</p>
        <div style="margin:18px 0; padding:16px 18px; border:1px solid #d9b15f; border-radius:12px; background:#fff8e8;">
          <p style="margin:0 0 8px; font-size:17px; font-weight:800;">Before you begin</p>
          <p style="margin:0;">Install <strong>Microsoft Authenticator</strong> or <strong>Google Authenticator</strong> on your phone. The six-digit verification code is generated inside the authenticator app. It is <strong>not</strong> sent by email or text message.</p>
        </div>
        <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin:18px 0; width:100%; max-width:520px;">
          <tr><td style="padding:10px 12px; border:1px solid #e4ddcf; background:#f8f3e9; font-weight:700;">SygShift</td><td style="padding:10px 12px; border:1px solid #e4ddcf;"><a href="${safeUrl}">${safeUrl}</a></td></tr>
          <tr><td style="padding:10px 12px; border:1px solid #e4ddcf; background:#f8f3e9; font-weight:700;">Username</td><td style="padding:10px 12px; border:1px solid #e4ddcf;">${safeUsername}</td></tr>
          <tr><td style="padding:10px 12px; border:1px solid #e4ddcf; background:#f8f3e9; font-weight:700;">Temporary password</td><td style="padding:10px 12px; border:1px solid #e4ddcf; font-family:Consolas, Menlo, monospace;">${safePassword}</td></tr>
        </table>
        <p><strong>Getting started:</strong></p>
        <ol>
          <li>Install Microsoft Authenticator or Google Authenticator.</li>
          <li>Open SygShift and sign in with your username and temporary password.</li>
          <li>Select <strong>Start Authenticator Setup</strong>.</li>
          <li>In the authenticator app, add a new account and scan the QR code shown by SygShift. <strong>Do not scan it with your regular phone camera.</strong></li>
          <li>Enter the six-digit code shown in the authenticator app.</li>
          <li>Create your permanent password when prompted.</li>
        </ol>
        <p>Authenticator codes change about every 30 seconds. Keep the SygShift entry in your authenticator app for future sign-ins.</p>
        <p>If you are completing setup on the same phone, keep the SygShift page open and use your phone’s app switcher to move between SygShift and the authenticator app.</p>
        <p>If setup does not work, contact Jordan Brown at <a href="mailto:${safeSupportEmail}">${safeSupportEmail}</a>.</p>
        <p><strong>SygShift</strong><br>Guardianship Security</p>
      `,
    }
  }

  return {
    subject: 'Your SygShift Login Is Ready',
    text: [
      `Hello ${firstName},`,
      'Your SygShift account is ready.',
      `SygShift: ${normalizedAppUrl}`,
      `Username: ${target.username}`,
      `Temporary password: ${temporaryPassword}`,
      'Getting started:',
      '1. Open the SygShift link above.',
      '2. Sign in with your username and temporary password.',
      '3. Create your permanent password when prompted.',
      '4. Confirm that the SygShift Home page opens.',
      'For security, do not share your temporary password.',
      `If sign-in does not work, contact Jordan Brown at ${supportEmail}.`,
      'SygShift',
      'Guardianship Security',
    ].join('\n\n'),
    html: `
      <p>Hello ${safeFirstName},</p>
      <p>Your SygShift account is ready.</p>
      <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin:18px 0; width:100%; max-width:520px;">
        <tr><td style="padding:10px 12px; border:1px solid #e4ddcf; background:#f8f3e9; font-weight:700;">SygShift</td><td style="padding:10px 12px; border:1px solid #e4ddcf;"><a href="${safeUrl}">${safeUrl}</a></td></tr>
        <tr><td style="padding:10px 12px; border:1px solid #e4ddcf; background:#f8f3e9; font-weight:700;">Username</td><td style="padding:10px 12px; border:1px solid #e4ddcf;">${safeUsername}</td></tr>
        <tr><td style="padding:10px 12px; border:1px solid #e4ddcf; background:#f8f3e9; font-weight:700;">Temporary password</td><td style="padding:10px 12px; border:1px solid #e4ddcf; font-family:Consolas, Menlo, monospace;">${safePassword}</td></tr>
      </table>
      <p><strong>Getting started:</strong></p>
      <ol>
        <li>Open the SygShift link above.</li>
        <li>Sign in with your username and temporary password.</li>
        <li>Create your permanent password when prompted.</li>
        <li>Confirm that the SygShift Home page opens.</li>
      </ol>
      <p>For security, do not share your temporary password.</p>
      <p>If sign-in does not work, contact Jordan Brown at <a href="mailto:${safeSupportEmail}">${safeSupportEmail}</a>.</p>
      <p><strong>SygShift</strong><br>Guardianship Security</p>
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
      'Welcome to SygShift, Guardianship Security’s scheduling and timekeeping system.',
      'SygShift gives you one secure place for:',
      '- Viewing your work schedule.',
      '- Clocking in, clocking out, and recording unpaid breaks.',
      '- Reviewing your time card.',
      '- Requesting time off.',
      '- Viewing open shifts and coverage opportunities.',
      '- Receiving company announcements and schedule updates.',
      'Your access is based on your job responsibilities, so you may not see every tool available in SygShift.',
      'You will receive a separate Login Instructions email with your username, temporary password, and the steps required to finish setting up your account.',
      `Open SygShift: ${normalizedAppUrl}`,
      `If you have questions, contact Jordan Brown at ${supportEmail}.`,
      'Jordan Brown',
      'IT and Business Development Engineer',
      'Guardianship Security',
    ].join('\n\n'),
    html: `
      <p>Hello ${safeFirstName},</p>
      <p>Welcome to <strong>SygShift</strong>, Guardianship Security’s scheduling and timekeeping system.</p>
      <p>SygShift gives you one secure place for:</p>
      <ul>
        <li>Viewing your work schedule.</li>
        <li>Clocking in, clocking out, and recording unpaid breaks.</li>
        <li>Reviewing your time card.</li>
        <li>Requesting time off.</li>
        <li>Viewing open shifts and coverage opportunities.</li>
        <li>Receiving company announcements and schedule updates.</li>
      </ul>
      <p>Your access is based on your job responsibilities, so you may not see every tool available in SygShift.</p>
      <p>You will receive a separate <strong>Login Instructions</strong> email with your username, temporary password, and the steps required to finish setting up your account.</p>
      <p><a href="${safeUrl}">Open SygShift</a></p>
      <p>If you have questions, contact Jordan Brown at <a href="mailto:${safeSupportEmail}">${safeSupportEmail}</a>.</p>
      <p><strong>Jordan Brown</strong><br>IT and Business Development Engineer<br>Guardianship Security</p>
    `,
  }
}

function buildPasswordResetEmail(target: LoginEmailTarget, actionLink: string): NotificationJob['message'] {
  const firstName = greetingName(target.displayName)
  const safeFirstName = escapeHtml(firstName)
  const safeActionLink = escapeHtml(actionLink)
  return {
    subject: 'Reset your SygShift password',
    text: [
      `Hello ${firstName},`,
      'A SygShift administrator requested a secure password reset for your account.',
      `Reset your password: ${actionLink}`,
      'This single-use link expires after a short time. If you did not expect this message, contact Jordan Brown before taking action.',
      'SygShift',
      'Guardianship Security',
    ].join('\n\n'),
    html: `
      <p>Hello ${safeFirstName},</p>
      <p>A SygShift administrator requested a secure password reset for your account.</p>
      <p><a href="${safeActionLink}">Reset your SygShift password</a></p>
      <p>This single-use link expires after a short time. If you did not expect this message, contact Jordan Brown before taking action.</p>
      <p><strong>SygShift</strong><br>Guardianship Security</p>
    `,
  }
}

async function sendLoginInstructions(
  environment: Environment,
  target: LoginEmailTarget,
  temporaryPassword: string,
) {
  const to = requireApprovedEmployeeEmail(environment, target)

  const appUrl = environment.SYGSHIFT_PUBLIC_APP_URL?.trim() || defaultAppUrl
  const message = buildLoginInstructionsEmail(target, temporaryPassword, appUrl)
  const result = await sendAuditedEmail(environment, to, message, {
    notificationType: 'login_instructions',
    relatedRecordId: target.employeeId,
    relatedRecordType: 'employee',
  })
  if (result.suppressed.length > 0) {
    throw new ApiError('email_recipient_suppressed', 409, 'Email was suppressed because the recipient domain is temporarily blocked.')
  }
  if (result.failed.length > 0) throw new ApiError('email_delivery_failed', 502, result.failed[0].error)
}

async function sendWelcomeEmail(
  environment: Environment,
  target: LoginEmailTarget,
): Promise<unknown> {
  const to = requireApprovedEmployeeEmail(environment, target)

  const appUrl = environment.SYGSHIFT_PUBLIC_APP_URL?.trim() || defaultAppUrl
  const message = buildWelcomeEmail(target, appUrl)
  const result = await sendAuditedEmail(environment, to, message, {
    notificationType: 'welcome_email',
    relatedRecordId: target.employeeId,
    relatedRecordType: 'employee',
  }, defaultSupportEmail)
  if (result.suppressed.length > 0) {
    throw new ApiError('email_recipient_suppressed', 409, 'Email was suppressed because the recipient domain is temporarily blocked.')
  }
  if (result.failed.length > 0) throw new ApiError('email_delivery_failed', 502, result.failed[0].error)
  return result
}

async function handleAccountMfaRecoveryApi(request: Request, environment: Environment, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
  const session = await requireAuthenticatedSession(request, environment)
  const body = await readJsonBody(request)
  const target = await callRpc<AuthTarget>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_get_employee_auth_target',
    { target_employee_id: session.context.employee_id },
    session.config.serviceRoleKey,
  )
  if (!target?.existingAuthUserId) throw new ApiError('employee_login_missing', 422, 'This employee does not have a login account.')

  const url = new URL(request.url)
  if (url.pathname === '/api/v1/account/mfa-recovery-codes') {
    if (!session.context.has_mfa || accessTokenAssuranceLevel(session.token) !== 'aal2') {
      throw new ApiError('aal2_required', 403, 'Verify your authenticator code before generating recovery codes.')
    }

    const rawCodes = Array.from({ length: 10 }, () => generateRecoveryCode())
    const records: MfaRecoveryCodeRecord[] = await Promise.all(rawCodes.map(async (code) => ({
      hash: await sha256Hex(code),
      hint: `****${code.slice(-4)}`,
    })))
    const batchId = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    await callRpc(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_replace_mfa_recovery_codes',
      {
        target_batch_id: batchId,
        target_codes: records,
        target_employee_id: session.context.employee_id,
        target_expires_at: expiresAt,
        target_request_id: requestId,
      },
      session.config.serviceRoleKey,
    )
    return json({ batchId, codes: rawCodes, expiresAt, requestId })
  }

  if (url.pathname === '/api/v1/account/mfa-recovery') {
    const suppliedCode = typeof body.code === 'string' ? normalizeRecoveryCode(body.code) : ''
    if (!suppliedCode) throw new ApiError('invalid_recovery_code', 422, 'Enter a valid SygShift recovery code.')
    const consumed = await callRpc<{ consumed?: boolean }>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_consume_mfa_recovery_code',
      {
        target_code_hash: await sha256Hex(suppliedCode),
        target_employee_id: session.context.employee_id,
        target_request_id: requestId,
      },
      session.config.serviceRoleKey,
    )
    if (!consumed.consumed) throw new ApiError('invalid_recovery_code', 422, 'The recovery code is invalid, expired, or already used.')

    const factors = await listAuthUserMfaFactors(session.config, target.existingAuthUserId)
    for (const factor of factors) await deleteAuthUserMfaFactor(session.config, target.existingAuthUserId, factor.id)
    const resetRecord = await callRpc<{ trustedDevicesRevoked?: number }>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_record_employee_mfa_reset',
      {
        target_actor_employee_id: session.context.employee_id,
        target_auth_user_id: target.existingAuthUserId,
        target_employee_id: session.context.employee_id,
        target_factor_count: factors.length,
        target_request_id: requestId,
      },
      session.config.serviceRoleKey,
    )
    return json({ factorsRemoved: factors.length, requestId, trustedDevicesRevoked: resetRecord.trustedDevicesRevoked ?? 0 })
  }

  return errorJson('not_found', requestId, 404)
}

function verifiedImageType(bytes: Uint8Array, contentType: string): 'image/jpeg' | 'image/png' | null {
  if (
    contentType === 'image/png'
    && bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return 'image/png'
  if (contentType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  return null
}

function storageObjectUrl(config: { url: string }, path: string): string {
  return `${config.url}/storage/v1/object/employee-photos/${path.split('/').map(encodeURIComponent).join('/')}`
}

async function deleteStoredPhoto(
  config: { serviceRoleKey: string; url: string },
  path: string | null | undefined,
): Promise<void> {
  if (!path) return
  const response = await fetch(storageObjectUrl(config, path), {
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
    },
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 404) throw new Error('The previous profile photo could not be removed.')
}

async function handleMyAccountApi(request: Request, environment: Environment, requestId: string): Promise<Response> {
  const session = await requireAuthenticatedSession(request, environment)
  const url = new URL(request.url)
  const serviceConfig = { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url }

  if (url.pathname === '/api/v1/account/photo') {
    const currentPath = await callRpc<string | null>(
      serviceConfig,
      'service_get_employee_photo_path',
      { target_employee_id: session.context.employee_id },
      session.config.serviceRoleKey,
    )

    if (request.method === 'GET') {
      if (!currentPath) return errorJson('profile_photo_not_found', requestId, 404, 'No profile photo is on file.')
      const stored = await fetch(storageObjectUrl(session.config, currentPath), {
        headers: {
          apikey: session.config.serviceRoleKey,
          authorization: `Bearer ${session.config.serviceRoleKey}`,
        },
      })
      if (!stored.ok) return errorJson('profile_photo_not_found', requestId, 404, 'The profile photo could not be loaded.')
      const headers = new Headers()
      headers.set('cache-control', 'private, no-store')
      headers.set('content-type', stored.headers.get('content-type') || 'application/octet-stream')
      return new Response(stored.body, { headers })
    }

    if (request.method === 'DELETE') {
      await requireMaintenanceWriteAccess(serviceConfig, 'user_accounts')
      await callRpc(
        serviceConfig,
        'service_update_employee_photo',
        { target_employee_id: session.context.employee_id, target_photo_path: null },
        session.config.serviceRoleKey,
      )
      await deleteStoredPhoto(session.config, currentPath).catch(() => undefined)
      return json({ removed: true, requestId })
    }

    if (request.method !== 'PUT') return errorJson('method_not_allowed', requestId, 405)
    await requireMaintenanceWriteAccess(serviceConfig, 'user_accounts')
    const contentLength = Number(request.headers.get('content-length') || 0)
    if (contentLength > 5 * 1024 * 1024) throw new ApiError('profile_photo_too_large', 413, 'Choose a JPG or PNG photo no larger than 5 MB.')
    const suppliedType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || ''
    const buffer = await request.arrayBuffer()
    if (buffer.byteLength === 0 || buffer.byteLength > 5 * 1024 * 1024) {
      throw new ApiError('profile_photo_too_large', 413, 'Choose a JPG or PNG photo no larger than 5 MB.')
    }
    const imageType = verifiedImageType(new Uint8Array(buffer), suppliedType)
    if (!imageType) throw new ApiError('profile_photo_invalid', 422, 'The selected file must be a valid JPG or PNG image.')

    const extension = imageType === 'image/png' ? 'png' : 'jpg'
    const newPath = `${session.context.employee_id}/${crypto.randomUUID()}.${extension}`
    const uploaded = await fetch(storageObjectUrl(session.config, newPath), {
      body: buffer,
      headers: {
        apikey: session.config.serviceRoleKey,
        authorization: `Bearer ${session.config.serviceRoleKey}`,
        'content-type': imageType,
        'x-upsert': 'false',
      },
      method: 'POST',
    })
    if (!uploaded.ok) throw new ApiError('profile_photo_upload_failed', 502, 'The profile photo could not be saved.')

    try {
      await callRpc(
        serviceConfig,
        'service_update_employee_photo',
        { target_employee_id: session.context.employee_id, target_photo_path: newPath },
        session.config.serviceRoleKey,
      )
    } catch (error) {
      await deleteStoredPhoto(session.config, newPath).catch(() => undefined)
      throw error
    }
    await deleteStoredPhoto(session.config, currentPath).catch(() => undefined)
    return json({ saved: true, requestId })
  }

  if (url.pathname === '/api/v1/account/email-verification/request') {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    await requireMaintenanceWriteAccess(serviceConfig, 'user_accounts')
    const body = await readJsonBody(request)
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new ApiError('invalid_personal_email', 422, 'Enter a valid personal email address.')
    }
    if (isBlockedEmailRecipient(environment, email)) {
      throw new ApiError('company_email_not_allowed', 422, 'Use a personal email address. Company-domain delivery is currently disabled.')
    }
    const rawToken = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`
    const tokenHash = await sha256Hex(rawToken)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await callRpc(
      serviceConfig,
      'service_create_email_verification',
      {
        target_email: email,
        target_employee_id: session.context.employee_id,
        target_expires_at: expiresAt,
        target_token_hash: tokenHash,
      },
      session.config.serviceRoleKey,
    )
    const appUrl = environment.SYGSHIFT_PUBLIC_APP_URL?.trim() || defaultAppUrl
    const verificationUrl = `${appUrl}/account?verify=${encodeURIComponent(rawToken)}`
    const delivery = await sendAuditedEmail(environment, email, {
      subject: 'Verify your SygShift personal email',
      text: `Confirm this personal email for your SygShift account: ${verificationUrl}\n\nThis link expires in one hour. If you did not request this change, no action is required.`,
    }, {
      notificationType: 'personal_email_verification',
      relatedRecordId: session.context.employee_id,
      relatedRecordType: 'employee',
    }, defaultSupportEmail)
    if (delivery.failed.length) throw new ApiError('email_delivery_failed', 502, delivery.failed[0].error)
    if (delivery.suppressed.length) throw new ApiError('email_recipient_suppressed', 409, 'That email address cannot receive SygShift messages right now.')
    return json({ expiresAt, requestId, sent: true })
  }

  if (url.pathname === '/api/v1/account/email-verification/confirm') {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    const body = await readJsonBody(request)
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (token.length < 40) throw new ApiError('invalid_verification_token', 422, 'This verification link is invalid or has expired.')
    const verified = await callRpc<{ employeeId?: string }>(
      serviceConfig,
      'service_confirm_email_verification',
      {
        target_employee_id: session.context.employee_id,
        target_token_hash: await sha256Hex(token),
      },
      session.config.serviceRoleKey,
    )
    if (verified.employeeId !== session.context.employee_id) {
      throw new ApiError('verification_account_mismatch', 403, 'Sign in to the account that requested this email change.')
    }
    return json({ requestId, verified: true })
  }

  return errorJson('not_found', requestId, 404)
}

async function handleAdminUsersApi(request: Request, environment: Environment, requestId: string): Promise<Response> {
  const url = new URL(request.url)
  const isNewUserInviteRequest = url.pathname === '/api/v1/admin/users/login-emails'
    || /^\/api\/v1\/admin\/users\/[0-9a-f-]{36}\/(?:login-email|welcome-email)$/i.test(url.pathname)
  let admin: Awaited<ReturnType<typeof requireAdminMfa>>
  try {
    admin = await requireAdminMfa(
      request,
      environment,
      isNewUserInviteRequest ? 'admin.users.invite' : 'admin.users.manage',
    )
  } catch (error) {
    if (error instanceof Response) {
      const payload = await error.json().catch(() => ({ error: 'auth_failed' })) as { error?: string }
      return errorJson(payload.error ?? 'auth_failed', requestId, error.status)
    }
    throw error
  }

  await requireMaintenanceWriteAccess(
    { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
    'user_accounts',
  )

  const body = await readJsonBody(request)
  let usersByEmail: Map<string, AuthUser> | null = null
  const getUsersByEmail = async () => {
    if (!usersByEmail) {
      usersByEmail = new Map(
        (await listAuthUsers(admin.config)).map((user) => [String(user.email).toLowerCase(), user]),
      )
    }
    return usersByEmail
  }

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
        const result = await provisionOne(admin.config, target, generateTemporaryPassword(), await getUsersByEmail())
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
        requireApprovedEmployeeEmail(environment, target)
        const result = await provisionOne(admin.config, target, generateTemporaryPassword(), await getUsersByEmail())
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
    requireApprovedEmployeeEmail(environment, target)

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

    const result = await provisionOne(admin.config, target, suppliedPassword || generateTemporaryPassword(), await getUsersByEmail())
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

  const passwordResetMatch = /^\/api\/v1\/admin\/users\/([0-9a-f-]{36})\/password-reset$/i.exec(url.pathname)
  if (passwordResetMatch) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)

    const target = await callRpc<LoginEmailTarget>(
      { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
      'service_get_employee_login_email_target',
      { target_employee_id: passwordResetMatch[1] },
      admin.config.serviceRoleKey,
    )
    if (!target?.existingAuthUserId) {
      throw new ApiError('employee_login_missing', 422, 'This employee does not have an active login account to reset.')
    }
    const recipient = requireApprovedEmployeeEmail(environment, target)
    const appUrl = (environment.SYGSHIFT_PUBLIC_APP_URL?.trim() || defaultAppUrl).replace(/\/+$/, '')
    const generated = await supabaseJson<{ action_link?: string }>(`${admin.config.url}/auth/v1/admin/generate_link`, {
      body: JSON.stringify({
        email: target.authEmail,
        redirect_to: `${appUrl}/account-security?mode=password-recovery`,
        type: 'recovery',
      }),
      headers: {
        apikey: admin.config.serviceRoleKey,
        authorization: `Bearer ${admin.config.serviceRoleKey}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    })
    if (!generated.action_link) throw new ApiError('password_reset_link_failed', 502, 'A secure password-reset link could not be generated.')

    const delivery = await sendAuditedEmail(environment, recipient, buildPasswordResetEmail(target, generated.action_link), {
      notificationType: 'password_reset',
      relatedRecordId: target.employeeId,
      relatedRecordType: 'employee',
    }, defaultSupportEmail)
    if (delivery.suppressed.length > 0) throw new ApiError('email_recipient_suppressed', 409, 'The reset email was suppressed by the active recipient safeguards.')
    if (delivery.failed.length > 0) throw new ApiError('email_delivery_failed', 502, delivery.failed[0].error)

    const maskedEmail = maskEmailAddress(recipient)
    await callRpc(
      { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
      'service_record_employee_password_reset',
      {
        target_actor_employee_id: admin.context.employee_id,
        target_auth_user_id: target.existingAuthUserId,
        target_delivery_email_masked: maskedEmail,
        target_employee_id: target.employeeId,
        target_request_id: requestId,
      },
      admin.config.serviceRoleKey,
    )

    return json({
      displayName: target.displayName,
      email: maskedEmail,
      requestId,
      username: target.username,
    })
  }

  const mfaResetMatch = /^\/api\/v1\/admin\/users\/([0-9a-f-]{36})\/mfa-reset$/i.exec(url.pathname)
  if (mfaResetMatch) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)

    const target = await callRpc<AuthTarget>(
      { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
      'service_get_employee_auth_target',
      { target_employee_id: mfaResetMatch[1] },
      admin.config.serviceRoleKey,
    )
    if (!target?.existingAuthUserId) {
      throw new ApiError('employee_login_missing', 422, 'This employee does not have a login account to reset.')
    }

    const factors = await listAuthUserMfaFactors(admin.config, target.existingAuthUserId)
    for (const factor of factors) {
      await deleteAuthUserMfaFactor(admin.config, target.existingAuthUserId, factor.id)
    }

    const recoveryCodesRevoked = await callRpc<number>(
      { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
      'service_revoke_mfa_recovery_codes',
      {
        target_actor_employee_id: admin.context.employee_id,
        target_employee_id: target.employeeId,
        target_request_id: requestId,
      },
      admin.config.serviceRoleKey,
    )

    const resetRecord = await callRpc<{ trustedDevicesRevoked?: number }>(
      { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
      'service_record_employee_mfa_reset',
      {
        target_actor_employee_id: admin.context.employee_id,
        target_auth_user_id: target.existingAuthUserId,
        target_employee_id: target.employeeId,
        target_factor_count: factors.length,
        target_request_id: requestId,
      },
      admin.config.serviceRoleKey,
    )

    return json({
      displayName: target.displayName,
      factorsRemoved: factors.length,
      recoveryCodesRevoked,
      requestId,
      trustedDevicesRevoked: resetRecord.trustedDevicesRevoked ?? 0,
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
  const result = await provisionOne(admin.config, target, password, await getUsersByEmail())

  return json({
    action: result.action,
    displayName: target.displayName,
    requestId,
    role: target.role,
    temporaryPassword: result.password,
    username: target.username,
  })
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

function formatDate(value: string): string {
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'America/Denver',
    year: 'numeric',
  }).format(date)
}

function formatReportDateTime(value: string | null, timeZone: string): string {
  if (!value) return 'Not tied to a scheduled shift'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const civilian = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(date)
  const military = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZone,
  }).format(date)
  return `${civilian} (${military})`
}

function attendanceEventLabel(eventType: AttendanceReportPayload['eventType']): string {
  return eventType === 'called_in_sick' ? 'called in sick' : 'reported a call-off'
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

async function handleAttendanceReportApi(request: Request, environment: Environment, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)

  let session: Awaited<ReturnType<typeof requireAuthenticatedSession>>
  try {
    session = await requireAuthenticatedSession(request, environment)
  } catch (error) {
    if (error instanceof Response) {
      const payload = await error.json().catch(() => ({ error: 'auth_failed' })) as { error?: string }
      return errorJson(payload.error ?? 'auth_failed', requestId, error.status)
    }
    throw error
  }

  const body = await readJsonBody(request)
  const eventType = typeof body.eventType === 'string' ? body.eventType.trim() : ''
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  const shiftId = typeof body.shiftId === 'string' && body.shiftId.trim() ? body.shiftId.trim() : null
  const operationalDate = typeof body.operationalDate === 'string' && body.operationalDate.trim()
    ? body.operationalDate.trim()
    : null

  if (eventType !== 'called_in_sick' && eventType !== 'call_off') {
    return errorJson('invalid_attendance_event_type', requestId, 400, 'Choose Sick or Call-off.')
  }
  if (!note) return errorJson('attendance_note_required', requestId, 400, 'A short note is required.')
  if (note.length > 2000) return errorJson('attendance_note_too_long', requestId, 400, 'The note is too long.')

  const additionalHeaders = request.headers.get('x-sygshift-trusted-device')
    ? { 'x-sygshift-trusted-device': request.headers.get('x-sygshift-trusted-device')! }
    : undefined

  const report = await callRpc<AttendanceReportPayload>(
    { publishableKey: session.config.publishableKey, url: session.config.url },
    'report_attendance_accountability_event',
    {
      target_event_type: eventType,
      target_note: note,
      target_operational_date: operationalDate,
      target_shift_id: shiftId,
    },
    session.token,
    additionalHeaders,
  )

  let dispatchNotified = false
  let dispatchError: string | null = null

  try {
    const location = [report.siteCode, report.siteName, report.postName ?? report.eventName]
      .filter(Boolean)
      .join(' / ') || report.locationName
    const subject = `SygShift attendance alert: ${report.employeeName}`
    const text = [
      `${report.employeeName} ${attendanceEventLabel(report.eventType)} in SygShift.`,
      '',
      `Employee: ${report.employeeName} (@${report.username})`,
      `Date: ${formatDate(report.operationalDate)}`,
      `Location: ${location}`,
      `Shift: ${formatReportDateTime(report.startsAt, report.timeZone)} - ${formatReportDateTime(report.endsAt, report.timeZone)}`,
      `Note: ${report.note}`,
      '',
      'This alert was sent automatically so Dispatch can review coverage immediately.',
    ].join('\n')
    const html = [
      `<p><strong>${escapeHtml(report.employeeName)}</strong> ${escapeHtml(attendanceEventLabel(report.eventType))} in SygShift.</p>`,
      '<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%; border-collapse:collapse; margin:16px 0;">',
      `<tr><td style="padding:8px 0; color:#6d665c;">Employee</td><td style="padding:8px 0; font-weight:700;">${escapeHtml(report.employeeName)} (@${escapeHtml(report.username)})</td></tr>`,
      `<tr><td style="padding:8px 0; color:#6d665c;">Date</td><td style="padding:8px 0; font-weight:700;">${escapeHtml(formatDate(report.operationalDate))}</td></tr>`,
      `<tr><td style="padding:8px 0; color:#6d665c;">Location</td><td style="padding:8px 0; font-weight:700;">${escapeHtml(location)}</td></tr>`,
      `<tr><td style="padding:8px 0; color:#6d665c;">Shift</td><td style="padding:8px 0; font-weight:700;">${escapeHtml(formatReportDateTime(report.startsAt, report.timeZone))} - ${escapeHtml(formatReportDateTime(report.endsAt, report.timeZone))}</td></tr>`,
      `<tr><td style="padding:8px 0; color:#6d665c;">Note</td><td style="padding:8px 0; font-weight:700;">${escapeHtml(report.note)}</td></tr>`,
      '</table>',
      '<p>This alert was sent automatically so Dispatch can review coverage immediately.</p>',
    ].join('')

    const delivery = await sendAuditedEmail(
      environment,
      dispatchAlertEmail,
      { html, subject, text },
      { notificationType: 'attendance_call_off', relatedRecordId: report.id, relatedRecordType: 'attendance_accountability_event' },
      defaultSupportEmail,
    )
    dispatchNotified = delivery.sent.length > 0
    dispatchError = delivery.suppressed.length > 0
      ? 'Suppressed — Blocked Domain'
      : delivery.failed[0]?.error ?? null
  } catch (error) {
    dispatchError = error instanceof Error ? error.message : 'Dispatch email delivery failed.'
  }

  await callRpc<unknown>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_mark_attendance_accountability_dispatch_result',
    {
      delivered: dispatchNotified,
      delivery_error: dispatchError,
      target_event_id: report.id,
    },
    session.config.serviceRoleKey,
  )

  return json({
    ...report,
    dispatchError,
    dispatchNotified,
    requestId,
  }, dispatchNotified ? 200 : 202)
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

  if (!operator.context.permissions?.some((permission) => permission === 'notifications.manage' || permission === 'announcements.send')) {
    return errorJson('operations_mfa_required', requestId, 403)
  }

  await requireMaintenanceWriteAccess(
    { serviceRoleKey: operator.config.serviceRoleKey, url: operator.config.url },
    'communications',
  )

  const processing = await processNotificationJobs(environment, 10)

  return json({
    ...processing,
    requestId,
    requestedBy: operator.context.username,
  })
}

async function processNotificationJobs(environment: Environment, limit = 10): Promise<{
  delivered: string[]
  failed: Array<{ id: string, error: string }>
  processed: number
  suppressed: string[]
}> {
  const config = configuredSupabase(environment)
  if (!config) throw new ApiError('server_not_configured', 503, 'The protected data service is not configured.')
  if (!environment.EMAIL) throw new ApiError('email_not_configured', 503, 'Cloudflare Email Sending is not configured for this Worker.')

  const timekeepingJobs = await callRpc<NotificationJob[]>(
    { serviceRoleKey: config.serviceRoleKey, url: config.url },
    'service_claim_timekeeping_notification_batch',
    { target_limit: limit },
    config.serviceRoleKey,
  )
  const delivered: string[] = []
  const failed: Array<{ id: string, error: string }> = []
  const suppressed: string[] = []

  const deliverJobs = async (jobs: NotificationJob[], respectEmployeePreferences = false) => {
    for (const job of jobs) {
      try {
        let recipients = [...new Set(job.recipients.map((recipient) => recipient.trim().toLowerCase()).filter(Boolean))]
        if (job.messageType === 'announcement_published' && job.aggregateId) {
          recipients = await callRpc<string[]>(
            { serviceRoleKey: config.serviceRoleKey, url: config.url },
            'service_get_announcement_email_recipients',
            { target_announcement_id: job.aggregateId },
            config.serviceRoleKey,
          )
        }
        if (respectEmployeePreferences && recipients.length > 0) {
          recipients = await callRpc<string[]>(
            { serviceRoleKey: config.serviceRoleKey, url: config.url },
            'service_filter_notification_recipients',
            {
              target_aggregate_id: job.aggregateId ?? null,
              target_message_type: job.messageType ?? 'outbox_notification',
              target_recipients: recipients,
            },
            config.serviceRoleKey,
          )
        }
        if (recipients.length === 0) {
          await callRpc<unknown>(
            { serviceRoleKey: config.serviceRoleKey, url: config.url },
            'service_mark_notification_suppressed',
            { target_notification_id: job.id, target_reason: 'Suppressed — Employee Preference' },
            config.serviceRoleKey,
          )
          suppressed.push(job.id)
          continue
        }

        const delivery = await sendAuditedEmail(environment, recipients, job.message, {
          notificationType: job.messageType ?? 'outbox_notification',
          relatedRecordId: job.aggregateId ?? null,
          relatedRecordType: job.aggregateType ?? null,
        })
        if (delivery.failed.length > 0) throw new Error(delivery.failed.map((item) => `${item.recipient}: ${item.error}`).join('; '))
        if (delivery.sent.length === 0 && delivery.suppressed.length > 0) {
          await callRpc<unknown>(
            { serviceRoleKey: config.serviceRoleKey, url: config.url },
            'service_mark_notification_suppressed',
            { target_notification_id: job.id, target_reason: 'Suppressed — Blocked Domain' },
            config.serviceRoleKey,
          )
          suppressed.push(job.id)
          continue
        }

        await callRpc<unknown>(
          { serviceRoleKey: config.serviceRoleKey, url: config.url },
          'service_mark_notification_result',
          { delivered: true, delivery_error: null, target_notification_id: job.id },
          config.serviceRoleKey,
        )
        delivered.push(job.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Email delivery failed.'
        await callRpc<unknown>(
          { serviceRoleKey: config.serviceRoleKey, url: config.url },
          'service_mark_notification_result',
          { delivered: false, delivery_error: message, target_notification_id: job.id },
          config.serviceRoleKey,
        )
        failed.push({ id: job.id, error: message })
      }
    }
  }

  await deliverJobs(timekeepingJobs)

  const timeOffJobs = await callRpc<NotificationJob[]>(
    { serviceRoleKey: config.serviceRoleKey, url: config.url },
    'service_claim_time_off_notification_batch',
    { target_limit: limit },
    config.serviceRoleKey,
  )
  await deliverJobs(timeOffJobs, true)

  const generalJobs = await callRpc<NotificationJob[]>(
    { serviceRoleKey: config.serviceRoleKey, url: config.url },
    'service_claim_notification_batch',
    { target_limit: limit },
    config.serviceRoleKey,
  )
  await deliverJobs(generalJobs, true)

  return {
    delivered,
    failed,
    processed: delivered.length + failed.length + suppressed.length,
    suppressed,
  }
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
    } else if (
      url.pathname === '/api/v1/account/photo'
      || url.pathname.startsWith('/api/v1/account/email-verification/')
    ) {
      try {
        response = await handleMyAccountApi(request, environment, requestId)
      } catch (error) {
        if (error instanceof Response) {
          const payload = await error.json().catch(() => ({ error: 'auth_required' })) as { error?: string }
          response = errorJson(payload.error ?? 'auth_required', requestId, error.status)
        } else {
          response = error instanceof ApiError
            ? errorJson(error.code, requestId, error.status, error.message)
            : errorJson('account_request_failed', requestId, 500, 'Your account request could not be completed.')
        }
      }
    } else if (url.pathname.startsWith('/api/v1/account/mfa-recovery')) {
      try {
        response = await handleAccountMfaRecoveryApi(request, environment, requestId)
      } catch (error) {
        response = error instanceof ApiError
          ? errorJson(error.code, requestId, error.status, error.message)
          : errorJson('mfa_recovery_request_failed', requestId, 500, 'The MFA recovery request failed.')
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
      } catch (error) {
        response = error instanceof ApiError
          ? errorJson(error.code, requestId, error.status, error.message)
          : errorJson('notification_process_failed', requestId, 500, 'The notification delivery request failed.')
      }
    } else if (url.pathname === '/api/v1/time/attendance/report') {
      try {
        response = await handleAttendanceReportApi(request, environment, requestId)
      } catch (error) {
        response = error instanceof ApiError
          ? errorJson(error.code, requestId, error.status, error.message)
          : errorJson('attendance_report_failed', requestId, 500, 'The attendance report request failed.')
      }
    } else if (url.pathname.startsWith('/api/')) {
      response = json({ error: 'not_found', requestId }, 404)
    } else {
      response = await environment.ASSETS.fetch(request)
    }

    return secureResponse(request, response, requestId)
  },
  async scheduled(
    controller: WorkerScheduledController,
    environment: Environment,
    context: WorkerExecutionContext,
  ): Promise<void> {
    context.waitUntil((async () => {
      const config = configuredSupabase(environment)
      if (!config) throw new Error('Scheduled timekeeping automation is missing its protected data configuration.')
      const jobRunId = crypto.randomUUID()
      const automation = await callRpc<Record<string, unknown>>(
        { serviceRoleKey: config.serviceRoleKey, url: config.url },
        'service_run_timekeeping_automation',
        { target_job_run_id: jobRunId },
        config.serviceRoleKey,
      )
      const denverTimeParts = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        hourCycle: 'h23',
        minute: '2-digit',
        timeZone: 'America/Denver',
      }).formatToParts(new Date(controller.scheduledTime))
      const denverHour = denverTimeParts.find((part) => part.type === 'hour')?.value
      const denverMinute = denverTimeParts.find((part) => part.type === 'minute')?.value
      const fullReconciliation = denverHour === '02' && denverMinute === '00'
      const alertLifecycle = await callRpc<Record<string, unknown>>(
        { serviceRoleKey: config.serviceRoleKey, url: config.url },
        'service_reconcile_operational_alert_lifecycle',
        { target_full_reconciliation: fullReconciliation },
        config.serviceRoleKey,
      )
      const scheduledAnnouncements = await callRpc<Record<string, unknown>>(
        { serviceRoleKey: config.serviceRoleKey, url: config.url },
        'service_publish_due_announcement_work_items',
        { target_limit: 25 },
        config.serviceRoleKey,
      )
      const notifications = await processNotificationJobs(environment, 25)
      console.info(JSON.stringify({ alertLifecycle, automation, cron: controller.cron, fullReconciliation, jobRunId, notifications, scheduledAnnouncements, scheduledTime: controller.scheduledTime }))
    })())
  },
}
