import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TimeAdjustmentRequest } from '../data/timeOperations'
import type { PendingCorrection } from '../data/timekeeping'
import { CorrectionPanel } from './MyTimePage'

const correction: PendingCorrection = {
  id: '10000000-0000-4000-8000-000000000001',
  timeEventId: '20000000-0000-4000-8000-000000000001',
  employeeId: '30000000-0000-4000-8000-000000000001',
  employeeName: 'Zachary Alexander Ward',
  username: 'zward',
  kind: 'clock_in',
  recordedAt: '2026-09-16T12:55:00.000Z',
  replacementTime: '2026-09-16T13:00:00.000Z',
  voided: false,
  reason: 'Clock-in time needs review.',
  requestedBy: '30000000-0000-4000-8000-000000000001',
  requestedAt: '2026-09-16T14:00:00.000Z',
  shiftId: null,
}

const missingRequest: TimeAdjustmentRequest = {
  id: '40000000-0000-4000-8000-000000000001',
  employeeId: '30000000-0000-4000-8000-000000000001',
  employeeName: 'Zachary Alexander Ward',
  shiftId: null,
  workDate: '2026-09-10',
  issueType: 'missing_shift',
  requestedClockInAt: '2026-09-11T00:00:00.000Z',
  requestedClockOutAt: '2026-09-11T02:19:00.000Z',
  requestedPostId: null,
  requestedLocation: 'MPP · MG Properties Patrol-Unarmed',
  requestedTimeZone: 'America/Denver',
  requestedUnpaidBreakMinutes: 0,
  appliedTimeEventIds: [],
  reason: 'Missing worked time for the changed schedule.',
  notes: null,
  status: 'submitted',
  submittedAt: '2026-09-16T14:00:00.000Z',
  reviewedAt: null,
  decisionNote: null,
  reviewer: null,
}

describe('My Time correction status identity', () => {
  it('attaches employee identity to punch corrections and missing-time requests', () => {
    render(
      <CorrectionPanel
        corrections={[correction]}
        employeeUsername="zward"
        loading={false}
        missingRequests={[missingRequest]}
      />,
    )

    const cards = document.querySelectorAll('.my-time-correction-card')
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(within(card as HTMLElement).getByText('Employee')).toBeInTheDocument()
      expect(within(card as HTMLElement).getByText('Zachary Alexander Ward')).toBeInTheDocument()
      expect(within(card as HTMLElement).getByText('@zward')).toBeInTheDocument()
    }
    expect(screen.getByText('Clocked in')).toBeInTheDocument()
    expect(screen.getByText('Missing worked time')).toBeInTheDocument()
  })
})
