export type PatrolOperationState = 'scheduled' | 'in_progress' | 'completed' | 'needs_review' | 'no_requirements'

export interface PatrolOperationAssignmentLike {
  endsAt: string
  obligations: Array<{ status: string }>
  startsAt: string
  status: 'active' | 'completed'
}

export interface PatrolScheduleCandidateIdentity {
  employeeId: string
  shiftId: string
}

export const patrolOperationLabels: Record<PatrolOperationState, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  needs_review: 'Needs review',
  no_requirements: 'No requirements',
}

export const patrolOperationTones: Record<PatrolOperationState, string> = {
  scheduled: 'scheduled',
  in_progress: 'active',
  completed: 'completed',
  needs_review: 'missed',
  no_requirements: 'paused',
}

export function getPatrolOperationState(
  assignment: PatrolOperationAssignmentLike,
  now = Date.now(),
): PatrolOperationState {
  if (assignment.obligations.some((item) => item.status === 'missed')) return 'needs_review'
  if (assignment.obligations.length === 0) return 'no_requirements'
  if (assignment.status === 'completed' || assignment.obligations.every((item) => item.status === 'completed' || item.status === 'waived')) return 'completed'
  if (new Date(assignment.startsAt).getTime() > now) return 'scheduled'
  if (new Date(assignment.endsAt).getTime() < now) return 'needs_review'
  return 'in_progress'
}

export function patrolScheduleCandidateValue(candidate: PatrolScheduleCandidateIdentity): string {
  return `${candidate.shiftId}:${candidate.employeeId}`
}

export function findPatrolScheduleCandidate<T extends PatrolScheduleCandidateIdentity>(
  candidates: T[],
  value: string,
): T | undefined {
  return candidates.find((candidate) => patrolScheduleCandidateValue(candidate) === value)
}
