/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const userAdminPage = readFileSync(join(root, 'src', 'pages', 'UserAdminPage.tsx'), 'utf8')

describe('administrator MFA reset guardrails', () => {
  it('keeps the reset endpoint behind an MFA-verified user-administration boundary', () => {
    expect(worker).toContain("const mfaResetMatch = /^\\/api\\/v1\\/admin\\/users")
    expect(worker).toContain('admin = await requireAdminMfa(')
    expect(worker).toContain(": isPasswordResetRequest")
    expect(worker).toContain("? 'admin.users.password_reset'")
    expect(worker).toContain(": 'admin.users.manage'")
    expect(worker).toContain('result.context.permissions?.includes(requiredPermission)')
    expect(worker).toContain('target_actor_employee_id: admin.context.employee_id')
  })

  it('fails closed before target lookup or Auth mutation until reset can invalidate every session', () => {
    const route = worker.slice(
      worker.indexOf('const mfaResetMatch ='),
      worker.indexOf('const match = /^\\/api\\/v1\\/admin\\/users', worker.indexOf('const mfaResetMatch =')),
    )
    expect(route).toContain("'mfa_reset_combined_recovery_required'")
    expect(route).toContain('safe reset must also replace the login credential and invalidate active sessions')
    expect(route).not.toContain('service_get_employee_auth_target')
    expect(route).not.toContain('/auth/v1/admin/users/')
    expect(route).not.toContain('service_begin_admin_mfa_reset')
  })

  it('does not advertise a factor-only reset as safe or complete', () => {
    expect(userAdminPage).toContain('MFA reset unavailable')
    expect(userAdminPage).toContain('paused until it can also invalidate every active session and establish a replacement login credential')
    expect(userAdminPage).not.toContain('Reset MFA setup')
    expect(userAdminPage).not.toContain('Confirm MFA reset')
  })
})
