/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EarlyClockInBlockedError,
  formatClockInDurationUntil,
  formatClockInWaitDuration,
  parseRecordTimeEventResponse,
} from './data/timekeeping'

const root = process.cwd()
const dialog = readFileSync(join(root, 'src', 'components', 'EarlyClockInWarningDialog.tsx'), 'utf8')
const modal = readFileSync(join(root, 'src', 'components', 'ModalDialog.tsx'), 'utf8')
const home = readFileSync(join(root, 'src', 'pages', 'OverviewPage.tsx'), 'utf8')
const myTime = readFileSync(join(root, 'src', 'pages', 'TimePage.tsx'), 'utf8')
const workspace = readFileSync(join(root, 'src', 'time', 'TimeWorkspace.tsx'), 'utf8')
const serverGuard = readFileSync(
  join(root, 'supabase', 'migrations', '20260902194500_structured_early_clock_in_restriction.sql'),
  'utf8',
)

const blockedResponse = {
  status: 'blocked',
  code: 'EARLY_CLOCK_IN_BLOCKED',
  trustedServerTime: '2026-09-02T23:42:00.000Z',
  scheduledShiftStart: '2026-09-03T00:00:00.000Z',
  scheduledShiftEnd: '2026-09-03T06:00:00.000Z',
  clockInEligibleAt: '2026-09-02T23:55:00.000Z',
  shiftDate: '2026-09-02',
  shiftDisplayName: 'MG Properties Patrol–Unarmed',
  siteCode: 'MPP',
  siteName: 'MG Properties',
  postName: 'Patrol–Unarmed',
  locationName: 'MG Properties',
  coverageType: 'Unarmed coverage',
  timeZone: 'America/Denver',
  clockInWindowMinutes: 5,
} as const

describe('production early clock-in restriction', () => {
  it('formats whole, compound, and sub-minute durations without showing zero minutes', () => {
    expect(formatClockInWaitDuration('2026-09-01T15:00:00.000Z', '2026-09-01T14:45:00.000Z')).toBe('15 minutes')
    expect(formatClockInWaitDuration('2026-09-01T16:15:00.000Z', '2026-09-01T14:45:00.000Z')).toBe('1 hour 30 minutes')
    expect(formatClockInWaitDuration('2026-09-01T16:45:00.000Z', '2026-09-01T14:45:00.000Z')).toBe('2 hours')
    expect(formatClockInDurationUntil('2026-09-01T14:45:30.000Z', '2026-09-01T14:45:00.000Z')).toBe('less than 1 minute')
  })

  it('turns the structured server rejection into the dedicated domain error', () => {
    expect(() => parseRecordTimeEventResponse(blockedResponse)).toThrow(EarlyClockInBlockedError)
    try {
      parseRecordTimeEventResponse(blockedResponse)
    } catch (error) {
      expect(error).toBeInstanceOf(EarlyClockInBlockedError)
      expect((error as EarlyClockInBlockedError).details.clockInEligibleAt).toBe(blockedResponse.clockInEligibleAt)
    }
  })

  it('requires one explicit acknowledgment and uses a true alert dialog', () => {
    expect(dialog).toContain('dialogRole="alertdialog"')
    expect(dialog).toContain('dismissible={false}')
    expect(dialog).toContain('Acknowledge &amp; close')
    expect(dialog).not.toContain('Cancel')
    expect(modal).toContain('if (busy || !dismissible) return')
    expect(modal).toContain('role={dialogRole}')
  })

  it('routes all three clock-in surfaces through the server mutation before showing the modal', () => {
    for (const surface of [home, myTime, workspace]) {
      expect(surface).toContain('recordTimeEvent(input)')
      expect(surface).toContain('<EarlyClockInWarningDialog')
      expect(surface).toContain('useEarlyClockInRestriction()')
    }
    expect(home).toContain("onPunch('clock_in', upcomingShift.shiftId)")
    expect(myTime).toContain('onPunch(kind, nextClockInShift?.shiftId ?? null)')
    expect(workspace).toContain('defaultShiftId ?? nextClockInShift?.shiftId ?? null')
  })

  it('enforces the boundary with trusted server time and never inserts a blocked punch', () => {
    expect(serverGuard).toContain("clock_in_eligible_at := selected_shift.starts_at - interval '5 minutes'")
    expect(serverGuard).toContain('if server_now < clock_in_eligible_at then')
    expect(serverGuard).toContain("'code', 'EARLY_CLOCK_IN_BLOCKED'")
    expect(serverGuard).toContain("'trustedServerTime', server_now")
    expect(serverGuard.indexOf("'code', 'EARLY_CLOCK_IN_BLOCKED'")).toBeLessThan(serverGuard.indexOf('insert into public.time_events'))
    expect(serverGuard).toContain("audit.occurred_at >= server_now - interval '30 seconds'")
  })
})
