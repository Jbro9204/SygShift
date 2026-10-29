/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const data = readFileSync(join(root, 'src', 'data', 'adminUsers.ts'), 'utf8')
const page = readFileSync(join(root, 'src', 'pages', 'UserAdminPage.tsx'), 'utf8')

describe('emergency employee access controls', () => {
  it('retires the browser-direct login state toggle', () => {
    expect(data).not.toContain("rpc('admin_set_employee_account_state'")
    expect(page).not.toContain('Enable login')
    expect(page).not.toContain('Disable login access')
    expect(page).toContain('Revoke all access')
    expect(page).toContain('Review access restoration')
  })

  it('uses dedicated Worker endpoints and one stable idempotency key', () => {
    expect(data).toContain('/emergency-access/${action}')
    expect(data).toContain("headers: { 'idempotency-key': operationRequestId }")
    expect(page).toContain("['provider_pending', 'provider_failed'].includes(state.operation.status)")
    expect(page).toContain('resumableOperation?.operationRequestId ?? crypto.randomUUID()')
    expect(page).toContain("resumableOperation?.reason ?? ''")
    expect(page).toContain('Retry this open form to reuse the same safe operation ID.')
  })

  it('requires both critical permissions and deliberate typed confirmation', () => {
    expect(page).toContain("canManageLogin && hasPermission('admin.security.manage')")
    expect(page).toContain('confirmation.trim() === employee.username')
    expect(page).toContain('reasonLength >= 10 && reasonLength <= 1000')
    expect(page).toContain('acknowledged && confirmed')
  })

  it('states the preservation and restoration boundaries clearly', () => {
    expect(page).toContain('Employment, roles, schedules, punches, payroll, licensing, client records, and audit history remain unchanged.')
    expect(page).toContain('It never revives old sessions, remembered devices, or passwords.')
    expect(page).toContain('fresh password-recovery link')
    expect(page).toContain('No security action is being reported as complete.')
  })
})
