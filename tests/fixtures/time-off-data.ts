// Real Time Off components with deterministic, isolated fixture data. No live account is used.
export const isSupabaseConfigured = true

const params = new URLSearchParams(location.search)
const managerEmployeeId = '10000000-0000-4000-8000-000000000001'
const employeeId = '20000000-0000-4000-8000-000000000001'
const pendingRequestId = '30000000-0000-4000-8000-000000000001'
const selfRequestId = '30000000-0000-4000-8000-000000000002'
const approvedRequestId = '30000000-0000-4000-8000-000000000003'
const withdrawnRequestId = '30000000-0000-4000-8000-000000000004'
const activeRequestId = '30000000-0000-4000-8000-000000000005'
const affectedShift = {
  shiftId: '40000000-0000-4000-8000-000000000001',
  assignmentId: '50000000-0000-4000-8000-000000000001',
  workday: '2099-10-12',
  startsAt: '2099-10-12T14:00:00.000Z',
  endsAt: '2099-10-12T22:00:00.000Z',
  timeZone: 'America/Denver',
  siteCode: 'CENTRAL',
  siteName: 'Central Campus',
  postName: 'Front Desk',
  eventName: null,
  location: 'Central Campus',
  estimatedMinutes: 480,
}

const manager = {
  id: managerEmployeeId,
  first_name: 'Morgan',
  last_name: 'Manager',
  preferred_name: null,
}
const employee = {
  id: employeeId,
  first_name: 'Alex',
  last_name: 'Guard',
  preferred_name: null,
}

function timeOffRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: pendingRequestId,
    employee_id: employeeId,
    employee_number: 'SYG-1041',
    starts_on: '2099-10-12',
    ends_on: '2099-10-14',
    partial_day_start: null,
    partial_day_end: null,
    request_type: 'sick_time',
    employment_type_snapshot: 'hourly',
    pay_treatment: 'sick_policy',
    requested_minutes: 960,
    return_on: '2099-10-15',
    affected_shift_count: 1,
    affected_shifts: [affectedShift],
    reason: 'Medical appointment and recovery time.',
    status: 'pending',
    decision_note: null,
    decided_at: null,
    decided_by_name: null,
    updated_at: '2026-09-28T15:00:00.000Z',
    created_at: '2026-09-28T15:00:00.000Z',
    employee,
    ...overrides,
  }
}

let requestCenterAttempts = 0
let approvedCancellation: { canceledAt: string; canceledByName: string; note: string } | null = null
let earlyReturn: { endedAt: string; recordedAt: string; endedByName: string; note: string; timeZone: string } | null = null
let endLeaveAttempts = 0

export async function getRequestCenter() {
  requestCenterAttempts += 1
  if (params.get('scenario') === 'error' && requestCenterAttempts === 1) {
    throw new Error('fixture database socket 9917 unavailable')
  }

  const isManager = params.get('viewer') === 'manager'
  const sharedRequests = [
    timeOffRequest(),
    timeOffRequest({
      id: approvedRequestId,
      starts_on: '2099-11-02',
      ends_on: '2099-11-02',
      request_type: 'unpaid_time_off',
      pay_treatment: 'unpaid',
      requested_minutes: 480,
      return_on: '2099-11-03',
      reason: 'Family appointment.',
      status: approvedCancellation ? 'canceled' : 'approved',
      cancellation: approvedCancellation,
      cancellationContext: { phase: 'future', canCancel: !approvedCancellation, canEndNow: false, blockReason: null, startsAt: '2099-11-02T07:00:00Z', endsAt: '2099-11-03T07:00:00Z', timeZone: 'America/Denver' },
      decision_note: 'Coverage is confirmed.',
      decided_at: '2026-09-29T16:00:00.000Z',
      decided_by_name: 'Taylor Supervisor',
    }),
    timeOffRequest({
      id: withdrawnRequestId,
      starts_on: '2025-03-04',
      ends_on: '2025-03-04',
      request_type: 'unpaid_time_off',
      pay_treatment: 'unpaid',
      requested_minutes: 0,
      return_on: '2025-03-05',
      affected_shift_count: 0,
      affected_shifts: [],
      reason: 'Plans changed.',
      status: 'withdrawn',
      updated_at: '2025-02-11T17:00:00.000Z',
      created_at: '2025-02-10T17:00:00.000Z',
    }),
  ]
  if (params.get('scenario')?.startsWith('early-return')) {
    sharedRequests.push(timeOffRequest({
      id: activeRequestId, starts_on: '2026-11-06', ends_on: '2026-11-08', return_on: '2026-11-09',
      request_type: 'unpaid_time_off', pay_treatment: 'unpaid', status: 'approved',
      reason: 'Unused leave remainder.', decision_note: 'Original approved leave.', earlyReturn,
      cancellationContext: {
        phase: earlyReturn ? 'ended_early' : 'in_progress', canCancel: false, canEndNow: !earlyReturn,
        blockReason: null, startsAt: '2026-11-06T07:00:00Z', endsAt: '2026-11-09T07:00:00Z', timeZone: 'America/Denver',
      },
    }))
  }
  const managerOnlyRequests = [
    timeOffRequest({
      id: selfRequestId,
      employee_id: managerEmployeeId,
      employee_number: 'SYG-1000',
      starts_on: '2099-12-01',
      ends_on: '2099-12-02',
      request_type: 'paid_vacation',
      employment_type_snapshot: 'salary',
      pay_treatment: 'salary_paid_leave',
      requested_minutes: 960,
      return_on: '2099-12-03',
      reason: 'Personal travel.',
      employee: manager,
    }),
  ]

  return {
    employeeId: isManager ? managerEmployeeId : employeeId,
    role: isManager ? 'supervisor' : 'guard',
    permissions: { canManage: isManager },
    timeOffHistory: { managerHistoryLimit: isManager ? 100 : null, truncated: isManager },
    timeOff: (isManager ? [...sharedRequests, ...managerOnlyRequests] : sharedRequests).map((request) => (
      params.get('scenario') === 'context-unavailable' && request.id === approvedRequestId
        ? { ...request, cancellationContext: undefined, cancellationContextUnavailable: true,
          cancellationContextIssue: 'Action availability could not be verified for this historical request. Ask HR to review it before making changes.' }
        : request
    )),
    shiftRequests: [],
    callOffs: [],
    upcomingAssignments: [],
  }
}

export async function getSessionContextWithSignal() {
  const isManager = params.get('viewer') === 'manager'
  return { employeeId: isManager ? managerEmployeeId : employeeId, accessGeneration: 1,
    timeZone: 'America/Denver', permissions: isManager ? ['requests.manage'] : [] }
}

export async function getTimeOffRequestPage(input: { search?: string; status?: string; bucket?: string; limit?: number; cursor?: { asOf: string; id: string | null } | null; requestId?: string | null }) {
  const center = await getRequestCenter()
  const rows = params.get('scenario') === 'history'
    ? Array.from({ length: 121 }, (_, index) => timeOffRequest({ id: `30000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      status: 'approved', reason: `Historical approved request ${index + 1}`, cancellationContext: { phase: 'future', canCancel: true, canEndNow: false, blockReason: null, startsAt: '2099-11-02T07:00:00Z', endsAt: '2099-11-03T07:00:00Z', timeZone: 'America/Denver' } }))
    : center.timeOff
  const displayStatus = (request: typeof rows[number]) => 'earlyReturn' in request && request.earlyReturn ? 'ended_early' : request.status
  const upcoming = (request: typeof rows[number]) => !('earlyReturn' in request && request.earlyReturn) && request.ends_on >= '2026-11-12' && ['pending', 'approved'].includes(request.status)
  const closed = (request: typeof rows[number]) => ['declined', 'withdrawn', 'canceled', 'ended_early'].includes(displayStatus(request))
  const matching = rows.filter((request) => (!input.requestId || request.id === input.requestId)
    && (!input.search || [request.reason, request.decision_note, employeeName(request.employee)].join(' ').toLowerCase().includes(input.search)))
  const selected = matching.filter((request) => (!input.status || input.status === 'all' || displayStatus(request) === input.status)
    && (!input.bucket || input.bucket === 'all' || (input.bucket === 'pending' ? request.status === 'pending' : input.bucket === 'history' ? request.status !== 'pending' : input.bucket === 'upcoming' ? upcoming(request) : !upcoming(request))))
  const limit = input.limit ?? 20
  const offset = input.cursor?.id ? Number(input.cursor.id.slice(-12)) : 0
  const cursor = { version: 1, scope: 'a'.repeat(64), asOf: input.cursor?.asOf ?? '2026-11-12T20:00:00.123456Z', createdAt: offset ? '2026-11-01T00:00:00.000001Z' : null, id: input.cursor?.id ?? null }
  const hasMore = offset + limit < selected.length
  return { employeeId: center.employeeId, employeeTimeZone: 'America/Denver', permissions: center.permissions,
    items: selected.slice(offset, offset + limit),
    counts: { all: matching.length, pending: matching.filter((request) => request.status === 'pending').length,
      approved: matching.filter((request) => displayStatus(request) === 'approved').length,
      closed: matching.filter(closed).length, pastOrClosed: matching.filter((request) => request.ends_on < '2026-11-12' || closed(request)).length,
      upcoming: matching.filter(upcoming).length, history: matching.filter((request) => !upcoming(request)).length,
      declined: 0, withdrawn: 0, canceled: 0, endedEarly: 0 },
    page: { limit, total: selected.length, currentCursor: cursor,
      nextCursor: hasMore ? { ...cursor, createdAt: '2026-11-01T00:00:00.000001Z', id: `40000000-0000-4000-8000-${String(offset + limit).padStart(12, '0')}` } : null,
      hasMore, asOf: cursor.asOf }, filters: { search: input.search ?? '', status: input.status ?? 'all', bucket: input.bucket ?? 'all', requestId: input.requestId ?? null } }
}

export async function getTimeOffRequestContext() {
  return {
    employee: {
      id: employeeId,
      employeeNumber: 'SYG-1041',
      name: 'Alex Guard',
      employmentType: 'hourly',
      timeZone: 'America/Denver',
      status: 'active',
    },
    allowedTypes: ['sick_time', 'unpaid_time_off'],
    affectedShifts: [affectedShift],
    recentRequests: [],
  }
}

export async function getTimeOffReviewContext(requestId: string) {
  if (requestId !== pendingRequestId) throw new Error('The time-off request could not be found.')
  return {
    id: pendingRequestId,
    employee: { id: employeeId, employeeNumber: 'SYG-1041', name: 'Alex Guard', timeZone: 'America/Denver' },
    requestType: 'sick_time',
    employmentType: 'hourly',
    payTreatment: 'sick_policy',
    startsOn: '2099-10-12',
    endsOn: '2099-10-14',
    partialStart: null,
    partialEnd: null,
    returnOn: '2099-10-15',
    requestedMinutes: 960,
    reason: 'Medical appointment and recovery time.',
    status: 'pending',
    createdAt: '2026-09-28T15:00:00.000Z',
    affectedShifts: [affectedShift],
    decisionNote: null,
    decisionSnapshot: null,
  }
}

export async function submitTimeOffRequestV2() { return '60000000-0000-4000-8000-000000000001' }
export async function decideTimeOffRequestV2() {}
export async function withdrawTimeOff() {}
export async function cancelApprovedTimeOff(requestId: string, note: string) {
  if (requestId !== approvedRequestId || params.get('viewer') !== 'manager' || !note.trim()) throw new Error('Cancellation could not be confirmed.')
  approvedCancellation = { canceledAt: '2026-11-05T18:00:00Z', canceledByName: 'Morgan Manager', note: note.trim() }
}
export async function endApprovedTimeOffNow(requestId: string, note: string) {
  if (requestId !== activeRequestId || params.get('viewer') !== 'manager' || !note.trim()) throw new Error('Ending leave could not be confirmed.')
  endLeaveAttempts += 1
  if (params.get('scenario') === 'early-return-error' && endLeaveAttempts === 1) throw new Error('Ending leave could not be confirmed. Refresh the request status before trying again.')
  earlyReturn = { endedAt: '2026-11-06T20:05:00Z', recordedAt: '2026-11-06T20:05:00Z', endedByName: 'Morgan Manager', note: note.trim(), timeZone: 'America/Denver' }
}
export async function decideShiftRequest() {}
export async function reportCallOff() { return '70000000-0000-4000-8000-000000000001' }
export async function getCallOffCoverageWorkspace() { throw new Error('No call-off is selected in this fixture.') }
export async function resolveCallOffCoverage() {}

export function employeeName(value: { first_name: string; last_name: string; preferred_name: string | null }) {
  return `${value.preferred_name || value.first_name} ${value.last_name}`
}

export function requestShiftTitle(value: { title?: string | null; post?: { name: string } | null; event?: { name: string } | null }) {
  return value.post?.name ?? value.event?.name ?? value.title ?? 'Scheduled shift'
}

export function requestShiftLocation(value: { location?: string | null; post?: { site?: { name: string } | null } | null }) {
  return value.post?.site?.name ?? value.location ?? 'Location not listed'
}

export const fixtureIds = { pendingRequestId }
