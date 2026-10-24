import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const worker = readFileSync(resolve(root, 'worker/index.ts'), 'utf8')
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20261024168000_durable_admin_security_operations.sql'),
  'utf8',
)
const passwordResetIdentityMigration = readFileSync(
  resolve(root, 'supabase/migrations/20261024175000_bind_admin_password_reset_identity.sql'),
  'utf8',
)

describe('durable admin security operation guard', () => {
  it('retires factor-only MFA reset before any target lookup, code consumption, or destructive Auth call', () => {
    const endpoint = worker.slice(
      worker.indexOf("const mfaResetMatch = /^\\/api\\/v1\\/admin\\/users"),
      worker.indexOf("const match = /^\\/api\\/v1\\/admin\\/users", worker.indexOf('const mfaResetMatch')),
    )
    expect(endpoint).toContain('mfa_reset_combined_recovery_required')
    expect(endpoint).not.toContain('service_get_employee_auth_target')
    expect(endpoint).not.toContain('listAuthUserMfaFactors')
    expect(endpoint).not.toContain('deleteAuthUserMfaFactor')

    const selfService = worker.slice(
      worker.indexOf('async function handleAccountMfaRecoveryApi'),
      worker.indexOf('function securityKeySummary'),
    )
    expect(selfService.indexOf('mfa_recovery_combined_reset_required')).toBeLessThan(
      selfService.indexOf('service_get_employee_auth_target'),
    )
    expect(selfService).not.toContain('service_consume_mfa_recovery_code')
    expect(selfService).not.toContain('deleteAuthUserMfaFactor')
  })

  it('keeps scheduled factor-only recovery inert while preserving the future durable schema', () => {
    expect(worker).toContain('async function recoverAdminMfaResetOperations')
    const recovery = worker.slice(
      worker.indexOf('export async function recoverAdminMfaResetOperations'),
      worker.indexOf('export function secureResponse'),
    )
    expect(recovery).toContain('return { recovered: 0, failed: 0 }')
    expect(recovery).not.toContain('service_list_admin_mfa_reset_recovery')
    expect(recovery).not.toContain('executeAdminMfaResetOperation')
    expect(worker).toContain('recoverAdminMfaResetOperations(environment, rpc, 10')
    expect(migration).toContain('recovery_next_attempt_at')
    expect(migration).toContain('recovery_quarantined_at')
    expect(migration).toContain('next_attempt_count := least(8')
    expect(migration).toContain('service_resume_admin_mfa_reset_recovery')
  })

  it('makes MFA completion and password-reset audit replay safe by immutable operation id', () => {
    expect(migration).toContain('employee_mfa_reset_events_operation_uidx')
    expect(migration).toContain('employee_password_reset_events_operation_uidx')
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(passwordResetIdentityMigration).toContain('private.admin_password_reset_operations')
    expect(passwordResetIdentityMigration).toContain('service_prepare_employee_password_reset_operation')
    expect(passwordResetIdentityMigration).toContain('service_complete_employee_password_reset_operation')
    expect(passwordResetIdentityMigration).toContain("dispatch.state = 'accepted'")
    expect(passwordResetIdentityMigration).toContain('account.auth_user_id')
    expect(passwordResetIdentityMigration).toContain('operation.recipient_email')
    expect(passwordResetIdentityMigration).toContain('on conflict (operation_id) do nothing')
    expect(migration).toContain('on conflict (id) do nothing')

    const passwordEndpoint = worker.slice(
      worker.indexOf('const passwordResetMatch'),
      worker.indexOf('const mfaResetMatch'),
    )
    expect(passwordEndpoint.indexOf('service_prepare_employee_password_reset_operation')).toBeLessThan(
      passwordEndpoint.indexOf('prepareInlineEmailDispatch'),
    )
    expect(passwordEndpoint.indexOf('service_complete_employee_password_reset_operation')).toBeGreaterThan(
      passwordEndpoint.indexOf('sendDurableInlineEmail'),
    )
    expect(passwordEndpoint).toContain('password_reset_identity_changed')
    expect(passwordEndpoint).not.toContain('service_record_employee_password_reset')
  })
})
