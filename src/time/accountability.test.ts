import { describe, expect, it } from 'vitest'
import type { AccountabilityEvent, AccountabilityWorkspace } from '../data/accountability'
import {
  accountabilityDisplayState,
  buildEmployeeAccountabilitySummaries,
  isNegativeReliabilityOccurrence,
  summarizeAccountability,
} from './accountability'

function event(overrides: Partial<AccountabilityEvent> = {}): AccountabilityEvent {
  return {
    id: crypto.randomUUID(),
    sourceTable: 'attendance_accountability_events',
    eventType: 'late_arrival',
    status: 'reported',
    employeeId: '0b06fda8-8509-4d06-86df-9cc3e8da5688',
    employeeName: 'Jordan Brown',
    username: 'jbrown',
    role: 'admin',
    employmentType: 'salary',
    operationalDate: '2026-08-22',
    startsAt: '2026-08-22T14:00:00.000Z',
    endsAt: '2026-08-22T22:00:00.000Z',
    timeZone: 'America/Denver',
    siteName: 'Administrative',
    siteCode: 'ADMIN',
    postName: 'Systems',
    eventName: null,
    locationName: 'Administrative',
    note: 'Arrived after the scheduled start.',
    createdAt: '2026-08-22T14:20:00.000Z',
    shiftId: '8e7362d5-c8bd-47ee-babe-70c1b7296056',
    reviewOutcome: null,
    reviewedAt: null,
    reviewedByName: null,
    decisionNote: null,
    reviewable: true,
    actionHistory: [],
    reconciliation: null,
    ...overrides,
  }
}

describe('accountability decisions', () => {
  it('does not count unreviewed, protected, corrected, dismissed, or voided records as negative reliability occurrences', () => {
    expect(isNegativeReliabilityOccurrence(event())).toBe(false)
    expect(isNegativeReliabilityOccurrence(event({ reviewOutcome: 'excused_protected', status: 'resolved' }))).toBe(false)
    expect(isNegativeReliabilityOccurrence(event({ reviewOutcome: 'corrected', status: 'resolved' }))).toBe(false)
    expect(isNegativeReliabilityOccurrence(event({ reviewOutcome: 'dismissed', status: 'resolved' }))).toBe(false)
    expect(isNegativeReliabilityOccurrence(event({ reviewOutcome: null, status: 'voided' }))).toBe(false)
  })

  it('counts only a reviewed and confirmed reliability occurrence', () => {
    expect(isNegativeReliabilityOccurrence(event({ reviewOutcome: 'confirmed', status: 'resolved' }))).toBe(true)
    expect(isNegativeReliabilityOccurrence(event({ eventType: 'called_in_sick', reviewOutcome: 'confirmed', status: 'resolved' }))).toBe(false)
    expect(isNegativeReliabilityOccurrence(event({ eventType: 'vacation', reviewOutcome: 'confirmed', status: 'resolved' }))).toBe(false)
  })

  it('keeps each documented state separate in summary totals', () => {
    const summary = summarizeAccountability([
      event(),
      event({ id: crypto.randomUUID(), reviewOutcome: 'confirmed', status: 'resolved' }),
      event({ id: crypto.randomUUID(), reviewOutcome: 'excused_protected', status: 'resolved' }),
      event({ id: crypto.randomUUID(), reviewOutcome: 'corrected', status: 'resolved' }),
      event({ id: crypto.randomUUID(), reviewOutcome: 'dismissed', status: 'resolved' }),
    ])
    expect(summary).toMatchObject({ total: 5, open: 1, confirmed: 1, protected: 1, corrected: 1, dismissed: 1 })
  })

  it('builds an employee-centered overview without listing employees who have no events', () => {
    const employees: AccountabilityWorkspace['employees'] = [
      { id: '0b06fda8-8509-4d06-86df-9cc3e8da5688', name: 'Jordan Brown', username: 'jbrown', role: 'admin', employmentType: 'salary' },
      { id: '40f73a85-cd55-4710-afdb-aade1398c501', name: 'Michelle Hood', username: 'mhood', role: 'admin', employmentType: 'salary' },
    ]
    const rows = buildEmployeeAccountabilitySummaries(employees, [event({ reviewOutcome: 'confirmed', status: 'resolved' })])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ employeeName: 'Jordan Brown', confirmed: 1, confirmedReliabilityOccurrences: 1 })
  })

  it('maps an unresolved record to the open review state', () => {
    expect(accountabilityDisplayState(event())).toBe('open')
  })
})
