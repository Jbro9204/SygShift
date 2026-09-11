import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('unified HR MFA release guard', () => {
  it('uses one 30-minute Worker boundary across every HR module and document workflow', () => {
    const worker = read('worker/index.ts')
    expect(worker).toContain('const recentHrMfaSeconds = 30 * 60')
    expect(worker).toContain("throw new ApiError('recent_hr_mfa_required'")
    expect(worker).toContain("url.pathname === '/api/v1/hr/mfa/window'")
    expect(worker.match(/requireRecentHrSession\(request, environment\)/g)?.length).toBeGreaterThanOrEqual(12)
    expect(worker.match(/requireRecentHrMfa\(request, session\)/g)?.length).toBeGreaterThanOrEqual(18)
  })

  it('keeps the fixed window server-bound and removes stricter HR database sub-windows', () => {
    const migration = read('supabase/migrations/20260912100000_unified_thirty_minute_hr_mfa_window.sql')
    expect(migration).toContain('service_verify_recent_hr_mfa')
    expect(migration).toContain("security_session.auth_session_id = target_auth_session_id")
    expect(migration).toContain('target_verified_at <= security_cutoff')
    expect(migration).toContain('private.employee_mfa_reset_events')
    expect(migration).toContain('private.employee_password_reset_events')
    expect(migration).toContain("clock_timestamp() - interval '30 minutes'")
    expect(migration).not.toContain("interval '15 minutes'")
    expect(migration).not.toContain("interval '10 minutes'")
    expect(migration).toContain('private.document_studio_require_recent_mfa')
    expect(migration).toContain('public.service_complete_hr_document_assignment')
  })

  it('coordinates prompts between tabs without persisting an MFA grant in localStorage', () => {
    const coordinator = read('src/lib/identityVerificationCoordinator.ts')
    expect(coordinator).toContain("const verificationLockName = 'sygshift:identity-verification:v1'")
    expect(coordinator).toContain('BroadcastChannel')
    expect(coordinator).toContain("code === 'recent_hr_mfa_required'")
    expect(coordinator).not.toContain('localStorage')
    expect(read('src/components/IdentityVerificationModal.tsx')).toContain('across HR for 30 minutes')
  })

  it('gates legacy direct HR RPC transports before data access', () => {
    expect(read('src/data/hrisPeople.ts')).toContain('await requireHrMfaWindow()')
    expect(read('src/data/hrisIdentityReadiness.ts')).toContain('await requireHrMfaWindow()')
  })
})
