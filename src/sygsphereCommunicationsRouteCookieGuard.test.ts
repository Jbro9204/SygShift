import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const worker = readFileSync(resolve(import.meta.dirname, '..', 'worker/index.ts'), 'utf8')
const coordinator = readFileSync(resolve(import.meta.dirname, '..', 'worker/comms/tenantCommsDurableObject.ts'), 'utf8')

describe('SygSphere Communications per-tab routing', () => {
  it('returns a route-only handle at bootstrap and never uses a shared routing cookie', () => {
    expect(worker).toContain('routeHandle: communicationsRouteHandle(authorization.data.tenantId, bootstrap.routeReference)')
    expect(worker).not.toContain('__Host-sygsphere-comms-route')
    expect(worker).not.toContain('communicationsRouteCookie(')
  })

  it('requires the per-tab handle on protected HTTP actions and the socket upgrade', () => {
    expect(worker).toContain("const communicationsRouteHeaderName = 'x-sygsphere-comms-route-reference'")
    expect(worker).toContain("const communicationsRouteWebSocketProtocolPrefix = 'sygsphere-comms-route.'")
    expect(worker).toContain('parseCommunicationsRouteWebSocketProtocol(request)')
    expect(worker).toContain('parseCommunicationsRouteHeader(request)')
  })

  it('selects only the validated route protocol in the WebSocket handshake', () => {
    expect(worker).toContain('const selectedCommunicationsRouteWebSocketProtocol')
    expect(worker).toContain("headers.set('sec-websocket-protocol', selectedCommunicationsRouteWebSocketProtocol(route))")
    expect(coordinator).toContain("headers: { 'sec-websocket-protocol': selectedProtocol }")
    expect(coordinator).toContain("selectedProtocol.includes(',')")
    expect(coordinator).not.toContain("headers: { 'sec-websocket-protocol': request.headers.get")
  })

  it('keeps the one-use ticket out of the route-handle implementation', () => {
    const routeDefinition = worker.match(/const communicationsRouteHandle[\s\S]*?\n\nconst parseCommunicationsRouteHandle/u)?.[0] ?? ''
    expect(routeDefinition).toContain('${tenantId}.${routeReference}')
    expect(routeDefinition).not.toContain('ticket')
  })
})
