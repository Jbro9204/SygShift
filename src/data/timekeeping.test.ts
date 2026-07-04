import { describe, expect, it } from 'vitest'
import {
  activeTimeState,
  nextTimeEventKinds,
  parseTimekeepingDashboard,
  parseTimekeepingEvent,
} from './timekeeping'

describe('timekeeping validation', () => {
  it('accepts the protected dashboard contract', () => {
    const dashboard = parseTimekeepingDashboard({
      serverTimestamp: '2026-07-04T15:00:00.000Z',
      operationalDate: '2026-07-04',
      operationalTimeZone: 'America/Denver',
      employee: {
        id: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        displayName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
      },
      lastEvent: null,
      eligibleShifts: [],
      recentEvents: [],
      pendingCorrectionCount: 0,
    })

    expect(dashboard.employee.username).toBe('jbrown')
    expect(activeTimeState(dashboard.lastEvent)).toBe('off_clock')
  })

  it('maps the last punch to the correct employee state', () => {
    expect(activeTimeState(parseTimekeepingEvent({
      id: '73000000-0000-4000-8000-000000000002',
      kind: 'clock_in',
      shiftId: null,
      recordedAt: '2026-07-04T15:00:00.000Z',
      source: 'web',
    }))).toBe('working')

    expect(activeTimeState(parseTimekeepingEvent({
      id: '73000000-0000-4000-8000-000000000003',
      kind: 'break_start',
      shiftId: null,
      recordedAt: '2026-07-04T17:00:00.000Z',
      source: 'web',
    }))).toBe('on_break')

    expect(activeTimeState(parseTimekeepingEvent({
      id: '73000000-0000-4000-8000-000000000004',
      kind: 'clock_out',
      shiftId: null,
      recordedAt: '2026-07-04T23:00:00.000Z',
      source: 'web',
    }))).toBe('off_clock')
  })

  it('limits next actions to valid punch sequences', () => {
    expect(nextTimeEventKinds('off_clock')).toEqual(['clock_in'])
    expect(nextTimeEventKinds('working')).toEqual(['break_start', 'clock_out'])
    expect(nextTimeEventKinds('on_break')).toEqual(['break_end'])
  })
})
