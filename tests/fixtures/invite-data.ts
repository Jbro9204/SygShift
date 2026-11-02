// Isolated browser fixture: synthetic identities and in-memory outcomes only.
import { AdminEmailRequestError, type AdminUser } from '../../src/data/adminUsers'
import { employeeRoleTestUser } from '../../src/test/employeeRoleFixtures'

export * from '../../src/data/adminUsers'
export { platformApplicationLabels, platformPresenceLabels } from '../../src/data/platformPresence'
export { isOfficialSygShiftOrigin } from '../../src/data/platformLaunch'

const requestId = '20000000-0000-4000-8000-000000000001'
const employee: AdminUser = { ...employeeRoleTestUser, role: 'guard', personalEmail: 'employee@example.invalid' }
const account = {
  authUserId: '20000000-0000-4000-8000-000000000002', invitedAt: '2026-11-02T20:00:00Z', activatedAt: null,
  disabledAt: null, lastSignInAt: null, mustChangePassword: true, passwordChangedAt: null,
  mfaEnrolledAt: null, isBootstrapAdmin: false, status: 'active' as const,
}
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'success'
let loginCalls = 0
let welcomeCalls = 0
let directoryCalls = 0
let accountExists = false
let releaseLogin: (() => void) | null = null
let releaseReadback: (() => void) | null = null
const accepted = () => ({ requestId, email: employee.personalEmail, username: employee.username, displayName: employee.displayName, action: 'created_auth_user' })

export const inviteFixture = {
  snapshot: () => ({ loginCalls, welcomeCalls, directoryCalls }),
  releaseLogin: () => releaseLogin?.(),
  releaseReadback: () => releaseReadback?.(),
}
export async function getSessionContext() {
  return { employeeId: '90000000-0000-4000-8000-000000000001', role: 'admin', permissions: ['admin.users.basic', 'admin.users.manage', 'admin.users.invite'] }
}
export async function getAdminUserDirectory() {
  directoryCalls += 1
  if (directoryCalls === 2 && scenario === 'pending') await new Promise<void>((resolve) => { releaseReadback = resolve })
  if (directoryCalls === 2 && scenario === 'readback-failure') throw new Error('Synthetic readback failure')
  return { serverTimestamp: '2026-11-02T20:00:00Z', currentEmployeeId: '90000000-0000-4000-8000-000000000001', users: [{ ...employee, account: accountExists ? account : null, accountStatus: accountExists ? 'active' as const : 'not_created' as const }] }
}
export async function sendEmployeeLoginEmail() {
  loginCalls += 1
  if (scenario === 'pending') await new Promise<void>((resolve) => { releaseLogin = resolve })
  accountExists = true // Simulates a partial account write so readback, not failure-stage inference, is exercised.
  if (scenario === 'failure' || scenario === 'readback-failure') {
    throw new AdminEmailRequestError('Login-instructions delivery could not be confirmed. Check account status and email history before retrying.', 502, 'login_instructions_email_failed', requestId)
  }
  return accepted()
}
export async function sendEmployeeWelcomeEmail() { welcomeCalls += 1; return accepted() }
export async function getPlatformPresenceDirectory() { return { people: [] } }
export async function getAccessControlCenter() { throw new Error('Unexpected access-control operation in invite fixture') }
export async function setEmployeeWorkforceRoles() { throw new Error('No role writes in invite fixture') }
export async function launchSygilantPlatform() { throw new Error('No platform launch in invite fixture') }
export async function returnToOfficialSygShift() { throw new Error('No platform launch in invite fixture') }
export async function submitSygilantPlatformLaunch() { throw new Error('No platform launch in invite fixture') }
