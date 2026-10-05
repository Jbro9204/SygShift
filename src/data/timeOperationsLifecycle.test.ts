import { describe, expect, it } from 'vitest'
import {
  isCallOffReportCurrent,
  isOperationalAlertLive,
  type EmployeeCallOffReport,
  type OperationalAlert,
} from './timeOperations'

const baseAlert: OperationalAlert = {
  id: '10000000-0000-4000-8000-000000000001',
  alertType: 'employee_call_off',
  priority: 'urgent',
  title: 'Coverage review required',
  summary: 'An employee call-off needs coverage.',
  employeeId: '20000000-0000-4000-8000-000000000001',
  shiftId: '30000000-0000-4000-8000-000000000001',
  directPath: '/requests?callOff=10000000-0000-4000-8000-000000000001',
  createdAt: '2026-10-05T10:00:00.000Z',
  acknowledgedAt: null,
}

const baseCallOff: EmployeeCallOffReport = {
  id: '10000000-0000-4000-8000-000000000001',
  employeeId: '20000000-0000-4000-8000-000000000001',
  employeeName: 'Randy Guard',
  shiftId: '30000000-0000-4000-8000-000000000001',
  startsAt: '2026-10-05T04:00:00.000Z',
  endsAt: '2026-10-05T12:00:00.000Z',
  timeZone: 'America/Denver',
  location: 'Central Site',
  callOffType: 'sick',
  reason: 'Unable to work the scheduled shift.',
  callReceivedAt: '2026-10-05T03:00:00.000Z',
  receivedBy: 'Dispatch',
  replacementNeeded: true,
  operationalDetails: null,
  reportedAt: '2026-10-05T03:00:00.000Z',
  resolvedAt: null,
  coverageStatus: null,
}

describe('operational alert live-surface lifecycle', () => {
  it('keeps a bounded alert live before its cutoff and retires it at the cutoff', () => {
    const alert = { ...baseAlert, active: true, lifecycleStatus: 'active_operations' as const, liveUntil: '2026-10-05T13:00:00.000Z' }

    expect(isOperationalAlertLive(alert, '2026-10-05T12:59:59.999Z')).toBe(true)
    expect(isOperationalAlertLive(alert, '2026-10-05T13:00:00.000Z')).toBe(false)
  })

  it('fails closed when a time-bounded alert has an invalid or missing authoritative timestamp', () => {
    expect(isOperationalAlertLive({ ...baseAlert, liveUntil: 'not-a-timestamp' }, '2026-10-05T12:00:00.000Z')).toBe(false)
    expect(isOperationalAlertLive({ ...baseAlert, liveUntil: '2026-10-05T13:00:00.000Z' }, 'not-a-timestamp')).toBe(false)
    expect(isOperationalAlertLive({ ...baseAlert, liveUntil: '2026-10-05T13:00:00.000Z' })).toBe(false)
  })

  it('hides inactive and non-operational lifecycle alerts', () => {
    expect(isOperationalAlertLive({ ...baseAlert, active: false })).toBe(false)
    expect(isOperationalAlertLive({ ...baseAlert, lifecycleStatus: 'payroll_review' })).toBe(false)
    expect(isOperationalAlertLive({ ...baseAlert, lifecycleStatus: 'resolved' })).toBe(false)
  })

  it('keeps an untimed legacy alert compatible when lifecycle fields are absent', () => {
    expect(isOperationalAlertLive({ ...baseAlert, alertType: 'late_arrival' })).toBe(true)
  })

  it('fails closed for a call-off alert that is missing its authoritative live window', () => {
    expect(isOperationalAlertLive({ ...baseAlert, alertType: 'employee_call_off' }, '2026-10-05T12:00:00.000Z')).toBe(false)
  })
})

describe('current call-off live-surface lifecycle', () => {
  it('keeps an unresolved call-off current before one hour after shift end and retires it at the boundary', () => {
    expect(isCallOffReportCurrent(baseCallOff, '2026-10-05T12:59:59.999Z')).toBe(true)
    expect(isCallOffReportCurrent(baseCallOff, '2026-10-05T13:00:00.000Z')).toBe(false)
  })

  it('fails closed for resolved records and invalid authoritative timestamps', () => {
    expect(isCallOffReportCurrent({ ...baseCallOff, replacementNeeded: false }, '2026-10-05T12:00:00.000Z')).toBe(false)
    expect(isCallOffReportCurrent({ ...baseCallOff, resolvedAt: '2026-10-05T11:00:00.000Z' }, '2026-10-05T12:00:00.000Z')).toBe(false)
    expect(isCallOffReportCurrent({ ...baseCallOff, endsAt: 'not-a-timestamp' }, '2026-10-05T12:00:00.000Z')).toBe(false)
    expect(isCallOffReportCurrent(baseCallOff, 'not-a-timestamp')).toBe(false)
  })
})
