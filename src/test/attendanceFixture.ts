import type { AccountabilityEvent } from '../data/accountability'

export function attendanceFixture(overrides: Partial<AccountabilityEvent> = {}): AccountabilityEvent {
  return {
    id: '11111111-1111-4111-8111-111111111111', employeeId: '22222222-2222-4222-8222-222222222222',
    employeeName: 'Test Employee', username: 'testemployee', role: 'guard', employmentType: 'hourly',
    sourceTable: 'attendance_accountability_events', eventType: 'call_off', status: 'resolved', reviewOutcome: 'corrected',
    operationalDate: '2026-08-31', startsAt: null, endsAt: null, timeZone: 'America/Denver',
    siteName: null, siteCode: null, postName: null, eventName: null, locationName: 'Date-only report', note: 'Call-off reported.',
    createdAt: '2026-09-01T12:00:00Z', shiftId: null, reviewedAt: null, reviewedByName: null, decisionNote: null,
    reviewable: false, actionHistory: [], reconciliation: null, ...overrides,
  }
}
