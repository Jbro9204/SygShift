import { describe, expect, it } from 'vitest'
import {
  parseImportCandidates,
  parseImportIssues,
  parseImportReviewSummary,
  verifiedWorkbookBaseline,
} from './importReview'

describe('import review validation', () => {
  it('accepts the protected review summary contract', () => {
    const summary = parseImportReviewSummary({
      importRunId: '16a6c13b-af3f-423c-aa4e-55f794723a3c',
      status: 'promoted',
      sourceSha256: verifiedWorkbookBaseline.sourceSha256,
      sourceFilename: verifiedWorkbookBaseline.sourceFilename,
      sourceCellCount: 110_274,
      candidateCount: 9_408,
      blockingIssueCount: 0,
      warningCount: 0,
      reconciliationDigest: verifiedWorkbookBaseline.reconciliationDigest,
      createdAt: '2026-07-03T12:00:00.000Z',
      candidateCounts: { 'employee:pending': 56 },
      issueCounts: { 'blocking:resolved': 132, 'warning:resolved': 60 },
    })

    expect(summary?.candidateCount).toBe(9_408)
    expect(summary?.sourceCellCount).toBe(110_274)
  })

  it('rejects malformed evidence and preserves source references', () => {
    expect(() => parseImportCandidates([{ id: 'not-a-uuid' }])).toThrow()
    expect(parseImportIssues([{
      id: '73000000-0000-4000-8000-000000000001',
      severity: 'blocking',
      code: 'SHIFT_CONTEXT_MISSING',
      message: 'A shift time has no preceding recognized context.',
      source_reference: { sheetIndex: 3, sheetName: 'Week', address: 'C12' },
      related_sources: [],
      resolution: null,
      resolved_at: null,
      total_count: 1,
    }])[0].source_reference?.address).toBe('C12')
  })

  it('keeps the verified candidate breakdown reconciled', () => {
    expect(140 + 56 + 82 + 9_130).toBe(verifiedWorkbookBaseline.candidateCount)
  })
})
