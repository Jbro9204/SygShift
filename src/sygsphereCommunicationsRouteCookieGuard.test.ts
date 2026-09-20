import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const worker = readFileSync(resolve(import.meta.dirname, '..', 'worker/index.ts'), 'utf8')

describe('SygSphere Communications routing-cookie lifetime', () => {
  it('keeps a route-only cookie available for the first 45-second authorization refresh', () => {
    expect(worker).toContain('Max-Age=90')
    expect(worker).toContain("url.pathname === '/api/comms/v1/authorization/refresh'")
    expect(worker).toContain("'set-cookie': communicationsRouteCookie(route.tenantId, route.routeReference)")
  })

  it('does not place the raw one-use ticket in the routing cookie', () => {
    const cookieDefinition = worker.match(/const communicationsRouteCookie[\s\S]*?\n\nconst parseCommunicationsRouteCookie/u)?.[0] ?? ''
    expect(cookieDefinition).toContain('${tenantId}.${routeReference}')
    expect(cookieDefinition).not.toContain('ticket')
  })
})
