import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('central emergency access bridge release guard', () => {
  it('removes the independent SygShift account-state control from browser code', () => {
    const directory = read('src/data/adminUsers.ts')
    const workspace = read('src/pages/UserAdminPage.tsx')

    expect(directory).not.toContain('admin_set_employee_account_state')
    expect(workspace).not.toContain('setEmployeeAccountState')
    expect(workspace).not.toContain('Disable login access')
    expect(workspace).toContain('launchSygilantPlatform(`/security?employeeId=${employee.id}`)')
    expect(workspace).toContain('Suspend access only')
    expect(workspace).toContain('Terminate employment')
  })

  it('requires the central emergency session authority at browser and Worker boundaries', () => {
    const browser = read('src/data/auth.ts')
    const registryClient = read('src/data/emergencyAccessSession.ts')
    const shell = read('src/components/AppShell.tsx')
    const worker = read('worker/index.ts')
    const handoff = read('worker/sygilantSharedIdentity.ts')

    expect(browser).toContain("rpc('get_session_context_emergency')")
    expect(browser).toContain('authSessionActive: z.literal(true)')
    expect(browser).toContain("emergencyAccessState: z.literal('active')")
    expect(worker.match(/'get_session_context_emergency'/g)).toHaveLength(2)
    expect(worker).toContain("error: 'access_revoked'")
    expect(registryClient).toContain('/api/v1/security/emergency-session/register')
    expect(shell).toContain('registerEmergencyPlatformSession(verifiedContext.accessGeneration, signal)')
    expect(worker).toContain("'sygilant_service_register_emergency_platform_session'")
    expect(worker).toContain("target_application: 'sygshift'")
    expect(worker).toContain('target_provider_session_hash: await sha256Hex(claims.session_id)')
    expect(handoff).toContain('/rest/v1/rpc/get_session_context_emergency')
    expect(handoff).toContain("new SharedLaunchError('access_revoked'")
  })

  it('keeps the forced-logout signal private and rechecks returning browsers', () => {
    const listener = read('src/components/EmergencyAccessRevocationListener.tsx')

    expect(listener).toContain('employee:${authUserId}')
    expect(listener).toContain("{ event: 'access-revoked' }")
    expect(listener).toContain('{ config: { private: true } }')
    expect(listener).toContain('acknowledgeEmergencyPlatformSessionRevocation')
    expect(listener).toContain("window.addEventListener('online', revalidate)")
    expect(listener).toContain("document.addEventListener('visibilitychange', revalidate)")
    expect(read('worker/index.ts')).toContain("'acknowledge_emergency_platform_session_revocation'")
    expect(read('worker/index.ts')).not.toContain("'sygilant_service_acknowledge_emergency_platform_session_revocation'")
  })
})
