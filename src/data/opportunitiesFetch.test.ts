import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getOpenOpportunities, submitOpportunityRequest } from './opportunities'

const supabase = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => supabase }))

const employeeId = '40000000-0000-4000-8000-000000000001'
const openShift = {
  id: '10000000-0000-4000-8000-000000000001',
  starts_at: '2099-07-07T14:00:00.000Z',
  ends_at: '2099-07-07T22:00:00.000Z',
  time_zone: 'America/Denver',
  headcount_required: 1,
  requires_armed: false,
  is_overtime: false,
  notes: null,
  post: null,
  event: null,
  schedules: { status: 'published' },
  assignments: [],
  requests: [],
}

beforeEach(() => supabase.rpc.mockReset())

describe('guard openings fetch', () => {
  it('hides filled shifts but keeps a guard\'s existing request visible', async () => {
    supabase.rpc.mockResolvedValue({
      data: {
        employeeId,
        role: 'guard',
        opportunities: [
          openShift,
          {
            ...openShift,
            id: '10000000-0000-4000-8000-000000000002',
            assignments: [{ id: '20000000-0000-4000-8000-000000000001', status: 'assigned' }],
          },
          {
            ...openShift,
            id: '10000000-0000-4000-8000-000000000003',
            assignments: [{ id: '20000000-0000-4000-8000-000000000002', status: 'assigned' }],
            requests: [{ id: '30000000-0000-4000-8000-000000000001', employee_id: employeeId, status: 'pending' }],
          },
        ],
      },
      error: null,
    })

    const result = await getOpenOpportunities()
    expect(result.opportunities.map((item) => item.id)).toEqual([
      openShift.id,
      '10000000-0000-4000-8000-000000000003',
    ])
  })

  it('turns a permission failure into a useful guard-facing message', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'new row violates row-level security policy' } })

    await expect(submitOpportunityRequest(openShift.id)).rejects.toThrow('Contact Scheduling')
    expect(supabase.rpc).toHaveBeenCalledWith('submit_shift_request', { target_shift_id: openShift.id, request_note: null })
  })
})
