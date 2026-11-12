import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn() }))
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc: mocks.rpc }) }))
import { getTimeOffRequestPage, type TimeOffPageCursor } from './requests'

const employeeId = '10000000-0000-4000-8000-000000000001'
const requestId = '20000000-0000-4000-8000-000000000001'
const cursor: TimeOffPageCursor = { version: 1, scope: 'a'.repeat(64), asOf: '2026-11-12T20:00:00.123456Z', createdAt: null, id: null }
function payload() {
  return { employeeId, employeeTimeZone: 'America/New_York', permissions: { canManage: true },
    items: [{ id: requestId, employeeId, employeeName: 'Test Guard', employeeNumber: 'T-1',
      startsOn: '2099-11-12', endsOn: '2099-11-13', partialDayStart: null, partialDayEnd: null,
      status: 'approved', reason: 'Saved history', decisionNote: 'Original approval', createdAt: '2026-11-12T19:00:00.000001Z' }],
    counts: { all: 102, pending: 1, approved: 101, declined: 0, withdrawn: 0, canceled: 0, endedEarly: 0, closed: 0, pastOrClosed: 100, upcoming: 2, history: 100 },
    page: { limit: 20, total: 101, currentCursor: { ...cursor }, nextCursor: { ...cursor, createdAt: '2026-11-12T19:00:00.000001Z', id: requestId }, hasMore: true, asOf: cursor.asOf },
    filters: { search: '', status: 'all', bucket: 'all', requestId: null as string | null } }
}
beforeEach(() => { mocks.rpc.mockReset().mockResolvedValue({ data: payload(), error: null }); mocks.abortSignal.mockReset() })

describe('time-off server page boundary', () => {
  it('uses the read-only page RPC and keeps exact server counts and microsecond cursors', async () => {
    const page = await getTimeOffRequestPage({ employeeId })
    expect(mocks.rpc).toHaveBeenCalledWith('get_time_off_request_page_v1', { target_search: null, target_status: 'all', target_bucket: 'all', target_limit: 20, target_cursor: null, target_request_id: null })
    expect(page.counts.all).toBe(102)
    expect(page.page.nextCursor?.createdAt).toBe('2026-11-12T19:00:00.000001Z')
    expect(page.items[0]).toMatchObject({ employee_id: employeeId, decision_note: 'Original approval', starts_on: '2099-11-12' })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('keeps exact request lookup separate from search and paging', async () => {
    const data = payload()
    data.page = { ...data.page, limit: 1, total: 1, hasMore: false, nextCursor: null as never }
    data.filters.requestId = requestId
    mocks.rpc.mockResolvedValue({ data, error: null })
    expect((await getTimeOffRequestPage({ employeeId, requestId, limit: 1 })).items).toHaveLength(1)
    expect(mocks.rpc).toHaveBeenCalledWith('get_time_off_request_page_v1', expect.objectContaining({ target_request_id: requestId, target_cursor: null }))
  })

  it.each(['employee', 'search', 'status', 'bucket', 'limit', 'request', 'cursor', 'counts'] as const)('rejects a mismatched %s response instead of displaying another page', async (kind) => {
    const data = payload()
    let suppliedCursor: TimeOffPageCursor | undefined
    if (kind === 'employee') data.employeeId = requestId
    if (kind === 'search') data.filters.search = 'another search'
    if (kind === 'status') data.filters.status = 'approved'
    if (kind === 'bucket') data.filters.bucket = 'history'
    if (kind === 'limit') data.page.limit = 50
    if (kind === 'request') data.filters.requestId = requestId
    if (kind === 'cursor') suppliedCursor = { ...cursor, createdAt: '2026-11-12T19:30:00.000002Z', id: employeeId }
    if (kind === 'counts') data.page.total = -1
    mocks.rpc.mockResolvedValue({ data, error: null })
    await expect(getTimeOffRequestPage({ employeeId, cursor: suppliedCursor })).rejects.toThrow('could not be verified')
  })

  it('does not use the capped legacy reader or expose the raw database error', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'private.secret_table denied token=secret' } })
    await expect(getTimeOffRequestPage({ employeeId })).rejects.toThrow('saved requests have not changed')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('retains a historical record while explicitly disabling unverifiable action context', async () => {
    const data = payload()
    const invalid = { ...data.items[0], cancellationContextUnavailable: true,
      cancellationContextIssue: 'Action availability could not be verified for this historical request. Ask HR to review it before making changes.',
      cancellationContext: { phase: 'future', canCancel: true, canEndNow: true, blockReason: null,
        startsAt: '2099-11-12T00:00:00Z', endsAt: '2099-11-14T00:00:00Z', timeZone: 'America/Denver' } }
    mocks.rpc.mockResolvedValue({ data: { ...data, items: [invalid] }, error: null })
    const result = await getTimeOffRequestPage({ employeeId })
    expect(result.items[0].id).toBe(requestId)
    expect(result.items[0].cancellationContextUnavailable).toBe(true)
    expect(result.items[0].cancellationContext).toBeUndefined()
  })

  it('attaches cancellation to the exact read without creating a write', async () => {
    mocks.abortSignal.mockResolvedValue({ data: payload(), error: null })
    mocks.rpc.mockReturnValue({ abortSignal: mocks.abortSignal })
    const controller = new AbortController()
    await getTimeOffRequestPage({ employeeId, signal: controller.signal })
    expect(mocks.abortSignal).toHaveBeenCalledWith(controller.signal)
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
})
