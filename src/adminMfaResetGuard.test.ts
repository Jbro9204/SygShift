/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260810154500_admin_mfa_reset_control.sql'),
  'utf8',
)
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const userAdminPage = readFileSync(join(root, 'src', 'pages', 'UserAdminPage.tsx'), 'utf8')

describe('administrator MFA reset guardrails', () => {
  it('keeps the reset endpoint behind an MFA-verified user-administration boundary', () => {
    expect(worker).toContain("const mfaResetMatch = /^\\/api\\/v1\\/admin\\/users")
    expect(worker).toContain('admin = await requireAdminMfa(')
    expect(worker).toContain("isNewUserInviteRequest ? 'admin.users.invite' : 'admin.users.manage'")
    expect(worker).toContain('result.context.permissions?.includes(requiredPermission)')
    expect(worker).toContain('target_actor_employee_id: admin.context.employee_id')
  })

  it('removes authentication factors and records the exact reset operation', () => {
    expect(worker).toContain('/auth/v1/admin/users/${userId}/factors')
    expect(worker).toContain('/auth/v1/admin/users/${userId}/factors/${factorId}')
    expect(worker).toContain("'service_record_employee_mfa_reset'")
    expect(migration).toContain('create table if not exists private.employee_mfa_reset_events')
    expect(migration).toContain('employee_mfa_reset_events_append_only')
    expect(migration).toContain('private.prevent_append_only_change()')
    expect(migration).toContain('employee_mfa_reset_events_audit')
    expect(migration).toContain('private.write_audit_event()')
    expect(migration).toContain("if (select auth.role()) <> 'service_role'")
    expect(migration).toContain('revoke all on function public.service_record_employee_mfa_reset')
    expect(migration).toContain('grant execute on function public.service_record_employee_mfa_reset')
  })

  it('requires deliberate confirmation and explains exactly what remains unchanged', () => {
    expect(userAdminPage).toContain('Reset MFA setup')
    expect(userAdminPage).toContain('Confirm MFA reset')
    expect(userAdminPage).toContain('Their password, employee record, and history will not change.')
    expect(userAdminPage).toContain('mfa-reset-confirmation__actions')
  })
})
