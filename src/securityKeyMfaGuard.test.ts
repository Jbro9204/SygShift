import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260829163000_security_key_mfa.sql'), 'utf8')
const accessControlMigration = readFileSync(join(root, 'supabase', 'migrations', '20260727203000_access_control_center.sql'), 'utf8')
const mfaRequirementMigration = readFileSync(join(root, 'supabase', 'migrations', '20260823200000_mfa_aware_onboarding_email_targets.sql'), 'utf8')
const accountPage = readFileSync(join(root, 'src', 'pages', 'MyAccountPage.tsx'), 'utf8')

describe('FIDO2 security-key guardrails', () => {
  it('keeps existing authenticator and trusted-device assurance while adding key assurance', () => {
    expect(migration).toContain('private.has_aal2()')
    expect(migration).toContain('public.has_trusted_device()')
    expect(migration).toContain('public.has_security_key_session()')
  })

  it('binds the opaque key session to the employee and Supabase authentication session', () => {
    expect(migration).toContain('security_session.employee_id = actor_id')
    expect(migration).toContain('security_session.auth_session_id = jwt_session_id')
    expect(migration).toContain("extensions.digest(session_token, 'sha256')")
    expect(migration).toContain('security_session.expires_at > now()')
    expect(worker).toContain('Date.now() + 12 * 60 * 60 * 1000')
  })

  it('uses one-time expiring challenges, verified origins, user verification, and monotonic counters', () => {
    expect(migration).toContain('and challenge.consumed_at is null')
    expect(migration).toContain("clock_timestamp() + interval '5 minutes'")
    expect(migration).toContain('target_counter <= current_counter')
    expect(worker).toContain('expectedOrigin: expectedWebAuthnOrigins(request)')
    expect(worker).toContain('requireUserVerification: true')
    expect(worker).toContain("authenticatorAttachment: 'cross-platform'")
  })

  it('requires fresh raw authenticator AAL2 for registering and removing keys', () => {
    expect(worker.match(/requireRawAal2\(session\.token\)/g)).toHaveLength(3)
    expect(accountPage).toContain('Verify your authenticator before adding or removing security keys.')
  })

  it('revokes security keys and their sessions during an administrator MFA reset', () => {
    expect(migration).toContain('keys_revoked_count')
    expect(migration).toContain('sessions_revoked_count')
    expect(migration).toContain("'securityKeysRevoked', keys_revoked_count")
    expect(migration).toContain("'securityKeySessionsRevoked', sessions_revoked_count")
  })

  it('returns the complete employee security-key contract to the administrator workspace', () => {
    expect(worker).toContain("'service_get_employee_auth_target'")
    expect(worker).toContain('displayName: target.displayName')
    expect(worker).toContain('employeeId: target.employeeId')
    expect(worker).toContain('keys: keys.map(securityKeySummary)')
  })

  it('does not require MFA from the Guard base role after a demotion', () => {
    expect(accessControlMigration).toContain("('system_guard', 'Guard', 'Baseline access for guards.', 'guard', true, true, false, true)")
    expect(mfaRequirementMigration).toContain('where base_role.base_app_role = employee.role')
    expect(mfaRequirementMigration).toContain('and base_role.mfa_required')
  })
})
