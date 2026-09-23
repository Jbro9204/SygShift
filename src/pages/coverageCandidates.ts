import type { CallOffCoverageCandidate } from '../data/requests'

export type CoverageCandidateSectionKey = 'flex' | 'available' | 'overtime' | 'unavailable'

export interface CoverageCandidateSection {
  candidates: CallOffCoverageCandidate[]
  description: string
  key: CoverageCandidateSectionKey
  label: string
}

export interface CoverageCandidateDirectory {
  availableCount: number
  matchingCount: number
  overtimeCount: number
  sections: CoverageCandidateSection[]
  unavailableCount: number
}

function candidateSearchText(candidate: CallOffCoverageCandidate): string {
  return [
    candidate.name,
    candidate.employeeNumber,
    candidate.employmentType,
    candidate.workClassification,
    candidate.isFlex ? 'flex' : null,
  ].filter(Boolean).join(' ').toLowerCase()
}

function byName(left: CallOffCoverageCandidate, right: CallOffCoverageCandidate): number {
  return left.name.localeCompare(right.name, 'en', { sensitivity: 'base' })
}

export function buildCoverageCandidateDirectory(
  candidates: CallOffCoverageCandidate[],
  search: string,
  includeUnavailable: boolean,
): CoverageCandidateDirectory {
  const normalizedSearch = search.trim().toLowerCase()
  const matching = candidates
    .filter((candidate) => !normalizedSearch || candidateSearchText(candidate).includes(normalizedSearch))
    .sort(byName)
  const eligible = matching.filter((candidate) => candidate.eligible)
  const unavailable = matching.filter((candidate) => !candidate.eligible)
  const flex = eligible.filter((candidate) => candidate.isFlex && !candidate.requiresOvertimeApproval)
  const available = eligible.filter((candidate) => !candidate.isFlex && !candidate.requiresOvertimeApproval)
  const overtime = eligible.filter((candidate) => candidate.requiresOvertimeApproval)

  const sectionCandidates: CoverageCandidateSection[] = [
    {
      key: 'flex',
      label: 'Recommended Flex',
      description: 'Available Flex employees with no shift conflict and no projected overtime.',
      candidates: flex,
    },
    {
      key: 'available',
      label: 'Available employees',
      description: 'Other qualified employees who are not scheduled during this coverage window.',
      candidates: available,
    },
    {
      key: 'overtime',
      label: 'Overtime approval required',
      description: 'Qualified employees without a conflict whose assignment would create scheduled overtime.',
      candidates: overtime,
    },
    {
      key: 'unavailable',
      label: 'Unavailable for this shift',
      description: 'Shown for reference. These employees cannot be selected until the listed conflict is resolved.',
      candidates: includeUnavailable || Boolean(normalizedSearch) ? unavailable : [],
    },
  ]
  const sections = sectionCandidates.filter((section) => section.candidates.length > 0)

  return {
    availableCount: eligible.length,
    matchingCount: matching.length,
    overtimeCount: overtime.length,
    sections,
    unavailableCount: unavailable.length,
  }
}
