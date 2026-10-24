import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const dataLayer = readFileSync(resolve(root, 'src/data/adminUsers.ts'), 'utf8')
const userAdminPage = readFileSync(resolve(root, 'src/pages/UserAdminPage.tsx'), 'utf8')
const worker = readFileSync(resolve(root, 'worker/index.ts'), 'utf8')

function workerSection(start: string, end: string): string {
  const startIndex = worker.indexOf(start)
  const endIndex = worker.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return worker.slice(startIndex, endIndex)
}

describe('durable admin email operation identities', () => {
  it('requires and transmits an explicit idempotency key for every admin email-producing action', () => {
    expect(dataLayer).toContain('resetEmployeeMfa(employeeId: string, idempotencyKey: string)')
    expect(dataLayer).toContain('sendEmployeePasswordReset(employeeId: string, idempotencyKey: string)')
    expect(dataLayer).toContain('sendEmployeeWelcomeEmail(employeeId: string, idempotencyKey: string)')
    expect(dataLayer).toContain('sendEmployeeLoginEmail(employeeId: string, idempotencyKey: string)')
    expect(dataLayer).toContain('sendAllEmployeeLoginEmails(idempotencyKey: string)')
    expect(dataLayer.match(/body: JSON\.stringify\(\{ idempotencyKey \}\)/g)).toHaveLength(5)
    expect(worker).toContain("'idempotency_key_required'")
    expect(worker).not.toContain("domainOperationUuid('admin-email-operation'")
  })

  it('retains one operation key across ambiguous retries and clears it only after a terminal outcome', () => {
    expect(userAdminPage).toContain('window.sessionStorage.getItem(storageKey)')
    expect(userAdminPage).toContain('window.sessionStorage.setItem(storageKey, created)')
    expect(userAdminPage).toContain("['email_delivery_unresolved', 'login_instruction_finalization_pending']")
    expect(userAdminPage).toContain("acquireDurableAdminOperationKey(actorEmployeeId, employee.id, 'password-reset')")
    expect(userAdminPage).toContain("acquireDurableAdminOperationKey(actorEmployeeId, employee.id, 'welcome-email')")
    expect(userAdminPage).toContain('MFA reset unavailable')
    expect(userAdminPage).toContain("acquireDurableAdminOperationKey(actorEmployeeId, employee.id, 'login-instructions')")
    expect(userAdminPage).toContain("'bulk-login-instructions'")
  })

  it('fences both self-service and admin password reset delivery before minting a recovery link', () => {
    const selfService = workerSection(
      'async function handleSelfServicePasswordResetApi(',
      'async function handleSelfServiceUsernameRecoveryApi(',
    )
    const adminPassword = workerSection(
      "const passwordResetMatch = /^\\/api\\/v1\\/admin\\/users",
      "const mfaResetMatch = /^\\/api\\/v1\\/admin\\/users",
    )
    for (const section of [selfService, adminPassword]) {
      expect(section.indexOf('prepareInlineEmailDispatch(')).toBeGreaterThanOrEqual(0)
      expect(section.indexOf('prepareInlineEmailDispatch('))
        .toBeLessThan(section.indexOf('/auth/v1/admin/generate_link'))
      expect(section).toContain('releaseUnsentLoginInstructionDispatch(')
      expect(section).toContain('provider was called')
    }
  })
})
