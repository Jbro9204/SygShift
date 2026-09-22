import { describe, expect, it } from 'vitest'
import { buildScheduleCalendar } from './calendar'
import type { ScheduleShift } from '../data/schedule'

const shift: ScheduleShift = {
  id: '11111111-1111-4111-8111-111111111111',
  starts_at: '2026-09-22T14:00:00.000Z',
  ends_at: '2026-09-22T22:00:00.000Z',
  time_zone: 'America/Denver',
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
    expect(calendar).toContain('BEGIN:VCALENDAR\r\n')
    expect(calendar).toContain('UID:11111111-1111-4111-8111-111111111111@sygshift.sygilant.us')
    expect(calendar).toContain('DTSTART:20260922T140000Z')
    expect(calendar).toContain('SUMMARY:Headquarters — Lobby')
    expect(calendar).toContain('Bring radio\\, keys')
  })

  it('limits a personal export to the signed-in employee', () => {
    const calendar = buildScheduleCalendar({ revision: 4, shifts: [shift], week_starts_on: '2026-09-20' }, { employeeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    expect(calendar).not.toContain('BEGIN:VEVENT')
  })
})
