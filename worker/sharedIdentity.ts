const launchPath = '/api/v1/auth/shared-identity/launch'
const completionPath = '/api/v1/auth/shared-identity/complete'
const finalizationPath = '/api/v1/auth/shared-identity/finalize'
const sessionPath = '/api/v1/auth/shared-identity/session'
const sessionLogoutPath = '/api/v1/auth/shared-identity/session/logout'
const callbackPath = '/auth/shared-identity/callback'
const destination = '/sygsphere'
const launchCookie = '__Host-sygshift-shared-launch'
const ticketCookie = '__Host-sygshift-shared-ticket'
const bootstrapCookie = '__Host-sygshift-shared-bootstrap'
const sessionCookie = '__Host-sygshift-shared-session'
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

type SharedIdentityBootstrap = {
  accessToken: string
  expiresAt: string
  refreshToken: string
}

type SharedIdentitySessionEnvelope = {
  accessToken: string
  accessTokenExpiresAt: string
  authSessionId: string
  authUserId: string
  employeeId: string
  expiresAt: string
  persistent: boolean
  refreshToken: string
  sessionToken: string
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
  if (![launchPath, completionPath, finalizationPath, sessionPath, sessionLogoutPath].includes(path)) return null

  try {
    const config = configuration(environment)
    if (path === launchPath) return await receiveLaunch(request, config, requestId)
    if (path === completionPath) return await completeLaunch(request, config, requestId)
    if (path === finalizationPath) return await finalizeLaunch(request, config, requestId)
    if (path === sessionPath) return await restoreSharedSession(request, config, requestId)
    return await clearSharedSession(request, config, requestId)
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
  const bootstrap = await verifySessionLink(actionLink, local.existingAuthUserId, config)
  const bootstrapValue = await encryptEnvelope(bootstrap, config.sessionSecret)
  const response = redirectResponse(callbackPath, [
    clearCookie(launchCookie),
    cookie(ticketCookie, ticket, 180),
    protectedCookie(bootstrapCookie, bootstrapValue, 180),
  ], 303)
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

  const bootstrapValue = readCookie(request, bootstrapCookie)
  const bootstrap = bootstrapValue
    ? await decryptEnvelope<SharedIdentityBootstrap>(bootstrapValue, config.sessionSecret)
    : null
  if (!validBootstrap(bootstrap)) {
    throw new SharedIdentityError('shared_identity_bootstrap_invalid', 401, 'The shared sign-in request is missing or expired.')
  }

  const token = bootstrap.accessToken
  const claims = accessTokenClaims(token)
  const authSessionId = claims.session_id ?? ''
  const authUser = await verifyAuthUser(token, config)
  if (
    authUser.id !== ticket.authUserId
    || claims.sub !== ticket.authUserId
    || !uuidPattern.test(authSessionId)
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
    target_auth_session_id: authSessionId,
    target_auth_user_id: ticket.authUserId,
    target_employee_id: ticket.employeeId,
    target_expires_at: expiresAt,
    target_launch_request_id: ticket.requestId,
    target_request_id: requestId,
    target_token_hash: await sha256Hex(sessionToken),
  }, config)

  const sessionEnvelope = await encryptEnvelope({
    accessToken: bootstrap.accessToken,
    accessTokenExpiresAt: bootstrap.expiresAt,
    authSessionId,
    authUserId: ticket.authUserId,
    employeeId: ticket.employeeId,
    expiresAt,
    persistent,
    refreshToken: bootstrap.refreshToken,
    sessionToken,
  } satisfies SharedIdentitySessionEnvelope, config.sessionSecret)
  const response = responseJson({
    destination,
    expiresAt,
    persistent,
    sharedIdentityToken: sessionToken,
    supabaseSession: {
      accessToken: bootstrap.accessToken,
      refreshToken: bootstrap.refreshToken,
    },
  }, 200)
  response.headers.append('set-cookie', clearCookie(ticketCookie))
  response.headers.append('set-cookie', clearCookie(bootstrapCookie))
  response.headers.append('set-cookie', protectedCookie(
    sessionCookie,
    sessionEnvelope,
    persistent ? secondsUntil(expiresAt) : undefined,
  ))
  return response
}

async function restoreSharedSession(request: Request, config: SharedIdentityConfiguration, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST', requestId)
  if (request.headers.get('origin') !== config.appOrigin) {
    throw new SharedIdentityError('shared_identity_origin_denied', 403, 'The shared session request did not come from SygShift.')
  }
  const cookieValue = readCookie(request, sessionCookie)
  if (!cookieValue) return responseEmpty(204)
  const shared = await decryptEnvelope<SharedIdentitySessionEnvelope>(cookieValue, config.sessionSecret)
  if (!validSharedSessionEnvelope(shared)) {
    const response = responseEmpty(204)
    response.headers.append('set-cookie', clearCookie(sessionCookie))
    return response
  }

  let authSession: SharedIdentityBootstrap = {
    accessToken: shared.accessToken,
    expiresAt: shared.accessTokenExpiresAt,
    refreshToken: shared.refreshToken,
  }
  let refreshed = false
  if (Date.parse(authSession.expiresAt) <= Date.now() + 60_000) {
    try {
      authSession = await refreshSupabaseSession(authSession.refreshToken, shared.authUserId, config)
      refreshed = true
    } catch {
      const response = responseEmpty(204)
      response.headers.append('set-cookie', clearCookie(sessionCookie))
      return response
    }
  }
  const token = authSession.accessToken
  const claims = accessTokenClaims(token)
  const authUser = await verifyAuthUser(token, config)
  if (
    authUser.id !== shared.authUserId
    || claims.sub !== shared.authUserId
    || claims.session_id !== shared.authSessionId
    || typeof claims.exp !== 'number'
    || claims.exp * 1000 <= Date.now()
    || !await verifySharedSession(shared.sessionToken, token, config)
  ) {
    const response = responseEmpty(204)
    response.headers.append('set-cookie', clearCookie(sessionCookie))
    return response
  }
  const response = responseJson({
    expiresAt: shared.expiresAt,
    persistent: shared.persistent,
    sharedIdentityToken: shared.sessionToken,
    supabaseSession: {
      accessToken: authSession.accessToken,
      refreshToken: authSession.refreshToken,
    },
  }, 200)
  if (refreshed) {
    response.headers.append('set-cookie', protectedCookie(
      sessionCookie,
      await encryptEnvelope({
        ...shared,
        accessToken: authSession.accessToken,
        accessTokenExpiresAt: authSession.expiresAt,
        refreshToken: authSession.refreshToken,
      } satisfies SharedIdentitySessionEnvelope, config.sessionSecret),
      shared.persistent ? secondsUntil(shared.expiresAt) : undefined,
    ))
  }
  return response
}

async function clearSharedSession(request: Request, config: SharedIdentityConfiguration, requestId: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST', requestId)
  if (request.headers.get('origin') !== config.appOrigin) {
    throw new SharedIdentityError('shared_identity_origin_denied', 403, 'The shared session request did not come from SygShift.')
  }
  const cookieValue = readCookie(request, sessionCookie)
  const shared = cookieValue
    ? await decryptEnvelope<SharedIdentitySessionEnvelope>(cookieValue, config.sessionSecret)
    : null
  if (validSharedSessionEnvelope(shared)) {
    try {
      await callServiceRpc('service_revoke_shared_identity_session', {
        target_request_id: requestId,
        target_token_hash: await sha256Hex(shared.sessionToken),
      }, config)
    } catch {
      // Browser sign-out must still clear the protected cookie if revocation is temporarily unavailable.
    }
  }
  const response = responseEmpty(204)
  response.headers.append('set-cookie', clearCookie(sessionCookie))
  response.headers.append('set-cookie', clearCookie(bootstrapCookie))
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

async function verifySessionLink(
  actionLink: string,
  expectedAuthUserId: string,
  config: SharedIdentityConfiguration,
): Promise<SharedIdentityBootstrap> {
  const link = new URL(actionLink)
  const tokenHash = link.searchParams.get('token_hash') || link.searchParams.get('token') || ''
  const verificationType = link.searchParams.get('type') || 'magiclink'
  if (!tokenHash || tokenHash.length > 4096 || !['email', 'magiclink'].includes(verificationType)) {
    throw new SharedIdentityError('shared_identity_session_unavailable', 502, 'The SygShift session could not be created.')
  }
  const response = await fetch(`${config.supabaseUrl}/auth/v1/verify`, {
    body: JSON.stringify({ token_hash: tokenHash, type: verificationType }),
    headers: { apikey: config.publishableKey, 'content-type': 'application/json' },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  const payload = await response.json().catch(() => null) as {
    access_token?: unknown
    expires_at?: unknown
    expires_in?: unknown
    refresh_token?: unknown
    user?: { id?: unknown }
  } | null
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : ''
  const refreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token : ''
  const claims = accessTokenClaims(accessToken)
  const expiresAtMs = typeof payload?.expires_at === 'number'
    ? payload.expires_at * 1000
    : Date.now() + Number(payload?.expires_in ?? 0) * 1000
  if (
    !response.ok
    || payload?.user?.id !== expectedAuthUserId
    || claims.sub !== expectedAuthUserId
    || !uuidPattern.test(claims.session_id ?? '')
    || accessToken.length < 20
    || accessToken.length > 10_000
    || refreshToken.length < 8
    || refreshToken.length > 4096
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= Date.now()
  ) {
    throw new SharedIdentityError('shared_identity_session_unavailable', 502, 'The SygShift session could not be created.')
  }
  return { accessToken, expiresAt: new Date(expiresAtMs).toISOString(), refreshToken }
}

async function refreshSupabaseSession(
  refreshToken: string,
  expectedAuthUserId: string,
  config: SharedIdentityConfiguration,
): Promise<SharedIdentityBootstrap> {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    body: JSON.stringify({ refresh_token: refreshToken }),
    headers: { apikey: config.publishableKey, 'content-type': 'application/json' },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  const payload = await response.json().catch(() => null) as {
    access_token?: unknown
    expires_at?: unknown
    expires_in?: unknown
    refresh_token?: unknown
    user?: { id?: unknown }
  } | null
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : ''
  const nextRefreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token : ''
  const claims = accessTokenClaims(accessToken)
  const expiresAtMs = typeof payload?.expires_at === 'number'
    ? payload.expires_at * 1000
    : Date.now() + Number(payload?.expires_in ?? 0) * 1000
  if (
    !response.ok
    || payload?.user?.id !== expectedAuthUserId
    || claims.sub !== expectedAuthUserId
    || !uuidPattern.test(claims.session_id ?? '')
    || accessToken.length < 20
    || accessToken.length > 10_000
    || nextRefreshToken.length < 8
    || nextRefreshToken.length > 4096
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= Date.now()
  ) {
    throw new SharedIdentityError('shared_identity_session_expired', 401, 'The shared SygSphere session expired.')
  }
  return { accessToken, expiresAt: new Date(expiresAtMs).toISOString(), refreshToken: nextRefreshToken }
}

async function verifySharedSession(sessionToken: string, accessToken: string, config: SharedIdentityConfiguration): Promise<boolean> {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/has_shared_identity_session`, {
    body: '{}',
    headers: {
      apikey: config.publishableKey,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'x-sygshift-shared-identity': sessionToken,
    },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  const payload = await response.json().catch(() => false)
  return response.ok && payload === true
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

function accessTokenClaims(token: string): { exp?: number, session_id?: string, sub?: string } {
  const encoded = token.split('.')[1]
  if (!encoded) return {}
  return decodeJson(encoded) as { exp?: number, session_id?: string, sub?: string } ?? {}
}

function validBootstrap(value: SharedIdentityBootstrap | null): value is SharedIdentityBootstrap {
  if (!value) return false
  const expiresAt = Date.parse(value.expiresAt)
  return value.accessToken.length >= 20
    && value.accessToken.length <= 10_000
    && value.refreshToken.length >= 8
    && value.refreshToken.length <= 4096
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now()
}

function validSharedSessionEnvelope(value: SharedIdentitySessionEnvelope | null): value is SharedIdentitySessionEnvelope {
  if (!value) return false
  if (
    typeof value.accessToken !== 'string'
    || typeof value.accessTokenExpiresAt !== 'string'
    || typeof value.refreshToken !== 'string'
  ) return false
  const expiresAt = Date.parse(value.expiresAt)
  const accessTokenExpiresAt = Date.parse(value.accessTokenExpiresAt)
  return value.accessToken.length >= 20
    && value.accessToken.length <= 10_000
    && value.refreshToken.length >= 8
    && value.refreshToken.length <= 4096
    && Number.isFinite(accessTokenExpiresAt)
    && uuidPattern.test(value.authSessionId)
    && uuidPattern.test(value.authUserId)
    && uuidPattern.test(value.employeeId)
    && /^[A-Za-z0-9_-]{40,180}$/.test(value.sessionToken)
    && typeof value.persistent === 'boolean'
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now()
    && expiresAt <= Date.now() + 14 * 24 * 60 * 60 * 1000 + 300_000
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

function protectedCookie(name: string, value: string, maxAge?: number): string {
  const lifetime = typeof maxAge === 'number' ? `; Max-Age=${Math.max(0, maxAge)}` : ''
  return `${name}=${encodeURIComponent(value)}${lifetime}; Path=/; Secure; HttpOnly; SameSite=Strict`
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

function responseEmpty(status: number): Response {
  return new Response(null, { headers: { 'cache-control': 'no-store' }, status })
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

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['decrypt', 'encrypt'])
}

async function encryptEnvelope<T>(value: T, secret: string): Promise<string> {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const plaintext = encoder.encode(JSON.stringify(value))
  const encrypted = await crypto.subtle.encrypt({ iv, name: 'AES-GCM' }, await encryptionKey(secret), plaintext)
  const bytes = new Uint8Array(iv.byteLength + encrypted.byteLength)
  bytes.set(iv)
  bytes.set(new Uint8Array(encrypted), iv.byteLength)
  const encoded = `sygenc_v1.${encodeBase64Url(bytes)}`
  if (encoded.length > 3800) {
    throw new SharedIdentityError('shared_identity_session_unavailable', 502, 'The shared session could not be protected.')
  }
  return encoded
}

async function decryptEnvelope<T>(value: string, secret: string): Promise<T | null> {
  if (!value.startsWith('sygenc_v1.') || value.length > 3800) return null
  const bytes = decodeBase64Url(value.slice('sygenc_v1.'.length))
  if (!bytes || bytes.byteLength <= 28) return null
  try {
    const plaintext = await crypto.subtle.decrypt(
      { iv: bytes.slice(0, 12), name: 'AES-GCM' },
      await encryptionKey(secret),
      bytes.slice(12),
    )
    return JSON.parse(decoder.decode(plaintext)) as T
  } catch {
    return null
  }
}

function secondsUntil(expiresAt: string): number {
  return Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
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

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const binary = atob(normalized)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
