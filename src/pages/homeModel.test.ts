import { describe, expect, it } from 'vitest'
import type { ScheduleShift } from '../data/schedule'
import { boundedHomeItems, greetingName, greetingPeriod, homeModeForRole, sundayWeekStart, summarizeTodayCoverage } from './homeModel'

function shift(overrides: Partial<ScheduleShift> = {}): ScheduleShift {
  return {
    assignments: [],
    ends_at: '2026-08-28T18:00:00-06:00',
    event: null,
    headcount_required: 2,
    id: '00000000-0000-4000-8000-000000000001',
    is_open: true,
    is_overtime: false,
    notes: null,
    post: null,
    requires_armed: false,
    starts_at: '2026-08-28T08:00:00-06:00',
    time_zone: 'America/Denver',
    ...overrides,
  }
}

describe('Home presentation model', () => {
  it('uses the Operations Home only for supervisors and admins', () => {
    expect(homeModeForRole('guard')).toBe('employee')
    expect(homeModeForRole('dispatcher')).toBe('employee')
    expect(homeModeForRole('scheduler')).toBe('employee')
    expect(homeModeForRole('recruiting_licensing')).toBe('employee')
    expect(homeModeForRole('supervisor')).toBe('operations')
    expect(homeModeForRole('admin')).toBe('operations')
  })

  it('builds a concise greeting with safe fallbacks', () => {
    expect(greetingName('Jordan Brown', 'jbrown')).toBe('Jordan')
    expect(greetingName(' ', 'jbrown')).toBe('jbrown')
    expect(greetingName(null, null)).toBe('there')
    expect(greetingPeriod(new Date('2026-08-28T14:00:00Z'))).toBe('morning')
    expect(greetingPeriod(new Date('2026-08-28T20:00:00Z'))).toBe('afternoon')
    expect(greetingPeriod(new Date('2026-08-29T02:00:00Z'))).toBe('evening')
  })

  it('finds the Sunday week boundary without using the computer local time zone', () => {
    expect(sundayWeekStart('2026-08-28')).toBe('2026-08-23')
    expect(sundayWeekStart('2026-08-23')).toBe('2026-08-23')
  })

  it('caps Home previews without changing their underlying records', () => {
    expect(boundedHomeItems([1, 2, 3, 4], 3)).toEqual([1, 2, 3])
  })

  it('summarizes only shifts that begin on the selected operational day', () => {
    const summary = summarizeTodayCoverage([
      shift({ assignments: [{
        employee: {
          employee_number: 'SYG-1001',
          first_name: 'Jordan',
          id: '00000000-0000-4000-8000-000000000002',
          last_name: 'Brown',
          preferred_name: null,
        },
        id: '00000000-0000-4000-8000-000000000003',
        status: 'assigned',
      }] }),
      shift({
        id: '00000000-0000-4000-8000-000000000004',
        starts_at: '2026-08-29T08:00:00-06:00',
      }),
    ], '2026-08-28')

    expect(summary.required).toBe(2)
    expect(summary.assigned).toBe(1)
    expect(summary.open).toBe(1)
    expect(summary.shifts).toHaveLength(1)
  })
})
