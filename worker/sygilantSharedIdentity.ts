const launchPath = '/api/v1/apps/sygilant/launch'
const introspectionPath = '/api/v1/apps/sygilant/introspect'
const destination = '/dashboard'
const applicationId = 'sygilant'
const assertionPattern = /^ssli_v1\.[A-Za-z0-9_-]{20,5000}\.[a-f0-9]{64}$/i
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const assuranceLevels = new Set(['aal2', 'security_key', 'trusted_device', 'external_mfa'])
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type SygilantSharedIdentityEnvironment = {
  SUPABASE_PUBLISHABLE_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  SUPABASE_URL?: string
  SYGSHIFT_PUBLIC_APP_URL?: string
  SYGILANT_SHARED_IDENTITY_APPLICATION_URL?: string
  SYGILANT_SHARED_IDENTITY_AUDIENCE?: string
  SYGILANT_SHARED_IDENTITY_CONSUMER_SECRET?: string
  SYGILANT_SHARED_IDENTITY_ENABLED?: string
  SYGILANT_SHARED_IDENTITY_ISSUER?: string
  SYGILANT_SHARED_IDENTITY_SIGNING_SECRET?: string
  SYGILANT_SHARED_IDENTITY_TOKEN_TTL_SECONDS?: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string
  VITE_SUPABASE_URL?: string
}

type Configuration = {
  applicationUrl: string
  audience: string
  consumerSecret: string
  issuer: string
  publishableKey: string
  serviceRoleKey: string
  signingSecret: string
  supabaseUrl: string
  ttlSeconds: number
}

type SessionContext = {
  employee_id?: string
  has_mfa?: boolean
  permissions?: string[]
  role?: string
  username?: string
}

type AuthUser = { id?: string }

type AssertionPayload = {
  applicationId: 'sygilant'
  assuranceLevel: 'aal2' | 'security_key' | 'trusted_device' | 'external_mfa'
  audience: string
  destination: '/dashboard'
  expiresAt: string
  externalEmployeeId: string
  externalSubjectId: string
  externalUsername: string
  issuedAt: string
  issuer: string
  nonce: string
  profileId: string
  requestId: string
  roleId: string
  version: 1
}

type ConsumedIdentity = {
  assuranceLevel?: string
  authUserId?: string
  destination?: string
  employeeId?: string
  expiresAt?: string
  requestId?: string
  roleId?: string
  username?: string
}

class SharedLaunchError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

export async function handleSygilantSharedIdentityRequest(
  request: Request,
  environment: SygilantSharedIdentityEnvironment,
  requestId: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (path !== launchPath && path !== introspectionPath) return null

  try {
    const config = configuration(environment)
    return path === launchPath
      ? await issueLaunch(request, config, requestId)
      : await introspectLaunch(request, config, requestId)
  } catch (error) {
    const failure = error instanceof SharedLaunchError
      ? error
      : new SharedLaunchError('sygilant_shared_identity_unavailable', 503, 'Sygilant shared access is temporarily unavailable.')
    if (failure.status >= 500) {
      console.error(JSON.stringify({
        code: failure.code,
        event: 'sygilant_shared_identity_failure',
        path,
        requestId,
        status: failure.status,
      }))
    }
    return responseJson({ error: failure.code, detail: failure.message, requestId }, failure.status)
  }
}

function configuration(environment: SygilantSharedIdentityEnvironment): Configuration {
  if (clean(environment.SYGILANT_SHARED_IDENTITY_ENABLED).toLowerCase() !== 'true') {
    throw new SharedLaunchError('sygilant_shared_identity_disabled', 503, 'Sygilant shared access is not enabled.')
  }
  const issuer = normalizedOrigin(environment.SYGILANT_SHARED_IDENTITY_ISSUER || environment.SYGSHIFT_PUBLIC_APP_URL || 'https://app.sygilant.us')
  const audience = normalizedOrigin(environment.SYGILANT_SHARED_IDENTITY_AUDIENCE || 'https://sygilant.us')
  const applicationUrl = normalizedOrigin(environment.SYGILANT_SHARED_IDENTITY_APPLICATION_URL || 'https://sygilant.us')
  const supabaseUrl = normalizedOrigin(environment.SUPABASE_URL || environment.VITE_SUPABASE_URL)
  const publishableKey = clean(environment.SUPABASE_PUBLISHABLE_KEY || environment.VITE_SUPABASE_PUBLISHABLE_KEY)
  const serviceRoleKey = clean(environment.SUPABASE_SERVICE_ROLE_KEY)
  const signingSecret = clean(environment.SYGILANT_SHARED_IDENTITY_SIGNING_SECRET)
  const consumerSecret = clean(environment.SYGILANT_SHARED_IDENTITY_CONSUMER_SECRET)
  const ttlSeconds = readTtl(environment.SYGILANT_SHARED_IDENTITY_TOKEN_TTL_SECONDS)
  if (
    issuer !== 'https://app.sygilant.us'
    || audience !== 'https://sygilant.us'
    || applicationUrl !== 'https://sygilant.us'
    || !supabaseUrl
    || !publishableKey
    || !serviceRoleKey
    || signingSecret.length < 32
    || consumerSecret.length < 32
  ) {
    throw new SharedLaunchError('sygilant_shared_identity_not_configured', 503, 'Sygilant shared access is not configured.')
  }
  if (constantTimeEqual(signingSecret, consumerSecret)) {
    throw new SharedLaunchError('sygilant_shared_identity_not_configured', 503, 'Sygilant shared access is not configured.')
  }
  return { applicationUrl, audience, consumerSecret, issuer, publishableKey, serviceRoleKey, signingSecret, supabaseUrl, ttlSeconds }
}

async function issueLaunch(request: Request, config: Configuration, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST', requestId)
  if (request.headers.get('origin') !== config.issuer) {
    throw new SharedLaunchError('sygilant_launch_origin_denied', 403, 'The launch request did not come from SygShift.')
  }
  if (Number(request.headers.get('content-length') ?? 0) > 0) {
    throw new SharedLaunchError('invalid_sygilant_launch_request', 400, 'The Sygilant launch request must not contain a body.')
  }

  const token = bearerToken(request)
  if (!token) throw new SharedLaunchError('authentication_required', 401, 'A verified SygShift session is required.')
  const context = await launchStage(
    'sygilant_launch_session_context_unavailable',
    'The active SygShift security context could not be confirmed.',
    () => sessionContext(token, request, config),
  )
  const authUser = await launchStage(
    'sygilant_launch_auth_identity_unavailable',
    'The active SygShift identity could not be confirmed.',
    () => verifyAuthUser(token, config),
  )
  const claims = accessTokenClaims(token)
  if (
    !uuidPattern.test(authUser.id ?? '')
    || claims.sub !== authUser.id
    || !uuidPattern.test(claims.session_id ?? '')
    || !uuidPattern.test(context.employee_id ?? '')
    || !/^[a-z][a-z0-9]{1,62}$/.test(context.username ?? '')
    || typeof context.role !== 'string'
  ) {
    throw new SharedLaunchError('sygilant_launch_identity_invalid', 403, 'The active SygShift identity could not be verified.')
  }
  if (context.permissions?.includes('apps.sygilant.access') !== true) {
    throw new SharedLaunchError('sygilant_launch_permission_required', 403, 'Your account is not approved for the Sygilant main platform.')
  }
  if (context.has_mfa !== true) {
    throw new SharedLaunchError('sygilant_launch_mfa_required', 403, 'Complete SygShift security verification before opening Sygilant.')
  }

  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + config.ttlSeconds * 1000)
  const payload: AssertionPayload = {
    applicationId,
    assuranceLevel: assuranceLevel(request, claims),
    audience: config.audience,
    destination,
    expiresAt: expiresAt.toISOString(),
    externalEmployeeId: context.employee_id!,
    externalSubjectId: authUser.id!,
    externalUsername: context.username!,
    issuedAt: issuedAt.toISOString(),
    issuer: config.issuer,
    nonce: randomToken(24),
    profileId: authUser.id!,
    requestId: crypto.randomUUID(),
    roleId: context.role,
    version: 1,
  }
  const assertion = await launchStage(
    'sygilant_launch_assertion_unavailable',
    'The secure launch assertion could not be prepared.',
    async () => {
      const encoded = encodeJson(payload)
      return `ssli_v1.${encoded}.${await hmacHex(encoded, config.signingSecret)}`
    },
  )
  await launchStage(
    'sygilant_launch_ledger_unavailable',
    'The secure launch request could not be recorded.',
    async () => serviceRpc('service_issue_sygilant_shared_launch', {
      target_payload: {
        ...payload,
        assertionHash: await sha256Hex(assertion),
        nonceHash: await sha256Hex(payload.nonce),
        requestContext: requestContext(request, requestId),
        sourceAuthSessionId: claims.session_id,
      },
    }, config),
  )

  return responseJson({
    launch: {
      applicationId,
      applicationUrl: config.applicationUrl,
      assertion,
      destination,
      expiresAt: payload.expiresAt,
      requestId: payload.requestId,
    },
    requestId,
  }, 201)
}

async function introspectLaunch(request: Request, config: Configuration, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST', requestId)
  const consumerToken = bearerToken(request)
  if (!constantTimeEqual(consumerToken, config.consumerSecret)) {
    throw new SharedLaunchError('invalid_consumer_authorization', 401, 'Sygilant consumer authorization is invalid.')
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new SharedLaunchError('sygilant_introspection_content_type_required', 415, 'The introspection request must use JSON.')
  }
  const body = await boundedJson(request, 20_000)
  if (!body || Object.keys(body).some((key) => key !== 'assertion')) {
    throw new SharedLaunchError('invalid_launch_assertion', 400, 'The shared identity assertion request is invalid.')
  }
  const assertion = clean(body.assertion)
  const verified = await verifyAssertion(assertion, config)
  const consumed = await serviceRpc<ConsumedIdentity>('service_consume_sygilant_shared_launch', {
    target_payload: {
      ...verified,
      assertionHash: await sha256Hex(assertion),
      requestContext: requestContext(request, requestId),
    },
  }, config)
  if (
    consumed.authUserId !== verified.externalSubjectId
    || consumed.employeeId !== verified.externalEmployeeId
    || consumed.username !== verified.externalUsername
    || consumed.roleId !== verified.roleId
    || consumed.requestId !== verified.requestId
    || consumed.assuranceLevel !== verified.assuranceLevel
    || consumed.destination !== destination
  ) {
    throw new SharedLaunchError('sygilant_launch_identity_mismatch', 403, 'The Sygilant launch identity could not be verified.')
  }

  return responseJson({
    identity: {
      applicationId,
      assuranceLevel: consumed.assuranceLevel,
      destination,
      expiresAt: consumed.expiresAt,
      externalEmployeeId: consumed.employeeId,
      externalSubjectId: consumed.authUserId,
      externalUsername: consumed.username,
      organizationId: 'sygshift',
      profileId: consumed.authUserId,
      requestId: consumed.requestId,
      roleId: consumed.roleId,
    },
    requestId,
  }, 200)
}

async function verifyAssertion(assertion: string, config: Configuration): Promise<AssertionPayload> {
  if (!assertionPattern.test(assertion) || assertion.length > 16_384) {
    throw new SharedLaunchError('invalid_launch_assertion', 400, 'The shared identity assertion is malformed.')
  }
  const [, encoded, signature] = assertion.split('.')
  const expected = await hmacHex(encoded, config.signingSecret)
  if (!constantTimeEqual(signature.toLowerCase(), expected)) {
    throw new SharedLaunchError('invalid_launch_signature', 401, 'The shared identity assertion signature is invalid.')
  }
  const value = decodeJson(encoded) as Partial<AssertionPayload> | null
  const issuedAt = Date.parse(value?.issuedAt ?? '')
  const expiresAt = Date.parse(value?.expiresAt ?? '')
  if (
    value?.version !== 1
    || value.applicationId !== applicationId
    || value.issuer !== config.issuer
    || value.audience !== config.audience
    || value.destination !== destination
    || value.profileId !== value.externalSubjectId
    || !uuidPattern.test(value.externalSubjectId ?? '')
    || !uuidPattern.test(value.externalEmployeeId ?? '')
    || !uuidPattern.test(value.requestId ?? '')
    || !/^[a-z][a-z0-9]{1,62}$/.test(value.externalUsername ?? '')
    || typeof value.roleId !== 'string'
    || value.roleId.length < 2
    || !assuranceLevels.has(value.assuranceLevel ?? '')
    || !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt > Date.now() + 60_000
    || expiresAt <= Date.now()
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > 300_000
  ) {
    throw new SharedLaunchError('invalid_launch_assertion', 400, 'The shared identity assertion payload is invalid or expired.')
  }
  return value as AssertionPayload
}

async function sessionContext(token: string, request: Request, config: Configuration): Promise<SessionContext> {
  const headers: Record<string, string> = {
    apikey: config.publishableKey,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }
  const trustedDevice = request.headers.get('x-sygshift-trusted-device')
  const securityKey = request.headers.get('x-sygshift-security-key')
  if (trustedDevice) headers['x-sygshift-trusted-device'] = trustedDevice
  if (securityKey) headers['x-sygshift-security-key'] = securityKey
  const payload = await upstreamJson(`${config.supabaseUrl}/rest/v1/rpc/get_session_context`, {
    body: '{}', headers, method: 'POST',
  }) as SessionContext[] | SessionContext
  const context = Array.isArray(payload) ? payload[0] : payload
  if (!context?.employee_id) throw new SharedLaunchError('authentication_required', 401, 'A verified SygShift session is required.')
  return context
}

async function verifyAuthUser(token: string, config: Configuration): Promise<AuthUser> {
  const payload = await upstreamJson(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: config.publishableKey, authorization: `Bearer ${token}` }, method: 'GET',
  }) as AuthUser
  if (!uuidPattern.test(payload?.id ?? '')) throw new SharedLaunchError('authentication_required', 401, 'The SygShift session could not be verified.')
  return payload
}

async function serviceRpc<T = unknown>(name: string, body: Record<string, unknown>, config: Configuration): Promise<T> {
  return upstreamJson(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
    body: JSON.stringify(body),
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  }) as Promise<T>
}

async function upstreamJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5_000) })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new SharedLaunchError('shared_identity_upstream_rejected', response.status === 409 ? 409 : 502, 'The shared identity service rejected the request.')
  }
  return payload
}

function assuranceLevel(request: Request, claims: { aal?: string }): AssertionPayload['assuranceLevel'] {
  if (claims.aal === 'aal2') return 'aal2'
  if (request.headers.get('x-sygshift-security-key')) return 'security_key'
  if (request.headers.get('x-sygshift-trusted-device')) return 'trusted_device'
  return 'external_mfa'
}

function accessTokenClaims(token: string): { aal?: string, session_id?: string, sub?: string } {
  return decodeJson(token.split('.')[1] ?? '') as { aal?: string, session_id?: string, sub?: string } ?? {}
}

function requestContext(request: Request, requestId: string): Record<string, string | null> {
  return {
    ipAddress: request.headers.get('cf-connecting-ip'),
    origin: request.headers.get('origin'),
    path: new URL(request.url).pathname,
    requestId,
    userAgent: request.headers.get('user-agent'),
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? ''
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}

async function boundedJson(request: Request, maximumBytes: number): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > maximumBytes) throw new SharedLaunchError('shared_identity_request_too_large', 413, 'The request was too large.')
  const text = await request.text()
  if (encoder.encode(text).byteLength > maximumBytes) throw new SharedLaunchError('shared_identity_request_too_large', 413, 'The request was too large.')
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function readTtl(value: unknown): number {
  if (value == null || value === '') return 60
  const ttl = Number.parseInt(String(value), 10)
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 300) {
    throw new SharedLaunchError('invalid_shared_identity_config', 503, 'The shared identity TTL must be between 30 and 300 seconds.')
  }
  return ttl
}

function normalizedOrigin(value: unknown): string {
  const text = clean(value)
  if (!text) return ''
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return ''
    return url.origin
  } catch {
    return ''
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function launchStage<T>(
  code: string,
  detail: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof SharedLaunchError) throw error
    throw new SharedLaunchError(code, 503, detail)
  }
}

function randomToken(size = 48): string {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  return encodeBase64Url(bytes)
}

async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { hash: 'SHA-256', name: 'HMAC' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)))
}

function decodeJson(value: string): unknown {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const binary = atob(normalized)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return JSON.parse(decoder.decode(bytes))
  } catch {
    return null
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function constantTimeEqual(left: string, right: string): boolean {
  if (!left || left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

function responseJson(payload: unknown, status: number): Response {
  return Response.json(payload, { headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' }, status })
}

function methodNotAllowed(allow: string, requestId: string): Response {
  const response = responseJson({ error: 'method_not_allowed', requestId }, 405)
  response.headers.set('allow', allow)
  return response
}
