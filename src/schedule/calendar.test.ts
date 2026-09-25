import { describe, expect, it } from 'vitest'
import { buildScheduleCalendar } from './calendar'
import type { ScheduleShift } from '../data/schedule'

const shift: ScheduleShift = {
  id: '11111111-1111-4111-8111-111111111111',
  starts_at: '2026-09-22T14:00:00.000Z',
  ends_at: '2026-09-22T22:00:00.000Z',
  time_zone: 'America/Denver',
  time_zone_source: 'site',
  time_zone_employee_id: null,
  headcount_required: 1,
  requires_armed: true,
  is_open: false,
  is_overtime: false,
  notes: 'Bring radio, keys',
  post: { id: '22222222-2222-4222-8222-222222222222', name: 'Lobby', site: { id: '33333333-3333-4333-8333-333333333333', code: 'HQ', name: 'Headquarters' } },
  event: null,
  assignments: [{ id: '44444444-4444-4444-8444-444444444444', status: 'assigned', employee: { id: '55555555-5555-4555-8555-555555555555', first_name: 'Daron', last_name: 'Jones', preferred_name: null, employee_number: 'SYG-1001' } }],
}

describe('schedule calendar export', () => {
  it('creates an Apple and Google compatible calendar with stable shift identity', () => {
    const calendar = buildScheduleCalendar({ revision: 4, shifts: [shift], week_starts_on: '2026-09-20' })
    const unfoldedCalendar = calendar.replace(/\r\n /g, '')
    expect(calendar).toContain('BEGIN:VCALENDAR\r\n')
    expect(calendar).toContain('UID:11111111-1111-4111-8111-111111111111@sygshift.sygilant.us')
    expect(calendar).toContain('DTSTART:20260922T140000Z')
    expect(calendar).toContain('SUMMARY:Headquarters — Lobby')
    expect(unfoldedCalendar).toContain('Schedule time basis: Site Time — Mountain')
    expect(calendar).toContain('Bring radio\\, keys')
  })

  it('identifies employee-time exports while preserving the authoritative UTC instant', () => {
    const employeeShift: ScheduleShift = {
      ...shift,
      starts_at: '2026-09-22T13:00:00.000Z',
      ends_at: '2026-09-22T21:00:00.000Z',
      time_zone: 'America/New_York',
      time_zone_source: 'employee',
      time_zone_employee_id: shift.assignments[0].employee.id,
    }

    const calendar = buildScheduleCalendar(
      { revision: 5, shifts: [employeeShift], week_starts_on: '2026-09-20' },
      { employeeId: shift.assignments[0].employee.id },
    )
    const unfoldedCalendar = calendar.replace(/\r\n /g, '')

    expect(calendar).toContain('DTSTART:20260922T130000Z')
    expect(calendar).toContain('DTEND:20260922T210000Z')
    expect(unfoldedCalendar).toContain('Schedule time basis: Employee Time — Eastern')
  })

  it('limits a personal export to the signed-in employee', () => {
    const calendar = buildScheduleCalendar({ revision: 4, shifts: [shift], week_starts_on: '2026-09-20' }, { employeeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    expect(calendar).not.toContain('BEGIN:VEVENT')
  })
})
