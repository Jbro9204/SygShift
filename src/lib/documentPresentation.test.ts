import { describe, expect, it } from 'vitest'
import {
  libraryAllowsWorkingCopy,
  libraryKindLabel,
  libraryPrimaryActionLabel,
  presentDocumentRecord,
  type DocumentSourceReference,
} from './documentPresentation'

function source(overrides: Partial<DocumentSourceReference> = {}): DocumentSourceReference {
  return {
    code: 'GS-HR-700',
    documentKind: 'hr_source',
    lifecycleStatus: 'adopted',
    purpose: 'Record a voluntary resignation.',
    recordClass: 'Personnel File / Separation',
    section: '01_FORMS/07_Separation',
    sourceFilename: 'GS-HR-700.pdf',
    sourceType: 'controlled_form',
    title: 'Voluntary Resignation Acknowledgment',
    ...overrides,
  }
}

describe('document library presentation', () => {
  it('keeps controlled sources distinct from completed employee and company records', () => {
    expect(presentDocumentRecord({ employeeId: null }, source())).toMatchObject({
      actionLabel: 'Start a new form',
      kind: 'controlled_form_source',
      label: 'Reusable controlled form',
      workingCopyAllowed: true,
    })
    expect(presentDocumentRecord({ employeeId: '11111111-1111-4111-8111-111111111111' }, null)).toMatchObject({
      kind: 'employee_record',
      label: 'Employee record',
    })
    expect(presentDocumentRecord({ employeeId: null }, null)).toMatchObject({
      kind: 'company_record',
      label: 'Company record',
    })
  })

  it('uses read-only reference actions for guides, policies, and training material', () => {
    const guide = source({ documentKind: 'document_guide', sourceType: 'reference_material' })
    expect(presentDocumentRecord({ employeeId: null }, guide)).toMatchObject({
      actionLabel: 'Preview guide or policy',
      kind: 'guide_policy_source',
      workingCopyAllowed: false,
    })
    expect(libraryAllowsWorkingCopy(guide)).toBe(false)
    expect(libraryAllowsWorkingCopy(source({ documentKind: 'training_module', sourceType: 'training_reference' }))).toBe(false)
    expect(libraryPrimaryActionLabel(guide)).toBe('Preview guide or policy')
    expect(libraryKindLabel(guide)).toBe('Guide or policy source')
  })

  it('allows new working copies only for form-like library sources', () => {
    expect(libraryAllowsWorkingCopy(source())).toBe(true)
    const trainingForm = source({ documentKind: 'training_form', sourceType: 'training_form' })
    expect(libraryAllowsWorkingCopy(trainingForm)).toBe(true)
    expect(libraryPrimaryActionLabel(trainingForm)).toBe('Start a training form')
  })

  it('does not treat broad hr_source records as forms when catalog metadata identifies reference material', () => {
    const operationsManual = source({
      code: 'GS-HR-GUIDE-100',
      recordClass: 'HR Governance / Operations Manual',
      section: '02_GUIDES/00_Core',
      sourceType: 'reference_material',
      title: 'Human Resources Operations Manual',
    })
    const jobDescription = source({
      code: 'GS-JD-100',
      recordClass: 'Recruiting / Job Descriptions',
      section: '04_EXP/02_Jobs_Recruit',
      sourceType: 'reference_material',
      title: 'Unarmed Security Officer',
    })

    expect(presentDocumentRecord({ employeeId: null }, operationsManual)).toMatchObject({
      actionLabel: 'Preview reference source',
      kind: 'guide_policy_source',
      workingCopyAllowed: false,
    })
    expect(libraryAllowsWorkingCopy(jobDescription)).toBe(false)
    expect(libraryKindLabel(jobDescription)).toBe('Guide, handbook, or role reference')
  })

  it('keeps a job-description template editable when it is not an issued role description', () => {
    const template = source({
      code: 'GS-HR-110',
      recordClass: 'Job Architecture / Controlled Template',
      section: '04_EXP/02_Jobs_Recruit',
      title: 'Master Job Description Template',
    })
    expect(libraryAllowsWorkingCopy(template)).toBe(true)
  })

  it('starts guided working copies from available draft forms while retired sources remain blocked', () => {
    const draft = source({ lifecycleStatus: 'draft_for_adoption' })
    const retired = source({ lifecycleStatus: 'retired' })
    expect(presentDocumentRecord({ employeeId: null }, draft)).toMatchObject({
      actionLabel: 'Start guided form',
      label: 'Available controlled form source',
      workingCopyAllowed: true,
    })
    expect(libraryAllowsWorkingCopy(draft)).toBe(true)
    expect(libraryAllowsWorkingCopy(retired)).toBe(false)
    expect(libraryPrimaryActionLabel(retired)).toBe('Preview retired source')
  })

  it('keeps available draft reference material read-only without requiring approval to preview it', () => {
    const draftReference = source({ lifecycleStatus: 'draft_for_adoption', sourceType: 'reference_material' })
    expect(presentDocumentRecord({ employeeId: null }, draftReference)).toMatchObject({
      actionLabel: 'Preview reference source',
      label: 'Guide, handbook, or role reference',
      workingCopyAllowed: false,
    })
  })

  it('uses explicit subtype metadata before broad hr_source or title wording', () => {
    const explicitReference = source({ sourceType: 'reference_material', title: 'Operational Record' })
    const titleOnlyManual = source({
      code: 'GS-HR-999',
      recordClass: 'Controlled Template',
      section: '01_FORMS/00_Control',
      title: 'Manual Adjustment Form',
    })
    expect(libraryAllowsWorkingCopy(explicitReference)).toBe(false)
    expect(libraryAllowsWorkingCopy(titleOnlyManual)).toBe(true)
  })

  it('keeps an omitted or unclassified source subtype preview-only', () => {
    const missingSubtype = source({ sourceType: undefined })
    const unclassified = source({ lifecycleStatus: 'adopted', sourceType: 'unclassified' })
    expect(libraryAllowsWorkingCopy(missingSubtype)).toBe(false)
    expect(presentDocumentRecord({ employeeId: null }, unclassified)).toMatchObject({
      label: 'Source classification pending',
      workingCopyAllowed: false,
    })
  })

  it('fails closed when a rollout fallback cannot classify a company record', () => {
    expect(presentDocumentRecord({ employeeId: null }, undefined)).toMatchObject({
      actionLabel: 'Preview saved file',
      label: 'Classification pending',
      workingCopyAllowed: false,
    })
  })
})
