import { describe, expect, it } from 'vitest'
import {
  employeeName,
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
})
