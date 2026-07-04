import { describe, expect, it } from 'vitest'
import { parseImportedScheduleNote, sourceReferenceLabel } from './sourceNotes'

describe('imported schedule note parsing', () => {
  it('extracts supervisor review fields from promoted imported shifts', () => {
    const source = parseImportedScheduleNote([
      'Imported schedule assignee: Jordan Brown',
      'Imported schedule context: PERA-Denver - Armed',
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
    const source = parseImportedScheduleNote([
      'Imported schedule assignee: Alex Rivera',
      'Assignment status: matched from reviewed/exact source label.',
    ].join('\n'))

    expect(source.reviewNeeded).toBe(false)
    expect(source.assignee).toBe('Alex Rivera')
  })

  it('flags guardrail skips even if no structured assignment status is present', () => {
    const source = parseImportedScheduleNote(
      'Assignment import skipped by system guardrail: employee already overlaps this time window',
    )

    expect(source.reviewNeeded).toBe(true)
    expect(source.importGuardrail).toBe('employee already overlaps this time window')
  })

  it('does not treat true open or note-only source labels as employee exceptions', () => {
    const openShift = parseImportedScheduleNote([
      'Imported schedule assignee: Open / blank',
      'Assignment status: needs supervisor review before payroll reliance.',
    ].join('\n'))
    const durationNote = parseImportedScheduleNote([
      'Imported schedule assignee: 8.5 hrs',
      'Assignment status: needs supervisor review before payroll reliance.',
    ].join('\n'))

    expect(openShift.reviewNeeded).toBe(false)
    expect(durationNote.reviewNeeded).toBe(false)
  })

  it('keeps resolved source history without leaving the shift in review state', () => {
    const source = parseImportedScheduleNote([
      'Imported schedule assignee: Jordan Brown',
      'Assignment status: supervisor reviewed and assigned.',
      'Assignment import skipped by system guardrail: resolved by supervisor revision.',
      'Supervisor resolution: assigned by supervisor on 2026-07-04 06:20:00 UTC',
    ].join('\n'))

    expect(source.reviewNeeded).toBe(false)
    expect(source.assignee).toBe('Jordan Brown')
  })
})
