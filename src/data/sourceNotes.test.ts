import { describe, expect, it } from 'vitest'
import { parseBibleSourceNote, sourceReferenceLabel } from './sourceNotes'

describe('Bible source note parsing', () => {
  it('extracts supervisor review fields from promoted Bible shifts', () => {
    const source = parseBibleSourceNote([
      'Bible source assignee: Jordan Brown',
      'Bible source context: PERA-Denver - Armed',
      'Source sheet: July 5th to July 11th',
      'Source time cell: C12',
      'Qualification source: armed',
      'Assignment status: needs supervisor review before payroll reliance.',
    ].join('\n'))

    expect(source).toMatchObject({
      assignee: 'Jordan Brown',
      context: 'PERA-Denver - Armed',
      sheet: 'July 5th to July 11th',
      timeCell: 'C12',
      qualification: 'armed',
      reviewNeeded: true,
    })
    expect(sourceReferenceLabel(source)).toBe('July 5th to July 11th, cell C12')
  })

  it('does not flag exact matched assignments for review', () => {
    const source = parseBibleSourceNote([
      'Bible source assignee: Alex Rivera',
      'Assignment status: matched from reviewed/exact source label.',
    ].join('\n'))

    expect(source.reviewNeeded).toBe(false)
    expect(source.assignee).toBe('Alex Rivera')
  })

  it('flags guardrail skips even if no structured assignment status is present', () => {
    const source = parseBibleSourceNote(
      'Assignment import skipped by system guardrail: employee already overlaps this time window',
    )

    expect(source.reviewNeeded).toBe(true)
    expect(source.importGuardrail).toBe('employee already overlaps this time window')
  })
})
