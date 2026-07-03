import { describe, expect, it } from 'vitest'
import {
  parseImportReadiness,
  verifiedCurrentImportScope,
  verifiedCurrentScopeBaseline,
} from './importMapping'

describe('operational import mapping', () => {
  it('validates the scoped readiness contract', () => {
    const readiness = parseImportReadiness({
      importRunId: '16a6c13b-af3f-423c-aa4e-55f794723a3c',
      fromDate: verifiedCurrentImportScope.fromDate,
      throughDate: verifiedCurrentImportScope.throughDate,
      employeeCandidateCount: 56,
      directoryEmployeeMappingCount: 0,
      scheduleCandidateCount: 7,
      acceptedScheduleCount: 0,
      shiftCandidateCount: 963,
      sourceOpenShiftCount: 199,
      missingContextShiftCount: 0,
      siteKeyCount: 14,
      siteMappingCount: 0,
      assigneeLabelCount: 53,
      aliasMappingCount: 0,
      conservativeAliasSuggestionCount: 28,
      qualificationConflictCount: 0,
      assignmentOverlapConflictCount: 0,
      directoryReady: false,
      scheduleReady: false,
    })

    expect(readiness.shiftCandidateCount).toBe(verifiedCurrentScopeBaseline.shifts)
    expect(readiness.scheduleReady).toBe(false)
  })

  it('rejects incomplete readiness payloads', () => {
    expect(() => parseImportReadiness({ scheduleReady: true })).toThrow()
  })
})
