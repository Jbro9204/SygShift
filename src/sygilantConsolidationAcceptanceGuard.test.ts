import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('Sygilant consolidation acceptance boundary', () => {
  it('preserves native SygShift login and recovery until final cutover approval', () => {
    const router = read('src/app/router.tsx')
    const login = read('src/pages/LoginPage.tsx')
    const readiness = read('docs/readiness/SYGILANT_CONSOLIDATION_ACCEPTANCE_09-11-2026.md')

    expect(router).toContain("path: '/login'")
    expect(login).toContain('Forgot password?')
    expect(readiness).toContain('Direct SygShift login must not be retired')
    expect(readiness).toContain('Sygilant-hosted cutover remains gated')
  })

  it('keeps authentication shared and authorization server-enforced independently', () => {
    const outgoing = read('worker/sygilantSharedIdentity.ts')
    const incoming = read('worker/sharedIdentity.ts')
    const browser = read('src/data/platformLaunch.ts')
    const policy = read('supabase/migrations/20260912010000_universal_sygilant_launch_access.sql')

    expect(outgoing).toContain("context.permissions?.includes('apps.sygilant.access')")
    expect(outgoing).toContain("request.headers.get('origin') !== config.issuer")
    expect(incoming).toContain('service_issue_shared_identity_session')
    expect(incoming).toContain('localAssuranceAllowed')
    expect(policy).toContain('private.employee_requires_mfa')
    expect(browser).toContain("form.method = 'POST'")
    expect(browser).not.toMatch(/[?&](?:assertion|token)=/)
  })
})
