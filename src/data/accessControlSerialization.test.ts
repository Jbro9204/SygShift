import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setEmployeeWorkforceRoles } from './accessControl'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({
    data: {
      generatedAt: '2026-09-30T12:00:00.000Z',
      permissions: [],
      roles: [],
      users: [],
    },
    error: null,
  })
})

describe('access-control role-only serialization', () => {
  it('saves workforce roles without sending cached direct permission grants', async () => {
    await setEmployeeWorkforceRoles({
      employeeId: '10000000-0000-4000-8000-000000000001',
      primaryRole: 'supervisor',
      reason: 'Promote to supervisor.',
      roleIds: ['20000000-0000-4000-8000-000000000001'],
    })

    expect(rpc).toHaveBeenCalledWith('set_employee_workforce_roles', {
      target_employee_id: '10000000-0000-4000-8000-000000000001',
      target_primary_role: 'supervisor',
      target_reason: 'Promote to supervisor.',
      target_role_ids: ['20000000-0000-4000-8000-000000000001'],
    })
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('target_permission_codes')
  })
})
