import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schedulePage = readFileSync('src/pages/SchedulePage.tsx', 'utf8')
const scheduleData = readFileSync('src/data/schedule.ts', 'utf8')
const personalScheduleDate = readFileSync('src/schedule/personalScheduleDate.ts', 'utf8')
const copyMigration = readFileSync('supabase/migrations/20260910165913_schedule_week_copy_dispatch_overlap_repair.sql', 'utf8')

describe('scheduler time-basis guardrails', () => {
  it('loads source metadata without making older payloads fail', () => {
    expect(scheduleData).toContain("time_zone_source: z.enum(['site', 'employee', 'explicit']).optional()")
    expect(scheduleData).toContain('time_zone_employee_id: z.string().uuid().nullable().optional()')
  })

  it('labels create and edit inputs and shows employee/site conversions', () => {
    expect(schedulePage).toContain('scheduleTimeBasisLabel(openShiftTimeBasisSource, openShiftTimeBasisZone)')
    expect(schedulePage).toContain('Open and multi-person coverage uses Site Time.')
    expect(schedulePage).toContain('Reassigning it keeps the same stored start and end instant')
    expect(schedulePage).toContain('scheduleTimeBasisLabel(shift.time_zone_source, shift.time_zone)')
    expect(schedulePage).toContain('ScheduleTimeBasisPanel')
  })

  it('preserves shift source authority when a schedule week is copied', () => {
    expect(copyMigration).toContain('source_shift.time_zone_source')
    expect(copyMigration).toContain('source_shift.time_zone_employee_id')
  })

  it('uses the profile-local calendar date for personal schedule week controls only', () => {
    expect(schedulePage).toContain("queryKey: ['maintenance-status']")
    expect(schedulePage).toContain('refetchInterval: 30_000')
    expect(schedulePage).toContain('serverTime: scheduleServerTimeQuery.data?.serverTime')
    expect(schedulePage).toContain('employeeOnlySchedule && personalScheduleDateReady')
    expect(schedulePage).toContain('personalScheduleToday && personalScheduleDateReady')
    expect(personalScheduleDate).toContain('scheduleCalendarDateInTimeZone(serverTime, timeZone)')
    expect(personalScheduleDate).toContain('setAnchoredBasisKey(basisKey)')
    expect(personalScheduleDate).not.toContain('new Date()')
    expect(schedulePage).toContain('onJumpToWeek(startOfWeek(today, { weekStartsOn: 0 }))')
    expect(schedulePage).toContain('const today = useMemo(() => operationalToday(), [])')
  })
})
