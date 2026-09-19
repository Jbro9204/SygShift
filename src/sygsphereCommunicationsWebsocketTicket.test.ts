import { describe, expect, it } from 'vitest'
import {
  SYGSPHERE_COMMS_WEBSOCKET_TICKET_TTL_MS,
  createSygSphereCommsWebSocketTicket,
  digestSygSphereCommsTicket,
  hasValidSygSphereCommsWebSocketTicket,
  parseSygSphereCommsFirstSocketFrame,
  parseSygSphereCommsWebSocketRouteReference,
} from '../worker/comms/websocketTicket'

describe('SygSphere communications WebSocket tickets', () => {
  it('creates opaque, hashed, short-lived ticket material', async () => {
    const now = 1_700_000_000_000
    const issued = await createSygSphereCommsWebSocketTicket(now)

    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(issued.ticketDigest).toHaveLength(64)
    expect(issued.ticketDigest).toBe(await digestSygSphereCommsTicket(issued.ticket))
    expect(issued.ticketDigest).not.toContain(issued.ticket)
    expect(issued.expiresAt).toBe(now + SYGSPHERE_COMMS_WEBSOCKET_TICKET_TTL_MS)
    expect(parseSygSphereCommsWebSocketRouteReference(issued.routeReference)).toBe(issued.routeReference)
  })

  it('accepts only a strict first authentication frame with no client authority', () => {
    expect(parseSygSphereCommsFirstSocketFrame({
      kind: 'auth',
      protocolVersion: 1,
      ticket: 'a'.repeat(43),
    })).toEqual({ kind: 'auth', protocolVersion: 1, ticket: 'a'.repeat(43) })

    expect(() => parseSygSphereCommsFirstSocketFrame({
      kind: 'auth',
      protocolVersion: 1,
      ticket: 'a'.repeat(43),
      tenantId: '00000000-0000-4000-8000-000000000000',
    })).toThrow()
    expect(() => parseSygSphereCommsFirstSocketFrame({ kind: 'auth', protocolVersion: 1, ticket: 'short' })).toThrow()
    expect(() => parseSygSphereCommsFirstSocketFrame({ kind: 'auth', protocolVersion: 2, ticket: 'a'.repeat(43) })).toThrow()
  })

  it('rejects malformed route references and ticket-shaped URL fragments', () => {
    expect(parseSygSphereCommsWebSocketRouteReference('not-a-route')).toBeNull()
    expect(parseSygSphereCommsWebSocketRouteReference(null)).toBeNull()
    expect(hasValidSygSphereCommsWebSocketTicket('not-a-ticket')).toBe(false)
    expect(hasValidSygSphereCommsWebSocketTicket('a'.repeat(43))).toBe(true)
  })
})
