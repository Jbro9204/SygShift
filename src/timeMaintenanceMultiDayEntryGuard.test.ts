/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TimeMaintenanceShiftOption } from './data/timekeeping'
import { zonedLocalDateTimeToUtc } from './data/timeOperations'
import { recommendedManualPunchTimestamp } from './time/manualPunchWorkday'

const timePage = readFileSync(join(process.cwd(), 'src', 'pages', 'TimePage.tsx'), 'utf8')

describe('Time Maintenance multi-day entry workflow', () => {
  it('lets the operator change workday without closing the employee timecard', () => {
    expect(timePage).toContain('aria-label="Previous workday"')
    expect(timePage).toContain('aria-label="Next workday"')
    expect(timePage).toContain('onChange={(event) => chooseAddWorkday(event.target.value)}')
    expect(timePage).not.toContain('disabled={Boolean(addShiftId)}')
  })

  it('clears stale occurrence state and synchronizes the next punch date', () => {
    expect(timePage).toContain('setAddOperationalDate(nextWorkday)')
    expect(timePage).toContain('setAddDate(nextWorkday)')
    expect(timePage).toContain('setAddShiftId(null)')
    expect(timePage).toContain('setAddLocationPostId(null)')
    expect(timePage).toContain('addMutation.reset()')
    expect(timePage).toContain('Add next workday')
  })

  it('retains the separate overnight punch-date recommendation', () => {
    expect(timePage).toContain('applyRecommendedAddTime(selectedShift, addKind)')
    expect(timePage).toContain('recommendedManualPunchTimestamp({ ...option, timeZone: OPERATIONAL_TIME_ZONE }, kind)')
    expect(timePage).toContain("setAddOriginalInstant(recommended ? (kind === 'clock_in' ? option.startsAt : option.endsAt) : undefined)")
    expect(timePage).toContain('setAddDate(recommended.date)')
    expect(timePage).toContain('setAddTime(recommended.time)')
    expect(timePage).toContain('For an overnight shift, use the date the shift starts.')
  })

  it('keeps the Mountain workday recommendation separate from exact overnight boundary evidence', () => {
    const shift: TimeMaintenanceShiftOption = {
      assignedEmployees: [], startsAt: '2026-11-01T04:00:12.345Z', endsAt: '2026-11-01T13:00:47.125Z',
      eventId: null, eventName: null, headcountRequired: 1, isOvertime: false,
      locationName: 'DST Test Site', operationalDate: '2026-10-31', postId: null, postName: 'Test post',
      requiresArmed: false, scheduleRevision: 1, scheduleStatus: 'published', selectedEmployeeAssigned: true,
      shiftId: 'a3000000-0000-4000-8000-000000000001', siteCode: 'DST', siteId: null,
      siteName: 'DST Test Site', timeZone: 'America/New_York', workType: 'post',
    }
    const formShift = { ...shift, timeZone: 'America/Denver' }
    expect(recommendedManualPunchTimestamp(formShift, 'clock_in')).toEqual({ date: '2026-10-31', time: '22:00' })
    expect(recommendedManualPunchTimestamp(formShift, 'clock_out')).toEqual({ date: '2026-11-01', time: '06:00' })
    expect(zonedLocalDateTimeToUtc('2026-11-01T06:00', formShift.timeZone, {
      originalInstant: shift.endsAt, originalTimeZone: formShift.timeZone,
    })).toBe(shift.endsAt)
    expect(recommendedManualPunchTimestamp(formShift, 'break_start')).toBeNull()
  })
})
