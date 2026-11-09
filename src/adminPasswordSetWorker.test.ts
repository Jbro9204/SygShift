import { describe, expect, it, vi } from 'vitest'
import { cancelEmployeePasswordSet, confirmEmployeePasswordSet, readEmployeePasswordSet, setEmployeePassword, type PasswordSetOperation } from '../worker/adminPasswordSet'

const employeeId = '20000000-0000-4000-8000-000000000002'
const operationId = '40000000-0000-4000-8000-000000000001'
const authUserId = '10000000-0000-4000-8000-000000000002'
const actor = { actorEmployeeId: '20000000-0000-4000-8000-000000000001', actorAuthSessionId: '30000000-0000-4000-8000-000000000001', recentMfaAt: '2026-11-09T18:00:00Z', mfaMethod: 'authenticator' as const, securityKeyTokenHash: null }
const input = { employeeId, confirmationUsername: 'testguard', password: 'OnlySynthetic!4728', requireChangeAtNextLogin: true, reason: 'Approved individual credential replacement.', idempotencyKey: operationId }
const operation: PasswordSetOperation = { operationId, employeeId, authUserId, username: 'testguard', status: 'prepared', providerWriteAllowed: true, requireChangeAtNextLogin: true, expiresAt: null }

function fixture() {
  return {
    rpc: vi.fn().mockResolvedValueOnce(operation).mockResolvedValueOnce({ ...operation, status: 'confirmed', providerWriteAllowed: false }),
    replacePassword: vi.fn().mockResolvedValue({ outcome: 'confirmed', authUserId }),
    digest: vi.fn().mockResolvedValue('d'.repeat(64)),
  }
}

describe('Admin-set password orchestration', () => {
  it('sends only the chosen password to the exact Auth identity and no secret to RPCs', async () => {
    const deps = fixture()
    expect((await setEmployeePassword(deps, actor, input)).status).toBe('confirmed')
    expect(deps.replacePassword).toHaveBeenCalledExactlyOnceWith(authUserId, input.password, operationId)
    expect(JSON.stringify(deps.rpc.mock.calls)).not.toContain(input.password)
    expect(deps.digest).not.toHaveBeenCalledWith(expect.stringContaining(input.password))
    expect(deps.rpc.mock.calls[0][1]).toMatchObject({ requireChangeAtNextLogin: true, employeeId })
  })

  it('keeps the unchecked choice and never adds password expiry', async () => {
    const deps = fixture()
    deps.rpc.mockReset().mockResolvedValueOnce({ ...operation, requireChangeAtNextLogin: false }).mockResolvedValueOnce({ ...operation, status: 'confirmed', providerWriteAllowed: false, requireChangeAtNextLogin: false })
    expect(await setEmployeePassword(deps, actor, { ...input, requireChangeAtNextLogin: false })).toMatchObject({ status: 'confirmed', expiresAt: null, requireChangeAtNextLogin: false })
  })

  it('does not rewrite the provider on a repeated or uncertain request', async () => {
    for (const status of ['confirmed', 'prepared', 'uncertain', 'known_failed'] as const) {
      const deps = fixture()
      deps.rpc.mockReset().mockResolvedValue({ ...operation, status, providerWriteAllowed: false })
      expect((await setEmployeePassword(deps, actor, input)).status).toBe(status)
      expect(deps.replacePassword).not.toHaveBeenCalled()
    }
  })

  it('records unknown provider outcome and does not leak provider error details', async () => {
    const deps = fixture()
    deps.replacePassword.mockRejectedValue(new Error(`private provider material ${input.password}`))
    deps.rpc.mockReset().mockResolvedValueOnce(operation).mockResolvedValueOnce({ ...operation, status: 'uncertain', providerWriteAllowed: false })
    expect((await setEmployeePassword(deps, actor, input)).status).toBe('uncertain')
    expect(deps.rpc.mock.calls[1][1]).toMatchObject({ outcome: 'unknown', errorCode: 'password_provider_unconfirmed' })
    expect(JSON.stringify(deps.rpc.mock.calls)).not.toContain(input.password)
  })

  it('treats a wrong provider identity as unconfirmed', async () => {
    const deps = fixture()
    deps.replacePassword.mockResolvedValue({ outcome: 'confirmed', authUserId: actor.actorEmployeeId })
    await setEmployeePassword(deps, actor, input)
    expect(deps.rpc.mock.calls[1][1]).toMatchObject({ outcome: 'unknown' })
  })

  it('checks durable state after a lost completion and never repeats the password write', async () => {
    const deps = fixture()
    deps.rpc.mockReset().mockResolvedValueOnce(operation).mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ ...operation, status: 'confirmed', providerWriteAllowed: false })
    expect((await setEmployeePassword(deps, actor, input)).status).toBe('confirmed')
    expect(deps.replacePassword).toHaveBeenCalledTimes(1)
    expect(deps.rpc.mock.calls[2]).toEqual(['service_get_employee_password_set', { ...actor, employeeId, operationId }])
  })

  it('rejects mismatched receipts before touching Auth', async () => {
    const deps = fixture()
    deps.rpc.mockReset().mockResolvedValue({ ...operation, employeeId: actor.actorEmployeeId })
    await expect(setEmployeePassword(deps, actor, input)).rejects.toThrow()
    expect(deps.replacePassword).not.toHaveBeenCalled()
  })

  it('read-only status does not create or write a password', async () => {
    const deps = fixture()
    deps.rpc.mockReset().mockResolvedValue(null)
    expect(await readEmployeePasswordSet(deps, actor, employeeId)).toBeNull()
    expect(deps.rpc).toHaveBeenCalledExactlyOnceWith('service_get_employee_password_set', { ...actor, employeeId })
    expect(deps.replacePassword).not.toHaveBeenCalled()
  })

  it('explicitly confirms an exact provider receipt without a second password write', async () => {
    const deps = fixture()
    deps.rpc.mockReset().mockResolvedValueOnce({ ...operation, status: 'uncertain', providerWriteAllowed: false, providerUpdateVerified: true })
      .mockResolvedValueOnce({ ...operation, status: 'confirmed', providerWriteAllowed: false, providerUpdateVerified: true })
    expect((await confirmEmployeePasswordSet(deps, actor, employeeId, operationId, 'testguard')).status).toBe('confirmed')
    expect(deps.replacePassword).not.toHaveBeenCalled()
    expect(deps.rpc.mock.calls[1]).toEqual(['service_finish_employee_password_set', expect.objectContaining({ operationId, outcome: 'confirmed', providerAuthUserId: authUserId })])
  })

  it('does not confirm when no matching committed Auth receipt exists', async () => {
    const deps = fixture()
    deps.rpc.mockReset().mockResolvedValue({ ...operation, status: 'uncertain', providerWriteAllowed: false, providerUpdateVerified: false })
    expect((await confirmEmployeePasswordSet(deps, actor, employeeId, operationId, 'testguard')).status).toBe('uncertain')
    expect(deps.rpc).toHaveBeenCalledTimes(1)
    expect(deps.replacePassword).not.toHaveBeenCalled()
  })

  it('cancels only the exact unconfirmed request through its protected RPC without a credential write', async () => {
    const deps = fixture()
    deps.rpc.mockReset().mockResolvedValue({ ...operation, status: 'canceled', providerWriteAllowed: false })
    expect((await cancelEmployeePasswordSet(deps, actor, employeeId, operationId, 'testguard', input.reason)).status).toBe('canceled')
    expect(deps.rpc).toHaveBeenCalledExactlyOnceWith('service_cancel_employee_password_set', { ...actor, employeeId, operationId, confirmationUsername: 'testguard', reason: input.reason })
    expect(deps.replacePassword).not.toHaveBeenCalled()
  })
})
