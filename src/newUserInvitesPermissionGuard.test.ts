/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260812133000_new_user_invites_permission.sql'),
  'utf8',
)
const navigation = readFileSync(join(root, 'src', 'app', 'navigation.ts'), 'utf8')
const userAdminPage = readFileSync(join(root, 'src', 'pages', 'UserAdminPage.tsx'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('New User Invites permission guardrails', () => {
  it('registers one assignable MFA permission and grants it to the system Admin role', () => {
    expect(migration).toContain("'admin.users.invite'")
    expect(migration).toContain("'New User Invites'")
    expect(migration).toContain("'sensitive'")
    expect(migration).toContain("where role.code = 'system_admin'")
    expect(migration).toContain("'admin.users.invite',\n      'admin.users.separate'")
  })

  it('makes the permission discoverable without merging it into login security controls', () => {
    expect(navigation).toContain("'admin.users.invite'")
    expect(userAdminPage).toContain("permissions.includes('admin.users.invite')")
    expect(userAdminPage).toContain('canSendNewUserInvites')
    expect(userAdminPage).toContain('Send new user invites')
    expect(userAdminPage).toContain('Email login instructions')
    expect(userAdminPage).toContain('Send welcome email')
  })

  it('enforces the exact effective permission on every invitation email route', () => {
    expect(worker).toContain("requiredPermission: 'admin.users.manage' | 'admin.users.invite'")
    expect(worker).toContain("requiredPermission === 'admin.users.invite'")
    expect(worker).toContain("url.pathname === '/api/v1/admin/users/login-emails'")
    expect(worker).toContain("(?:login-email|welcome-email)")
    expect(worker).toContain("isNewUserInviteRequest ? 'admin.users.invite' : 'admin.users.manage'")
    expect(worker).toContain('new_user_invites_permission_required')
  })
})
