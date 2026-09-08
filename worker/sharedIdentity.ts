const launchPath = '/api/v1/auth/shared-identity/launch'
const completionPath = '/api/v1/auth/shared-identity/complete'
const finalizationPath = '/api/v1/auth/shared-identity/finalize'
const callbackPath = '/auth/shared-identity/callback'
const destination = '/sygsphere'
const launchCookie = '__Host-sygshift-shared-launch'
const ticketCookie = '__Host-sygshift-shared-ticket'
const assertionPattern = /^glsi_v1\.[A-Za-z0-9_-]{20,3000}\.[a-f0-9]{64}$/i
const ticketPattern = /^sygsso_v1\.[A-Za-z0-9_-]{20,3000}\.[a-f0-9]{64}$/i
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const assuranceLevels = new Set(['aal2', 'security_key', 'trusted_device', 'external_mfa'])
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type SharedIdentityEnvironment = {
  SUPABASE_PUBLISHABLE_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  SUPABASE_URL?: string
  SYGSHIFT_PUBLIC_APP_URL?: string
  SYGSHIFT_SHARED_IDENTITY_CONSUMER_SECRET?: string
  SYGSHIFT_SHARED_IDENTITY_ENABLED?: string
  SYGSHIFT_SHARED_IDENTITY_INTROSPECTION_URL?: string
  SYGSHIFT_SHARED_IDENTITY_ISSUER?: string
  SYGSHIFT_SHARED_IDENTITY_SESSION_SECRET?: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string
  VITE_SUPABASE_URL?: string
}

type SharedIdentityConfiguration = {
  appOrigin: string
  consumerSecret: string
  introspectionUrl: string
  issuer: string
  publishableKey: string
  serviceRoleKey: string
  sessionSecret: string
  supabaseUrl: string
}

type SharedIdentity = {
  applicationId: 'sygshift'
  assuranceLevel: 'aal2' | 'security_key' | 'trusted_device' | 'external_mfa'
  destination: '/sygsphere'
  expiresAt: string
  externalEmployeeId: string
  externalSubjectId: string
  externalUsername: string
  profileId: string
  requestId: string
}

type LocalIdentity = {
  authEmail: string
  employeeId: string
  existingAuthUserId: string
  username: string
}

type SharedIdentityTicket = {
  assuranceLevel: SharedIdentity['assuranceLevel']
  authUserId: string
  employeeId: string
  expiresAt: string
  nonce: string
  requestId: string
  username: string
}

class SharedIdentityError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

export async function handleSharedIdentityRequest(
  request: Request,
  environment: SharedIdentityEnvironment,
  requestId: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (![launchPath, completionPath, finalizationPath].includes(path)) return null

  try {
    const config = configuration(environment)
    if (path === launchPath) return await receiveLaunch(request, config, requestId)
    if (path === completionPath) return await completeLaunch(request, config, requestId)
    return await finalizeLaunch(request, config, requestId)
  } catch (error) {
    const failure = error instanceof SharedIdentityError
      ? error
      : new SharedIdentityError('shared_identity_unavailable', 503, 'Shared access is temporarily unavailable.')
    return responseJson({ error: failure.code, detail: failure.message, requestId }, failure.status)
  }
}

function configuration(environment: SharedIdentityEnvironment): SharedIdentityConfiguration {
  if (environment.SYGSHIFT_SHARED_IDENTITY_ENABLED?.trim().toLowerCase() !== 'true') {
    throw new SharedIdentityError('shared_identity_disabled', 503, 'Shared access is not enabled.')
  }

  const appOrigin = normalizedOrigin(environment.SYGSHIFT_PUBLIC_APP_URL || 'https://app.sygilant.us')
  const issuer = normalizedOrigin(environment.SYGSHIFT_SHARED_IDENTITY_ISSUER)
  const introspectionUrl = normalizedHttpsUrl(environment.SYGSHIFT_SHARED_IDENTITY_INTROSPECTION_URL)
  const supabaseUrl = normalizedHttpsUrl(environment.SUPABASE_URL || environment.VITE_SUPABASE_URL)
  const publishableKey = clean(environment.SUPABASE_PUBLISHABLE_KEY || environment.VITE_SUPABASE_PUBLISHABLE_KEY)
  const serviceRoleKey = clean(environment.SUPABASE_SERVICE_ROLE_KEY)
  const consumerSecret = clean(environment.SYGSHIFT_SHARED_IDENTITY_CONSUMER_SECRET)
  const sessionSecret = clean(environment.SYGSHIFT_SHARED_IDENTITY_SESSION_SECRET)

  if (
    !appOrigin
    || !issuer
    || !introspectionUrl
    || new URL(introspectionUrl).origin !== issuer
    || !supabaseUrl
    || !publishableKey
    || !serviceRoleKey
    || consumerSecret.length < 32
    || sessionSecret.length < 32
  ) {
    throw new SharedIdentityError('shared_identity_not_configured', 503, 'Shared access is not configured.')
  }

  return { appOrigin, consumerSecret, introspectionUrl, issuer, publishableKey, serviceRoleKey, sessionSecret, supabaseUrl }
}

async function receiveLaunch(request: Request, config: SharedIdentityConfiguration, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST', requestId)
  if (request.headers.get('origin') !== config.issuer) {
    throw new SharedIdentityError('shared_identity_origin_denied', 403, 'The shared access request did not come from an approved application.')
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new SharedIdentityError('shared_identity_content_type_required', 415, 'The shared access request format was not accepted.')
  }

  const text = await boundedText(request, 4096)
  const form = new URLSearchParams(text)
  if ([...form.keys()].some((key) => key !== 'assertion' && key !== 'destination')) {
    throw new SharedIdentityError('invalid_shared_identity_request', 400, 'The shared access request contained unexpected fields.')
  }
  const assertion = form.get('assertion')?.trim() ?? ''
  if (form.get('destination') !== destination || !assertionPattern.test(assertion)) {
    throw new SharedIdentityError('invalid_shared_identity_request', 400, 'The shared access request was invalid.')
  }

  return redirectResponse(completionPath, [cookie(launchCookie, assertion, 90)], 303)
}

async function completeLaunch(request: Request, config: SharedIdentityConfiguration, requestId: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET', requestId)
  const assertion = readCookie(request, launchCookie)
  if (!assertion || !assertionPattern.test(assertion)) {
    throw new SharedIdentityError('shared_identity_launch_missing', 401, 'The shared access request is missing or expired.')
  }

  const identity = await introspectAssertion(assertion, config)
  const local = await loadLocalIdentity(identity.externalEmployeeId, config)
  validateLocalIdentity(identity, local)
  const ticket = await createTicket(identity, config)
  const actionLink = await createSessionLink(local.authEmail, config)
  const response = redirectResponse(actionLink, [clearCookie(launchCookie), cookie(ticketCookie, ticket, 180)], 303)
  response.headers.set('referrer-policy', 'no-referrer')
  return response
}

async function finalizeLaunch(request: Request, config: SharedIdentityConfiguration, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST', requestId)
  if (request.headers.get('origin') !== config.appOrigin) {
    throw new SharedIdentityError('shared_identity_origin_denied', 403, 'The shared session request did not come from SygShift.')
  }
  const ticketValue = readCookie(request, ticketCookie)
  const ticket = ticketValue ? await verifyTicket(ticketValue, config) : null
  if (!ticket) throw new SharedIdentityError('shared_identity_ticket_invalid', 401, 'The shared session request is missing or expired.')

  const token = bearerToken(request)
  const claims = accessTokenClaims(token)
  const authUser = await verifyAuthUser(token, config)
  if (
    authUser.id !== ticket.authUserId
    || claims.sub !== ticket.authUserId
    || !uuidPattern.test(claims.session_id ?? '')
    || typeof claims.exp !== 'number'
    || claims.exp * 1000 <= Date.now()
  ) {
    throw new SharedIdentityError('shared_identity_subject_mismatch', 403, 'The shared session identity did not match the authenticated account.')
  }

  const local = await loadLocalIdentity(ticket.employeeId, config)
  if (local.existingAuthUserId !== ticket.authUserId || local.username !== ticket.username) {
    throw new SharedIdentityError('shared_identity_subject_mismatch', 403, 'The shared session identity is no longer active.')
  }

  const sessionToken = generateOpaqueToken()
  const persistent = ticket.assuranceLevel === 'trusted_device'
  const expiresAt = new Date(Date.now() + (persistent ? 14 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000)).toISOString()
  await callServiceRpc('service_issue_shared_identity_session', {
    target_assurance_level: ticket.assuranceLevel,
    target_auth_session_id: claims.session_id,
    target_auth_user_id: ticket.authUserId,
    target_employee_id: ticket.employeeId,
    target_expires_at: expiresAt,
    target_launch_request_id: ticket.requestId,
    target_request_id: requestId,
    target_token_hash: await sha256Hex(sessionToken),
  }, config)

  const response = responseJson({ destination, expiresAt, persistent, sharedIdentityToken: sessionToken }, 200)
  response.headers.append('set-cookie', clearCookie(ticketCookie))
  return response
}

async function introspectAssertion(assertion: string, config: SharedIdentityConfiguration): Promise<SharedIdentity> {
  const response = await fetch(config.introspectionUrl, {
    body: JSON.stringify({ assertion }),
    headers: {
      authorization: `Bearer ${config.consumerSecret}`,
      'content-type': 'application/json',
    },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  const payload = await response.json().catch(() => null) as { identity?: unknown } | null
  if (!response.ok) {
    throw new SharedIdentityError('shared_identity_assertion_rejected', 401, 'The shared access request could not be verified.')
  }
  const identity = payload?.identity as Partial<SharedIdentity> | undefined
  if (
    identity?.applicationId !== 'sygshift'
    || identity.destination !== destination
    || !uuidPattern.test(identity.externalSubjectId ?? '')
    || identity.profileId !== identity.externalSubjectId
    || !uuidPattern.test(identity.externalEmployeeId ?? '')
    || !/^[a-z][a-z0-9]{1,62}$/.test(identity.externalUsername ?? '')
    || !uuidPattern.test(identity.requestId ?? '')
    || !assuranceLevels.has(identity.assuranceLevel ?? '')
    || !identity.expiresAt
    || Date.parse(identity.expiresAt) <= Date.now()
  ) {
    throw new SharedIdentityError('shared_identity_response_invalid', 502, 'The shared identity authority returned an invalid response.')
  }
  return identity as SharedIdentity
}

async function loadLocalIdentity(employeeId: string, config: SharedIdentityConfiguration): Promise<LocalIdentity> {
  const payload = await callServiceRpc('service_get_employee_login_email_target', {
    target_employee_id: employeeId,
  }, config) as Partial<LocalIdentity> | null
  if (
    !payload
    || payload.employeeId !== employeeId
    || !uuidPattern.test(payload.existingAuthUserId ?? '')
    || !/^[a-z][a-z0-9]{1,62}$/.test(payload.username ?? '')
    || typeof payload.authEmail !== 'string'
    || payload.authEmail.length > 320
  ) {
    throw new SharedIdentityError('shared_identity_account_unavailable', 403, 'The SygShift account is not active.')
  }
  return payload as LocalIdentity
}

function validateLocalIdentity(identity: SharedIdentity, local: LocalIdentity): void {
  if (
    local.existingAuthUserId !== identity.externalSubjectId
    || local.employeeId !== identity.externalEmployeeId
    || local.username !== identity.externalUsername
  ) {
    throw new SharedIdentityError('shared_identity_subject_mismatch', 403, 'The shared identity did not match the active SygShift account.')
  }
}

async function createSessionLink(authEmail: string, config: SharedIdentityConfiguration): Promise<string> {
  const payload = await upstreamJson(`${config.supabaseUrl}/auth/v1/admin/generate_link`, {
    body: JSON.stringify({
      email: authEmail,
      redirect_to: `${config.appOrigin}${callbackPath}`,
      type: 'magiclink',
    }),
    headers: serviceHeaders(config),
    method: 'POST',
  }) as { action_link?: unknown }
  const actionLink = typeof payload.action_link === 'string' ? payload.action_link : ''
  const parsed = normalizedHttpsUrl(actionLink)
  if (!parsed || new URL(parsed).origin !== new URL(config.supabaseUrl).origin || new URL(parsed).pathname !== '/auth/v1/verify') {
    throw new SharedIdentityError('shared_identity_session_unavailable', 502, 'The SygShift session could not be created.')
  }
  return actionLink
}

async function verifyAuthUser(token: string, config: SharedIdentityConfiguration): Promise<{ id: string }> {
  if (!token) throw new SharedIdentityError('shared_identity_auth_required', 401, 'A SygShift session is required.')
  const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: config.publishableKey, authorization: `Bearer ${token}` },
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  const payload = await response.json().catch(() => null) as { id?: unknown } | null
  if (!response.ok || typeof payload?.id !== 'string' || !uuidPattern.test(payload.id)) {
    throw new SharedIdentityError('shared_identity_auth_required', 401, 'The SygShift session could not be verified.')
  }
  return { id: payload.id }
}

async function callServiceRpc(name: string, body: Record<string, unknown>, config: SharedIdentityConfiguration): Promise<unknown> {
  return upstreamJson(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
    body: JSON.stringify(body),
    headers: serviceHeaders(config),
    method: 'POST',
  })
}

async function upstreamJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new SharedIdentityError('shared_identity_upstream_rejected', response.status === 409 ? 409 : 502, 'The shared session could not be completed.')
  }
  return payload
}

function serviceHeaders(config: SharedIdentityConfiguration): Record<string, string> {
  return {
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
    'content-type': 'application/json',
  }
}

async function createTicket(identity: SharedIdentity, config: SharedIdentityConfiguration): Promise<string> {
  const payload: SharedIdentityTicket = {
    assuranceLevel: identity.assuranceLevel,
    authUserId: identity.externalSubjectId,
    employeeId: identity.externalEmployeeId,
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
    nonce: generateOpaqueToken(24),
    requestId: identity.requestId,
    username: identity.externalUsername,
  }
  const encoded = encodeJson(payload)
  return `sygsso_v1.${encoded}.${await hmacHex(encoded, config.sessionSecret)}`
}

async function verifyTicket(value: string, config: SharedIdentityConfiguration): Promise<SharedIdentityTicket | null> {
  if (!ticketPattern.test(value)) return null
  const [, encoded, signature] = value.split('.')
  const expected = await hmacHex(encoded, config.sessionSecret)
  if (!constantTimeEqual(signature.toLowerCase(), expected)) return null
  const ticket = decodeJson(encoded) as Partial<SharedIdentityTicket> | null
  if (
    !ticket
    || !uuidPattern.test(ticket.authUserId ?? '')
    || !uuidPattern.test(ticket.employeeId ?? '')
    || !uuidPattern.test(ticket.requestId ?? '')
    || !/^[a-z][a-z0-9]{1,62}$/.test(ticket.username ?? '')
    || !assuranceLevels.has(ticket.assuranceLevel ?? '')
    || !ticket.expiresAt
    || Date.parse(ticket.expiresAt) <= Date.now()
    || Date.parse(ticket.expiresAt) > Date.now() + 185_000
  ) return null
  return ticket as SharedIdentityTicket
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? ''
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}

function accessTokenClaims(token: string): { exp?: number, session_id?: string, sub?: string } {
  const encoded = token.split('.')[1]
  if (!encoded) return {}
  return decodeJson(encoded) as { exp?: number, session_id?: string, sub?: string } ?? {}
}

async function boundedText(request: Request, maximumBytes: number): Promise<string> {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > maximumBytes) throw new SharedIdentityError('shared_identity_request_too_large', 413, 'The shared access request was too large.')
  const text = await request.text()
  if (encoder.encode(text).byteLength > maximumBytes) {
    throw new SharedIdentityError('shared_identity_request_too_large', 413, 'The shared access request was too large.')
  }
  return text
}

function readCookie(request: Request, name: string): string | null {
  const prefix = `${name}=`
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const item = part.trim()
    if (!item.startsWith(prefix)) continue
    try {
      return decodeURIComponent(item.slice(prefix.length))
    } catch {
      return null
    }
  }
  return null
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`
}

function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`
}

function redirectResponse(location: string, cookies: string[], status: 303): Response {
  const headers = new Headers({ 'cache-control': 'no-store', location })
  for (const value of cookies) headers.append('set-cookie', value)
  return new Response(null, { headers, status })
}

function responseJson(payload: unknown, status: number): Response {
  return Response.json(payload, {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    status,
  })
}

function methodNotAllowed(allow: string, requestId: string): Response {
  const response = responseJson({ error: 'method_not_allowed', requestId }, 405)
  response.headers.set('allow', allow)
  return response
}

function normalizedOrigin(value: unknown): string {
  const url = normalizedHttpsUrl(value)
  return url ? new URL(url).origin : ''
}

function normalizedHttpsUrl(value: unknown): string {
  const text = clean(value)
  if (!text) return ''
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:') return ''
    return url.toString()
  } catch {
    return ''
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function generateOpaqueToken(size = 48): string {
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

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)))
}

function decodeJson(value: string): unknown {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const binary = atob(normalized)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return JSON.parse(decoder.decode(bytes))
  } catch {
    return null
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
