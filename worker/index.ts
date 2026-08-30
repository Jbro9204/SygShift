/* oxlint-disable typescript/triple-slash-reference -- Wrangler emits global binding declarations. */
/// <reference path="./bindings.d.ts" />
/// <reference path="../worker-configuration.d.ts" />
/* oxlint-enable typescript/triple-slash-reference */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { strFromU8, unzipSync } from 'fflate'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server'
import { isSecurityKeyPilotEligible, securityKeyFeatureEnabled } from './securityKeyPilot'

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
  SYGSHIFT_SECURITY_KEYS_ENABLED?: string
  SYGSHIFT_SECURITY_KEY_PILOT_USERNAMES?: string
  SYGSHIFT_DOCUMENT_PIPELINE_ENABLED?: string
  SYGSHIFT_DOCUMENT_SCANNER_SECRET?: string
  SYGSHIFT_HR_AUTOMATION_ENABLED?: string
  SYGSHIFT_HR_RECRUITING_ENABLED?: string
  SYGSHIFT_HR_ONBOARDING_ENABLED?: string
  SYGSHIFT_HR_LEAVE_ENABLED?: string
  SYGSHIFT_HR_BENEFITS_ENABLED?: string
  SYGSHIFT_HR_COMPENSATION_ENABLED?: string
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

interface SecurityKeyCredentialRecord {
  id: string
  credentialId: string
  publicKey: string
  counter: number
  transports: AuthenticatorTransportFuture[]
  deviceType: string | null
  backedUp: boolean
  label: string
  createdAt: string
  lastUsedAt: string | null
}

interface SecurityKeyChallengeRecord {
  id: string
  challenge: string
  expiresAt: string
}

interface AccessTokenClaims {
  aal?: string
  amr?: Array<{ method?: string, timestamp?: number }>
  exp?: number
  session_id?: string
}

interface HrDocumentUploadMetadata {
  accessClassification: 'confidential' | 'restricted' | 'highly_restricted'
  category: string
  declaredMimeType: string
  description: string
  documentId: string | null
  employeeId: string
  idempotencyKey: string
  originalFilename: string
  replacementReason: string | null
  title: string
  vaultCode: string
}

interface HrDocumentUploadOperation {
  bucket: string
  documentId: string
  objectKey: string
  operationId: string
  state: string
  versionId: string
}

interface HrDocumentAccessGrant {
  expiresAt: string
  grantId: string
}

interface HrDocumentAccessObject {
  action: 'preview' | 'view' | 'download'
  bucket: string
  documentId: string
  filename: string
  mimeType: string
  objectKey: string
  versionId: string
}

interface HrDocumentWorkspacePayload {
  actor?: { canManageAny?: boolean }
  documents?: unknown[]
  employees?: unknown[]
  pagination?: Record<string, unknown>
  releaseState?: string
  vaults?: unknown[]
}

interface HrDocumentWorkflowPayload {
  assignments?: unknown[]
  pagination?: Record<string, unknown>
  releaseState?: string
  requests?: unknown[]
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
const maxWebAuthnBodyBytes = 64 * 1024
const maxHrDocumentBytes = 25 * 1024 * 1024
const maxHrDocumentMetadataBytes = 16 * 1024
const recentDocumentMfaSeconds = 15 * 60
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

async function readWebAuthnBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {}
  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > maxWebAuthnBodyBytes) {
    throw new ApiError('request_body_too_large', 413, 'The security-key response is too large.')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).length > maxWebAuthnBodyBytes) {
    throw new ApiError('request_body_too_large', 413, 'The security-key response is too large.')
  }
  if (!text.trim()) return {}
  try {
    const payload = JSON.parse(text) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid object')
    return payload as Record<string, unknown>
  } catch {
    throw new ApiError('invalid_json', 400, 'The request body must be a valid JSON object.')
  }
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

function buildSecurityKeyChangeEmail(
  target: LoginEmailTarget,
  action: 'added' | 'removed',
  label: string,
  appUrl: string,
): NotificationJob['message'] {
  const verb = action === 'added' ? 'added to' : 'removed from'
  const subject = action === 'added' ? 'Security key added to your SygShift account' : 'Security key removed from your SygShift account'
  const safeLabel = label.trim() || 'Security key'
  return {
    subject,
    text: [
      `Hello ${target.displayName},`,
      '',
      `The security key “${safeLabel}” was ${verb} your SygShift account.`,
      '',
      'If you made this change, no action is needed.',
      'If you did not make this change, contact an administrator immediately and reset your password.',
      '',
      `Review your account security: ${appUrl}/my-account?tab=security`,
    ].join('\n'),
  }
}

async function sendSecurityKeyChangeNotice(
  environment: Environment,
  employeeId: string,
  action: 'added' | 'removed',
  label: string,
  keyId: string,
): Promise<void> {
  const config = configuredSupabase(environment)
  if (!config) return
  try {
    const target = await callRpc<LoginEmailTarget>(
      { serviceRoleKey: config.serviceRoleKey, url: config.url },
      'service_get_employee_login_email_target',
      { target_employee_id: employeeId },
      config.serviceRoleKey,
    )
    if (!target) return
    const recipient = requireApprovedEmployeeEmail(environment, target)
    const appUrl = (environment.SYGSHIFT_PUBLIC_APP_URL?.trim() || defaultAppUrl).replace(/\/+$/, '')
    const delivery = await sendAuditedEmail(
      environment,
      recipient,
      buildSecurityKeyChangeEmail(target, action, label, appUrl),
      {
        notificationType: action === 'added' ? 'security_key_added' : 'security_key_removed',
        relatedRecordId: keyId,
        relatedRecordType: 'security_key',
      },
      defaultSupportEmail,
    )
    if (delivery.failed.length > 0) {
      console.warn(JSON.stringify({ event: 'security_key_notice_failed', employeeId, keyId }))
    }
  } catch {
    // Account-security changes must not be rolled back because an optional notice could not be delivered.
    console.warn(JSON.stringify({ event: 'security_key_notice_unavailable', employeeId, keyId }))
  }
}

async function requireAdminMfa(
  request: Request,
  environment: Environment,
  requiredPermission: 'admin.users.manage' | 'admin.users.invite' = 'admin.users.manage',
): Promise<{
  config: NonNullable<ReturnType<typeof configuredSupabase>>
  context: SessionContext
  token: string
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

function forwardedAssuranceHeaders(request: Request): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  const trustedDevice = request.headers.get('x-sygshift-trusted-device')
  const securityKey = request.headers.get('x-sygshift-security-key')
  if (trustedDevice) headers['x-sygshift-trusted-device'] = trustedDevice
  if (securityKey) headers['x-sygshift-security-key'] = securityKey
  return Object.keys(headers).length > 0 ? headers : undefined
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
    forwardedAssuranceHeaders(request),
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
    forwardedAssuranceHeaders(request),
  )
  const context = Array.isArray(payload) ? payload[0] : payload

  if (!context || !context.has_mfa) {
    throw new Response(JSON.stringify({ error: mfaError }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      status: 403,
    })
  }

  return { config, context, token }
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

function accessTokenClaims(token: string): AccessTokenClaims | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const normalized = payload.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const decoded = JSON.parse(atob(normalized)) as AccessTokenClaims
    return decoded && typeof decoded === 'object' ? decoded : null
  } catch {
    return null
  }
}

function accessTokenAssuranceLevel(token: string): string | null {
  const aal = accessTokenClaims(token)?.aal
  return typeof aal === 'string' ? aal : null
}

function requireRawAal2(token: string): AccessTokenClaims {
  const claims = accessTokenClaims(token)
  if (!claims || claims.aal !== 'aal2') {
    throw new ApiError('aal2_required', 403, 'Verify your authenticator code before managing security keys.')
  }
  return claims
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function generateOpaqueToken(size = 48): string {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  return encodeBase64Url(bytes)
}

function expectedWebAuthnOrigins(request: Request): string[] {
  const current = new URL(request.url)
  if (isLocalDevelopment(current.hostname)) return [current.origin]
  if (current.hostname === 'app.sygilant.us') return ['https://app.sygilant.us']
  throw new ApiError('security_key_origin_not_allowed', 403, 'Security keys are available only at the official SygShift address.')
}

function webAuthnRpId(request: Request): string {
  const hostname = new URL(request.url).hostname
  if (hostname === 'app.sygilant.us') return 'sygilant.us'
  if (isLocalDevelopment(hostname)) return hostname
  throw new ApiError('security_key_origin_not_allowed', 403, 'Security keys are not available from this site address.')
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

async function sha256BytesHex(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value)
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hrDocumentPipelineEnabled(environment: Environment): boolean {
  return environment.SYGSHIFT_DOCUMENT_PIPELINE_ENABLED?.trim().toLowerCase() === 'true'
}

function requireHrDocumentPipeline(environment: Environment): void {
  if (!hrDocumentPipelineEnabled(environment)) {
    throw new ApiError('hr_document_pipeline_unavailable', 503, 'The secure HR document workspace has not been released.')
  }
}

function hrAutomationEnabled(environment: Environment): boolean {
  return environment.SYGSHIFT_HR_AUTOMATION_ENABLED?.trim().toLowerCase() === 'true'
}

function requireHrAutomationRelease(environment: Environment): void {
  if (!hrAutomationEnabled(environment)) {
    throw new ApiError('hr_automation_unavailable', 503, 'The HR automation workspace has not been released.')
  }
}

function hrRecruitingEnabled(environment: Environment): boolean {
  return environment.SYGSHIFT_HR_RECRUITING_ENABLED?.trim().toLowerCase() === 'true'
}

function requireHrRecruitingRelease(environment: Environment): void {
  if (!hrRecruitingEnabled(environment)) {
    throw new ApiError('hr_recruiting_unavailable', 503, 'The Recruiting workspace has not been released.')
  }
}

function hrOnboardingEnabled(environment: Environment): boolean {
  return environment.SYGSHIFT_HR_ONBOARDING_ENABLED?.trim().toLowerCase() === 'true'
}

function requireHrOnboardingRelease(environment: Environment): void {
  if (!hrOnboardingEnabled(environment)) {
    throw new ApiError('hr_onboarding_unavailable', 503, 'The Onboarding workspace has not been released.')
  }
}

function hrLeaveEnabled(environment: Environment): boolean {
  return environment.SYGSHIFT_HR_LEAVE_ENABLED?.trim().toLowerCase() === 'true'
}

function hrBenefitsEnabled(environment: Environment): boolean {
  return environment.SYGSHIFT_HR_BENEFITS_ENABLED?.trim().toLowerCase() === 'true'
}

function hrCompensationEnabled(environment: Environment): boolean {
  return environment.SYGSHIFT_HR_COMPENSATION_ENABLED?.trim().toLowerCase() === 'true'
}

function requireSessionPermission(context: SessionContext, permission: string): void {
  if (context.permissions?.includes(permission) !== true) {
    throw new ApiError('permission_required', 403, 'The required permission is missing.')
  }
}

function normalizedMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function fileExtension(filename: string): string {
  const lastSegment = filename.trim().split(/[\\/]/).at(-1) ?? ''
  const separator = lastSegment.lastIndexOf('.')
  return separator > 0 ? lastSegment.slice(separator + 1).toLowerCase() : ''
}

export function sanitizeHrDocumentFilename(filename: string): string {
  const lastSegment = filename.normalize('NFKC').trim().split(/[\\/]/).at(-1) ?? ''
  const cleaned = [...lastSegment]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if (!cleaned || cleaned.length > 180) {
    throw new ApiError('invalid_document_filename', 400, 'Use a valid file name no longer than 180 characters.')
  }
  return cleaned
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function hasSignature(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value)
}

function inspectOfficeZip(bytes: Uint8Array): { entryNames: string[], detectedMimeType: string } {
  let eocd = -1
  const minimum = Math.max(0, bytes.length - 65_557)
  for (let index = bytes.length - 22; index >= minimum; index -= 1) {
    if (u32(bytes, index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new ApiError('invalid_office_document', 400, 'The Office file is malformed or encrypted.')

  const entryCount = u16(bytes, eocd + 10)
  const centralDirectoryOffset = u32(bytes, eocd + 16)
  if (entryCount < 1 || entryCount > 500 || centralDirectoryOffset >= bytes.length) {
    throw new ApiError('unsafe_office_document', 400, 'The Office file contains an unsafe archive structure.')
  }

  const names: string[] = []
  let totalUncompressed = 0
  let offset = centralDirectoryOffset
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) {
      throw new ApiError('invalid_office_document', 400, 'The Office file directory is malformed.')
    }
    const flags = u16(bytes, offset + 8)
    const uncompressedSize = u32(bytes, offset + 24)
    const filenameLength = u16(bytes, offset + 28)
    const extraLength = u16(bytes, offset + 30)
    const commentLength = u16(bytes, offset + 32)
    if ((flags & 0x0001) !== 0 || uncompressedSize > 50 * 1024 * 1024) {
      throw new ApiError('unsafe_office_document', 400, 'Encrypted or oversized Office content is not allowed.')
    }
    totalUncompressed += uncompressedSize
    if (totalUncompressed > 100 * 1024 * 1024) {
      throw new ApiError('unsafe_office_document', 400, 'The Office file expands beyond the safe processing limit.')
    }
    const nameStart = offset + 46
    const nameEnd = nameStart + filenameLength
    if (nameEnd > bytes.length) throw new ApiError('invalid_office_document', 400, 'The Office file directory is malformed.')
    names.push(strFromU8(bytes.subarray(nameStart, nameEnd)).replaceAll('\\', '/').toLowerCase())
    offset = nameEnd + extraLength + commentLength
  }

  const disallowedPath = names.find((name) => (
    name.endsWith('/vbaproject.bin')
    || name.includes('/activex/')
    || name.includes('/embeddings/')
    || name.includes('/oleobject')
    || name.includes('/externallinks/')
    || name.includes('/customui/')
  ))
  if (disallowedPath) throw new ApiError('active_content_not_allowed', 400, 'Macro, embedded, or external Office content is not allowed.')

  let archive: Record<string, Uint8Array>
  try {
    archive = unzipSync(bytes)
  } catch {
    throw new ApiError('invalid_office_document', 400, 'The Office file could not be safely opened.')
  }
  for (const [name, contents] of Object.entries(archive)) {
    if (!name.toLowerCase().endsWith('.rels')) continue
    const relationshipXml = strFromU8(contents).toLowerCase()
    if (/targetmode\s*=\s*["']external["']/.test(relationshipXml)) {
      throw new ApiError('external_content_not_allowed', 400, 'Office documents with external relationships are not allowed.')
    }
  }

  const isDocx = names.includes('word/document.xml')
  const isXlsx = names.includes('xl/workbook.xml')
  if (isDocx === isXlsx) throw new ApiError('invalid_office_document', 400, 'The Office file type could not be verified.')
  return {
    detectedMimeType: isDocx
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    entryNames: names,
  }
}

export function validateHrDocumentFile(
  bytes: Uint8Array,
  originalFilename: string,
  declaredMimeType: string,
): { detectedMimeType: string, extension: string, sanitizedFilename: string } {
  if (bytes.byteLength < 1 || bytes.byteLength > maxHrDocumentBytes) {
    throw new ApiError('invalid_document_size', 413, 'Documents must be between 1 byte and 25 MB.')
  }
  const sanitizedFilename = sanitizeHrDocumentFilename(originalFilename)
  const extension = fileExtension(sanitizedFilename)
  const declared = normalizedMimeType(declaredMimeType)
  const allowedByExtension: Record<string, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    pdf: 'application/pdf',
    png: 'image/png',
    txt: 'text/plain',
    webp: 'image/webp',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  const expected = allowedByExtension[extension]
  if (!expected) throw new ApiError('document_type_not_allowed', 400, 'This document type is not allowed.')

  let detectedMimeType = ''
  if (hasSignature(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    detectedMimeType = 'application/pdf'
    const pdfText = strFromU8(bytes.subarray(0, Math.min(bytes.length, 5 * 1024 * 1024)), true)
    if (/\/(javascript|js|launch|embeddedfile|openaction|aa|richmedia)\b/i.test(pdfText)) {
      throw new ApiError('active_content_not_allowed', 400, 'PDF files with scripts, launch actions, or embedded content are not allowed.')
    }
  } else if (hasSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    detectedMimeType = 'image/png'
  } else if (hasSignature(bytes, [0xff, 0xd8, 0xff])) {
    detectedMimeType = 'image/jpeg'
  } else if (
    hasSignature(bytes, [0x52, 0x49, 0x46, 0x46])
    && hasSignature(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    detectedMimeType = 'image/webp'
  } else if (hasSignature(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    detectedMimeType = inspectOfficeZip(bytes).detectedMimeType
  } else if (extension === 'txt') {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new ApiError('invalid_text_document', 400, 'Text documents must use UTF-8 encoding.')
    }
    const hasBinaryControlData = [...text].some((character) => {
      const code = character.charCodeAt(0)
      return code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)
    })
    if (hasBinaryControlData) {
      throw new ApiError('invalid_text_document', 400, 'Text documents cannot contain binary control data.')
    }
    detectedMimeType = 'text/plain'
  }

  if (!detectedMimeType || detectedMimeType !== expected || declared !== expected) {
    throw new ApiError('document_type_mismatch', 400, 'The file name, declared type, and verified content do not match.')
  }
  return { detectedMimeType, extension, sanitizedFilename }
}

export function recentAuthenticatorMfa(
  claims: AccessTokenClaims | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  if (claims?.aal !== 'aal2' || !Array.isArray(claims.amr)) return null
  const verified = claims.amr
    .filter((entry) => ['totp', 'authenticator'].includes(entry.method?.toLowerCase() ?? ''))
    .map((entry) => entry.timestamp)
    .filter((timestamp): timestamp is number => Number.isFinite(timestamp))
    .sort((left, right) => right - left)[0]
  if (!verified || verified < nowSeconds - recentDocumentMfaSeconds || verified > nowSeconds + 60) return null
  return new Date(verified * 1000).toISOString()
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function requiredText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
    throw new ApiError('invalid_document_metadata', 422, `${field} is required and must be no longer than ${maximumLength} characters.`)
  }
  return value.trim()
}

function optionalText(value: unknown, field: string, maximumLength: number): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.trim().length > maximumLength) {
    throw new ApiError('invalid_document_metadata', 422, `${field} must be no longer than ${maximumLength} characters.`)
  }
  return value.trim() || null
}

function parseHrDocumentMetadata(request: Request): HrDocumentUploadMetadata {
  const encoded = request.headers.get('x-sygshift-document-metadata')?.trim() ?? ''
  if (!encoded || encoded.length > Math.ceil(maxHrDocumentMetadataBytes * 4 / 3) + 16) {
    throw new ApiError('invalid_document_metadata', 422, 'Secure document metadata is required.')
  }

  let raw: Uint8Array
  let payload: unknown
  try {
    raw = decodeBase64Url(encoded)
    if (raw.byteLength > maxHrDocumentMetadataBytes) throw new Error('metadata too large')
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new ApiError('invalid_document_metadata', 422, 'Secure document metadata is invalid.')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError('invalid_document_metadata', 422, 'Secure document metadata must be a JSON object.')
  }
  const data = payload as Record<string, unknown>
  const employeeId = requiredText(data.employeeId, 'Employee', 36)
  const idempotencyKey = requiredText(data.idempotencyKey, 'Upload request ID', 36)
  const documentId = optionalText(data.documentId, 'Document ID', 36)
  if (!validUuid(employeeId) || !validUuid(idempotencyKey) || (documentId !== null && !validUuid(documentId))) {
    throw new ApiError('invalid_document_metadata', 422, 'Employee, document, or upload request identifiers are invalid.')
  }
  const vaultCode = requiredText(data.vaultCode, 'Document vault', 40)
  if (!['hr-general', 'hr-financial', 'hr-identity', 'hr-medical', 'hr-disciplinary', 'hr-legal-safety'].includes(vaultCode)) {
    throw new ApiError('invalid_document_metadata', 422, 'Choose a valid protected document vault.')
  }
  const accessClassification = requiredText(data.accessClassification, 'Access classification', 30)
  if (!['confidential', 'restricted', 'highly_restricted'].includes(accessClassification)) {
    throw new ApiError('invalid_document_metadata', 422, 'Choose a valid access classification.')
  }

  return {
    accessClassification: accessClassification as HrDocumentUploadMetadata['accessClassification'],
    category: requiredText(data.category, 'Category', 100),
    declaredMimeType: normalizedMimeType(requiredText(data.declaredMimeType, 'File type', 160)),
    description: optionalText(data.description, 'Description', 2000) ?? '',
    documentId,
    employeeId,
    idempotencyKey,
    originalFilename: requiredText(data.originalFilename, 'File name', 255),
    replacementReason: optionalText(data.replacementReason, 'Replacement reason', 1000),
    title: requiredText(data.title, 'Title', 200),
    vaultCode,
  }
}

async function readHrDocumentBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new ApiError('document_file_required', 422, 'Choose a document to upload.')
  const length = request.headers.get('content-length')
  if (length && (!Number.isFinite(Number(length)) || Number(length) < 1 || Number(length) > maxHrDocumentBytes)) {
    throw new ApiError('invalid_document_size', 413, 'Documents must be between 1 byte and 25 MB.')
  }
  const buffer = await request.arrayBuffer()
  if (buffer.byteLength < 1 || buffer.byteLength > maxHrDocumentBytes) {
    throw new ApiError('invalid_document_size', 413, 'Documents must be between 1 byte and 25 MB.')
  }
  return new Uint8Array(buffer)
}

function privateStorageObjectUrl(config: { url: string }, bucket: string, path: string): string {
  const safeBucket = encodeURIComponent(bucket)
  const safePath = path.split('/').map(encodeURIComponent).join('/')
  return `${config.url}/storage/v1/object/${safeBucket}/${safePath}`
}

async function fetchPrivateStorageObject(
  config: { serviceRoleKey: string, url: string },
  bucket: string,
  objectKey: string,
): Promise<Response> {
  return fetch(privateStorageObjectUrl(config, bucket, objectKey), {
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
    },
  })
}

async function deletePrivateStorageObject(
  config: { serviceRoleKey: string, url: string },
  bucket: string,
  objectKey: string,
): Promise<void> {
  const response = await fetch(privateStorageObjectUrl(config, bucket, objectKey), {
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
    },
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 404) throw new Error('Quarantined storage cleanup failed.')
}

async function storeQuarantinedDocument(
  config: { serviceRoleKey: string, url: string },
  operation: HrDocumentUploadOperation,
  bytes: Uint8Array,
  mimeType: string,
  checksum: string,
): Promise<void> {
  const objectUrl = privateStorageObjectUrl(config, operation.bucket, operation.objectKey)
  const uploadBody = bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : new Uint8Array(bytes).buffer
  const uploaded = await fetch(objectUrl, {
    body: uploadBody,
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      'content-type': mimeType,
      'x-upsert': 'false',
    },
    method: 'POST',
  })
  if (uploaded.ok) return

  // An idempotent retry may arrive after the object was stored but before its state advanced.
  const existing = await fetchPrivateStorageObject(config, operation.bucket, operation.objectKey)
  if (!existing.ok) throw new Error(`Quarantine storage rejected the upload (${uploaded.status}).`)
  const existingBytes = new Uint8Array(await existing.arrayBuffer())
  if (existingBytes.byteLength !== bytes.byteLength || await sha256BytesHex(existingBytes) !== checksum) {
    throw new Error('The idempotent upload key is already associated with different content.')
  }
}

async function constantTimeSecretMatches(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false
  const [providedHash, expectedHash] = await Promise.all([sha256Hex(provided), sha256Hex(expected)])
  let difference = 0
  for (let index = 0; index < expectedHash.length; index += 1) {
    difference |= expectedHash.charCodeAt(index) ^ providedHash.charCodeAt(index)
  }
  return difference === 0
}

async function requireDocumentScanner(request: Request, environment: Environment): Promise<void> {
  const expected = environment.SYGSHIFT_DOCUMENT_SCANNER_SECRET?.trim() ?? ''
  const provided = request.headers.get('x-sygshift-document-scanner-secret')?.trim() ?? ''
  if (expected.length < 32) throw new ApiError('document_scanner_not_configured', 503, 'The protected document scanner is not configured.')
  if (!await constantTimeSecretMatches(provided, expected)) {
    throw new ApiError('document_scanner_authentication_failed', 401, 'Scanner authentication failed.')
  }
}

async function requireRecentDocumentMfa(
  request: Request,
  session: Awaited<ReturnType<typeof requireAuthenticatedSession>>,
): Promise<{ method: 'authenticator' | 'security_key', verifiedAt: string }> {
  const claims = accessTokenClaims(session.token)
  const authenticatorVerifiedAt = recentAuthenticatorMfa(claims)
  if (authenticatorVerifiedAt) return { method: 'authenticator', verifiedAt: authenticatorVerifiedAt }

  const securityKeyToken = request.headers.get('x-sygshift-security-key')?.trim() ?? ''
  const authSessionId = claims?.session_id
  if (!securityKeyToken || !authSessionId || !validUuid(authSessionId)) {
    throw new ApiError('recent_document_mfa_required', 403, 'Verify with your authenticator or security key before accessing protected HR documents.')
  }
  const verification = await callRpc<{ method?: string, verifiedAt?: string }>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_verify_security_key_document_mfa',
    {
      target_actor_id: session.context.employee_id,
      target_auth_session_id: authSessionId,
      target_token_hash: await sha256Hex(securityKeyToken),
    },
    session.config.serviceRoleKey,
  )
  if (verification.method !== 'security_key' || !verification.verifiedAt) {
    throw new ApiError('recent_document_mfa_required', 403, 'Verify with your security key before accessing protected HR documents.')
  }
  return { method: 'security_key', verifiedAt: verification.verifiedAt }
}

async function handleHrDocumentUpload(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  if (request.method !== 'PUT') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  const session = await requireAuthenticatedSession(request, environment)
  await requireRecentDocumentMfa(request, session)
  const metadata = parseHrDocumentMetadata(request)
  const bodyMimeType = normalizedMimeType(request.headers.get('content-type') ?? '')
  if (bodyMimeType !== metadata.declaredMimeType) {
    throw new ApiError('document_type_mismatch', 400, 'The upload content type does not match the document metadata.')
  }
  const bytes = await readHrDocumentBody(request)
  const validated = validateHrDocumentFile(bytes, metadata.originalFilename, metadata.declaredMimeType)
  const checksum = await sha256BytesHex(bytes)
  const serviceConfig = { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url }
  const operation = await callRpc<HrDocumentUploadOperation>(
    serviceConfig,
    'service_begin_hr_document_upload',
    {
      target_access_classification: metadata.accessClassification,
      target_actor_id: session.context.employee_id,
      target_category: metadata.category,
      target_declared_mime_type: metadata.declaredMimeType,
      target_description: metadata.description,
      target_detected_mime_type: validated.detectedMimeType,
      target_document_id: metadata.documentId,
      target_employee_id: metadata.employeeId,
      target_extension: validated.extension,
      target_idempotency_key: metadata.idempotencyKey,
      target_original_filename: metadata.originalFilename,
      target_replacement_reason: metadata.replacementReason,
      target_request_id: requestId,
      target_sanitized_filename: validated.sanitizedFilename,
      target_sha256_checksum: checksum,
      target_size_bytes: bytes.byteLength,
      target_title: metadata.title,
      target_vault_code: metadata.vaultCode,
    },
    session.config.serviceRoleKey,
  )

  if (operation.state !== 'quarantined') {
    return json({
      documentId: operation.documentId,
      operationId: operation.operationId,
      requestId,
      scanState: operation.state,
      versionId: operation.versionId,
    }, 202)
  }

  try {
    await storeQuarantinedDocument(serviceConfig, operation, bytes, validated.detectedMimeType, checksum)
    await callRpc(
      serviceConfig,
      'service_mark_hr_document_upload_stored',
      { target_operation_id: operation.operationId, target_request_id: requestId },
      session.config.serviceRoleKey,
    )
  } catch (error) {
    await deletePrivateStorageObject(serviceConfig, operation.bucket, operation.objectKey).catch(() => undefined)
    await callRpc(
      serviceConfig,
      'service_fail_hr_document_upload',
      {
        target_failure_code: 'quarantine_storage_failed',
        target_failure_detail: error instanceof Error ? error.message.slice(0, 1000) : 'Quarantine storage failed.',
        target_operation_id: operation.operationId,
        target_state: 'scan_error',
      },
      session.config.serviceRoleKey,
    ).catch(() => undefined)
    throw new ApiError('document_quarantine_failed', 502, 'The document could not be placed in protected quarantine.')
  }

  return json({
    documentId: operation.documentId,
    operationId: operation.operationId,
    requestId,
    scanState: 'scan_pending',
    versionId: operation.versionId,
  }, 202)
}

async function handleHrDocumentWorkspace(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  const session = await requireAuthenticatedSession(request, environment)
  await requireRecentDocumentMfa(request, session)
  const url = new URL(request.url)
  const search = url.searchParams.get('search')?.trim() ?? ''
  if (search.length > 120) throw new ApiError('invalid_document_search', 422, 'Document search is limited to 120 characters.')
  const employeeId = url.searchParams.get('employeeId')?.trim() ?? ''
  if (employeeId && !validUuid(employeeId)) throw new ApiError('invalid_employee_id', 422, 'The employee filter is invalid.')
  const vaultCode = url.searchParams.get('vaultCode')?.trim() ?? ''
  if (vaultCode && !/^hr-[a-z-]{2,80}$/.test(vaultCode)) throw new ApiError('invalid_document_vault', 422, 'The document vault filter is invalid.')
  const pageValue = Number.parseInt(url.searchParams.get('page') ?? '1', 10)
  const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1
  const pageSizeValue = Number.parseInt(url.searchParams.get('pageSize') ?? '10', 10)
  const pageSize = [5, 10, 20].includes(pageSizeValue) ? pageSizeValue : 10
  const includeArchived = url.searchParams.get('includeArchived') === 'true'
  const payload = await callRpc<HrDocumentWorkspacePayload>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_get_hr_document_workspace',
    {
      target_actor_id: session.context.employee_id,
      target_employee_id: employeeId || null,
      target_include_archived: includeArchived,
      target_page: page,
      target_page_size: pageSize,
      target_search: search || null,
      target_vault_code: vaultCode || null,
    },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId })
}

async function handleHrDocumentScanCallback(
  request: Request,
  environment: Environment,
  requestId: string,
  operationId: string,
): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
  await requireDocumentScanner(request, environment)
  if (!validUuid(operationId)) throw new ApiError('invalid_upload_operation', 422, 'The upload operation is invalid.')
  const config = configuredSupabase(environment)
  if (!config) throw new ApiError('server_not_configured', 503, 'The secure data connection is unavailable.')
  const body = await readJsonBody(request)
  const state = requiredText(body.state, 'Scan result', 20)
  if (!['clean', 'rejected', 'scan_error'].includes(state)) {
    throw new ApiError('invalid_scan_result', 422, 'The scanner result is invalid.')
  }
  const scannerName = requiredText(body.scannerName, 'Scanner name', 120)
  const scannerVersion = requiredText(body.scannerVersion, 'Scanner version', 120)
  const signatureReference = optionalText(body.signatureReference, 'Signature reference', 255)
  const evidenceSha256 = optionalText(body.evidenceSha256, 'Scanner evidence checksum', 64)
  if (state === 'clean' && (!evidenceSha256 || !/^[a-f0-9]{64}$/.test(evidenceSha256))) {
    throw new ApiError('scanner_evidence_required', 422, 'Clean scan results require SHA-256 evidence.')
  }
  const result = await callRpc<Record<string, unknown>>(
    { serviceRoleKey: config.serviceRoleKey, url: config.url },
    'service_record_hr_document_scan_result',
    {
      target_details: optionalText(body.details, 'Scanner details', 2000),
      target_evidence_sha256: evidenceSha256,
      target_operation_id: operationId,
      target_scanner_name: scannerName,
      target_scanner_version: scannerVersion,
      target_signature_reference: signatureReference,
      target_state: state,
    },
    config.serviceRoleKey,
  )
  return json({ ...result, requestId })
}

async function handleHrDocumentAccessGrant(
  request: Request,
  environment: Environment,
  requestId: string,
  documentId: string,
): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  if (!validUuid(documentId)) throw new ApiError('invalid_document_id', 422, 'The document identifier is invalid.')
  const session = await requireAuthenticatedSession(request, environment)
  const mfa = await requireRecentDocumentMfa(request, session)
  const body = await readJsonBody(request)
  const action = requiredText(body.action, 'Document action', 20)
  if (!['preview', 'view', 'download'].includes(action)) {
    throw new ApiError('invalid_document_action', 422, 'Choose preview, view, or download.')
  }
  const reason = requiredText(body.reason, 'Access reason', 1000)
  const rawToken = generateOpaqueToken()
  const grant = await callRpc<HrDocumentAccessGrant>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_issue_hr_document_access_grant',
    {
      target_action: action,
      target_actor_id: session.context.employee_id,
      target_document_id: documentId,
      target_mfa_method: mfa.method,
      target_mfa_verified_at: mfa.verifiedAt,
      target_reason: reason,
      target_request_id: requestId,
      target_token_hash: await sha256Hex(rawToken),
    },
    session.config.serviceRoleKey,
  )
  return json({
    accessPath: `/api/v1/hr/documents/access/${rawToken}`,
    expiresAt: grant.expiresAt,
    requestId,
  }, 201)
}

async function handleHrDocumentAccess(
  request: Request,
  environment: Environment,
  requestId: string,
  rawToken: string,
): Promise<Response> {
  if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(rawToken)) {
    throw new ApiError('invalid_document_access_token', 401, 'The document access link is invalid or expired.')
  }
  const session = await requireAuthenticatedSession(request, environment)
  const serviceConfig = { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url }
  const target = await callRpc<HrDocumentAccessObject>(
    serviceConfig,
    'service_consume_hr_document_access_grant',
    {
      target_actor_id: session.context.employee_id,
      target_request_id: requestId,
      target_token_hash: await sha256Hex(rawToken),
    },
    session.config.serviceRoleKey,
  )
  const stored = await fetchPrivateStorageObject(serviceConfig, target.bucket, target.objectKey)
  if (!stored.ok || !stored.body) {
    throw new ApiError('document_storage_unavailable', 502, 'The protected document could not be loaded.')
  }
  const filename = sanitizeHrDocumentFilename(target.filename).replaceAll('"', '_')
  const disposition = target.action === 'download' ? 'attachment' : 'inline'
  const headers = new Headers()
  headers.set('cache-control', 'private, no-store, max-age=0')
  headers.set('content-disposition', `${disposition}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
  headers.set('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:")
  headers.set('content-type', target.mimeType)
  headers.set('pragma', 'no-cache')
  return new Response(stored.body, { headers, status: 200 })
}

function optionalIsoDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  const text = requiredText(value, field, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ApiError('invalid_document_date', 422, `${field} must be a valid date.`)
  return text
}

async function handleHrDocumentWorkflowWorkspace(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  const session = await requireAuthenticatedSession(request, environment)
  await requireRecentDocumentMfa(request, session)
  const url = new URL(request.url)
  const status = url.searchParams.get('status')?.trim() || null
  const allowedStatuses = ['requested', 'submitted', 'accepted', 'rejected', 'cancelled', 'pending', 'completed', 'declined']
  if (status && !allowedStatuses.includes(status)) throw new ApiError('invalid_document_workflow_status', 422, 'The workflow status filter is invalid.')
  const pageValue = Number.parseInt(url.searchParams.get('page') ?? '1', 10)
  const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1
  const pageSizeValue = Number.parseInt(url.searchParams.get('pageSize') ?? '10', 10)
  const pageSize = [5, 10, 20].includes(pageSizeValue) ? pageSizeValue : 10
  const payload = await callRpc<HrDocumentWorkflowPayload>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_get_hr_document_workflow_workspace',
    { target_actor_id: session.context.employee_id, target_page: page, target_page_size: pageSize, target_status: status },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId })
}

async function handleMyHrDocumentWorkspace(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  const session = await requireAuthenticatedSession(request, environment)
  await requireRecentDocumentMfa(request, session)
  const payload = await callRpc<HrDocumentWorkflowPayload>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_get_my_hr_document_workspace',
    { target_actor_id: session.context.employee_id },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId })
}

async function handleCreateHrDocumentRequest(request: Request, environment: Environment, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  const session = await requireAuthenticatedSession(request, environment)
  await requireRecentDocumentMfa(request, session)
  const body = await readJsonBody(request)
  const employeeId = requiredText(body.employeeId, 'Employee', 36)
  if (!validUuid(employeeId)) throw new ApiError('invalid_employee_id', 422, 'The employee is invalid.')
  const payload = await callRpc<Record<string, unknown>>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_create_hr_document_request',
    {
      target_actor_id: session.context.employee_id,
      target_category: requiredText(body.category, 'Category', 100),
      target_due_date: optionalIsoDate(body.dueDate, 'Due date'),
      target_employee_id: employeeId,
      target_instructions: requiredText(body.instructions, 'Employee instructions', 2000),
      target_request_id: requestId,
      target_title: requiredText(body.title, 'Request title', 160),
      target_vault_code: requiredText(body.vaultCode, 'Document vault', 100),
    },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId }, 201)
}

async function handleReviewHrDocumentRequest(request: Request, environment: Environment, requestId: string, workflowId: string): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  if (!validUuid(workflowId)) throw new ApiError('invalid_document_request', 422, 'The document request is invalid.')
  const session = await requireAuthenticatedSession(request, environment)
  await requireRecentDocumentMfa(request, session)
  const body = await readJsonBody(request)
  const action = requiredText(body.action, 'Review action', 20)
  if (!['accepted', 'rejected', 'cancelled'].includes(action)) throw new ApiError('invalid_document_request_action', 422, 'Choose accept, reject, or cancel.')
  const payload = await callRpc<Record<string, unknown>>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_review_hr_document_request',
    { target_action: action, target_actor_id: session.context.employee_id, target_correlation_id: requestId, target_note: requiredText(body.note, 'Audit note', 2000), target_request_id: workflowId },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId })
}

async function handleCreateHrDocumentAssignment(request: Request, environment: Environment, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  const session = await requireAuthenticatedSession(request, environment)
  await requireRecentDocumentMfa(request, session)
  const body = await readJsonBody(request)
  const employeeId = requiredText(body.employeeId, 'Employee', 36)
  const documentId = requiredText(body.documentId, 'Document', 36)
  if (!validUuid(employeeId) || !validUuid(documentId)) throw new ApiError('invalid_document_assignment', 422, 'Choose a valid employee and document.')
  const requirementType = requiredText(body.requirementType, 'Required action', 40)
  if (!['acknowledgment', 'electronic_signature'].includes(requirementType)) throw new ApiError('invalid_document_requirement', 422, 'Choose acknowledgment or electronic signature.')
  const payload = await callRpc<Record<string, unknown>>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_create_hr_document_assignment',
    {
      target_actor_id: session.context.employee_id,
      target_document_id: documentId,
      target_due_date: optionalIsoDate(body.dueDate, 'Due date'),
      target_employee_id: employeeId,
      target_request_id: requestId,
      target_requirement_type: requirementType,
      target_statement: requiredText(body.statement, 'Completion statement', 2000),
    },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId }, 201)
}

async function handleCancelHrDocumentAssignment(request: Request, environment: Environment, requestId: string, assignmentId: string): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  if (!validUuid(assignmentId)) throw new ApiError('invalid_document_assignment', 422, 'The document assignment is invalid.')
  const session = await requireAuthenticatedSession(request, environment)
  await requireRecentDocumentMfa(request, session)
  const body = await readJsonBody(request)
  const payload = await callRpc<Record<string, unknown>>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_cancel_hr_document_assignment',
    { target_actor_id: session.context.employee_id, target_assignment_id: assignmentId, target_reason: requiredText(body.reason, 'Cancellation reason', 2000), target_request_id: requestId },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId })
}

async function handleMyHrDocumentAccessGrant(request: Request, environment: Environment, requestId: string, assignmentId: string): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  if (!validUuid(assignmentId)) throw new ApiError('invalid_document_assignment', 422, 'The document assignment is invalid.')
  const session = await requireAuthenticatedSession(request, environment)
  const mfa = await requireRecentDocumentMfa(request, session)
  const body = await readJsonBody(request)
  const action = requiredText(body.action, 'Document action', 20)
  if (!['preview', 'view', 'download'].includes(action)) throw new ApiError('invalid_document_action', 422, 'Choose preview, view, or download.')
  const rawToken = generateOpaqueToken()
  const grant = await callRpc<HrDocumentAccessGrant>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_issue_my_hr_document_access_grant',
    {
      target_action: action,
      target_actor_id: session.context.employee_id,
      target_assignment_id: assignmentId,
      target_mfa_method: mfa.method,
      target_mfa_verified_at: mfa.verifiedAt,
      target_reason: requiredText(body.reason, 'Access reason', 1000),
      target_request_id: requestId,
      target_token_hash: await sha256Hex(rawToken),
    },
    session.config.serviceRoleKey,
  )
  return json({ accessPath: `/api/v1/hr/documents/access/${rawToken}`, expiresAt: grant.expiresAt, requestId }, 201)
}

async function handleCompleteHrDocumentAssignment(request: Request, environment: Environment, requestId: string, assignmentId: string): Promise<Response> {
  if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
  requireHrDocumentPipeline(environment)
  if (!validUuid(assignmentId)) throw new ApiError('invalid_document_assignment', 422, 'The document assignment is invalid.')
  const session = await requireAuthenticatedSession(request, environment)
  const mfa = await requireRecentDocumentMfa(request, session)
  const body = await readJsonBody(request)
  const action = requiredText(body.action, 'Completion action', 20)
  if (!['acknowledge', 'sign'].includes(action)) throw new ApiError('invalid_document_completion', 422, 'Choose acknowledge or sign.')
  const payload = await callRpc<Record<string, unknown>>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_complete_hr_document_assignment',
    {
      target_action: action,
      target_actor_id: session.context.employee_id,
      target_assignment_id: assignmentId,
      target_confirmed: body.confirmed === true,
      target_legal_name: requiredText(body.legalName, 'Legal name', 200),
      target_mfa_method: mfa.method,
      target_mfa_verified_at: mfa.verifiedAt,
      target_request_id: requestId,
    },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId })
}

function disabledHrAutomationWorkspace(requestId: string): Record<string, unknown> {
  return {
    enabled: false,
    pageSize: 10,
    offset: 0,
    definitions: [],
    instances: [],
    tasks: [],
    deadLetters: [],
    counts: { definitions: 0, activeInstances: 0, openTasks: 0, deadLetters: 0 },
    requestId,
  }
}

function boundedWorkspacePage(url: URL): { offset: number; pageSize: 5 | 10 | 20 } {
  const requestedPageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '10', 10)
  const requestedOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
  return {
    pageSize: ([5, 10, 20].includes(requestedPageSize) ? requestedPageSize : 10) as 5 | 10 | 20,
    offset: Number.isFinite(requestedOffset) ? Math.max(0, Math.min(requestedOffset, 10_000)) : 0,
  }
}

function requireAnySessionPermission(context: SessionContext, permissions: readonly string[]): void {
  if (!permissions.some((permission) => context.permissions?.includes(permission) === true)) {
    throw new ApiError('permission_required', 403, 'The required permission is missing.')
  }
}

function disabledRecruitingWorkspace(requestId: string): Record<string, unknown> {
  return {
    enabled: false,
    pageSize: 10,
    offset: 0,
    requisitions: [],
    applications: [],
    counts: { openRequisitions: 0, activeCandidates: 0, pendingInterviews: 0, pendingOffers: 0 },
    requestId,
  }
}

async function handleHrRecruitingApi(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url)
  const session = await requireVerifiedOperationsSession(request, environment, 'hr_recruiting_mfa_required')

  if (url.pathname === '/api/v1/hr/recruiting/workspace') {
    if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
    requireSessionPermission(session.context, 'hr.recruiting.view')
    if (!hrRecruitingEnabled(environment)) return json(disabledRecruitingWorkspace(requestId))
    const { offset, pageSize } = boundedWorkspacePage(url)
    const payload = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_get_hr_recruiting_workspace',
      { target_actor_id: session.context.employee_id, target_offset: offset, target_page_size: pageSize },
      session.config.serviceRoleKey,
    )
    return json({ ...payload, requestId })
  }

  if (url.pathname === '/api/v1/hr/recruiting/actions') {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    requireHrRecruitingRelease(environment)
    requireAnySessionPermission(session.context, ['hr.recruiting.manage', 'hr.recruiting.approve'])
    const body = await readJsonBody(request)
    const action = requiredText(body.action, 'Recruiting action', 80)
    const allowedActions = new Set([
      'create_requisition', 'submit_requisition', 'approve_requisition', 'create_application',
      'move_application', 'schedule_interview', 'assign_interview_panelist', 'submit_scorecard',
      'prepare_offer', 'submit_offer', 'approve_offer', 'mark_offer_sent', 'record_offer_decision',
      'dispose_application',
    ])
    if (!allowedActions.has(action)) throw new ApiError('invalid_recruiting_action', 422, 'Choose a supported recruiting action.')
    const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? body.payload as Record<string, unknown>
      : {}
    const result = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_hr_recruiting_action',
      {
        target_action: action,
        target_actor_id: session.context.employee_id,
        target_payload: payload,
        target_reason: requiredText(body.reason, 'Audit reason', 1000),
      },
      session.config.serviceRoleKey,
    )
    return json({ ...result, requestId })
  }

  if (url.pathname === '/api/v1/hr/recruiting/conversions') {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    requireHrRecruitingRelease(environment)
    requireSessionPermission(session.context, 'hr.recruiting.manage')
    const body = await readJsonBody(request)
    const applicationId = requiredText(body.applicationId, 'Application', 36)
    if (!validUuid(applicationId)) throw new ApiError('invalid_application', 422, 'The application is invalid.')
    const role = requiredText(body.role, 'Role', 40)
    const employmentType = requiredText(body.employmentType, 'Employment type', 20)
    if (!['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'].includes(role)) {
      throw new ApiError('invalid_employee_role', 422, 'Choose a supported employee role.')
    }
    if (!['hourly', 'salary', 'flex'].includes(employmentType)) {
      throw new ApiError('invalid_employment_type', 422, 'Choose hourly, salary, or flex employment.')
    }
    const result = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_request_candidate_conversion',
      {
        target_actor_id: session.context.employee_id,
        target_application_id: applicationId,
        target_employment_type: employmentType,
        target_job_title: requiredText(body.jobTitle, 'Job title', 160),
        target_reason: requiredText(body.reason, 'Audit reason', 1000),
        target_role: role,
        target_start_date: requiredText(body.startDate, 'Start date', 10),
      },
      session.config.serviceRoleKey,
    )
    return json({ ...result, requestId })
  }

  const conversionRequestId = url.pathname.match(/^\/api\/v1\/hr\/recruiting\/conversions\/([0-9a-f-]{36})\/review$/i)?.[1]
  if (conversionRequestId) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    requireHrRecruitingRelease(environment)
    requireSessionPermission(session.context, 'hr.recruiting.approve')
    if (!validUuid(conversionRequestId)) throw new ApiError('invalid_conversion_request', 422, 'The conversion request is invalid.')
    const body = await readJsonBody(request)
    const decision = requiredText(body.decision, 'Decision', 20)
    if (!['approve', 'reject', 'cancel'].includes(decision)) throw new ApiError('invalid_conversion_decision', 422, 'Choose approve, reject, or cancel.')
    const result = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_review_candidate_conversion',
      {
        target_actor_id: session.context.employee_id,
        target_decision: decision,
        target_reason: requiredText(body.reason, 'Audit reason', 1000),
        target_request_id: conversionRequestId,
      },
      session.config.serviceRoleKey,
    )
    return json({ ...result, requestId })
  }

  return errorJson('not_found', requestId, 404)
}

function disabledOnboardingWorkspace(requestId: string): Record<string, unknown> {
  return {
    enabled: false,
    pageSize: 10,
    offset: 0,
    cases: [],
    templates: [],
    counts: { activeCases: 0, readyCases: 0, overdueTasks: 0 },
    requestId,
  }
}

async function handleHrOnboardingApi(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url)
  const session = await requireVerifiedOperationsSession(request, environment, 'hr_onboarding_mfa_required')

  if (url.pathname === '/api/v1/hr/onboarding/workspace') {
    if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
    requireSessionPermission(session.context, 'hr.onboarding.view')
    if (!hrOnboardingEnabled(environment)) return json(disabledOnboardingWorkspace(requestId))
    const { offset, pageSize } = boundedWorkspacePage(url)
    const payload = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_get_hr_onboarding_workspace',
      { target_actor_id: session.context.employee_id, target_offset: offset, target_page_size: pageSize },
      session.config.serviceRoleKey,
    )
    return json({ ...payload, requestId })
  }

  const caseId = url.pathname.match(/^\/api\/v1\/hr\/onboarding\/cases\/([0-9a-f-]{36})$/i)?.[1]
  if (caseId) {
    if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
    requireSessionPermission(session.context, 'hr.onboarding.view')
    requireHrOnboardingRelease(environment)
    if (!validUuid(caseId)) throw new ApiError('invalid_onboarding_case', 422, 'The onboarding case is invalid.')
    const payload = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_get_hr_onboarding_case',
      { target_actor_id: session.context.employee_id, target_case_id: caseId },
      session.config.serviceRoleKey,
    )
    return json({ ...payload, requestId })
  }

  if (url.pathname === '/api/v1/hr/onboarding/actions') {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    requireHrOnboardingRelease(environment)
    requireAnySessionPermission(session.context, ['hr.onboarding.manage', 'hr.onboarding.approve'])
    const body = await readJsonBody(request)
    const action = requiredText(body.action, 'Onboarding action', 80)
    const allowedActions = new Set([
      'create_template', 'add_template_step', 'add_step_dependency', 'activate_template',
      'launch_case', 'start_task', 'complete_task', 'waive_task', 'finalize_case', 'cancel_case',
    ])
    if (!allowedActions.has(action)) throw new ApiError('invalid_onboarding_action', 422, 'Choose a supported onboarding action.')
    const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? body.payload as Record<string, unknown>
      : {}
    const result = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_hr_onboarding_action',
      {
        target_action: action,
        target_actor_id: session.context.employee_id,
        target_payload: payload,
        target_reason: requiredText(body.reason, 'Audit reason', 1000),
      },
      session.config.serviceRoleKey,
    )
    return json({ ...result, requestId })
  }

  return errorJson('not_found', requestId, 404)
}

function disabledHrLeaveWorkspace(requestId: string): Record<string, unknown> {
  return {
    enabled: false,
    pageSize: 10,
    offset: 0,
    counts: { openCases: 0, approvedCases: 0, activePolicies: 0 },
    items: [],
    policies: [],
    requestId,
  }
}

function disabledHrBenefitsWorkspace(requestId: string): Record<string, unknown> {
  return {
    enabled: false,
    pageSize: 10,
    offset: 0,
    counts: { activePlans: 0, openWindows: 0, pendingEnrollments: 0 },
    items: [],
    windows: [],
    requestId,
  }
}

function disabledHrCompensationWorkspace(requestId: string): Record<string, unknown> {
  return {
    enabled: false,
    pageSize: 10,
    offset: 0,
    counts: { activeComponents: 0, pendingProposals: 0, activeRecords: 0 },
    items: [],
    components: [],
    requestId,
  }
}

async function handleHrLeaveApi(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url)
  const session = await requireVerifiedOperationsSession(request, environment, 'hr_leave_mfa_required')
  if (url.pathname !== '/api/v1/hr/leave/workspace') return errorJson('not_found', requestId, 404)
  if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
  requireSessionPermission(session.context, 'hr.leave.view')
  if (!hrLeaveEnabled(environment)) return json(disabledHrLeaveWorkspace(requestId))
  const { offset, pageSize } = boundedWorkspacePage(url)
  const payload = await callRpc<Record<string, unknown>>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_get_hr_leave_workspace',
    { target_actor_id: session.context.employee_id, target_offset: offset, target_page_size: pageSize },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId })
}

async function handleHrBenefitsApi(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url)
  const session = await requireVerifiedOperationsSession(request, environment, 'hr_benefits_mfa_required')
  if (url.pathname !== '/api/v1/hr/benefits/workspace') return errorJson('not_found', requestId, 404)
  if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
  requireSessionPermission(session.context, 'hr.benefits.view')
  if (!hrBenefitsEnabled(environment)) return json(disabledHrBenefitsWorkspace(requestId))
  const { offset, pageSize } = boundedWorkspacePage(url)
  const payload = await callRpc<Record<string, unknown>>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_get_hr_benefits_workspace',
    { target_actor_id: session.context.employee_id, target_offset: offset, target_page_size: pageSize },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId })
}

async function handleHrCompensationApi(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url)
  const session = await requireVerifiedOperationsSession(request, environment, 'hr_compensation_mfa_required')
  if (url.pathname !== '/api/v1/hr/compensation/workspace') return errorJson('not_found', requestId, 404)
  if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
  requireSessionPermission(session.context, 'hr.compensation.view')
  if (!hrCompensationEnabled(environment)) return json(disabledHrCompensationWorkspace(requestId))
  const mfa = await requireRecentDocumentMfa(request, session)
  const { offset, pageSize } = boundedWorkspacePage(url)
  const payload = await callRpc<Record<string, unknown>>(
    { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
    'service_get_hr_compensation_workspace',
    {
      target_actor_id: session.context.employee_id,
      target_mfa_method: mfa.method,
      target_mfa_verified_at: mfa.verifiedAt,
      target_offset: offset,
      target_page_size: pageSize,
    },
    session.config.serviceRoleKey,
  )
  return json({ ...payload, requestId })
}

async function handleHrAutomationApi(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url)

  if (url.pathname === '/api/v1/hr/automation/mine') {
    if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
    const session = await requireAuthenticatedSession(request, environment)
    requireSessionPermission(session.context, 'actions.self.view')
    if (!hrAutomationEnabled(environment)) return json({ enabled: false, total: 0, tasks: [], requestId })
    const payload = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_get_my_hr_automation_tasks',
      { target_actor_id: session.context.employee_id },
      session.config.serviceRoleKey,
    )
    return json({ ...payload, requestId })
  }

  if (url.pathname === '/api/v1/hr/automation/workspace') {
    if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
    const session = await requireVerifiedOperationsSession(request, environment, 'hr_automation_mfa_required')
    requireSessionPermission(session.context, 'hr.automation.view')
    if (!hrAutomationEnabled(environment)) return json(disabledHrAutomationWorkspace(requestId))
    const requestedPageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '10', 10)
    const requestedOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
    const pageSize = [5, 10, 20].includes(requestedPageSize) ? requestedPageSize : 10
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.min(requestedOffset, 10_000)) : 0
    const payload = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_get_hr_automation_workspace',
      { target_actor_id: session.context.employee_id, target_offset: offset, target_page_size: pageSize },
      session.config.serviceRoleKey,
    )
    return json({ ...payload, requestId })
  }

  const viewedTaskId = url.pathname.match(/^\/api\/v1\/hr\/automation\/tasks\/([0-9a-f-]{36})\/viewed$/i)?.[1]
  if (viewedTaskId) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    requireHrAutomationRelease(environment)
    if (!validUuid(viewedTaskId)) throw new ApiError('invalid_automation_task', 422, 'The automation task is invalid.')
    const session = await requireAuthenticatedSession(request, environment)
    requireSessionPermission(session.context, 'actions.self.view')
    const payload = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_mark_hr_workflow_task_viewed',
      { target_actor_id: session.context.employee_id, target_task_id: viewedTaskId },
      session.config.serviceRoleKey,
    )
    return json({ ...payload, requestId })
  }

  const completeTaskId = url.pathname.match(/^\/api\/v1\/hr\/automation\/tasks\/([0-9a-f-]{36})\/complete$/i)?.[1]
  if (completeTaskId) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    requireHrAutomationRelease(environment)
    if (!validUuid(completeTaskId)) throw new ApiError('invalid_automation_task', 422, 'The automation task is invalid.')
    const session = await requireAuthenticatedSession(request, environment)
    requireSessionPermission(session.context, 'actions.self.view')
    const body = await readJsonBody(request)
    const payload = await callRpc<Record<string, unknown>>(
      { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url },
      'service_complete_hr_workflow_task',
      {
        target_actor_id: session.context.employee_id,
        target_note: requiredText(body.note, 'Completion note', 2000),
        target_task_id: completeTaskId,
      },
      session.config.serviceRoleKey,
    )
    return json({ ...payload, requestId })
  }

  return errorJson('not_found', requestId, 404)
}

async function handleHrDocumentsApi(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/api/v1/hr/documents/workspace') {
    return handleHrDocumentWorkspace(request, environment, requestId)
  }
  if (url.pathname === '/api/v1/hr/documents/workflows') {
    return handleHrDocumentWorkflowWorkspace(request, environment, requestId)
  }
  if (url.pathname === '/api/v1/hr/documents/mine') {
    return handleMyHrDocumentWorkspace(request, environment, requestId)
  }
  if (url.pathname === '/api/v1/hr/documents/requests') {
    return handleCreateHrDocumentRequest(request, environment, requestId)
  }
  if (url.pathname === '/api/v1/hr/documents/assignments') {
    return handleCreateHrDocumentAssignment(request, environment, requestId)
  }
  if (url.pathname === '/api/v1/hr/documents/uploads') {
    return handleHrDocumentUpload(request, environment, requestId)
  }
  const scanOperationId = url.pathname.match(/^\/api\/v1\/hr\/documents\/scans\/([0-9a-f-]{36})$/i)?.[1]
  if (scanOperationId) return handleHrDocumentScanCallback(request, environment, requestId, scanOperationId)
  const accessToken = url.pathname.match(/^\/api\/v1\/hr\/documents\/access\/([A-Za-z0-9_-]{40,100})$/)?.[1]
  if (accessToken) return handleHrDocumentAccess(request, environment, requestId, accessToken)
  const accessDocumentId = url.pathname.match(/^\/api\/v1\/hr\/documents\/([0-9a-f-]{36})\/access$/i)?.[1]
  if (accessDocumentId) return handleHrDocumentAccessGrant(request, environment, requestId, accessDocumentId)
  const requestWorkflowId = url.pathname.match(/^\/api\/v1\/hr\/documents\/requests\/([0-9a-f-]{36})\/review$/i)?.[1]
  if (requestWorkflowId) return handleReviewHrDocumentRequest(request, environment, requestId, requestWorkflowId)
  const cancelAssignmentId = url.pathname.match(/^\/api\/v1\/hr\/documents\/assignments\/([0-9a-f-]{36})\/cancel$/i)?.[1]
  if (cancelAssignmentId) return handleCancelHrDocumentAssignment(request, environment, requestId, cancelAssignmentId)
  const assignmentAccessId = url.pathname.match(/^\/api\/v1\/hr\/documents\/assignments\/([0-9a-f-]{36})\/access$/i)?.[1]
  if (assignmentAccessId) return handleMyHrDocumentAccessGrant(request, environment, requestId, assignmentAccessId)
  const completeAssignmentId = url.pathname.match(/^\/api\/v1\/hr\/documents\/assignments\/([0-9a-f-]{36})\/complete$/i)?.[1]
  if (completeAssignmentId) return handleCompleteHrDocumentAssignment(request, environment, requestId, completeAssignmentId)
  return errorJson('not_found', requestId, 404)
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

function securityKeySummary(record: SecurityKeyCredentialRecord): Record<string, unknown> {
  return {
    backedUp: record.backedUp,
    createdAt: record.createdAt,
    credentialId: record.credentialId,
    deviceType: record.deviceType,
    id: record.id,
    label: record.label,
    lastUsedAt: record.lastUsedAt,
    transports: record.transports,
  }
}

function securityKeyPilotEligible(environment: Environment, username: string): boolean {
  return isSecurityKeyPilotEligible(
    environment.SYGSHIFT_SECURITY_KEYS_ENABLED,
    environment.SYGSHIFT_SECURITY_KEY_PILOT_USERNAMES,
    username,
  )
}

function requireSecurityKeyPilot(environment: Environment, username: string): void {
  if (!securityKeyPilotEligible(environment, username)) {
    throw new ApiError('security_key_pilot_unavailable', 403, 'Security-key access is not enabled for this account.')
  }
}

function asSecurityKeyResponse(value: unknown, field: string): RegistrationResponseJSON | AuthenticationResponseJSON {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('invalid_security_key_response', 422, `The ${field} security-key response was invalid.`)
  }
  const candidate = value as { id?: unknown; response?: unknown; type?: unknown }
  if (typeof candidate.id !== 'string' || candidate.type !== 'public-key' || !candidate.response || typeof candidate.response !== 'object') {
    throw new ApiError('invalid_security_key_response', 422, `The ${field} security-key response was invalid.`)
  }
  return value as RegistrationResponseJSON | AuthenticationResponseJSON
}

async function listSecurityKeyCredentials(
  config: { serviceRoleKey: string; url: string },
  employeeId: string,
): Promise<SecurityKeyCredentialRecord[]> {
  const records = await callRpc<SecurityKeyCredentialRecord[] | null>(
    config,
    'service_list_webauthn_credentials',
    { target_employee_id: employeeId },
    config.serviceRoleKey,
  )
  return Array.isArray(records) ? records : []
}

async function handleAccountSecurityKeysApi(
  request: Request,
  environment: Environment,
  requestId: string,
): Promise<Response> {
  const session = await requireAuthenticatedSession(request, environment)
  const url = new URL(request.url)
  const serviceConfig = { serviceRoleKey: session.config.serviceRoleKey, url: session.config.url }
  const featureEnabled = securityKeyFeatureEnabled(environment.SYGSHIFT_SECURITY_KEYS_ENABLED)
  const pilotEligible = securityKeyPilotEligible(environment, session.context.username)
  const credentials = pilotEligible
    ? await listSecurityKeyCredentials(serviceConfig, session.context.employee_id)
    : []
  const registrationOptionsPath = '/api/v1/account/security-keys/registration/options'
  const registrationVerifyPath = '/api/v1/account/security-keys/registration/verify'
  const authenticationOptionsPath = '/api/v1/account/security-keys/authentication/options'
  const authenticationVerifyPath = '/api/v1/account/security-keys/authentication/verify'

  if (url.pathname === '/api/v1/account/security-keys') {
    if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
    return json({ featureEnabled, keys: credentials.map(securityKeySummary), pilotEligible, requestId })
  }

  if (url.pathname === registrationOptionsPath) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    requireSecurityKeyPilot(environment, session.context.username)
    requireRawAal2(session.token)
    await requireMaintenanceWriteAccess(serviceConfig, 'user_accounts')
    if (credentials.length >= 5) throw new ApiError('security_key_limit_reached', 409, 'A maximum of five active security keys is allowed.')
    const body = await readJsonBody(request)
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (!label || label.length > 60) throw new ApiError('security_key_label_required', 422, 'Enter a key name no longer than 60 characters.')
    const rpID = webAuthnRpId(request)
    const userID = new TextEncoder().encode(session.context.employee_id)
    const options = await generateRegistrationOptions({
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'cross-platform',
        residentKey: 'discouraged',
        userVerification: 'required',
      },
      excludeCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports,
      })),
      preferredAuthenticatorType: 'securityKey',
      rpID,
      rpName: 'SygShift',
      supportedAlgorithmIDs: [-7, -257],
      timeout: 90_000,
      userDisplayName: session.context.display_name,
      userID,
      userName: session.context.username,
    })
    const challengeRecord = await callRpc<{ id: string; expiresAt: string }>(
      serviceConfig,
      'service_store_webauthn_challenge',
      {
        target_challenge: options.challenge,
        target_employee_id: session.context.employee_id,
        target_purpose: 'registration',
      },
      session.config.serviceRoleKey,
    )
    return json({ challengeId: challengeRecord.id, expiresAt: challengeRecord.expiresAt, label, options, requestId })
  }

  if (url.pathname === registrationVerifyPath) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    requireSecurityKeyPilot(environment, session.context.username)
    requireRawAal2(session.token)
    await requireMaintenanceWriteAccess(serviceConfig, 'user_accounts')
    const body = await readWebAuthnBody(request)
    const challengeId = typeof body.challengeId === 'string' ? body.challengeId : ''
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !label || label.length > 60) {
      throw new ApiError('invalid_security_key_request', 422, 'The security-key registration request was invalid.')
    }
    const response = asSecurityKeyResponse(body.response, 'registration') as RegistrationResponseJSON
    const challenge = await callRpc<SecurityKeyChallengeRecord>(
      serviceConfig,
      'service_consume_webauthn_challenge',
      {
        target_challenge_id: challengeId,
        target_employee_id: session.context.employee_id,
        target_purpose: 'registration',
      },
      session.config.serviceRoleKey,
    )
    let verification
    try {
      verification = await verifyRegistrationResponse({
        expectedChallenge: challenge.challenge,
        expectedOrigin: expectedWebAuthnOrigins(request),
        expectedRPID: webAuthnRpId(request),
        requireUserPresence: true,
        requireUserVerification: true,
        response,
        supportedAlgorithmIDs: [-7, -257],
      })
    } catch {
      throw new ApiError('security_key_verification_failed', 422, 'The security key could not be verified. Start again and touch the key when prompted.')
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new ApiError('security_key_verification_failed', 422, 'The security key could not be verified.')
    }
    const info = verification.registrationInfo
    await callRpc<Record<string, unknown>>(
      serviceConfig,
      'service_store_webauthn_credential',
      {
        target_backed_up: info.credentialBackedUp,
        target_counter: info.credential.counter,
        target_credential_id: info.credential.id,
        target_device_type: info.credentialDeviceType,
        target_employee_id: session.context.employee_id,
        target_label: label,
        target_public_key: encodeBase64Url(info.credential.publicKey),
        target_request_id: requestId,
        target_transports: response.response.transports ?? info.credential.transports ?? [],
        target_webauthn_user_id: encodeBase64Url(new TextEncoder().encode(session.context.employee_id)),
      },
      session.config.serviceRoleKey,
    )
    const storedCredentials = await listSecurityKeyCredentials(serviceConfig, session.context.employee_id)
    const stored = storedCredentials.find((credential) => credential.credentialId === info.credential.id)
    if (!stored) throw new ApiError('security_key_store_failed', 500, 'The security key was verified but could not be loaded. Try again.')
    await sendSecurityKeyChangeNotice(environment, session.context.employee_id, 'added', stored.label, stored.id)
    return json({ key: securityKeySummary(stored), requestId, verified: true })
  }

  if (url.pathname === authenticationOptionsPath) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    requireSecurityKeyPilot(environment, session.context.username)
    if (credentials.length === 0) throw new ApiError('security_key_not_registered', 404, 'No security key is registered for this account.')
    const options = await generateAuthenticationOptions({
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports,
      })),
      rpID: webAuthnRpId(request),
      timeout: 90_000,
      userVerification: 'required',
    })
    const challengeRecord = await callRpc<{ id: string; expiresAt: string }>(
      serviceConfig,
      'service_store_webauthn_challenge',
      {
        target_challenge: options.challenge,
        target_employee_id: session.context.employee_id,
        target_purpose: 'authentication',
      },
      session.config.serviceRoleKey,
    )
    return json({ challengeId: challengeRecord.id, expiresAt: challengeRecord.expiresAt, options, requestId })
  }

  if (url.pathname === authenticationVerifyPath) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', requestId, 405)
    requireSecurityKeyPilot(environment, session.context.username)
    const body = await readWebAuthnBody(request)
    const challengeId = typeof body.challengeId === 'string' ? body.challengeId : ''
    if (!/^[0-9a-f-]{36}$/i.test(challengeId)) throw new ApiError('invalid_security_key_request', 422, 'The security-key request was invalid.')
    const response = asSecurityKeyResponse(body.response, 'authentication') as AuthenticationResponseJSON
    const credentialRecord = credentials.find((credential) => credential.credentialId === response.id)
    if (!credentialRecord) throw new ApiError('security_key_not_registered', 404, 'That security key is not registered for this account.')
    const challenge = await callRpc<SecurityKeyChallengeRecord>(
      serviceConfig,
      'service_consume_webauthn_challenge',
      {
        target_challenge_id: challengeId,
        target_employee_id: session.context.employee_id,
        target_purpose: 'authentication',
      },
      session.config.serviceRoleKey,
    )
    const storedCredential: WebAuthnCredential = {
      counter: Number(credentialRecord.counter),
      id: credentialRecord.credentialId,
      publicKey: decodeBase64Url(credentialRecord.publicKey),
      transports: credentialRecord.transports,
    }
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        credential: storedCredential,
        expectedChallenge: challenge.challenge,
        expectedOrigin: expectedWebAuthnOrigins(request),
        expectedRPID: webAuthnRpId(request),
        requireUserVerification: true,
        response,
      })
    } catch {
      throw new ApiError('security_key_verification_failed', 422, 'The security key could not be verified. Start again and touch the key when prompted.')
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      throw new ApiError('security_key_verification_failed', 422, 'The security key could not be verified.')
    }
    await callRpc(
      serviceConfig,
      'service_update_webauthn_counter',
      {
        target_counter: verification.authenticationInfo.newCounter,
        target_credential_id: credentialRecord.credentialId,
        target_employee_id: session.context.employee_id,
      },
      session.config.serviceRoleKey,
    )
    const claims = accessTokenClaims(session.token)
    const authSessionId = claims?.session_id
    const jwtExpiresAt = typeof claims?.exp === 'number' ? claims.exp * 1000 : 0
    if (!authSessionId || !/^[0-9a-f-]{36}$/i.test(authSessionId) || jwtExpiresAt <= Date.now()) {
      throw new ApiError('security_key_session_unavailable', 401, 'Sign in again before using the security key.')
    }
    const rawToken = generateOpaqueToken()
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    await callRpc(
      serviceConfig,
      'service_issue_security_key_session',
      {
        target_auth_session_id: authSessionId,
        target_employee_id: session.context.employee_id,
        target_expires_at: expiresAt,
        target_request_id: requestId,
        target_token_hash: await sha256Hex(rawToken),
      },
      session.config.serviceRoleKey,
    )
    return json({ expiresAt, key: securityKeySummary(credentialRecord), requestId, securityKeyToken: rawToken, verified: true })
  }

  const keyId = url.pathname.match(/^\/api\/v1\/account\/security-keys\/([0-9a-f-]{36})$/i)?.[1]
  if (keyId) {
    requireSecurityKeyPilot(environment, session.context.username)
    requireRawAal2(session.token)
    await requireMaintenanceWriteAccess(serviceConfig, 'user_accounts')
    if (request.method === 'PATCH') {
      const body = await readJsonBody(request)
      const label = typeof body.label === 'string' ? body.label.trim() : ''
      if (!label || label.length > 60) throw new ApiError('security_key_label_required', 422, 'Enter a key name no longer than 60 characters.')
      await callRpc(
        serviceConfig,
        'service_rename_webauthn_credential',
        {
          target_credential_record_id: keyId,
          target_employee_id: session.context.employee_id,
          target_label: label,
          target_request_id: requestId,
        },
        session.config.serviceRoleKey,
      )
      const renamed = (await listSecurityKeyCredentials(serviceConfig, session.context.employee_id))
        .find((credential) => credential.id === keyId)
      if (!renamed) throw new ApiError('security_key_not_found', 404, 'The security key was not found.')
      return json({ key: securityKeySummary(renamed), requestId })
    }
    if (request.method !== 'DELETE') return errorJson('method_not_allowed', requestId, 405)
    const key = credentials.find((credential) => credential.id === keyId)
    if (!key) throw new ApiError('security_key_not_found', 404, 'The security key was not found.')
    const result = await callRpc<Record<string, unknown>>(
      serviceConfig,
      'service_revoke_webauthn_credential',
      {
        target_credential_record_id: keyId,
        target_employee_id: session.context.employee_id,
        target_request_id: requestId,
      },
      session.config.serviceRoleKey,
    )
    await sendSecurityKeyChangeNotice(environment, session.context.employee_id, 'removed', key.label, key.id)
    return json({ ...result, requestId })
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

  if (request.method !== 'GET') {
    await requireMaintenanceWriteAccess(
      { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url },
      'user_accounts',
    )
  }

  const body = request.method === 'GET' ? {} : await readJsonBody(request)
  let usersByEmail: Map<string, AuthUser> | null = null
  const getUsersByEmail = async () => {
    if (!usersByEmail) {
      usersByEmail = new Map(
        (await listAuthUsers(admin.config)).map((user) => [String(user.email).toLowerCase(), user]),
      )
    }
    return usersByEmail
  }

  const adminSecurityKeysMatch = /^\/api\/v1\/admin\/users\/([0-9a-f-]{36})\/security-keys(?:\/([0-9a-f-]{36}))?$/i.exec(url.pathname)
  if (adminSecurityKeysMatch) {
    const employeeId = adminSecurityKeysMatch[1]
    const keyId = adminSecurityKeysMatch[2]
    const serviceConfig = { serviceRoleKey: admin.config.serviceRoleKey, url: admin.config.url }
    if (!keyId) {
      if (request.method !== 'GET') return errorJson('method_not_allowed', requestId, 405)
      const keys = await listSecurityKeyCredentials(serviceConfig, employeeId)
      return json({ keys: keys.map(securityKeySummary), requestId })
    }
    if (request.method !== 'DELETE') return errorJson('method_not_allowed', requestId, 405)
    const key = (await listSecurityKeyCredentials(serviceConfig, employeeId))
      .find((credential) => credential.id === keyId)
    if (!key) throw new ApiError('security_key_not_found', 404, 'The security key was not found.')
    const result = await callRpc<Record<string, unknown>>(
      serviceConfig,
      'service_admin_revoke_webauthn_credential',
      {
        target_actor_employee_id: admin.context.employee_id,
        target_credential_record_id: keyId,
        target_employee_id: employeeId,
        target_request_id: requestId,
      },
      admin.config.serviceRoleKey,
    )
    await sendSecurityKeyChangeNotice(environment, employeeId, 'removed', key.label, key.id)
    return json({ ...result, requestId })
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

    const resetRecord = await callRpc<{
      securityKeysRevoked?: number
      securityKeySessionsRevoked?: number
      trustedDevicesRevoked?: number
    }>(
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
    if ((resetRecord.securityKeysRevoked ?? 0) > 0) {
      await sendSecurityKeyChangeNotice(
        environment,
        target.employeeId,
        'removed',
        `${resetRecord.securityKeysRevoked} security key${resetRecord.securityKeysRevoked === 1 ? '' : 's'} during an MFA reset`,
        target.employeeId,
      )
    }

    return json({
      displayName: target.displayName,
      factorsRemoved: factors.length,
      recoveryCodesRevoked,
      requestId,
      securityKeysRevoked: resetRecord.securityKeysRevoked ?? 0,
      securityKeySessionsRevoked: resetRecord.securityKeySessionsRevoked ?? 0,
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

  const additionalHeaders = forwardedAssuranceHeaders(request)

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

interface HrAutomationJob {
  id: string
  instanceId: string
  stepKey: string
  jobType: 'human_task' | 'notification' | 'delay' | 'condition' | 'complete'
  payload: Record<string, unknown>
  attemptCount: number
  maxAttempts: number
  leasedUntil: string
}

function asHrAutomationJobs(value: unknown): HrAutomationJob[] {
  if (!Array.isArray(value)) throw new Error('The automation queue returned an invalid batch.')
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('The automation queue returned an invalid job.')
    const job = item as Record<string, unknown>
    const jobType = job.jobType
    if (
      typeof job.id !== 'string'
      || typeof job.instanceId !== 'string'
      || typeof job.stepKey !== 'string'
      || !['human_task', 'notification', 'delay', 'condition', 'complete'].includes(String(jobType))
      || !job.payload
      || typeof job.payload !== 'object'
      || Array.isArray(job.payload)
      || typeof job.attemptCount !== 'number'
      || typeof job.maxAttempts !== 'number'
      || typeof job.leasedUntil !== 'string'
    ) throw new Error('The automation queue returned an invalid job.')
    return job as unknown as HrAutomationJob
  })
}

function hrAutomationCompletionResult(job: HrAutomationJob): Record<string, unknown> {
  if (job.jobType !== 'condition') return {}
  if (typeof job.payload.conditionMatched !== 'boolean') {
    throw new Error('A condition step requires an explicit conditionMatched boolean.')
  }
  return { conditionMatched: job.payload.conditionMatched }
}

async function processHrAutomationJobs(environment: Environment, limit = 10): Promise<{
  claimed: number
  completed: string[]
  enabled: boolean
  failed: Array<{ id: string, error: string }>
  scheduled: number
  escalated: number
}> {
  if (!hrAutomationEnabled(environment)) {
    return { claimed: 0, completed: [], enabled: false, failed: [], scheduled: 0, escalated: 0 }
  }
  const config = configuredSupabase(environment)
  if (!config) throw new ApiError('server_not_configured', 503, 'The protected data service is not configured.')
  const batchLimit = Math.max(1, Math.min(limit, 10))
  const targetNow = new Date().toISOString()
  const [scheduled, escalated] = await Promise.all([
    callRpc<number>(
      { serviceRoleKey: config.serviceRoleKey, url: config.url },
      'service_enqueue_due_hr_automation',
      { target_now: targetNow },
      config.serviceRoleKey,
    ),
    callRpc<number>(
      { serviceRoleKey: config.serviceRoleKey, url: config.url },
      'service_enqueue_hr_task_escalations',
      { target_now: targetNow },
      config.serviceRoleKey,
    ),
  ])
  const jobs = asHrAutomationJobs(await callRpc<unknown>(
    { serviceRoleKey: config.serviceRoleKey, url: config.url },
    'service_claim_hr_automation_jobs',
    { target_lease_seconds: 120, target_limit: batchLimit, target_worker_id: crypto.randomUUID() },
    config.serviceRoleKey,
  ))
  const completed: string[] = []
  const failed: Array<{ id: string, error: string }> = []
  for (const job of jobs) {
    try {
      await callRpc<unknown>(
        { serviceRoleKey: config.serviceRoleKey, url: config.url },
        'service_complete_hr_automation_job',
        { target_job_id: job.id, target_result: hrAutomationCompletionResult(job) },
        config.serviceRoleKey,
      )
      completed.push(job.id)
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'The automation job failed.').slice(0, 500)
      failed.push({ id: job.id, error: message })
      try {
        await callRpc<unknown>(
          { serviceRoleKey: config.serviceRoleKey, url: config.url },
          'service_fail_hr_automation_job',
          { target_error_code: 'worker_execution_failed', target_error_message: message, target_job_id: job.id },
          config.serviceRoleKey,
        )
      } catch (failureRecordingError) {
        console.error(JSON.stringify({
          error: failureRecordingError instanceof Error ? failureRecordingError.message : 'Failure recording failed.',
          event: 'hr_automation_failure_recording_failed',
          jobId: job.id,
        }))
      }
    }
  }
  return {
    claimed: jobs.length,
    completed,
    enabled: true,
    failed,
    scheduled: Number.isFinite(scheduled) ? scheduled : 0,
    escalated: Number.isFinite(escalated) ? escalated : 0,
  }
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
    } else if (url.pathname.startsWith('/api/v1/account/security-keys')) {
      try {
        response = await handleAccountSecurityKeysApi(request, environment, requestId)
      } catch (error) {
        if (error instanceof Response) {
          const payload = await error.json().catch(() => ({ error: 'auth_required' })) as { error?: string }
          response = errorJson(payload.error ?? 'auth_required', requestId, error.status)
        } else {
          response = error instanceof ApiError
            ? errorJson(error.code, requestId, error.status, error.message)
            : errorJson('security_key_request_failed', requestId, 500, 'The security-key request could not be completed.')
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
    } else if (url.pathname.startsWith('/api/v1/hr/recruiting')) {
      try {
        response = await handleHrRecruitingApi(request, environment, requestId)
      } catch (error) {
        if (error instanceof Response) {
          const payload = await error.json().catch(() => ({ error: 'auth_required' })) as { error?: string }
          response = errorJson(payload.error ?? 'auth_required', requestId, error.status)
        } else {
          response = error instanceof ApiError
            ? errorJson(error.code, requestId, error.status, error.message)
            : errorJson('hr_recruiting_request_failed', requestId, 500, 'The Recruiting request could not be completed.')
        }
      }
    } else if (url.pathname.startsWith('/api/v1/hr/leave')) {
      try {
        response = await handleHrLeaveApi(request, environment, requestId)
      } catch (error) {
        if (error instanceof Response) {
          const payload = await error.json().catch(() => ({ error: 'auth_required' })) as { error?: string }
          response = errorJson(payload.error ?? 'auth_required', requestId, error.status)
        } else {
          response = error instanceof ApiError
            ? errorJson(error.code, requestId, error.status, error.message)
            : errorJson('hr_leave_request_failed', requestId, 500, 'The Leave Administration request could not be completed.')
        }
      }
    } else if (url.pathname.startsWith('/api/v1/hr/benefits')) {
      try {
        response = await handleHrBenefitsApi(request, environment, requestId)
      } catch (error) {
        if (error instanceof Response) {
          const payload = await error.json().catch(() => ({ error: 'auth_required' })) as { error?: string }
          response = errorJson(payload.error ?? 'auth_required', requestId, error.status)
        } else {
          response = error instanceof ApiError
            ? errorJson(error.code, requestId, error.status, error.message)
            : errorJson('hr_benefits_request_failed', requestId, 500, 'The Benefits request could not be completed.')
        }
      }
    } else if (url.pathname.startsWith('/api/v1/hr/compensation')) {
      try {
        response = await handleHrCompensationApi(request, environment, requestId)
      } catch (error) {
        if (error instanceof Response) {
          const payload = await error.json().catch(() => ({ error: 'auth_required' })) as { error?: string }
          response = errorJson(payload.error ?? 'auth_required', requestId, error.status)
        } else {
          response = error instanceof ApiError
            ? errorJson(error.code, requestId, error.status, error.message)
            : errorJson('hr_compensation_request_failed', requestId, 500, 'The Compensation request could not be completed.')
        }
      }
    } else if (url.pathname.startsWith('/api/v1/hr/onboarding')) {
      try {
        response = await handleHrOnboardingApi(request, environment, requestId)
      } catch (error) {
        if (error instanceof Response) {
          const payload = await error.json().catch(() => ({ error: 'auth_required' })) as { error?: string }
          response = errorJson(payload.error ?? 'auth_required', requestId, error.status)
        } else {
          response = error instanceof ApiError
            ? errorJson(error.code, requestId, error.status, error.message)
            : errorJson('hr_onboarding_request_failed', requestId, 500, 'The Onboarding request could not be completed.')
        }
      }
    } else if (url.pathname.startsWith('/api/v1/hr/automation')) {
      try {
        response = await handleHrAutomationApi(request, environment, requestId)
      } catch (error) {
        if (error instanceof Response) {
          const payload = await error.json().catch(() => ({ error: 'auth_required' })) as { error?: string }
          response = errorJson(payload.error ?? 'auth_required', requestId, error.status)
        } else {
          response = error instanceof ApiError
            ? errorJson(error.code, requestId, error.status, error.message)
            : errorJson('hr_automation_request_failed', requestId, 500, 'The HR automation request could not be completed.')
        }
      }
    } else if (url.pathname.startsWith('/api/v1/hr/documents')) {
      try {
        response = await handleHrDocumentsApi(request, environment, requestId)
      } catch (error) {
        if (error instanceof Response) {
          const payload = await error.json().catch(() => ({ error: 'auth_required' })) as { error?: string }
          response = errorJson(payload.error ?? 'auth_required', requestId, error.status)
        } else {
          response = error instanceof ApiError
            ? errorJson(error.code, requestId, error.status, error.message)
            : errorJson('hr_document_request_failed', requestId, 500, 'The protected document request could not be completed.')
        }
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
      const hrAutomation = await processHrAutomationJobs(environment, 10)
      const notifications = await processNotificationJobs(environment, 25)
      console.info(JSON.stringify({ alertLifecycle, automation, cron: controller.cron, fullReconciliation, hrAutomation, jobRunId, notifications, scheduledAnnouncements, scheduledTime: controller.scheduledTime }))
    })())
  },
}
