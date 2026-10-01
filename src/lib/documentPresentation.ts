import type { HrDocumentRecord } from '../data/hrDocuments'
import type { HrDocumentLibraryItem } from '../data/hrDocumentLibrary'

export type DocumentRecordKind =
  | 'company_record'
  | 'controlled_form_source'
  | 'employee_record'
  | 'guide_policy_source'
  | 'training_source'

export interface DocumentRecordPresentation {
  actionLabel: string
  description: string
  kind: DocumentRecordKind
  label: string
  workingCopyAllowed: boolean
}

export type DocumentSourceType = 'controlled_form' | 'reference_material' | 'training_form' | 'training_reference' | 'unclassified'

export type DocumentSourceReference = Pick<
  HrDocumentLibraryItem,
  'code' | 'documentKind' | 'lifecycleStatus' | 'purpose' | 'recordClass' | 'section' | 'sourceFilename' | 'title'
> & { sourceType?: DocumentSourceType }

const sourcePresentations: Record<HrDocumentLibraryItem['documentKind'], DocumentRecordPresentation> = {
  document_guide: {
    actionLabel: 'Preview guide or policy',
    description: 'Reusable reference material. Open it from the Guides & policies library; do not file the unchanged source as completed work.',
    kind: 'guide_policy_source',
    label: 'Guide or policy source',
    workingCopyAllowed: false,
  },
  hr_source: {
    actionLabel: 'Start a new form',
    description: 'Reusable controlled form. Each employee or company action should begin from a new working copy.',
    kind: 'controlled_form_source',
    label: 'Reusable controlled form',
    workingCopyAllowed: true,
  },
  training_admin: {
    actionLabel: 'Preview training reference',
    description: 'Reusable training-administration material. The protected source remains unchanged.',
    kind: 'training_source',
    label: 'Training reference source',
    workingCopyAllowed: false,
  },
  training_form: {
    actionLabel: 'Start a training form',
    description: 'Reusable training form. Start a new working copy for each completed record.',
    kind: 'training_source',
    label: 'Reusable training form',
    workingCopyAllowed: true,
  },
  training_module: {
    actionLabel: 'Preview training material',
    description: 'Reusable training material. The protected source remains unchanged.',
    kind: 'training_source',
    label: 'Training material source',
    workingCopyAllowed: false,
  },
}

const hrReferencePresentation: DocumentRecordPresentation = {
  actionLabel: 'Preview reference source',
  description: 'Reusable company reference material. Review or download the protected source without creating a completed employee form from it.',
  kind: 'guide_policy_source',
  label: 'Guide, handbook, or role reference',
  workingCopyAllowed: false,
}

/**
 * Source subtype is reviewed and stored with the catalog item. Never infer an
 * editable form from the historically broad `hr_source` storage kind.
 */
export function isHrReferenceSource(source: DocumentSourceReference): boolean {
  return source.sourceType === 'reference_material'
}

function lifecyclePresentation(
  source: DocumentSourceReference,
  base: DocumentRecordPresentation,
): DocumentRecordPresentation {
  if (source.lifecycleStatus === 'adopted') return base
  const retired = source.lifecycleStatus === 'retired'
  const typeLabel = base.kind === 'controlled_form_source'
    ? 'controlled form source'
    : base.kind === 'training_source'
      ? 'training source'
      : 'guide, handbook, or reference source'
  return {
    ...base,
    actionLabel: retired ? 'Preview retired source' : 'Preview draft source',
    description: retired
      ? 'Retired company-library source. It remains available for historical reference but cannot start new work.'
      : 'Draft company-library source awaiting formal adoption. It may be reviewed, but it cannot start a working copy yet.',
    label: retired ? `Retired ${typeLabel}` : `Draft ${typeLabel}`,
    workingCopyAllowed: false,
  }
}

function presentationForSource(source: DocumentSourceReference): DocumentRecordPresentation {
  if (!source.sourceType || source.sourceType === 'unclassified') {
    const retired = source.lifecycleStatus === 'retired'
    return {
      actionLabel: retired ? 'Preview retired source' : source.lifecycleStatus === 'draft_for_adoption' ? 'Preview draft source' : 'Preview source',
      description: 'The source subtype has not been reviewed. Preview remains available, but this item cannot start a working copy.',
      kind: 'guide_policy_source',
      label: retired ? 'Retired source · classification pending' : source.lifecycleStatus === 'draft_for_adoption' ? 'Draft source · classification pending' : 'Source classification pending',
      workingCopyAllowed: false,
    }
  }
  const base = source.sourceType === 'reference_material'
    ? source.documentKind === 'document_guide' ? sourcePresentations.document_guide : hrReferencePresentation
    : source.sourceType === 'training_form'
      ? sourcePresentations.training_form
      : source.sourceType === 'training_reference'
        ? source.documentKind === 'training_admin' ? sourcePresentations.training_admin : sourcePresentations.training_module
        : sourcePresentations.hr_source
  return lifecyclePresentation(source, base)
}

export function presentDocumentRecord(
  document: Pick<HrDocumentRecord, 'employeeId'>,
  source: DocumentSourceReference | null | undefined,
): DocumentRecordPresentation {
  if (source === undefined) {
    return {
      actionLabel: 'Preview saved file',
      description: 'Source classification is temporarily unavailable. Preview remains available, but editing and lifecycle changes are paused until classification loads.',
      kind: 'company_record',
      label: 'Classification pending',
      workingCopyAllowed: false,
    }
  }
  if (source !== null) return presentationForSource(source)
  if (document.employeeId) {
    return {
      actionLabel: 'Create an editable copy',
      description: 'Completed or uploaded evidence filed to one employee record.',
      kind: 'employee_record',
      label: 'Employee record',
      workingCopyAllowed: true,
    }
  }
  return {
    actionLabel: 'Create an editable copy',
    description: 'Completed or uploaded company record that is not a reusable library source.',
    kind: 'company_record',
    label: 'Company record',
    workingCopyAllowed: true,
  }
}

export function libraryKindLabel(source: DocumentSourceReference): string {
  return presentationForSource(source).label
}

export function libraryPrimaryActionLabel(source: DocumentSourceReference): string {
  return presentationForSource(source).actionLabel
}

export function libraryAllowsWorkingCopy(source: DocumentSourceReference): boolean {
  return presentationForSource(source).workingCopyAllowed
}
