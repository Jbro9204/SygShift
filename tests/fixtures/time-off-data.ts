// Real Time Off components with deterministic, isolated fixture data. No live account is used.
export const isSupabaseConfigured = true

const params = new URLSearchParams(location.search)
const managerEmployeeId = '10000000-0000-4000-8000-000000000001'
const employeeId = '20000000-0000-4000-8000-000000000001'
const pendingRequestId = '30000000-0000-4000-8000-000000000001'
const selfRequestId = '30000000-0000-4000-8000-000000000002'
const approvedRequestId = '30000000-0000-4000-8000-000000000003'
const withdrawnRequestId = '30000000-0000-4000-8000-000000000004'
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
      status: 'approved',
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
    timeOff: isManager ? [...sharedRequests, ...managerOnlyRequests] : sharedRequests,
    shiftRequests: [],
    callOffs: [],
    upcomingAssignments: [],
  }
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
