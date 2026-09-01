/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatClockInWaitDuration } from './data/timekeeping'

const root = process.cwd()
const dialog = readFileSync(join(root, 'src', 'components', 'EarlyClockInWarningDialog.tsx'), 'utf8')
const modal = readFileSync(join(root, 'src', 'components', 'ModalDialog.tsx'), 'utf8')
const home = readFileSync(join(root, 'src', 'pages', 'OverviewPage.tsx'), 'utf8')
const myTime = readFileSync(join(root, 'src', 'pages', 'TimePage.tsx'), 'utf8')
const serverGuard = readFileSync(join(root, 'supabase', 'migrations', '20260831050000_timekeeping_release_guardrails.sql'), 'utf8')

describe('early clock-in acknowledgment warning', () => {
  it('states the remaining time clearly in minutes and hours', () => {
    expect(formatClockInWaitDuration('2026-09-01T15:00:00.000Z', '2026-09-01T14:45:00.000Z')).toBe('15 minutes')
    expect(formatClockInWaitDuration('2026-09-01T16:15:00.000Z', '2026-09-01T14:45:00.000Z')).toBe('1 hour 30 minutes')
    expect(formatClockInWaitDuration('2026-09-01T16:45:00.000Z', '2026-09-01T14:45:00.000Z')).toBe('2 hours')
  })

  it('requires an explicit acknowledgment and cannot be dismissed with close or Escape', () => {
    expect(dialog).toContain('dismissible={false}')
    expect(dialog).toContain('Your shift does not start for {waitDuration}.')
    expect(dialog).toContain('I understand')
    expect(modal).toContain('if (busy || !dismissible) return')
    expect(modal).toContain('{dismissible ? (')
  })

  it('is connected to both employee clock-in entry points', () => {
    expect(home).toContain('<EarlyClockInWarningDialog')
    expect(home).toContain('setEarlyClockInWarningOpen(true)')
    expect(myTime).toContain('<EarlyClockInWarningDialog')
    expect(myTime).toContain('setEarlyClockInWarningOpen(true)')
  })

  it('keeps the server-enforced five-minute payroll safeguard', () => {
    expect(serverGuard).toContain("shift.starts_at <= server_now + interval '5 minutes'")
    expect(serverGuard).toContain('Clock-in opens five minutes before your scheduled shift.')
  })
})
