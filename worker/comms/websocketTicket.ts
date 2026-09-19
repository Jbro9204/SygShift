import { z } from 'zod'
import { SYGSPHERE_COMMS_PROTOCOL_VERSION } from '../../shared/sygsphere-communications/v1/contract'

/**
 * Browser WebSockets cannot safely carry an application Authorization header.
 * A bootstrap response therefore issues a short-lived, one-use bearer ticket.
 * The ticket is sent only as the first TLS-protected WebSocket application
 * message; it is never allowed in a query string, path, attachment, log, or
 * coordinator response after initial consumption.
 */
export const SYGSPHERE_COMMS_WEBSOCKET_TICKET_TTL_MS = 30_000

const ticketPattern = /^[A-Za-z0-9_-]{43,128}$/

const firstSocketFrameSchema = z.object({
  kind: z.literal('auth'),
  protocolVersion: z.literal(SYGSPHERE_COMMS_PROTOCOL_VERSION),
  ticket: z.string().regex(ticketPattern),
}).strict()

export type SygSphereCommsFirstSocketFrame = z.infer<typeof firstSocketFrameSchema>

export type SygSphereCommsWebSocketTicket = Readonly<{
  expiresAt: number
  routeReference: string
  ticket: string
  ticketDigest: string
}>

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export const digestSygSphereCommsTicket = async (ticket: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const createSygSphereCommsWebSocketTicket = async (
  now = Date.now(),
): Promise<SygSphereCommsWebSocketTicket> => {
  const entropy = new Uint8Array(32)
  crypto.getRandomValues(entropy)
  const ticket = encodeBase64Url(entropy)
  return {
    expiresAt: now + SYGSPHERE_COMMS_WEBSOCKET_TICKET_TTL_MS,
    routeReference: crypto.randomUUID(),
    ticket,
    ticketDigest: await digestSygSphereCommsTicket(ticket),
  }
}

/**
 * The opening message is deliberately tiny and credential-only. All tenant,
 * actor, permission, scope, room, provider, and feature-gate authority stays
 * in the server-side ticket record.
 */
export const parseSygSphereCommsFirstSocketFrame = (input: unknown): SygSphereCommsFirstSocketFrame =>
  firstSocketFrameSchema.parse(input)

export const parseSygSphereCommsWebSocketRouteReference = (value: string | null): string | null => {
  if (!value || !z.uuid().safeParse(value).success) return null
  return value
}

export const hasValidSygSphereCommsWebSocketTicket = (ticket: string): boolean => ticketPattern.test(ticket)
