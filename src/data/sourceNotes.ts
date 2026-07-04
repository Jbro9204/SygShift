export interface ImportedScheduleNote {
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
  assignee: ['Imported schedule assignee', 'Bible source assignee'],
  context: ['Imported schedule context', 'Bible source context'],
  sheet: 'Source sheet',
  timeCell: 'Source time cell',
  qualification: 'Qualification source',
  status: 'Assignment status',
} as const

function readNoteField(notes: string, label: string | readonly string[]): string | null {
  const labels = Array.isArray(label) ? label : [label]
  const line = notes
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => labels.some((candidate) => entry.toLocaleLowerCase().startsWith(`${candidate.toLocaleLowerCase()}:`)))

  const matchedLabel = line
    ? labels.find((candidate) => line.toLocaleLowerCase().startsWith(`${candidate.toLocaleLowerCase()}:`))
    : null
  const value = matchedLabel ? line?.slice(matchedLabel.length + 1).trim() : null
  return value ? value : null
}

function isOperationalOpenLabel(value: string | null): boolean {
  const label = value?.trim().toLocaleLowerCase() ?? ''
  if (!label) return true
  if (['open', 'open / blank', 'blank', 'none', 'n/a', 'na', 'no named guard'].includes(label)) return true
  if (/^\d+(?:\.\d+)?\s*(?:hr|hrs|hour|hours)$/.test(label)) return true
  if (/\bno coverage\b|\bholiday\b|\bcalled out\b|\bno show\b|\btraining\b|\bmay cancel\b/.test(label)) return true
  if (/\b\d+\s*armed\b|\barmed guards?\b|\bunarmed\b/.test(label)) return true
  if (/^asked\s+/.test(label)) return true
  return false
}

export function parseImportedScheduleNote(notes: string | null | undefined): ImportedScheduleNote {
  const text = notes?.trim() ?? ''
  const status = readNoteField(text, NOTE_FIELD_LABELS.status)
  const guardrail = readNoteField(text, 'Assignment import skipped by system guardrail')
  const assignee = readNoteField(text, NOTE_FIELD_LABELS.assignee)
  const supervisorResolved = /supervisor reviewed|supervisor resolution/i.test(text)
  const openOrNoteOnlySource = assignee !== null && isOperationalOpenLabel(assignee)
  const reviewNeeded = !supervisorResolved
    && !openOrNoteOnlySource
    && /needs supervisor review|import skipped by system guardrail/i.test(text)

  return {
    assignee,
    context: readNoteField(text, NOTE_FIELD_LABELS.context),
    sheet: readNoteField(text, NOTE_FIELD_LABELS.sheet),
    timeCell: readNoteField(text, NOTE_FIELD_LABELS.timeCell),
    qualification: readNoteField(text, NOTE_FIELD_LABELS.qualification),
    status,
    reviewNeeded,
    importGuardrail: guardrail,
  }
}

export function sourceReferenceLabel(source: Pick<ImportedScheduleNote, 'sheet' | 'timeCell'>): string | null {
  if (source.sheet && source.timeCell) return `${source.sheet}, cell ${source.timeCell}`
  if (source.sheet) return source.sheet
  if (source.timeCell) return `Cell ${source.timeCell}`
  return null
}
