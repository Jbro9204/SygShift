import { describe, expect, it } from 'vitest'
import type { SessionContext } from '../data/auth'
import type { AttendanceReconciliationRow } from '../data/timekeeping'
import {
  recentAttendanceReviewPeriod,
  recommendedAttendanceAction,
  recommendedClientCreditStatus,
  reconciliationNeedsCorrection,
} from './dailyAttendanceReview'
import { canManageAttendanceReview, canViewAttendanceReview } from './timePermissions'

const baseRow: AttendanceReconciliationRow = {
  shiftId: '81000000-0000-4000-8000-000000000001',
  scheduleId: '81000000-0000-4000-8000-000000000002',
  operationalDate: '2026-08-14',
  startsAt: '2026-08-14T14:00:00.000Z',
  endsAt: '2026-08-14T22:00:00.000Z',
  timeZone: 'America/Denver',
  headcountRequired: 1,
  requiresArmed: false,
  scheduledMinutesPerPosition: 480,
  scheduledCoverageMinutes: 480,
  actualPaidMinutes: 420,
  varianceMinutes: -60,
  scheduledEmployeeCount: 1,
  actualEmployeeCount: 1,
  scheduledMissingCount: 0,
  unexpectedActualCount: 0,
  siteId: '81000000-0000-4000-8000-000000000003',
  siteCode: 'ADMIN',
  siteName: 'Administrative',
  postId: '81000000-0000-4000-8000-000000000004',
  postName: 'Recruiting and Licensure',
  eventId: null,
  eventName: null,
  locationName: 'Administrative',
  scheduledEmployees: [],
  actualEmployees: [],
  callOffs: [],
  discrepancyCodes: ['worked_time_variance'],
  requiresTimeCorrection: false,
  occurrenceFingerprint: 'a'.repeat(64),
  reviewStatus: 'unresolved',
  resolution: null,
}

const session: SessionContext = {
  employeeId: '81000000-0000-4000-8000-000000000005',
  username: 'reviewer',
  displayName: 'Attendance Reviewer',
  role: 'guard',
  timeZone: 'America/Denver',
  mustChangePassword: false,
  passwordChangedAt: '2026-08-01T12:00:00.000Z',
  mfaEnrolledAt: '2026-08-01T12:00:00.000Z',
  mfaRequired: true,
  hasMfa: true,
  permissions: [],
}

describe('daily attendance review decisions', () => {
  it('defaults to the seven most recently completed operational days', () => {
    expect(recentAttendanceReviewPeriod(new Date('2026-08-16T16:00:00.000Z'))).toEqual({
      fromDate: '2026-08-09',
      throughDate: '2026-08-15',
    })
  })

  it('recognizes replacements, uncovered work, call-offs, and legitimate variances', () => {
    expect(recommendedAttendanceAction({ ...baseRow, discrepancyCodes: ['replacement_or_unplanned_worker'] })).toBe('confirmed_replacement')
    expect(recommendedAttendanceAction({ ...baseRow, discrepancyCodes: ['missing_recorded_time'] })).toBe('confirmed_uncovered')
    expect(recommendedAttendanceAction({ ...baseRow, discrepancyCodes: ['call_off_reported'] })).toBe('confirmed_call_off')
    expect(recommendedAttendanceAction(baseRow)).toBe('approved_variance')
    expect(recommendedClientCreditStatus('confirmed_uncovered')).toBe('review_required')
  })

  it('keeps incomplete punch sequences as hard correction requirements', () => {
    expect(reconciliationNeedsCorrection({ ...baseRow, discrepancyCodes: ['multiple_work_segments'] })).toBe(false)
    expect(reconciliationNeedsCorrection({ ...baseRow, discrepancyCodes: ['incomplete_punch_sequence'] })).toBe(true)
    expect(reconciliationNeedsCorrection({ ...baseRow, requiresTimeCorrection: true })).toBe(true)
  })
})

describe('daily attendance review permissions', () => {
  it('separates view and decision permissions without role-name bypasses', () => {
    expect(canViewAttendanceReview({ ...session, permissions: ['accountability.view'] })).toBe(true)
    expect(canManageAttendanceReview({ ...session, permissions: ['accountability.view'] })).toBe(false)
    expect(canManageAttendanceReview({ ...session, permissions: ['accountability.manage'] })).toBe(true)
    expect(canManageAttendanceReview({ ...session, permissions: ['time.manage'] })).toBe(true)
    expect(canManageAttendanceReview({ ...session, role: 'admin' })).toBe(false)
    expect(canManageAttendanceReview({ ...session, role: 'admin', permissions: ['accountability.manage'] })).toBe(true)
  })
})
