export const workforceActivityOutcomeValues = [
  'worked_as_scheduled',
  'replacement_worked',
  'worked_not_scheduled',
  'salary_worked_confirmed',
  'scheduled_no_work_record',
  'called_off',
  'open_unassigned',
  'needs_time_correction',
] as const

export type WorkforceActivityOutcome = typeof workforceActivityOutcomeValues[number]

export interface WorkforceActivityRow {
  id: string
  operationalDate: string
  employeeId: string | null
  employeeName: string | null
  employeeNumber: string | null
  employmentType: string | null
  shiftId: string | null
  assignmentId: string | null
  clientId: string | null
  clientName: string | null
  eventId: string | null
  eventName: string | null
  siteId: string | null
  siteCode: string | null
  siteName: string | null
  postId: string | null
  postName: string | null
  locationLabel: string
  locationDetail: string | null
  timeZone: string
  scheduledStartAt: string | null
  scheduledEndAt: string | null
  scheduledMinutes: number | null
  actualStartAt: string | null
  actualEndAt: string | null
  workedMinutes: number | null
  unpaidBreakMinutes: number | null
  outcome: WorkforceActivityOutcome
  payrollReady: boolean
  notes: string[]
}

export interface WorkforceActivityExportMetadata {
  filterDescription: string
  fromDate: string
  generatedAt: string
  throughDate: string
}
