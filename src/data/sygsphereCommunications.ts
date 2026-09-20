import { z } from 'zod'
import { parseSygSphereCommsCommand, parseSygSphereCommsEvent, type ValidatedSygSphereCommsCommand, type ValidatedSygSphereCommsEvent } from '../../shared/sygsphere-communications/v1/contract'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'
import { getSupabaseClient } from '../lib/supabase'

const communicationsBootstrapSchema = z.object({
  connection: z.object({
    expiresAt: z.iso.datetime(),
    protocolVersion: z.literal(1),
    socketPath: z.literal('/api/comms/v1/connect'),
    ticket: z.string().min(32).max(512),
  }).strict(),
  requestId: z.uuid(),
}).strict()

const communicationsCommandResponseSchema = z.object({
  outcome: z.enum(['accepted', 'invalid_state', 'recipient_unavailable', 'rate_limited', 'runtime_disabled', 'provider_unavailable']),
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

export type SygSphereCommunicationsBootstrap = z.infer<typeof communicationsBootstrapSchema>
export type SygSphereCommunicationsCommandOutcome = z.infer<typeof communicationsCommandResponseSchema>['outcome']
export type SygSphereDirectAudioIceServer = RTCIceServer

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

/** Opens an authenticated server-owned delivery channel. The ticket is
 * short-lived and supplied only in the first WebSocket frame, never a URL. */
export async function bootstrapSygSphereCommunications(): Promise<SygSphereCommunicationsBootstrap> {
  const response = await communicationsRequest('/api/comms/v1/bootstrap', { method: 'POST' })
  return communicationsBootstrapSchema.parse(await communicationsJson(response))
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
  const socket = new WebSocket(endpoint)
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
