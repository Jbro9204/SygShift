import type { ScheduleShift, WeeklySchedule } from '../data/schedule'

function escapeCalendarText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

function utcCalendarDate(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function foldCalendarLine(line: string): string {
  const parts: string[] = []
  let remaining = line
  while (new TextEncoder().encode(remaining).length > 73) {
    let cut = Math.min(73, remaining.length)
    while (cut > 1 && new TextEncoder().encode(remaining.slice(0, cut)).length > 73) cut -= 1
    parts.push(remaining.slice(0, cut))
    remaining = ` ${remaining.slice(cut)}`
  }
  parts.push(remaining)
  return parts.join('\r\n')
}

function shiftTitle(shift: ScheduleShift): string {
  const location = shift.post?.site.name ?? shift.event?.site?.name ?? shift.event?.location_name ?? 'Scheduled shift'
  const post = shift.post?.name ?? shift.event?.name ?? ''
  return post && post !== location ? `${location} — ${post}` : location
}

function shiftLocation(shift: ScheduleShift): string {
  return shift.event?.location_name ?? shift.post?.site.name ?? shift.event?.site?.name ?? ''
}

export function buildScheduleCalendar(
  schedule: Pick<WeeklySchedule, 'revision' | 'shifts' | 'week_starts_on'>,
  options: { employeeId?: string | null; calendarName?: string } = {},
): string {
  const shifts = options.employeeId
    ? schedule.shifts.filter((shift) => shift.assignments.some((assignment) => assignment.employee.id === options.employeeId))
    : schedule.shifts
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SygShift//Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeCalendarText(options.calendarName ?? 'SygShift Schedule')}`,
  ]
  for (const shift of shifts) {
    const assignees = shift.assignments.map((assignment) => [assignment.employee.preferred_name ?? assignment.employee.first_name, assignment.employee.last_name].filter(Boolean).join(' ')).join(', ')
    const description = [
      shift.requires_armed ? 'Armed assignment' : 'Unarmed assignment',
      assignees ? `Assigned: ${assignees}` : 'Open assignment',
      `Schedule time zone: ${shift.time_zone}`,
      shift.notes?.trim() || null,
    ].filter(Boolean).join('\n')
    lines.push(
      'BEGIN:VEVENT',
      `UID:${shift.id}@sygshift.sygilant.us`,
      `DTSTAMP:${utcCalendarDate(new Date().toISOString())}`,
      `DTSTART:${utcCalendarDate(shift.starts_at)}`,
      `DTEND:${utcCalendarDate(shift.ends_at)}`,
      `SEQUENCE:${schedule.revision}`,
      `SUMMARY:${escapeCalendarText(`${shift.coverage?.marker === 'call_off' ? '[CALL OFF] ' : shift.coverage?.marker === 'coverage' ? '[COVERAGE] ' : ''}${shiftTitle(shift)}`)}`,
      `DESCRIPTION:${escapeCalendarText(description)}`,
      `LOCATION:${escapeCalendarText(shiftLocation(shift))}`,
      ...(shift.coverage?.marker === 'call_off' ? ['STATUS:CANCELLED'] : ['STATUS:CONFIRMED']),
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldCalendarLine).join('\r\n') + '\r\n'
}

export function downloadScheduleCalendar(
  schedule: Pick<WeeklySchedule, 'revision' | 'shifts' | 'week_starts_on'>,
  options: { employeeId?: string | null; calendarName?: string; filename?: string } = {},
): void {
  const content = buildScheduleCalendar(schedule, options)
  const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = options.filename ?? `sygshift-schedule-${schedule.week_starts_on}.ics`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
