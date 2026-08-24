import { describe, expect, it } from 'vitest'
import type { TimeMaintenanceShiftOption } from '../data/timekeeping'
import { recommendedManualPunchTimestamp } from './manualPunchWorkday'

const overnightShift: TimeMaintenanceShiftOption = {
  assignedEmployees: [],
  endsAt: '2026-08-10T12:00:00.000Z',
  eventId: null,
  eventName: null,
  headcountRequired: 1,
  isOvertime: false,
  locationName: 'Cherry Tree',
  operationalDate: '2026-08-09',
  postId: '83000000-0000-4000-8000-000000000001',
  postName: 'Unarmed coverage',
  requiresArmed: false,
  scheduleRevision: 1,
  scheduleStatus: 'published',
  selectedEmployeeAssigned: true,
  shiftId: '83000000-0000-4000-8000-000000000003',
  siteCode: 'CHERRY',
  siteId: '83000000-0000-4000-8000-000000000002',
  siteName: 'Cherry Tree',
  startsAt: '2026-08-10T00:00:00.000Z',
  timeZone: 'America/Denver',
  workType: 'post',
}

describe('manual punch workday defaults', () => {
  it('uses the operational workday shift start for clock-in', () => {
    expect(recommendedManualPunchTimestamp(overnightShift, 'clock_in')).toEqual({
      date: '2026-08-09',
      time: '18:00',
    })
  })

  it('moves an overnight clock-out to the following calendar day', () => {
    expect(recommendedManualPunchTimestamp(overnightShift, 'clock_out')).toEqual({
      date: '2026-08-10',
      time: '06:00',
    })
  })

  it('does not invent a break time', () => {
    expect(recommendedManualPunchTimestamp(overnightShift, 'break_start')).toBeNull()
    expect(recommendedManualPunchTimestamp(overnightShift, 'break_end')).toBeNull()
  })
})
