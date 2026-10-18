import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const page = readFileSync(join(root, 'src', 'time', 'TimeCommandCenterPage.tsx'), 'utf8')
const model = readFileSync(join(root, 'src', 'time', 'timeCommandCenter.ts'), 'utf8')
const querySync = readFileSync(join(root, 'src', 'time', 'timeQuerySync.ts'), 'utf8')

describe('Time Command Center live-status boundary', () => {
  it('uses the current live roster instead of a selected-period attendance event', () => {
    expect(page).toContain('getLiveTimeRoster')
    expect(page).toContain("queryKey: ['live-time-roster']")
    expect(page).toContain('liveRoster: liveRosterQuery.data')
    expect(page).not.toContain('getTeamAttendanceSummary')
    expect(page).not.toContain('time-command-attendance-summary')

    expect(model).toContain('liveRoster?: LiveTimeRoster')
    expect(model).toContain('elapsedMinutes >= ACTIVE_CLOCK_IN_REVIEW_LIMIT_HOURS * 60')
    expect(model).not.toContain('attendanceSummary?: TeamAttendanceSummary')
    expect(model).not.toContain('latestEffectiveAt')
    expect(querySync).toContain("['live-time-roster']")
  })
})
