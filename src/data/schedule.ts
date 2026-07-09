import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const assignedEmployeeSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  preferred_name: z.string().nullable(),
})

const assignmentSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['assigned', 'confirmed', 'canceled', 'completed']),
  employee: assignedEmployeeSchema,
})

const postSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  site: z.object({
    id: z.string().uuid(),
    code: z.string().nullable(),
    name: z.string(),
  }),
})

const eventSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  location_name: z.string().nullable(),
  site: z.object({
    id: z.string().uuid(),
    code: z.string().nullable(),
    name: z.string(),
  }).nullable(),
})

const shiftSchema = z.object({
  id: z.string().uuid(),
  starts_at: z.string(),
  ends_at: z.string(),
  time_zone: z.string(),
  headcount_required: z.number().int().positive(),
  requires_armed: z.boolean(),
  is_open: z.boolean(),
  is_overtime: z.boolean(),
  notes: z.string().nullable(),
  post: postSchema.nullable(),
  event: eventSchema.nullable(),
  assignments: z.array(assignmentSchema),
})

const scheduleSchema = z.object({
  id: z.string().uuid(),
  week_starts_on: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(['draft', 'published', 'superseded', 'archived']),
  published_at: z.string().nullable(),
  shifts: z.array(shiftSchema),
})

export type WeeklySchedule = z.infer<typeof scheduleSchema>
export type ScheduleShift = z.infer<typeof shiftSchema>

const builderPostSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  requires_armed: z.boolean(),
  site: z.object({
    id: z.string().uuid(),
    code: z.string().nullable(),
    name: z.string(),
    time_zone: z.string(),
  }),
})

const builderOptionsSchema = z.object({
  posts: z.array(builderPostSchema),
  employees: z.array(z.object({
    id: z.string().uuid(),
    first_name: z.string(),
    last_name: z.string(),
    preferred_name: z.string().nullable(),
    role: z.enum(['guard', 'dispatcher', 'scheduler', 'supervisor', 'admin']),
    employment_type: z.enum(['hourly', 'salary', 'contractor']),
    has_armed_guard_credential: z.boolean(),
  })),
})

const createOpenShiftResultSchema = z.object({
  schedule_id: z.string().uuid(),
  schedule_revision: z.number().int().positive(),
  shift_id: z.string().uuid(),
  assignment_id: z.string().uuid().nullable().optional(),
  event_id: z.string().uuid().nullable(),
  announcement_id: z.string().uuid().nullable(),
  starts_at: z.string(),
  ends_at: z.string(),
  time_zone: z.string(),
})

const resolveReviewShiftResultSchema = z.object({
  schedule_id: z.string().uuid(),
  schedule_revision: z.number().int().positive(),
  shift_id: z.string().uuid(),
  employee_id: z.string().uuid(),
})

const staffingSuggestionSchema = z.object({
  shiftId: z.string().uuid(),
  openSlots: z.number().int().nonnegative(),
  suggestions: z.array(z.object({
    employeeId: z.string().uuid(),
    name: z.string(),
    role: z.enum(['guard', 'dispatcher', 'scheduler', 'supervisor', 'admin']),
    employmentType: z.enum(['hourly', 'salary', 'contractor']),
    hasArmedCredential: z.boolean(),
    reason: z.string(),
  })),
})

export type ScheduleBuilderOptions = z.infer<typeof builderOptionsSchema>
export type ScheduleBuilderPost = z.infer<typeof builderPostSchema>
export type ScheduleBuilderEmployee = ScheduleBuilderOptions['employees'][number]
export type CreateOpenShiftResult = z.infer<typeof createOpenShiftResultSchema>
export type ResolveReviewShiftResult = z.infer<typeof resolveReviewShiftResultSchema>
export type StaffingSuggestion = z.infer<typeof staffingSuggestionSchema>

const importedScheduleShiftSchema = z.object({
  id: z.string().uuid(),
  candidateKey: z.string(),
  reviewStatus: z.string(),
  localDate: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  crossesMidnight: z.boolean(),
  contextLabel: z.string().nullable(),
  siteKeyCandidate: z.string().nullable(),
  assigneeLabel: z.string().nullable(),
  openCandidate: z.boolean(),
  qualificationCandidate: z.string().nullable(),
  confidence: z.string().nullable(),
  sourceTimeAddress: z.string().nullable(),
  sourceAssignmentAddress: z.string().nullable(),
})

const importedSchedulePreviewSchema = z.object({
  importRunId: z.string().uuid(),
  weekStartsOn: z.string(),
  weekEndsOn: z.string().nullable(),
  sourceSheetName: z.string().nullable(),
  sourceSheetIndex: z.number().int().nullable(),
  blockingIssueCount: z.number().int().nonnegative(),
  warningIssueCount: z.number().int().nonnegative(),
  shifts: z.array(importedScheduleShiftSchema),
})

export type ImportedSchedulePreview = z.infer<typeof importedSchedulePreviewSchema>
export type ImportedScheduleShift = z.infer<typeof importedScheduleShiftSchema>

export interface ImportedScheduleRow {
  id: string
  name: string
  qualification: string | null
  shifts: ImportedScheduleShift[]
}

export interface CreateOpenShiftInput {
  weekStartsOn: string
  mode: 'post' | 'event'
  postId?: string | null
  eventName?: string
  eventLocationName?: string
  eventSiteId?: string | null
  eventTimeZone?: string
  eventRequiresArmed?: boolean
  shiftDate: string
  startTime: string
  endTime: string
  headcount: number
  isOvertime: boolean
  notes?: string
  publishAnnouncement: boolean
  employeeId?: string | null
}

export interface UpdateDraftShiftInput {
  shiftId: string
  shiftDate: string
  startTime: string
  endTime: string
  headcount: number
  isOpen: boolean
  isOvertime: boolean
  notes?: string
  employeeId?: string | null
}

export interface ScheduleRow {
  id: string
  code: string | null
  name: string
  type: 'site' | 'event'
  shifts: ScheduleShift[]
}

export interface EmployeeScheduleRow {
  id: string
  name: string
  shifts: ScheduleShift[]
}

export async function getWeeklySchedule(weekStartsOn: string): Promise<WeeklySchedule | null> {
  const { data, error } = await getSupabaseClient().rpc('get_weekly_schedule_payload', {
    target_week_starts_on: weekStartsOn,
  })

  if (error) throw new Error('The weekly schedule could not be loaded for this account.')
  if (!data) return null

  const schedule = scheduleSchema.parse(data)
  return {
    ...schedule,
    shifts: schedule.shifts.map((shift) => ({
      ...shift,
      assignments: shift.assignments.filter((assignment) => assignment.status !== 'canceled'),
    })),
  }
}

export async function getScheduleBuilderOptions(): Promise<ScheduleBuilderOptions> {
  const { data, error } = await getSupabaseClient().rpc('get_schedule_builder_options')
  if (error) throw new Error('Schedule builder options could not be loaded.')
  return builderOptionsSchema.parse(data)
}

export async function getImportedSchedulePreview(weekStartsOn: string): Promise<ImportedSchedulePreview | null> {
  const { data, error } = await getSupabaseClient().rpc('get_imported_schedule_preview', {
    target_week_starts_on: weekStartsOn,
  })

  if (error) throw new Error('The imported source schedule could not be loaded.')
  if (!data) return null
  return importedSchedulePreviewSchema.parse(data)
}

export async function createSupervisorOpenShift(input: CreateOpenShiftInput): Promise<CreateOpenShiftResult> {
  const { data, error } = await getSupabaseClient().rpc('create_supervisor_open_shift', {
    target_week_starts_on: input.weekStartsOn,
    target_post_id: input.mode === 'post' ? input.postId : null,
    event_name: input.mode === 'event' ? input.eventName?.trim() : null,
    event_location_name: input.mode === 'event' ? input.eventLocationName?.trim() : null,
    event_site_id: input.mode === 'event' ? input.eventSiteId ?? null : null,
    event_time_zone: input.mode === 'event' ? input.eventTimeZone?.trim() || 'America/Denver' : null,
    event_requires_armed: input.mode === 'event' ? input.eventRequiresArmed ?? false : false,
    shift_operational_date: input.shiftDate,
    shift_start_time: input.startTime,
    shift_end_time: input.endTime,
    target_headcount: input.headcount,
    target_is_overtime: input.isOvertime,
    target_notes: input.notes?.trim() || null,
    publish_announcement: input.publishAnnouncement,
    target_employee_id: input.employeeId || null,
  })

  if (error) throw new Error(error.message || 'The open shift could not be created.')
  return createOpenShiftResultSchema.parse(data)
}

export async function ensureScheduleDraft(weekStartsOn: string): Promise<WeeklySchedule | null> {
  const { data, error } = await getSupabaseClient().rpc('ensure_schedule_draft', {
    target_week_starts_on: weekStartsOn,
  })

  if (error) throw new Error(error.message || 'The schedule draft could not be opened.')
  if (!data) return null
  return scheduleSchema.parse(data)
}

export async function updateScheduleDraftShift(input: UpdateDraftShiftInput): Promise<WeeklySchedule> {
  const { data, error } = await getSupabaseClient().rpc('update_schedule_draft_shift', {
    target_shift_id: input.shiftId,
    shift_operational_date: input.shiftDate,
    shift_start_time: input.startTime,
    shift_end_time: input.endTime,
    target_headcount: input.headcount,
    target_is_open: input.isOpen,
    target_is_overtime: input.isOvertime,
    target_notes: input.notes?.trim() || null,
    target_employee_id: input.employeeId || null,
  })

  if (error) throw new Error(error.message || 'The draft shift could not be updated.')
  return scheduleSchema.parse(data)
}

export async function publishScheduleDraft(scheduleId: string): Promise<WeeklySchedule> {
  const { data, error } = await getSupabaseClient().rpc('publish_schedule_draft', {
    target_schedule_id: scheduleId,
  })

  if (error) throw new Error(error.message || 'The schedule draft could not be published.')
  return scheduleSchema.parse(data)
}

export async function cancelScheduleDraft(scheduleId: string): Promise<WeeklySchedule | null> {
  const { data, error } = await getSupabaseClient().rpc('cancel_schedule_draft', {
    target_schedule_id: scheduleId,
  })

  if (error) throw new Error(error.message || 'The schedule draft could not be canceled.')
  if (!data) return null
  return scheduleSchema.parse(data)
}

export async function getScheduleStaffingSuggestions(scheduleId: string): Promise<StaffingSuggestion[]> {
  const { data, error } = await getSupabaseClient().rpc('get_schedule_staffing_suggestions', {
    target_schedule_id: scheduleId,
  })

  if (error) throw new Error(error.message || 'Staffing suggestions could not be loaded.')
  return z.array(staffingSuggestionSchema).parse(data ?? [])
}

export async function resolveScheduleReviewShift(input: {
  shiftId: string
  employeeId: string
  note: string | null
}): Promise<ResolveReviewShiftResult> {
  const { data, error } = await getSupabaseClient().rpc('resolve_schedule_review_shift', {
    target_shift_id: input.shiftId,
    target_employee_id: input.employeeId,
    resolution_note: input.note?.trim() || null,
  })

  if (error) throw new Error(error.message || 'The review item could not be resolved.')
  return resolveReviewShiftResultSchema.parse(data)
}

export function scheduleRows(schedule: WeeklySchedule): ScheduleRow[] {
  const rows = new Map<string, ScheduleRow>()

  for (const shift of schedule.shifts) {
    const site = shift.post?.site ?? shift.event?.site
    const id = site?.id ?? `event:${shift.event?.id ?? shift.id}`
    const row = rows.get(id) ?? {
      id,
      code: site?.code ?? null,
      name: site?.name ?? shift.event?.location_name ?? shift.event?.name ?? 'Event',
      type: site ? 'site' : 'event',
      shifts: [],
    }
    row.shifts.push(shift)
    rows.set(id, row)
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      shifts: [...row.shifts].sort((left, right) => left.starts_at.localeCompare(right.starts_at)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function employeeScheduleRows(schedule: WeeklySchedule): EmployeeScheduleRow[] {
  const rows = new Map<string, EmployeeScheduleRow>()

  for (const shift of schedule.shifts) {
    for (const assignment of shift.assignments) {
      const employee = assignment.employee
      const row = rows.get(employee.id) ?? {
        id: employee.id,
        name: assignmentName(assignment),
        shifts: [],
      }
      row.shifts.push(shift)
      rows.set(employee.id, row)
    }
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      shifts: [...row.shifts].sort((left, right) => left.starts_at.localeCompare(right.starts_at)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function importedScheduleRows(schedule: ImportedSchedulePreview): ImportedScheduleRow[] {
  const rows = new Map<string, ImportedScheduleRow>()

  for (const shift of schedule.shifts) {
    const name = shift.contextLabel ?? 'Unlabeled source row'
    const id = shift.siteKeyCandidate ?? name.toLocaleLowerCase()
    const row = rows.get(id) ?? {
      id,
      name,
      qualification: shift.qualificationCandidate,
      shifts: [],
    }
    row.shifts.push(shift)
    if (!row.qualification && shift.qualificationCandidate) row.qualification = shift.qualificationCandidate
    rows.set(id, row)
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      shifts: [...row.shifts].sort((left, right) =>
        `${left.localDate} ${left.startTime} ${left.candidateKey}`.localeCompare(`${right.localDate} ${right.startTime} ${right.candidateKey}`),
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}


export function shiftOperationalDate(shift: ScheduleShift): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: shift.time_zone,
  }).formatToParts(new Date(shift.starts_at))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function shiftTimeRange(shift: ScheduleShift): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: shift.time_zone,
  })
  return `${formatter.format(new Date(shift.starts_at))} – ${formatter.format(new Date(shift.ends_at))}`
}

export function assignmentName(assignment: ScheduleShift['assignments'][number]): string {
  const employee = assignment.employee
  return `${employee.preferred_name || employee.first_name} ${employee.last_name}`
}
