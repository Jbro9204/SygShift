import { describe, expect, it } from 'vitest'
import {
  employeeName,
  parseCallOffCoverageWorkspace,
  parseRequestCenterPayload,
  parseRequestCenterRecords,
  requestShiftLocation,
  requestShiftTitle,
  type RequestShift,
} from './requests'

const employee = {
  id: '10000000-0000-4000-8000-000000000001',
  first_name: 'Alexandra',
  last_name: 'Rivera',
  preferred_name: 'Alex',
}

const shift: RequestShift = {
  id: '20000000-0000-4000-8000-000000000001',
  starts_at: '2099-07-06T14:00:00.000Z',
  ends_at: '2099-07-06T22:00:00.000Z',
  time_zone: 'America/Denver',
  post: {
    id: '30000000-0000-4000-8000-000000000001',
    name: 'Main entrance',
    site: { id: '40000000-0000-4000-8000-000000000001', name: 'North Campus' },
  },
  event: null,
}

describe('request center contracts', () => {
  it('accepts the exact nested records returned by the database', () => {
    const parsed = parseRequestCenterRecords({
      timeOff: [{
        id: '50000000-0000-4000-8000-000000000001',
        employee_id: employee.id,
        starts_on: '2099-08-01',
        ends_on: '2099-08-01',
        partial_day_start: null,
        partial_day_end: null,
        reason: null,
        status: 'pending',
        decision_note: null,
        created_at: '2099-07-01T12:00:00.000Z',
        employee,
      }],
      shiftRequests: [],
      callOffs: [],
      assignments: [{
        id: '60000000-0000-4000-8000-000000000001',
        status: 'confirmed',
        shift,
      }],
    })

    expect(parsed.timeOff[0].status).toBe('pending')
    expect(parsed.assignments[0].shift.time_zone).toBe('America/Denver')
  })

  it('uses preferred names and clear location labels', () => {
    expect(employeeName(employee)).toBe('Alex Rivera')
    expect(requestShiftTitle(shift)).toBe('Main entrance')
    expect(requestShiftLocation(shift)).toBe('North Campus')
  })

  it('rejects request-center payloads that omit manager permissions', () => {
    expect(() => parseRequestCenterPayload({
      employeeId: employee.id,
      role: 'supervisor',
      timeOff: [],
      shiftRequests: [],
      callOffs: [],
      upcomingAssignments: [],
    })).toThrow()
  })

  it('normalizes a legacy null Flex flag without rejecting the coverage worklist', () => {
    const parsed = parseCallOffCoverageWorkspace({
      callOff: {
        id: '70000000-0000-4000-8000-000000000001',
        employeeId: employee.id,
        employeeName: 'Alex Rivera',
        reason: null,
        reportedAt: '2099-07-01T12:00:00.000Z',
        replacementNeeded: true,
      },
      shift: {
        id: shift.id,
        startsAt: shift.starts_at,
        endsAt: shift.ends_at,
        timeZone: shift.time_zone,
        title: 'Main entrance',
        location: 'North Campus',
        requiresArmed: false,
        isOpen: false,
      },
      coverageCase: null,
      candidates: [{
        id: '80000000-0000-4000-8000-000000000001',
        name: 'Regular Guard',
        employeeNumber: 'SYG-1008',
        employmentType: 'hourly',
        workClassification: null,
        isFlex: null,
        available: true,
        noOverlap: true,
        armedReady: true,
        overtimeMinutes: 0,
        requiresOvertimeApproval: false,
        eligible: true,
        recommended: true,
        blockReason: null,
      }],
      actions: [],
      attendancePolicy: { pointsActive: false, message: 'No point policy is active.' },
      patrolFallback: { available: true, message: 'Dispatch can review this site.' },
    })

    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0].isFlex).toBe(false)
  })

  it('replaces malformed coverage payload details with a safe user message', () => {
    expect(() => parseCallOffCoverageWorkspace({ candidates: [] }))
      .toThrow('The coverage details could not be verified. Refresh and try again.')
  })
})
