import { describe, expect, it } from 'vitest'
import { reportRowKey } from './ReportsPage'

describe('report result identity', () => {
  it('keeps multiple shifts for one employee and operational day distinct', () => {
    const shared = {
      employeeId: '73000000-0000-4000-8000-000000000001',
      operationalDate: '2026-10-17',
    }

    expect(reportRowKey({ ...shared, shiftId: '73000000-0000-4000-8000-000000000002' }, 0))
      .not.toBe(reportRowKey({ ...shared, shiftId: '73000000-0000-4000-8000-000000000003' }, 1))
  })

  it('uses payroll occurrence and manual-entry identities when no generic id exists', () => {
    const occurrence = reportRowKey({ payrollOccurrenceKey: 'shift:one:2026-10-17' }, 0)
    const manual = reportRowKey({ manualEntryId: '73000000-0000-4000-8000-000000000004' }, 0)

    expect(occurrence).toContain('occurrence:shift:one:2026-10-17')
    expect(manual).toContain('manual:73000000-0000-4000-8000-000000000004')
    expect(occurrence).not.toBe(manual)
  })

  it('keeps multiple audit events for one manual entry distinct across reorder', () => {
    const shared = {
      manualEntryId: '73000000-0000-4000-8000-000000000004',
      employeeId: '73000000-0000-4000-8000-000000000001',
      createdAt: '2026-10-24T15:00:00Z',
    }
    const created = { ...shared, historyId: '73000000-0000-4000-8000-000000000007', action: 'created' }
    const approved = { ...shared, historyId: '73000000-0000-4000-8000-000000000008', action: 'approved' }

    expect(reportRowKey(created, 0)).not.toBe(reportRowKey(approved, 1))
    expect(reportRowKey(created, 0)).toBe(reportRowKey(created, 1))
    expect(reportRowKey(approved, 1)).toBe(reportRowKey(approved, 0))
  })

  it('keeps automatic clock-outs at the same scheduled start distinct by immutable exception identity', () => {
    const shared = {
      scheduledStartAt: '2026-10-24T14:00:00Z',
      automaticClockOutAt: '2026-10-24T22:00:00Z',
    }
    const first = { ...shared, id: '73000000-0000-4000-8000-000000000005', employeeName: 'First Employee' }
    const second = { ...shared, id: '73000000-0000-4000-8000-000000000006', employeeName: 'Second Employee' }

    expect(reportRowKey(first, 0)).not.toBe(reportRowKey(second, 1))
    expect(reportRowKey(first, 0)).toBe(reportRowKey(first, 1))
    expect(reportRowKey(second, 1)).toBe(reportRowKey(second, 0))
  })

  it('never reuses a fallback key for a different same-start row after refetch reordering', () => {
    const shared = {
      scheduledStartAt: '2026-10-24T14:00:00Z',
      automaticClockOutAt: '2026-10-24T22:00:00Z',
    }
    const first = { ...shared, employeeName: 'First Employee', sitePost: 'Site A' }
    const second = { ...shared, employeeName: 'Second Employee', sitePost: 'Site B' }
    const selectedKey = reportRowKey(first, 0)

    expect(reportRowKey(second, 0)).not.toBe(selectedKey)
    expect(reportRowKey(first, 1)).not.toBe(selectedKey)
  })
})
