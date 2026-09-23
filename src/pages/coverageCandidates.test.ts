import { describe, expect, it } from 'vitest'
import type { CallOffCoverageCandidate } from '../data/requests'
import { buildCoverageCandidateDirectory } from './coverageCandidates'

function candidate(overrides: Partial<CallOffCoverageCandidate>): CallOffCoverageCandidate {
  return {
    id: crypto.randomUUID(),
    name: 'Available Guard',
    employeeNumber: 'SYG-1000',
    employmentType: 'hourly',
    workClassification: null,
    isFlex: false,
    available: true,
    noOverlap: true,
    armedReady: true,
    overtimeMinutes: 0,
    requiresOvertimeApproval: false,
    eligible: true,
    recommended: true,
    blockReason: null,
    ...overrides,
  }
}

describe('coverage candidate directory', () => {
  it('keeps every available non-Flex employee visible after a long Flex list', () => {
    const candidates = [
      ...Array.from({ length: 15 }, (_, index) => candidate({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        name: `Flex Guard ${String(index + 1).padStart(2, '0')}`,
        employeeNumber: `SYG-F${index + 1}`,
        employmentType: 'flex',
        isFlex: true,
      })),
      candidate({
        id: '10000000-0000-4000-8000-000000000001',
        name: 'Regular Available Guard',
        employeeNumber: 'SYG-R1',
      }),
    ]

    const directory = buildCoverageCandidateDirectory(candidates, '', false)

    expect(directory.availableCount).toBe(16)
    expect(directory.sections.find((section) => section.key === 'flex')?.candidates).toHaveLength(15)
    expect(directory.sections.find((section) => section.key === 'available')?.candidates.map((item) => item.name))
      .toEqual(['Regular Available Guard'])
  })

  it('separates overtime and hides unavailable employees until requested', () => {
    const candidates = [
      candidate({ name: 'Overtime Guard', requiresOvertimeApproval: true, overtimeMinutes: 180, recommended: false }),
      candidate({ name: 'Busy Guard', eligible: false, noOverlap: false, recommended: false, blockReason: 'Another active assignment overlaps this shift.' }),
    ]

    const defaultDirectory = buildCoverageCandidateDirectory(candidates, '', false)
    expect(defaultDirectory.sections.map((section) => section.key)).toEqual(['overtime'])
    expect(defaultDirectory.overtimeCount).toBe(1)
    expect(defaultDirectory.unavailableCount).toBe(1)

    const expandedDirectory = buildCoverageCandidateDirectory(candidates, '', true)
    expect(expandedDirectory.sections.map((section) => section.key)).toEqual(['overtime', 'unavailable'])
  })

  it('shows a searched unavailable employee with the blocking reason', () => {
    const directory = buildCoverageCandidateDirectory([
      candidate({
        name: 'Jordan Busy',
        employeeNumber: 'SYG-2001',
        eligible: false,
        available: false,
        recommended: false,
        blockReason: 'Approved unavailability overlaps this shift.',
      }),
    ], '2001', false)

    expect(directory.matchingCount).toBe(1)
    expect(directory.sections[0]?.key).toBe('unavailable')
    expect(directory.sections[0]?.candidates[0]?.blockReason).toContain('Approved unavailability')
  })
})
