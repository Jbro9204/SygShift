import { z } from 'zod'
import { parseSygSphereCommsCommand, parseSygSphereCommsEvent, type ValidatedSygSphereCommsCommand, type ValidatedSygSphereCommsEvent } from '../../shared/sygsphere-communications/v1/contract'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'
import { getSupabaseClient } from '../lib/supabase'

const communicationsRouteHeaderName = 'x-sygsphere-comms-route-reference'
const communicationsRouteHandleSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
)
// Module state is per JavaScript tab. This deliberately never enters a URL,
// cookie, local storage, or a cross-app browser cache.
let activeCommunicationsRouteHandle: string | null = null

const communicationsBootstrapSchema = z.object({
  connection: z.object({
    expiresAt: z.iso.datetime(),
    protocolVersion: z.literal(1),
    routeHandle: communicationsRouteHandleSchema,
    socketPath: z.literal('/api/comms/v1/connect'),
    ticket: z.string().min(32).max(512),
  }).strict(),
  requestId: z.uuid(),
}).strict()

const communicationsCommandResponseSchema = z.object({
  outcome: z.enum(['accepted', 'invalid_state', 'recipient_unavailable', 'channel_busy', 'rate_limited', 'runtime_disabled', 'provider_unavailable']),
  requestId: z.uuid(),
}).strict()

const directCallContextResponseSchema = z.object({
  conversationReference: z.uuid(),
  requestId: z.uuid(),
}).strict()

const directAudioPreparationResponseSchema = z.object({
  iceServers: z.array(z.object({
    credential: z.string().min(1).max(512).optional(),
    urls: z.union([z.string().min(1).max(256), z.array(z.string().min(1).max(256)).min(1).max(8)]),
    username: z.string().min(1).max(256).optional(),
  }).strict()).min(1).max(4),
  requestId: z.uuid(),
}).strict()

const providerSmokeProbeResponseSchema = z.object({
  checks: z.object({
    emptySfuSession: z.boolean(),
    turnCredentials: z.boolean(),
  }).strict(),
  outcome: z.enum(['failed', 'passed', 'rate_limited', 'runtime_unavailable']),
}).strict()

export type SygSphereCommunicationsBootstrap = z.infer<typeof communicationsBootstrapSchema>
export type SygSphereCommunicationsCommandOutcome = z.infer<typeof communicationsCommandResponseSchema>['outcome']
export type SygSphereDirectAudioIceServer = RTCIceServer
export type SygSphereProviderSmokeProbeResult = z.infer<typeof providerSmokeProbeResponseSchema>

export function setSygSphereCommunicationsRouteHandle(routeHandle: string | null): void {
  activeCommunicationsRouteHandle = routeHandle === null ? null : communicationsRouteHandleSchema.parse(routeHandle)
}

function appendCommunicationsRouteHeader(path: string, headers: Headers): void {
  // Bootstrap establishes a fresh route. Every later mutation/refresh is
  // explicitly routed to that tab's server-side connection.
  if (path !== '/api/comms/v1/bootstrap' && activeCommunicationsRouteHandle) {
    headers.set(communicationsRouteHeaderName, activeCommunicationsRouteHandle)
  }
}

function employeeSafeCommunicationsMessage(status: number): string {
  if (status === 401 || status === 403) return 'Communications is not available for this account.'
  if (status === 429) return 'Please wait a moment before trying Communications again.'
  return 'Communications is temporarily unavailable. SygSphere messages and Dispatch remain available.'
}

async function communicationsRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Your secure SygSphere session is unavailable. Sign in again.')
  const headers = appendProtectedSessionHeaders(init.headers, { includeSharedIdentity: true })
  headers.set('accept', 'application/json')
  headers.set('authorization', `Bearer ${data.session.access_token}`)
  appendCommunicationsRouteHeader(path, headers)
  return fetch(path, {
    ...init,
    cache: 'no-store',
    credentials: 'same-origin',
    headers,
  })
}

async function communicationsJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(employeeSafeCommunicationsMessage(response.status))
  try {
    return await response.json()
  } catch {
    throw new Error('Communications returned an incomplete response. Please try again.')
  }
}

/** Shared browser-runtime request path. Access tokens stay in memory and every
 * response passes through the same employee-safe error boundary as the rest
 * of the SygShift communications client. */
export async function sygSphereCommunicationsApiRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = appendProtectedSessionHeaders(init.headers, { includeSharedIdentity: true })
  headers.set('accept', 'application/json')
  headers.set('authorization', `Bearer ${accessToken}`)
  appendCommunicationsRouteHeader(path, headers)
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    credentials: 'same-origin',
    headers,
  })
  return await communicationsJson(response) as T
}

/** Opens an authenticated server-owned delivery channel. The ticket is
 * short-lived and supplied only in the first WebSocket frame, never a URL. */
export async function bootstrapSygSphereCommunications(): Promise<SygSphereCommunicationsBootstrap> {
  const response = await communicationsRequest('/api/comms/v1/bootstrap', { method: 'POST' })
  const bootstrap = communicationsBootstrapSchema.parse(await communicationsJson(response))
  setSygSphereCommunicationsRouteHandle(bootstrap.connection.routeHandle)
  return bootstrap
}

/** Every command crosses the Worker authorization boundary. The WebSocket is
 * deliberately not a second mutation transport. */
export async function sendSygSphereCommunicationsCommand(input: unknown): Promise<SygSphereCommunicationsCommandOutcome> {
  const command = parseSygSphereCommsCommand(input)
  if (command.kind === 'auth' || command.kind === 'heartbeat' || command.kind === 'resume' || command.kind === 'snapshot.request') {
    throw new Error('That Communications action is not available here.')
  }
  const response = await communicationsRequest('/api/comms/v1/commands', {
    body: JSON.stringify({ command }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return communicationsCommandResponseSchema.parse(await communicationsJson(response)).outcome
}

export async function refreshSygSphereCommunicationsAuthorization(): Promise<void> {
  const response = await communicationsRequest('/api/comms/v1/authorization/refresh', { method: 'POST' })
  await communicationsJson(response)
}

/* A temporary, hidden-by-default infrastructure control. The server still
 * requires MFA plus admin.security.manage; this browser helper merely keeps
 * the authenticated session token in memory instead of copying it anywhere. */
export async function runSygSphereProviderSmokeProbe(): Promise<SygSphereProviderSmokeProbeResult> {
  const response = await communicationsRequest('/api/comms/v1/internal/provider-smoke', { method: 'POST' })
  const payload = await response.json().catch(() => null)
  const parsed = providerSmokeProbeResponseSchema.safeParse(payload)
  if (!parsed.success) throw new Error('The protected voice-provider check could not be completed.')
  return parsed.data
}

export async function getSygSphereDirectCallContext(callId: string): Promise<{ conversationReference: string }> {
  const response = await communicationsRequest(`/api/comms/v1/calls/${encodeURIComponent(callId)}`)
  return directCallContextResponseSchema.parse(await communicationsJson(response))
}

export async function prepareSygSphereDirectAudio(callId: string, conversationReference: string): Promise<readonly SygSphereDirectAudioIceServer[]> {
  const response = await communicationsRequest('/api/comms/v1/media/prepare', {
    body: JSON.stringify({ callId, conversationReference }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return directAudioPreparationResponseSchema.parse(await communicationsJson(response)).iceServers
}

export async function startSygSphereDirectAudio(callId: string, conversationReference: string, offer: string): Promise<SygSphereCommunicationsCommandOutcome> {
  const response = await communicationsRequest('/api/comms/v1/media/direct-audio', {
    body: JSON.stringify({ callId, conversationReference, offer }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  return communicationsCommandResponseSchema.parse(await communicationsJson(response)).outcome
}

export function openSygSphereCommunicationsSocket(
  bootstrap: SygSphereCommunicationsBootstrap,
  handlers: Readonly<{
    onAuthenticated?: () => void
    onEvent: (event: ValidatedSygSphereCommsEvent) => void
    onOpen?: () => void
    onUnavailable: () => void
  }>,
): WebSocket {
  const endpoint = new URL(bootstrap.connection.socketPath, window.location.origin)
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(endpoint, [`sygsphere-comms-route.${bootstrap.connection.routeHandle}`])
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ kind: 'auth', protocolVersion: 1, ticket: bootstrap.connection.ticket }))
    handlers.onOpen?.()
  })
  socket.addEventListener('message', (message) => {
    try {
      const raw = typeof message.data === 'string' ? JSON.parse(message.data) as unknown : null
      if (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'authenticated') {
        handlers.onAuthenticated?.()
      } else if (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind !== 'command.outcome' && (raw as { kind?: unknown }).kind !== 'heartbeat.ack') {
        handlers.onEvent(parseSygSphereCommsEvent(raw))
      }
    } catch {
      /* Discard malformed or stale delivery frames without exposing internals. */
    }
  })
  socket.addEventListener('error', handlers.onUnavailable)
  socket.addEventListener('close', (event) => {
    if (event.code !== 1000) handlers.onUnavailable()
  })
  return socket
}

export const directCallRequestCommand = (conversationReference: string, connectionEpoch: number): ValidatedSygSphereCommsCommand => parseSygSphereCommsCommand({
  commandId: crypto.randomUUID(),
  connectionEpoch,
  kind: 'call.request',
  payload: { clientIntentId: crypto.randomUUID(), conversationReference },
  protocolVersion: 1,
})

export const directCallInvitationCommand = (
  kind: 'call.accept' | 'call.decline',
  invitationId: string,
  connectionEpoch: number,
): ValidatedSygSphereCommsCommand => parseSygSphereCommsCommand({
  commandId: crypto.randomUUID(),
  connectionEpoch,
  kind,
  payload: { invitationId },
  protocolVersion: 1,
})

export const directCallEndCommand = (
  kind: 'call.cancel' | 'call.end',
  callId: string,
  connectionEpoch: number,
): ValidatedSygSphereCommsCommand => parseSygSphereCommsCommand({
  commandId: crypto.randomUUID(),
  connectionEpoch,
  kind,
  payload: { callId },
  protocolVersion: 1,
})

export const directMediaAnswerCommand = (
  input: Readonly<{ answer: string, generation: number, negotiationId: string, peerHandle: string }>,
  connectionEpoch: number,
): ValidatedSygSphereCommsCommand => parseSygSphereCommsCommand({
  commandId: crypto.randomUUID(),
  connectionEpoch,
  kind: 'media.answer',
  payload: input,
  protocolVersion: 1,
})
