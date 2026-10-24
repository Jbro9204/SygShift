import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveAdminLoginTemporaryPassword, validateSuppliedTemporaryPassword } from '../worker'

const root = resolve(import.meta.dirname, '..')
const dataLayer = readFileSync(resolve(root, 'src/data/adminUsers.ts'), 'utf8')
const userAdminPage = readFileSync(resolve(root, 'src/pages/UserAdminPage.tsx'), 'utf8')
const worker = readFileSync(resolve(root, 'worker/index.ts'), 'utf8')
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20261024171000_durable_admin_login_instructions.sql'),
  'utf8',
)
const sqlRegression = readFileSync(
  resolve(root, 'supabase/tests/durable_admin_login_instructions_regression.sql'),
  'utf8',
)

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('durable admin login instructions', () => {
  it('derives a stable policy-compliant 18-character credential without persisting plaintext', async () => {
    const secret = 'rollback-only-service-secret'
    const operationId = '31e75d57-47f9-4a35-8c4b-01bd118a4761'
    const employeeId = '5a10f7fe-bc0d-44ac-8477-f75be090ef34'
    const first = await deriveAdminLoginTemporaryPassword(secret, operationId, employeeId, 'alexander')
    const replay = await deriveAdminLoginTemporaryPassword(secret, operationId, employeeId, 'alexander')
    const anotherOperation = await deriveAdminLoginTemporaryPassword(
      secret,
      '19df5655-8e79-427d-b18a-c1dded495be8',
      employeeId,
      'alexander',
    )

    expect(first).toBe(replay)
    expect(first).not.toBe(anotherOperation)
    expect(first).toHaveLength(18)
    expect(first).toMatch(/[a-z]/)
    expect(first).toMatch(/[A-Z]/)
    expect(first).toMatch(/[0-9]/)
    expect(first).toMatch(/[^A-Za-z0-9]/)
    expect(validateSuppliedTemporaryPassword(first, 'alexander')).toEqual([])
    expect(migration).not.toMatch(/\btemporary_password\b|\bplaintext\b\s+text|\bcredential_value\b/)
  })

  it('requires explicit client keys for single and bulk requests and preserves ambiguous retries', () => {
    expect(dataLayer).toContain('sendEmployeeLoginEmail(employeeId: string, idempotencyKey: string)')
    expect(dataLayer).toContain('sendAllEmployeeLoginEmails(idempotencyKey: string)')
    expect(dataLayer).toContain('body: JSON.stringify({ idempotencyKey })')
    expect(userAdminPage).toContain("'bulk-login-instructions' | 'login-instructions'")
    expect(userAdminPage).toContain("acquireDurableAdminOperationKey(actorEmployeeId, employee.id, 'login-instructions')")
    expect(userAdminPage).toContain("readDurableAdminOperationKey(")
    expect(userAdminPage).toContain("'bulk-login-instructions'")
    expect(userAdminPage).toContain("failure.code === 'email_delivery_unresolved'")
    expect(userAdminPage).toContain("['email_delivery_unresolved', 'login_instruction_finalization_pending']")
    expect(userAdminPage).toContain("failure.code === 'login_instruction_finalization_pending'")
    expect(userAdminPage).not.toContain("failure.code === 'login_credential_material_unavailable'\n        ||")
  })

  it('preflights runtime email configuration and the complete durable recipient fence before Auth mutation', () => {
    const execute = section(
      worker,
      'async function executeAdminLoginInstructionOperation(',
      'async function sendWelcomeEmail(',
    )
    const emailBindingCheck = execute.indexOf('if (!environment.EMAIL)')
    const senderCheck = execute.indexOf("if (!environment.SYGSHIFT_EMAIL_FROM?.trim())")
    const recipientFence = execute.indexOf('prepareAdminLoginInstructionDispatches(')
    const authMutation = execute.indexOf('await provisionOne(')
    expect(emailBindingCheck).toBeGreaterThanOrEqual(0)
    expect(senderCheck).toBeGreaterThan(emailBindingCheck)
    expect(recipientFence).toBeGreaterThan(senderCheck)
    expect(authMutation).toBeGreaterThan(recipientFence)
    expect(worker).toContain('permittedLinkedAuthUserIds.has(currentAuthUserId)')
    expect(worker).toContain('expectedLinkedAuthUserIds.size === 0')
    expect(worker).toContain('currentAuthByEmail !== expectedAuthByEmail')
    expect(worker).toContain('item.candidateAuthUserId')
    expect(worker).toContain('if (candidateAuthUser)')
    expect(worker).toContain("currentAuthUser.app_metadata?.employeeId !== item.employeeId")
    expect(worker).toContain("'login_instruction_auth_identity_conflict'")
    expect(worker.indexOf('linked = await link(existing.id)')).toBeLessThan(
      worker.indexOf('user = await updateAuthUser(config, target, existing, password, operationId)'),
    )
    expect(worker).toContain('Credential content was redacted.')
  })

  it('uses a first-writer manifest, safe created-account replay, and a durable empty bulk result', () => {
    expect(migration).toContain("pg_advisory_xact_lock(hashtextextended('admin-login-instructions:'")
    expect(migration).toContain("target_mode = 'single' and item_count <> 1")
    expect(migration).toContain('if item_count = 0 then')
    expect(migration).toContain("item.state not in ('completed', 'failed')")
    expect(sqlRegression).toContain('response-loss/concurrent retry')
    expect(sqlRegression).toContain('created_auth_user')
    expect(sqlRegression).toContain('An empty bulk operation must be durably completed')
    expect(sqlRegression.trimEnd().endsWith('rollback;')).toBe(true)
  })

  it('prevents distinct-key operations from racing the same employee', () => {
    expect(migration).toContain('admin_login_instruction_items_one_active_employee')
    expect(migration).toContain("where state in ('prepared', 'provisioned', 'unresolved')")
    expect(migration).toContain('service_find_active_admin_login_instruction_operations')
    expect(migration).toContain('service_claim_admin_login_instruction_operation')
    expect(migration).toContain('ADMIN_LOGIN_INSTRUCTIONS_RECOVERY_CLAIMED')
    expect(migration).toContain("purpose in ('admin_login_instructions', 'onboarding_account_setup')")
    expect(worker).toContain("'onboarding_account_setup',")
    expect(sqlRegression).toContain('must not claim an admin login-instruction operation')
    expect(migration).toContain('service_prepare_admin_login_instruction_dispatches')
    expect(migration).toContain("raise check_violation using message = 'login_instruction_employee_operation_active'")
    expect(worker).toContain("'login_instruction_employee_operation_active',")
    expect(worker).toContain("if (operation.state !== 'prepared')")
    expect(worker).toContain("failure.code === 'email_delivery_unresolved' || failure.status >= 500")
    expect(sqlRegression).toContain('A distinct-key concurrent operation for the same employee must fail')
    expect(sqlRegression).toContain('roll back atomically without a partial operation')
    expect(sqlRegression).toContain('Browser-loss recovery must preserve the original operation and actor')
  })

  it('keeps invite-only login instructions from resetting an already linked account', () => {
    const execute = section(
      worker,
      'async function executeAdminLoginInstructionOperation(',
      'async function sendWelcomeEmail(',
    )
    const singleRoute = section(
      worker,
      'const emailMatch = /^\\/api\\/v1\\/admin\\/users\\/([0-9a-f-]{36})\\/login-email$/i.exec(url.pathname)',
      'const passwordResetMatch = /^\\/api\\/v1\\/admin\\/users\\/([0-9a-f-]{36})\\/password-reset$/i.exec(url.pathname)',
    )

    expect(singleRoute).toContain("'existing_account_requires_password_reset'")
    expect(singleRoute.indexOf('target.existingAuthUserId')).toBeLessThan(
      singleRoute.indexOf('beginAdminLoginInstructionOperation('),
    )
    expect(execute).toContain('const provenByPersistedItem = Boolean(')
    expect(execute).toContain('const provenByOperationMetadata = Boolean(')
    expect(execute).toContain('invite-only')
    expect(execute).toContain('authority must never rotate a now-linked account credential again')
    expect(execute.indexOf("'existing_account_requires_password_reset'")).toBeLessThan(
      execute.indexOf('await provisionOne('),
    )
  })
})
