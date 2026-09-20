import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const worker = readFileSync(resolve(import.meta.dirname, '..', 'worker/index.ts'), 'utf8')

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

  it('keeps the one-use ticket out of the route-handle implementation', () => {
    const routeDefinition = worker.match(/const communicationsRouteHandle[\s\S]*?\n\nconst parseCommunicationsRouteHandle/u)?.[0] ?? ''
    expect(routeDefinition).toContain('${tenantId}.${routeReference}')
    expect(routeDefinition).not.toContain('ticket')
  })
})
