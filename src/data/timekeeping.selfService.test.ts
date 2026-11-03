import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOwnTimekeepingReview, getTimekeepingReview } from './timekeeping'
import { cancelIdentityVerification, clearIdentityVerificationSession, subscribeToIdentityVerification } from '../lib/identityVerificationCoordinator'

const selected = vi.hoisted(() => ({ client: null as unknown as SupabaseClient }))
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => selected.client }))
vi.mock('../lib/sharedIdentitySession', () => ({ getSharedIdentitySessionScope: () => null }))

const employeeId = '10000000-0000-4000-8000-000000000001'
const otherEmployeeId = '10000000-0000-4000-8000-000000000002'
const shiftId = '20000000-0000-4000-8000-000000000001'
const fromDate = '2026-10-25'
const throughDate = '2026-11-07'

function canonicalRow(overrides: Record<string, unknown> = {}) {
  return {
    rowKind: 'time_event', employeeId, username: 'syntheticguard', employeeName: 'Synthetic Guard',
    role: 'guard', employmentType: 'hourly', shiftId, operationalDate: '2026-10-31',
    weekStartsOn: '2026-10-25', weekEndsOn: '2026-10-31',
    siteName: 'Synthetic Site', siteCode: 'TEST', postName: 'Synthetic Post', eventName: null, locationName: 'Synthetic Site',
    scheduledStartsAt: '2026-11-01T02:00:00.000Z', scheduledEndsAt: '2026-11-01T11:00:00.000Z', timeZone: 'America/Denver',
    firstClockIn: '2026-11-01T02:00:00.000Z', lastClockOut: '2026-11-01T11:00:00.000Z',
    grossMinutes: 540, breakMinutes: 30, paidMinutes: 510, regularMinutes: 450, overtimeMinutes: 60,
    salaryDefaultMinutes: 0, timeOffMinutes: 0, eventCount: 4, requiresArmed: false, isOvertime: true,
    payrollReady: true, exceptionCodes: [], payrollCategory: 'ep', payrollCategoryLabel: 'EP', payrollCategoryResolved: true,
    payrollOccurrenceKey: `shift:${shiftId}:employee:${employeeId}`, payrollOccurrenceFingerprint: 'a'.repeat(64),
    crossesPayrollBoundary: true, payrollAssignmentStatus: 'derived', payrollAssignmentSource: 'scheduled_shift',
    eventTimeline: [{
      id: '30000000-0000-4000-8000-000000000001', kind: 'clock_in', shiftId,
      recordedAt: '2026-11-01T04:45:00.000Z', effectiveAt: '2026-11-01T02:00:00.000Z',
    }, {
      id: '30000000-0000-4000-8000-000000000002', kind: 'clock_out', shiftId,
      recordedAt: '2026-11-01T11:00:00.000Z', effectiveAt: '2026-11-01T11:00:00.000Z',
    }],
    workedSegments: [{ segmentNumber: 1, startsAt: '2026-11-01T02:00:00.000Z', endsAt: '2026-11-01T11:00:00.000Z', paidMinutes: 510, breakMinutes: 30 }],
    unpaidGaps: [], unpaidGapMinutes: 0,
    payrollWeekAllocations: [{
      allocationKey: 'synthetic-before-boundary', weekStartsOn: '2026-10-25', weekEndsOn: '2026-10-31',
      grossMinutes: 240, breakMinutes: 30, unpaidGapMinutes: 0, paidMinutes: 210, regularMinutes: 210, overtimeMinutes: 0,
      regularCategoryMinutes: 0, epMinutes: 210, truepMinutes: 0, unclassifiedCategoryMinutes: 0,
    }, {
      allocationKey: 'synthetic-after-boundary', weekStartsOn: '2026-11-01', weekEndsOn: '2026-11-07',
      grossMinutes: 300, breakMinutes: 0, unpaidGapMinutes: 0, paidMinutes: 300, regularMinutes: 240, overtimeMinutes: 60,
      regularCategoryMinutes: 0, epMinutes: 300, truepMinutes: 0, unclassifiedCategoryMinutes: 0,
    }],
    ...overrides,
  }
}

function canonicalPayload(rows = [canonicalRow()]) {
  return {
    serverTimestamp: '2026-11-03T00:37:00.000Z', fromDate, throughDate, operationalTimeZone: 'America/Denver',
    summary: { rowCount: rows.length, readyCount: rows.length, exceptionCount: 0, pendingCorrectionCount: 0, grossMinutes: 540, paidMinutes: 510 },
    rows, pendingCorrections: [], exceptionResolutionHistory: [],
  }
}

function transport(role = 'guard', aal = 'aal1') {
  const authSessionId = crypto.randomUUID()
  const session = {
    user: { id: employeeId, factors: [], app_metadata: { role }, user_metadata: {} },
    access_token: `synthetic.${btoa(JSON.stringify({ sub: employeeId, session_id: authSessionId, aal }))}.not-a-real-token`,
  } as unknown as Session
  const rpc = vi.fn(async (_name: string, _parameters: Record<string, unknown>) => ({ data: canonicalPayload() as unknown, error: null as { code: string; message: string } | null }))
  const getSession = vi.fn(async () => ({ data: { session }, error: null }))
  const client = {
    rpc,
    auth: { getSession, onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  } as unknown as SupabaseClient
  selected.client = client
  return { rpc, getSession }
}

beforeEach(() => clearIdentityVerificationSession())
afterEach(() => clearIdentityVerificationSession())

describe('canonical own-time access stays separate from protected payroll review', () => {
  it.each(['guard', 'supervisor', 'admin'])('loads only the canonical own-time RPC without a checkpoint for %s', async (role) => {
    const local = transport(role, 'aal1')
    const checkpoints: boolean[] = []
    const unsubscribe = subscribeToIdentityVerification((required) => { if (required) checkpoints.push(required) })
    try {
      const result = await getOwnTimekeepingReview({ employeeId, fromDate, throughDate })

      expect(local.rpc).toHaveBeenCalledExactlyOnceWith('get_timekeeping_review', { target_from_date: fromDate, target_through_date: throughDate })
      expect(result.rows).toHaveLength(1)
      expect(result.summary.paidMinutes).toBe(510)
      expect(result.fromDate).toBe(fromDate)
      expect(result.throughDate).toBe(throughDate)
      expect(checkpoints).toEqual([])
    } finally { unsubscribe() }
  })

  it('preserves adjusted overnight/DST instants, breaks, weekly allocations and payroll category totals', async () => {
    const local = transport()
    const rows = [
      canonicalRow(),
      canonicalRow({ grossMinutes: 65, breakMinutes: 0, paidMinutes: 65, regularMinutes: 65, overtimeMinutes: 0, payrollCategory: 'truep', payrollCategoryLabel: 'TRUEP', payrollWeekAllocations: undefined }),
      canonicalRow({ grossMinutes: 20, breakMinutes: 0, paidMinutes: 20, regularMinutes: 20, overtimeMinutes: 0, payrollCategory: null, payrollCategoryResolved: false, payrollReady: false, payrollWeekAllocations: undefined }),
      canonicalRow({ grossMinutes: 15, breakMinutes: 0, paidMinutes: 15, regularMinutes: 15, overtimeMinutes: 0, payrollCategory: undefined, payrollCategoryLabel: undefined, payrollWeekAllocations: undefined }),
      canonicalRow({ employeeId: otherEmployeeId, paidMinutes: 999, payrollWeekAllocations: undefined }),
    ]
    local.rpc.mockResolvedValue({ data: canonicalPayload(rows), error: null })

    const result = await getOwnTimekeepingReview({ employeeId, fromDate, throughDate })

    expect(result.rows).toHaveLength(4)
    expect(result.rows.every((row) => row.employeeId === employeeId)).toBe(true)
    expect(result.rows[0]).toMatchObject({ firstClockIn: '2026-11-01T02:00:00.000Z', lastClockOut: '2026-11-01T11:00:00.000Z', grossMinutes: 540, breakMinutes: 30, paidMinutes: 510, regularMinutes: 450, overtimeMinutes: 60 })
    expect(result.rows[0]?.eventTimeline[0]).toMatchObject({ recordedAt: '2026-11-01T04:45:00.000Z', effectiveAt: '2026-11-01T02:00:00.000Z' })
    expect(result.rows[0]?.payrollWeekAllocations).toEqual(rows[0]?.payrollWeekAllocations)
    expect(result.summary).toMatchObject({ rowCount: 4, readyCount: 3, exceptionCount: 1, grossMinutes: 640, paidMinutes: 610, regularMinutes: 550, overtimeMinutes: 60, regularCategoryMinutes: 15, epMinutes: 510, truepMinutes: 65, unclassifiedCategoryMinutes: 20 })
    expect(result.rows[2]).toMatchObject({ payrollCategory: null, payrollCategoryResolved: false })
    expect(result.rows[3]).toMatchObject({ payrollCategory: 'regular', payrollCategoryLabel: 'Regular' })
  })

  it('does not send a requested employee ID as an authority to read another employee', async () => {
    const local = transport()
    const result = await getOwnTimekeepingReview({ employeeId: otherEmployeeId, fromDate, throughDate })

    expect(local.rpc).toHaveBeenCalledExactlyOnceWith('get_timekeeping_review', { target_from_date: fromDate, target_through_date: throughDate })
    expect(result.rows).toEqual([])
    expect(result.summary.paidMinutes).toBe(0)
  })

  it.each(['42501', '57014'])('returns a failed own-time read once, without automatically opening MFA or falling back: %s', async (code) => {
    const local = transport()
    local.rpc.mockResolvedValue({ data: null, error: { code, message: 'MFA verification or permission denied by the canonical server.' } })
    const checkpoints: boolean[] = []
    const unsubscribe = subscribeToIdentityVerification((required) => { if (required) checkpoints.push(required) })
    try {
      await expect(getOwnTimekeepingReview({ employeeId, fromDate, throughDate })).rejects.toMatchObject({ code })
      expect(local.rpc).toHaveBeenCalledTimes(1)
      expect(checkpoints).toEqual([])
    } finally { unsubscribe() }
  })

  it.each(['supervisor', 'admin'])('retains the canonical v2 payroll endpoint for an assured %s team review', async (role) => {
    const local = transport(role, 'aal2')
    const result = await getTimekeepingReview({ fromDate, throughDate })

    expect(local.rpc).toHaveBeenCalledExactlyOnceWith('get_timekeeping_review_v2', { target_from_date: fromDate, target_through_date: throughDate })
    expect(result.rows[0]?.paidMinutes).toBe(510)
  })

  it.each(['guard', 'supervisor', 'admin'])('keeps genuine payroll MFA denial protected for %s and never retries through the own endpoint', async (role) => {
    const local = transport(role, 'aal1')
    local.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'MFA verification is required to load payroll review details.' } })
    let requestId: string | null = null
    const unsubscribe = subscribeToIdentityVerification((required, _context, id) => { if (required) requestId = id })
    const pending = getTimekeepingReview({ fromDate, throughDate })
    const rejected = expect(pending).rejects.toMatchObject({ code: '42501' })
    try {
      await vi.waitFor(() => expect(requestId).not.toBeNull())
      cancelIdentityVerification(requestId ?? undefined)
      await rejected
      expect(local.rpc).toHaveBeenCalledExactlyOnceWith('get_timekeeping_review_v2', { target_from_date: fromDate, target_through_date: throughDate })
    } finally { unsubscribe() }
  })

  it('shares the unchanged payload normalization with payroll and retains supplied work-type fields', async () => {
    const local = transport('admin', 'aal2')
    const payload = canonicalPayload([canonicalRow({ workType: 'training', workTypeLabel: 'Paid training', payCode: 'TRAIN', mixedWorkTypes: false })])
    local.rpc.mockResolvedValue({ data: payload, error: null })
    const own = await getOwnTimekeepingReview({ employeeId, fromDate, throughDate })
    const team = await getTimekeepingReview({ fromDate, throughDate })

    expect(own.rows).toEqual(team.rows)
    expect(own.rows[0]).toMatchObject({ workType: 'training', workTypeLabel: 'Paid training', payCode: 'TRAIN', paidMinutes: 510 })
  })

  it('retains existing parser defaults when the base endpoint omits optional display-only work-type enrichment', async () => {
    transport()
    const own = await getOwnTimekeepingReview({ employeeId, fromDate, throughDate })

    expect(own.rows[0]).toMatchObject({ workType: 'post', workTypeLabel: 'Worked Time', paidMinutes: 510, grossMinutes: 540, breakMinutes: 30 })
  })
})
