import { describe, expect, it } from 'vitest'
import { formatPatrolDateTime } from './data/patrol'
import {
  findPatrolScheduleCandidate,
  getPatrolOperationState,
  patrolScheduleCandidateValue,
} from './patrolOperations'

const now = new Date('2026-09-07T18:00:00.000Z').getTime()
const assignment = (overrides: Partial<Parameters<typeof getPatrolOperationState>[0]> = {}) => ({
  endsAt: '2026-09-07T20:00:00.000Z',
  obligations: [{ status: 'due' }],
  startsAt: '2026-09-07T16:00:00.000Z',
  status: 'active' as const,
  ...overrides,
})

describe('Patrol Operations presentation rules', () => {
  it('distinguishes scheduled, current, completed, review, and unconfigured assignments', () => {
    expect(getPatrolOperationState(assignment(), now)).toBe('in_progress')
    expect(getPatrolOperationState(assignment({ startsAt: '2026-09-07T19:00:00.000Z' }), now)).toBe('scheduled')
    expect(getPatrolOperationState(assignment({ obligations: [{ status: 'completed' }] }), now)).toBe('completed')
    expect(getPatrolOperationState(assignment({ obligations: [{ status: 'missed' }] }), now)).toBe('needs_review')
    expect(getPatrolOperationState(assignment({ endsAt: '2026-09-07T17:00:00.000Z' }), now)).toBe('needs_review')
    expect(getPatrolOperationState(assignment({ obligations: [] }), now)).toBe('no_requirements')
  })

  it('uses both shift and employee IDs so multi-assignee shifts cannot select the wrong employee', () => {
    const candidates = [
      { shiftId: 'same-shift', employeeId: 'employee-a', name: 'Employee A' },
      { shiftId: 'same-shift', employeeId: 'employee-b', name: 'Employee B' },
    ]
    expect(patrolScheduleCandidateValue(candidates[0])).not.toBe(patrolScheduleCandidateValue(candidates[1]))
    expect(findPatrolScheduleCandidate(candidates, 'same-shift:employee-b')?.name).toBe('Employee B')
  })

  it('renders the required date, time, and zone without an invalid Intl option combination', () => {
    expect(formatPatrolDateTime('2026-09-07T18:00:00.000Z', 'America/Denver')).toMatch(/^09\/07\/2026, 12:00 PM MDT$/)
  })
})
