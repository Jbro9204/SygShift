/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const staticHeaders = readFileSync(join(root, 'public', '_headers'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
const e2eServer = readFileSync(join(root, 'tools', 'e2e-static-server.mjs'), 'utf8')

const requiredHeaders = [
  'Content-Security-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
  'Permissions-Policy',
  'Referrer-Policy',
  'Strict-Transport-Security',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'X-Robots-Tag',
] as const

describe('static asset security header guardrails', () => {
  it('covers every static application route with the production security boundary', () => {
    expect(staticHeaders.startsWith('/*\n')).toBe(true)
    for (const header of requiredHeaders) {
      expect(staticHeaders).toContain(header + ':')
    }
  })

  it('keeps the asset and Worker policies aligned', () => {
    expect(staticHeaders).toContain("default-src 'self'")
    expect(staticHeaders).toContain("connect-src 'self' https://*.supabase.co wss://*.supabase.co")
    expect(staticHeaders).toContain("frame-ancestors 'self'")
    expect(staticHeaders).toContain("object-src 'none'")
    expect(staticHeaders).toContain("style-src-attr 'unsafe-inline'")
    expect(staticHeaders).toContain('max-age=63072000; includeSubDomains; preload')
    expect(worker).toContain("'cross-origin-opener-policy': 'same-origin'")
    expect(worker).toContain("'x-content-type-options': 'nosniff'")
    expect(worker).toContain('"style-src-attr \'unsafe-inline\'"')
    expect(worker).toContain("headers.set('content-security-policy', contentSecurityPolicy)")
    expect(wrangler).toContain('"not_found_handling": "single-page-application"')
    expect(e2eServer).toContain("join(root, '_headers')")
    expect(e2eServer).toContain('response.setHeader(name, value)')
  })

  it('does not weaken the policy with unsafe script execution or broad framing', () => {
    expect(staticHeaders).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(staticHeaders).not.toContain("'unsafe-eval'")
    expect(staticHeaders).not.toContain('frame-ancestors *')
  })
})
