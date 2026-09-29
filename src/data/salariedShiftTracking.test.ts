import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSalariedShiftWorkspace,
  parseSalariedShiftWorkspace,
  recordSalariedShiftOutcome,
  salariedShiftWorkspaceQueryKey,
} from './salariedShiftTracking'

const { rpc, withIdentityVerification } = vi.hoisted(() => ({
  rpc: vi.fn(),
  withIdentityVerification: vi.fn(async <T>(request: () => Promise<T>) => request()),
}))
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))
vi.mock('../lib/identityVerificationCoordinator', () => ({
  supabaseWithIdentityVerification: withIdentityVerification,
}))

const employee = {
  id: '10000000-0000-4000-8000-000000000001',
  employeeNumber: 'SYG-1001',
  displayName: 'Salary Employee',
  timeZone: 'America/New_York',
}
const assignment = {
  assignmentId: '20000000-0000-4000-8000-000000000001',
  shiftId: '30000000-0000-4000-8000-000000000001',
  employee,
  startsAt: '2026-09-28T13:00:00.000Z',
  endsAt: '2026-09-28T21:00:00.000Z',
  shiftTimeZone: 'America/New_York',
  employeeTimeZone: 'America/New_York',
  workday: '2026-09-28',
  scheduleStatus: 'published',
  assignmentStatus: 'confirmed',
  assignmentType: 'standard',
  siteCode: 'EAST',
  siteName: 'East Campus',
  postName: 'Main Desk',
  eventName: null,
  location: 'East Campus / Main Desk',
  presenceStatus: 'unconfirmed',
  workedAt: null,
  recordedNote: null,
  recordedBy: null,
  updatedAt: null,
  canMarkWorked: true,
  canVoid: false,
  blockingReason: null,
  history: [],
}
const workspace = {
  generatedAt: '2026-09-29T12:00:00.000Z',
  range: { startsOn: '2026-08-30', endsOn: '2026-10-13' },
  viewer: { employeeId: employee.id, timeZone: 'America/Denver', employmentType: 'salary', canManage: true },
  filters: { employeeId: null },
  summary: { total: 1, worked: 0, unconfirmed: 1 },
  employees: [employee],
  assignments: [assignment],
}
const requestId = '60000000-0000-4000-8000-000000000001'

describe('salaried shift tracking data boundary', () => {
  beforeEach(() => {
    rpc.mockReset()
    withIdentityVerification.mockReset()
    withIdentityVerification.mockImplementation(async <T>(request: () => Promise<T>) => request())
  })

  it('validates a shift-count workspace with only Worked or Unconfirmed states', () => {
    const parsed = parseSalariedShiftWorkspace(workspace)
    expect(parsed.assignments[0].presenceStatus).toBe('unconfirmed')
    expect(parsed.summary).toEqual({ total: 1, worked: 0, unconfirmed: 1 })
  })

  it('rejects unsupported attendance outcomes and malformed payloads', () => {
    expect(() => parseSalariedShiftWorkspace({
      ...workspace,
      assignments: [{ ...assignment, presenceStatus: 'did_not_work' }],
    })).toThrow('The shift confirmation details could not be verified. Refresh and try again.')
  })

  it('passes the explicit report range and employee filter to the read RPC', async () => {
    rpc.mockResolvedValue({ data: workspace, error: null })
    await getSalariedShiftWorkspace({ startsOn: '2026-09-01', endsOn: '2026-09-29', employeeId: employee.id })
    expect(rpc).toHaveBeenCalledWith('get_salaried_shift_workspace', {
      range_starts_on: '2026-09-01',
      range_ends_on: '2026-09-29',
      requested_employee_id: employee.id,
    })
    expect(salariedShiftWorkspaceQueryKey({ employeeId: employee.id })).toEqual(['salaried-shift-workspace', null, null, employee.id])
  })

  it('requires a meaningful reason before removing a Worked marker', async () => {
    await expect(recordSalariedShiftOutcome({
      assignmentId: assignment.assignmentId,
      presenceStatus: 'unconfirmed',
      requestId,
      note: 'mistake',
    })).rejects.toThrow('Enter at least 8 characters')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('records a Worked marker through the narrow RPC contract', async () => {
    rpc.mockResolvedValue({ data: {
      assignmentId: assignment.assignmentId,
      presenceStatus: 'worked',
      workedAt: '2026-09-29T12:15:00.000Z',
      updatedAt: '2026-09-29T12:15:00.000Z',
      action: 'recorded',
    }, error: null })
    await recordSalariedShiftOutcome({ assignmentId: assignment.assignmentId, presenceStatus: 'worked', requestId })
    expect(rpc).toHaveBeenCalledWith('record_salaried_shift_outcome', {
      target_assignment_id: assignment.assignmentId,
      requested_outcome: 'worked',
      outcome_note: null,
      request_id: requestId,
    })
  })

  it('keeps one idempotency key when identity verification retries the same save', async () => {
    const result = {
      data: {
        assignmentId: assignment.assignmentId,
        presenceStatus: 'worked',
        workedAt: '2026-09-29T12:15:00.000Z',
        updatedAt: '2026-09-29T12:15:00.000Z',
        action: 'unchanged',
      },
      error: null,
    }
    rpc.mockResolvedValue(result)
    withIdentityVerification.mockImplementation(async <T>(request: () => Promise<T>) => {
      await request()
      return request()
    })

    await recordSalariedShiftOutcome({ assignmentId: assignment.assignmentId, presenceStatus: 'worked', requestId })

    const firstArgs = rpc.mock.calls[0]?.[1] as { request_id?: string }
    const retryArgs = rpc.mock.calls[1]?.[1] as { request_id?: string }
    expect(firstArgs.request_id).toBe(requestId)
    expect(retryArgs.request_id).toBe(requestId)
  })
})
