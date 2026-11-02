import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from './supabase'
import { getSharedIdentitySessionScope } from './sharedIdentitySession'

export type IdentityVerificationMethod = 'authenticator' | 'security_key'
export type IdentityVerificationContext = 'general' | 'hr' | 'licensing'

export type IdentityVerificationActor = {
  client: SupabaseClient
  clientKind: string
  epoch: number
  scope: string
}
type PendingVerification = {
  actor: IdentityVerificationActor
  context: IdentityVerificationContext
  id: string
  promise: Promise<IdentityVerificationMethod>
  reject: (error: Error) => void
  resolve: (method: IdentityVerificationMethod) => void
}
type VerificationListener = (required: boolean, context: IdentityVerificationContext, requestId: string | null) => void
type VerificationResolution = {
  actor: string
  canceled: boolean
  completedAt: number
  method: IdentityVerificationMethod | null
  requestId: string
}
type ObservedClient = {
  client: SupabaseClient
  kind: string
  revision: number
  unsubscribe: () => void
  capture: Promise<IdentityVerificationActor | null> | null
}

class IdentityVerificationContextChangedError extends Error {
  constructor() { super('The signed-in session or page changed. Please retry from the current page.') }
}

let pendingVerification: PendingVerification | null = null
let lastResolution: VerificationResolution | null = null
let observedClient: ObservedClient | null = null
let currentScope: string | null = null
let currentSurface: string | null = null
let currentAccessGeneration: string | null = null
let blockedSignOutScope: string | null = null
let epoch = 0
let verificationLifetime = new AbortController()
let verificationChannel: BroadcastChannel | null = null
let verificationChannelScope: string | null = null
const listeners = new Set<VerificationListener>()
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const verificationPrefix = 'sygshift:identity-verification:v2'

function activeClient() {
  try { return { client: getSupabaseClient(), kind: getSharedIdentitySessionScope() ?? 'native' } }
  catch { return null }
}

// These claims only fence stale browser work. The server remains authoritative
// for permissions, current assurance, and every attempted protected operation.
function sessionScope(session: Session | null, kind: string): string | null {
  if (!session?.user?.id || !uuidPattern.test(session.user.id)) return null
  try {
    const payload = session.access_token.split('.')[1]
    if (!payload) return null
    const normalized = payload.replaceAll('-', '+').replaceAll('_', '/')
    const claims = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as { session_id?: unknown; sub?: unknown }
    if (claims.sub !== session.user.id || typeof claims.session_id !== 'string' || !uuidPattern.test(claims.session_id)) return null
    return `${kind}:${session.user.id}:${claims.session_id}`
  } catch { return null }
}

function notifyListeners(): void {
  listeners.forEach((listener) => listener(pendingVerification !== null, pendingVerification?.context ?? 'general', pendingVerification?.id ?? null))
}

function invalidateVerification(): void {
  epoch += 1
  if (observedClient) observedClient.capture = null
  verificationLifetime.abort()
  verificationLifetime = new AbortController()
  const pending = pendingVerification
  pendingVerification = null
  lastResolution = null
  verificationChannel?.close()
  verificationChannel = null
  verificationChannelScope = null
  pending?.reject(new Error('Identity verification was canceled because the signed-in session or page changed.'))
  notifyListeners()
}

function updateSessionScope(scope: string | null): void {
  if (scope === blockedSignOutScope) scope = null
  else if (scope) blockedSignOutScope = null
  if (scope === currentScope) return
  invalidateVerification()
  currentScope = scope
}

function observeActiveClient(): ObservedClient | null {
  const active = activeClient()
  if (!active) {
    if (observedClient) {
      observedClient.unsubscribe()
      observedClient = null
      updateSessionScope(null)
    }
    return null
  }
  if (observedClient?.client === active.client && observedClient.kind === active.kind) return observedClient
  observedClient?.unsubscribe()
  invalidateVerification()
  currentScope = null
  const observed: ObservedClient = { ...active, revision: 0, unsubscribe: () => undefined, capture: null }
  observedClient = observed
  try {
    const { data } = active.client.auth.onAuthStateChange((event, session) => {
      const selected = activeClient()
      if (observedClient !== observed || selected?.client !== observed.client || selected.kind !== observed.kind) return
      if (event === 'INITIAL_SESSION' && observed.revision > 0) return
      const initialBootstrap = event === 'INITIAL_SESSION' && observed.revision === 0 && currentScope === null
      observed.revision += 1
      // Supabase may hold its auth lock here. Never await an auth method inside
      // this callback. Same-session refreshes and MFA upgrades preserve scope.
      if (event === 'SIGNED_OUT' && currentScope) blockedSignOutScope = currentScope
      const scope = event === 'SIGNED_OUT' ? null : sessionScope(session, observed.kind)
      if (initialBootstrap && scope !== blockedSignOutScope) currentScope = scope
      else updateSessionScope(scope)
    })
    observed.unsubscribe = () => data.subscription.unsubscribe()
  } catch { /* Unavailable identity support never enables an automatic retry. */ }
  return observed
}

export async function captureIdentityVerificationActor(): Promise<IdentityVerificationActor | null> {
  const observed = observeActiveClient()
  if (!observed) return null
  if (observed.capture) return observed.capture
  const revision = observed.revision
  const capturedEpoch = epoch
  const capture = (async () => { try {
    const { data, error } = await observed.client.auth.getSession()
    const active = activeClient()
    if (observedClient !== observed || active?.client !== observed.client || active.kind !== observed.kind || capturedEpoch !== epoch) {
      throw new IdentityVerificationContextChangedError()
    }
    const scope = error ? null : sessionScope(data.session, observed.kind)
    // A delayed bootstrap cannot resurrect an identity after a newer event.
    if (revision !== observed.revision && scope !== currentScope) throw new IdentityVerificationContextChangedError()
    updateSessionScope(scope)
    return currentScope ? { client: observed.client, clientKind: observed.kind, epoch, scope: currentScope } : null
  } catch (error) {
    if (error instanceof IdentityVerificationContextChangedError) throw error
    return null
  } })()
  observed.capture = capture
  try { return await capture }
  finally { if (observed.capture === capture) observed.capture = null }
}

function actorIsCurrent(actor: IdentityVerificationActor): boolean {
  const active = activeClient()
  return Boolean(active && actor.epoch === epoch && actor.scope === currentScope
    && actor.client === active.client && actor.clientKind === active.kind)
}

export function identityVerificationActorIsCurrentNow(actor: IdentityVerificationActor): boolean {
  return actorIsCurrent(actor)
}

export function pendingIdentityVerificationActor(requestId: string): IdentityVerificationActor | undefined {
  return pendingVerification?.id === requestId && actorIsCurrent(pendingVerification.actor) ? pendingVerification.actor : undefined
}

export async function identityVerificationActorIsCurrent(actor: IdentityVerificationActor | null): Promise<boolean> {
  if (!actor || !actorIsCurrent(actor)) return false
  try {
    const current = await captureIdentityVerificationActor()
    return Boolean(current && actorIsCurrent(actor) && current.epoch === actor.epoch && current.scope === actor.scope)
  } catch { return false }
}

export function clearIdentityVerificationSession(): void {
  blockedSignOutScope = currentScope
  invalidateVerification()
  currentScope = null
}

export function setIdentityVerificationSurface(pathname: string, search: string): void {
  const next = `${pathname}${search}`
  if (next === currentSurface) return
  currentSurface = next
  invalidateVerification()
}

export function setIdentityVerificationAccessGeneration(employeeId: string, generation: number): void {
  const next = `${employeeId}:${generation}`
  if (next === currentAccessGeneration) return
  currentAccessGeneration = next
  invalidateVerification()
}

export function monitorIdentityVerificationSession(): () => void {
  void captureIdentityVerificationActor().catch(() => undefined)
  return () => {
    invalidateVerification()
    observedClient?.unsubscribe()
    observedClient = null
    currentScope = null
  }
}

function getVerificationChannel(actor: IdentityVerificationActor): BroadcastChannel | null {
  if (!actorIsCurrent(actor)) return null
  if (verificationChannelScope === actor.scope) return verificationChannel
  verificationChannel?.close()
  verificationChannelScope = actor.scope
  verificationChannel = typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new BroadcastChannel(`${verificationPrefix}:${actor.scope}`) : null
  verificationChannel?.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!actorIsCurrent(actor) || !isVerificationResolution(event.data, actor.scope)) return
    if (!lastResolution || event.data.completedAt >= lastResolution.completedAt) lastResolution = event.data
  })
  return verificationChannel
}

function isVerificationResolution(value: unknown, scope: string): value is VerificationResolution {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<VerificationResolution>
  return result.actor === scope && typeof result.canceled === 'boolean'
    && typeof result.completedAt === 'number' && Number.isFinite(result.completedAt)
    && result.completedAt <= Date.now() && result.completedAt >= Date.now() - 60_000
    && typeof result.requestId === 'string' && uuidPattern.test(result.requestId)
    && (result.canceled ? result.method === null : result.method === 'authenticator' || result.method === 'security_key')
}

function publishResolution(pending: PendingVerification, canceled: boolean, method: IdentityVerificationMethod | null): void {
  if (!actorIsCurrent(pending.actor)) return
  const resolution = { actor: pending.actor.scope, canceled, completedAt: Date.now(), method, requestId: pending.id }
  lastResolution = resolution
  getVerificationChannel(pending.actor)?.postMessage(resolution)
}

export function subscribeToIdentityVerification(listener: VerificationListener): () => void {
  listeners.add(listener)
  listener(pendingVerification !== null, pendingVerification?.context ?? 'general', pendingVerification?.id ?? null)
  return () => listeners.delete(listener)
}

function requestLocalIdentityVerification(context: IdentityVerificationContext, actor: IdentityVerificationActor): Promise<IdentityVerificationMethod> {
  if (!actorIsCurrent(actor)) return Promise.reject(new Error('The signed-in session changed.'))
  if (pendingVerification) {
    if (pendingVerification.actor.scope !== actor.scope || pendingVerification.actor.epoch !== actor.epoch) return Promise.reject(new Error('The signed-in session changed.'))
    if (pendingVerification.context === 'general' && context !== 'general') {
      pendingVerification.context = context
      notifyListeners()
    }
    return pendingVerification.promise
  }
  let resolvePromise!: (method: IdentityVerificationMethod) => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<IdentityVerificationMethod>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
  pendingVerification = { actor, context, id: crypto.randomUUID(), promise, reject: rejectPromise, resolve: resolvePromise }
  notifyListeners()
  return promise
}

export async function requestIdentityVerification(
  context: IdentityVerificationContext = 'general', expectedActor?: IdentityVerificationActor | null,
): Promise<IdentityVerificationMethod> {
  const actor = expectedActor === undefined ? await captureIdentityVerificationActor() : expectedActor
  if (!await identityVerificationActorIsCurrent(actor) || !actor) throw new Error('The signed-in session could not be verified.')
  if (pendingVerification) return requestLocalIdentityVerification(context, actor)
  if (!actorIsCurrent(actor)) throw new Error('The signed-in session changed.')
  const requestedAt = Date.now()
  getVerificationChannel(actor)
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) return requestLocalIdentityVerification(context, actor)
  const signal = verificationLifetime.signal
  return locks.request(`${verificationPrefix}:${actor.scope}`, { mode: 'exclusive', signal }, async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    if (!await identityVerificationActorIsCurrent(actor)) throw new Error('The signed-in session changed.')
    if (lastResolution?.actor === actor.scope && lastResolution.completedAt >= requestedAt && isVerificationResolution(lastResolution, actor.scope)) {
      if (lastResolution.canceled || !lastResolution.method) throw new Error('Identity verification was canceled.')
      return lastResolution.method
    }
    return requestLocalIdentityVerification(context, actor)
  })
}

export async function completeIdentityVerification(method: IdentityVerificationMethod, requestId: string): Promise<void> {
  const pending = pendingVerification
  if (!pending || pending.id !== requestId || !await identityVerificationActorIsCurrent(pending.actor) || pendingVerification !== pending) return
  pendingVerification = null
  publishResolution(pending, false, method)
  pending.resolve(method)
  notifyListeners()
}

export function cancelIdentityVerification(requestId?: string): void {
  const pending = pendingVerification
  if (!pending || (requestId !== undefined && pending.id !== requestId)) return
  pendingVerification = null
  publishResolution(pending, true, null)
  pending.reject(new Error('Identity verification was canceled.'))
  notifyListeners()
}

export function identityVerificationContextForCode(value: unknown): IdentityVerificationContext {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (code === 'recent_hr_mfa_required' || code.startsWith('hr_')) return 'hr'
  if (code.startsWith('licensing_')) return 'licensing'
  return 'general'
}

export function isIdentityVerificationRequiredCode(value: unknown): boolean {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return code === 'recent_document_mfa_required' || code.endsWith('_mfa_required')
}

export async function responseRequiresIdentityVerification(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  const payload = await response.clone().json().catch(() => null) as { error?: unknown } | null
  return isIdentityVerificationRequiredCode(payload?.error)
}

export async function fetchWithIdentityVerification(makeRequest: () => Promise<Response>): Promise<Response> {
  const actor = await captureIdentityVerificationActor()
  const response = await makeRequest()
  if (!await identityVerificationActorIsCurrent(actor) || response.status !== 403) return response
  const payload = await response.clone().json().catch(() => null) as { error?: unknown } | null
  if (!isIdentityVerificationRequiredCode(payload?.error) || !await identityVerificationActorIsCurrent(actor)) return response
  try {
    await requestIdentityVerification(identityVerificationContextForCode(payload?.error), actor)
    if (!await identityVerificationActorIsCurrent(actor)) return response
  } catch { return response }
  const retry = await makeRequest()
  return await identityVerificationActorIsCurrent(actor) ? retry : response
}

type SupabaseOperationResult = { error: { code?: string | null; message?: string | null } | null }

function supabaseResultRequiresIdentityVerification(result: SupabaseOperationResult): boolean {
  if (result.error?.code !== '42501') return false
  const message = result.error.message?.trim().toLowerCase() ?? ''
  // Legacy SQL messages combine permission and MFA requirements. Preserve that
  // established verification path; the server still denies unauthorized retries.
  return /\b(mfa|identity verification|recent verification)\b/.test(message)
}

export async function supabaseWithIdentityVerification<T extends SupabaseOperationResult>(
  makeRequest: () => PromiseLike<T>, context: IdentityVerificationContext = 'general',
): Promise<T> {
  const actor = await captureIdentityVerificationActor()
  const result = await makeRequest()
  if (!supabaseResultRequiresIdentityVerification(result) || !await identityVerificationActorIsCurrent(actor)) return result
  try {
    await requestIdentityVerification(context, actor)
    if (!await identityVerificationActorIsCurrent(actor)) return result
  } catch { return result }
  const retry = await makeRequest()
  return await identityVerificationActorIsCurrent(actor) ? retry : result
}
