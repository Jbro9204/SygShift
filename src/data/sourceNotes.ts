export interface BibleSourceNote {
  assignee: string | null
  context: string | null
  sheet: string | null
  timeCell: string | null
  qualification: string | null
  status: string | null
  reviewNeeded: boolean
  importGuardrail: string | null
}

const NOTE_FIELD_LABELS = {
  assignee: 'Bible source assignee',
  context: 'Bible source context',
  sheet: 'Source sheet',
  timeCell: 'Source time cell',
  qualification: 'Qualification source',
  status: 'Assignment status',
} as const

function readNoteField(notes: string, label: string): string | null {
  const line = notes
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.toLocaleLowerCase().startsWith(`${label.toLocaleLowerCase()}:`))

  const value = line?.slice(label.length + 1).trim()
  return value ? value : null
}

export function parseBibleSourceNote(notes: string | null | undefined): BibleSourceNote {
  const text = notes?.trim() ?? ''
  const status = readNoteField(text, NOTE_FIELD_LABELS.status)
  const guardrail = readNoteField(text, 'Assignment import skipped by system guardrail')
  const supervisorResolved = /supervisor reviewed|supervisor resolution/i.test(text)
  const reviewNeeded = !supervisorResolved && /needs supervisor review|import skipped by system guardrail/i.test(text)

  return {
    assignee: readNoteField(text, NOTE_FIELD_LABELS.assignee),
    context: readNoteField(text, NOTE_FIELD_LABELS.context),
    sheet: readNoteField(text, NOTE_FIELD_LABELS.sheet),
    timeCell: readNoteField(text, NOTE_FIELD_LABELS.timeCell),
    qualification: readNoteField(text, NOTE_FIELD_LABELS.qualification),
    status,
    reviewNeeded,
    importGuardrail: guardrail,
  }
}

export function sourceReferenceLabel(source: Pick<BibleSourceNote, 'sheet' | 'timeCell'>): string | null {
  if (source.sheet && source.timeCell) return `${source.sheet}, cell ${source.timeCell}`
  if (source.sheet) return source.sheet
  if (source.timeCell) return `Cell ${source.timeCell}`
  return null
}
