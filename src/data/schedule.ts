import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { formatDualTimeRange } from '../lib/time'
import { employeeScheduleDisplayName, employeeScheduleGivenName } from '../lib/employeeName'

const assignedEmployeeSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  preferred_name: z.string().nullable(),
  employee_number: z.string().nullable(),
})

const assignmentOverrideSchema = z.object({
  kind: z.enum(['availability', 'armed_credential', 'scheduled_overtime']),
  note: z.string(),
  createdAt: z.string().nullable().optional(),
})

const assignmentSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['assigned', 'confirmed', 'canceled', 'completed']),
  employee: assignedEmployeeSchema,
  overrides: z.array(assignmentOverrideSchema).optional(),
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
  assignment_type: z.enum(['standard', 'dispatch_phone_duty']).optional(),
  work_type: z.enum(['post', 'training']).optional(),
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
    employee_number: z.string().nullable(),
    role: z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin']),
    employment_type: z.enum(['hourly', 'salary', 'flex']),
    time_zone: z.string().default('America/Denver'),
    has_armed_guard_credential: z.boolean(),
  })),
})

const createOpenShiftResultSchema = z.object({
  schedule_id: z.string().uuid(),
  schedule_revision: z.number().int().positive(),
  shift_id: z.string().uuid(),
  assignment_id: z.string().uuid().nullable().optional(),
  event_id: z.string().uuid().nullable().optional(),
  announcement_id: z.string().uuid().nullable().optional(),
  starts_at: z.string(),
  ends_at: z.string(),
  time_zone: z.string(),
})

const createCoveragePlanResultSchema = z.object({
  schedule_id: z.string().uuid(),
  schedule_revision: z.number().int().positive(),
  shift_ids: z.array(z.string().uuid()).min(1),
  armed_shift_id: z.string().uuid().nullable(),
  unarmed_shift_id: z.string().uuid().nullable(),
  assignment_id: z.string().uuid().nullable().optional(),
  event_id: z.string().uuid().nullable().optional(),
  announcement_id: z.string().uuid().nullable().optional(),
  starts_at: z.string(),
  ends_at: z.string(),
  time_zone: z.string(),
  headcount: z.number().int().positive(),
  armed_headcount: z.number().int().nonnegative(),
  unarmed_headcount: z.number().int().nonnegative(),
})

const shiftWorkTypeMapSchema = z.array(z.object({
  shiftId: z.string().uuid(),
  workType: z.enum(['post', 'training']),
}))

const shiftAssignmentTypeMapSchema = z.array(z.object({
  shiftId: z.string().uuid(),
  assignmentType: z.enum(['standard', 'dispatch_phone_duty']),
}))

const resolveReviewShiftResultSchema = z.object({
  schedule_id: z.string().uuid(),
  schedule_revision: z.number().int().positive(),
  shift_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  retained_current_assignment: z.boolean().optional(),
})

const staffingSuggestionSchema = z.object({
  shiftId: z.string().uuid(),
  openSlots: z.number().int().nonnegative(),
  suggestions: z.array(z.object({
    employeeId: z.string().uuid(),
    name: z.string(),
    role: z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin']),
    employmentType: z.enum(['hourly', 'salary', 'flex']),
    hasArmedCredential: z.boolean(),
    reason: z.string(),
  })),
})

const scheduleNotificationResultSchema = z.object({
  notificationId: z.string().uuid(),
  scheduleId: z.string().uuid(),
  weekStartsOn: z.string(),
  weekEndsOn: z.string(),
  revision: z.number().int().positive(),
})

const scheduledOvertimePreviewSchema = z.object({
  employeeId: z.string().uuid(),
  shiftId: z.string().uuid(),
  weekStartsOn: z.string(),
  weekEndsOn: z.string(),
  currentMinutes: z.number().int().nonnegative(),
  proposedMinutes: z.number().int().nonnegative(),
  resultingMinutes: z.number().int().nonnegative(),
  overtimeMinutes: z.number().int().nonnegative(),
  requiresOverride: z.boolean(),
})

const scheduledOvertimeCreatePreviewSchema = scheduledOvertimePreviewSchema
  .omit({ shiftId: true })
  .extend({
    countedShifts: z.array(z.object({
      shiftId: z.string().uuid(),
      startsAt: z.string(),
      endsAt: z.string(),
      timeZone: z.string(),
      location: z.string(),
      minutes: z.number().int().nonnegative(),
    })),
  })

const copyScheduleWeekResultSchema = z.object({
  schedule: scheduleSchema,
  copiedCount: z.number().int().nonnegative(),
  copiedAssignmentCount: z.number().int().nonnegative(),
  replacedCount: z.number().int().nonnegative(),
  skippedInactiveAssignmentCount: z.number().int().nonnegative(),
  carriedCredentialOverrideCount: z.number().int().nonnegative(),
  siteCount: z.number().int().nonnegative(),
})

export type ScheduleBuilderOptions = z.infer<typeof builderOptionsSchema>
export type ScheduleBuilderPost = z.infer<typeof builderPostSchema>
export type ScheduleBuilderEmployee = ScheduleBuilderOptions['employees'][number]
export type CreateOpenShiftResult = z.infer<typeof createOpenShiftResultSchema>
export type CreateCoveragePlanResult = z.infer<typeof createCoveragePlanResultSchema>
export type ResolveReviewShiftResult = z.infer<typeof resolveReviewShiftResultSchema>
export type StaffingSuggestion = z.infer<typeof staffingSuggestionSchema>
export type ScheduleNotificationResult = z.infer<typeof scheduleNotificationResultSchema>
export type CopyScheduleWeekResult = z.infer<typeof copyScheduleWeekResultSchema>
export type ScheduledOvertimePreview = z.infer<typeof scheduledOvertimePreviewSchema>
export type ScheduledOvertimeCreatePreview = z.infer<typeof scheduledOvertimeCreatePreviewSchema>

const employeeNameCollator = new Intl.Collator('en-US', {
  numeric: true,
  sensitivity: 'base',
})

export function compareScheduleBuilderEmployeesByFirstName(
  left: ScheduleBuilderEmployee,
  right: ScheduleBuilderEmployee,
): number {
  const leftFirstName = employeeScheduleGivenName({
    firstName: left.first_name,
    lastName: left.last_name,
    preferredName: left.preferred_name,
  })
  const rightFirstName = employeeScheduleGivenName({
    firstName: right.first_name,
    lastName: right.last_name,
    preferredName: right.preferred_name,
  })

  return employeeNameCollator.compare(leftFirstName, rightFirstName)
    || employeeNameCollator.compare(left.last_name.trim(), right.last_name.trim())
    || employeeNameCollator.compare(left.first_name.trim(), right.first_name.trim())
    || left.id.localeCompare(right.id)
}

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
  availabilityOverrideNote?: string | null
  credentialOverrideNote?: string | null
  workType?: 'post' | 'training'
}

export interface CreateCoveragePlanInput {
  weekStartsOn: string
  mode: 'post' | 'event'
  postId?: string | null
  eventName?: string
  eventLocationName?: string
  eventSiteId?: string | null
  eventTimeZone?: string
  shiftDate: string
  startTime: string
  endTime: string
  headcount: number
  armedHeadcount: number
  isOvertime: boolean
  notes?: string
  publishAnnouncement: boolean
  employeeId?: string | null
  assignmentRequirement?: 'armed' | 'unarmed'
  availabilityOverrideNote?: string | null
  credentialOverrideNote?: string | null
  overtimeOverrideNote?: string | null
  workType?: 'post' | 'training'
  useEmployeeTimeZone?: boolean
}

export interface ScheduledOvertimeCreatePreviewInput {
  weekStartsOn: string
  employeeId: string
  postId?: string | null
  eventTimeZone?: string | null
  shiftDates: string[]
  startTime: string
  endTime: string
  useEmployeeTimeZone: boolean
}

export interface AddDraftShiftAssignmentInput {
  shiftId: string
  employeeId: string
  availabilityOverrideNote?: string | null
  credentialOverrideNote?: string | null
  overtimeOverrideNote?: string | null
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
  availabilityOverrideNote?: string | null
  credentialOverrideNote?: string | null
  overtimeOverrideNote?: string | null
  workType?: 'post' | 'training'
}

export interface RemoveDraftShiftInput {
  shiftId: string
  note?: string | null
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
  const [scheduleResult, workTypeResult, assignmentTypeResult] = await Promise.all([
    getSupabaseClient().rpc('get_weekly_schedule_payload', { target_week_starts_on: weekStartsOn }),
    getSupabaseClient().rpc('get_shift_work_type_map', { target_week_starts_on: weekStartsOn }),
    getSupabaseClient().rpc('get_shift_assignment_type_map', { target_week_starts_on: weekStartsOn }),
  ])
  const { data, error } = scheduleResult

  if (error) throw new Error('The weekly schedule could not be loaded for this account.')
  if (!data) return null

  const schedule = scheduleSchema.parse(data)
  const workTypes = workTypeResult.error ? [] : shiftWorkTypeMapSchema.parse(workTypeResult.data ?? [])
  const workTypeByShift = new Map(workTypes.map((item) => [item.shiftId, item.workType]))
  const assignmentTypes = assignmentTypeResult.error ? [] : shiftAssignmentTypeMapSchema.parse(assignmentTypeResult.data ?? [])
  const assignmentTypeByShift = new Map(assignmentTypes.map((item) => [item.shiftId, item.assignmentType]))
  return {
    ...schedule,
    shifts: schedule.shifts.map((shift) => ({
      ...shift,
      work_type: workTypeByShift.get(shift.id) ?? shift.work_type,
      assignment_type: assignmentTypeByShift.get(shift.id) ?? shift.assignment_type,
      assignments: shift.assignments.filter((assignment) => assignment.status !== 'canceled'),
    })),
  }
}

export async function getScheduleBuilderOptions(): Promise<ScheduleBuilderOptions> {
  const { data, error } = await getSupabaseClient().rpc('get_schedule_builder_options')
  if (error) throw new Error('Schedule builder options could not be loaded.')
  const options = builderOptionsSchema.parse(data)
  return {
    ...options,
    employees: [...options.employees].sort(compareScheduleBuilderEmployeesByFirstName),
  }
}

export async function getImportedSchedulePreview(weekStartsOn: string): Promise<ImportedSchedulePreview | null> {
  const { data, error } = await getSupabaseClient().rpc('get_imported_schedule_preview', {
    target_week_starts_on: weekStartsOn,
  })

  if (error) throw new Error('The historical schedule preview could not be loaded.')
  if (!data) return null
  return importedSchedulePreviewSchema.parse(data)
}

export async function createSupervisorOpenShift(input: CreateOpenShiftInput): Promise<CreateOpenShiftResult> {
  const { data, error } = await getSupabaseClient().rpc('scheduler_create_typed_open_shift', {
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
    target_availability_override_note: input.availabilityOverrideNote?.trim() || null,
    target_credential_override_note: input.credentialOverrideNote?.trim() || null,
    target_work_type: input.workType ?? 'post',
  })

  if (error) throw new Error(error.message || 'The open shift could not be created.')
  return createOpenShiftResultSchema.parse(data)
}

export async function createSupervisorCoveragePlan(input: CreateCoveragePlanInput): Promise<CreateCoveragePlanResult> {
  const rpcPayload = {
    target_week_starts_on: input.weekStartsOn,
    target_post_id: input.mode === 'post' ? input.postId : null,
    event_name: input.mode === 'event' ? input.eventName?.trim() : null,
    event_location_name: input.mode === 'event' ? input.eventLocationName?.trim() : null,
    event_site_id: input.mode === 'event' ? input.eventSiteId ?? null : null,
    event_time_zone: input.mode === 'event' ? input.eventTimeZone?.trim() || 'America/Denver' : null,
    shift_operational_date: input.shiftDate,
    shift_start_time: input.startTime,
    shift_end_time: input.endTime,
    target_headcount: input.headcount,
    target_armed_headcount: input.armedHeadcount,
    target_is_overtime: input.isOvertime,
    target_notes: input.notes?.trim() || null,
    target_work_type: input.workType ?? 'post',
    publish_announcement: input.publishAnnouncement,
    target_employee_id: input.employeeId || null,
    target_assignment_requires_armed: input.assignmentRequirement === 'armed',
    target_availability_override_note: input.availabilityOverrideNote?.trim() || null,
    target_credential_override_note: input.credentialOverrideNote?.trim() || null,
    target_overtime_override_note: input.overtimeOverrideNote?.trim() || null,
  }
  const request = input.useEmployeeTimeZone
    ? getSupabaseClient().rpc('scheduler_create_employee_local_coverage_plan_v2', rpcPayload)
    : getSupabaseClient().rpc('scheduler_create_coverage_plan_v2', rpcPayload)
  const { data, error } = await request

  if (error) throw new Error(error.message || 'The coverage plan could not be created.')
  return createCoveragePlanResultSchema.parse(data)
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
  const { data, error } = await getSupabaseClient().rpc('scheduler_update_typed_draft_shift_v2', {
    target_shift_id: input.shiftId,
    shift_operational_date: input.shiftDate,
    shift_start_time: input.startTime,
    shift_end_time: input.endTime,
    target_headcount: input.headcount,
    target_is_open: input.isOpen,
    target_is_overtime: input.isOvertime,
    target_notes: input.notes?.trim() || null,
    target_employee_id: input.employeeId || null,
    target_availability_override_note: input.availabilityOverrideNote?.trim() || null,
    target_credential_override_note: input.credentialOverrideNote?.trim() || null,
    target_overtime_override_note: input.overtimeOverrideNote?.trim() || null,
    target_work_type: input.workType ?? 'post',
  })

  if (error) throw new Error(error.message || 'The draft shift could not be updated.')
  const schedule = scheduleSchema.parse(data)
  return {
    ...schedule,
    shifts: schedule.shifts.map((shift) => shift.id === input.shiftId ? { ...shift, work_type: input.workType ?? 'post' } : shift),
  }
}

export async function addScheduleDraftShiftAssignment(input: AddDraftShiftAssignmentInput): Promise<WeeklySchedule> {
  const { data, error } = await getSupabaseClient().rpc('scheduler_add_draft_shift_assignment_v2', {
    target_shift_id: input.shiftId,
    target_employee_id: input.employeeId,
    target_availability_override_note: input.availabilityOverrideNote?.trim() || null,
    target_credential_override_note: input.credentialOverrideNote?.trim() || null,
    target_overtime_override_note: input.overtimeOverrideNote?.trim() || null,
  })

  if (error) throw new Error(error.message || 'The guard could not be added to this shift.')
  const schedule = scheduleSchema.parse(data)
  return {
    ...schedule,
    shifts: schedule.shifts.map((shift) => ({
      ...shift,
      assignments: shift.assignments.filter((assignment) => assignment.status !== 'canceled'),
    })),
  }
}

export async function getScheduledOvertimePreview(
  shiftId: string,
  employeeId: string,
): Promise<ScheduledOvertimePreview> {
  const { data, error } = await getSupabaseClient().rpc('get_scheduled_overtime_preview', {
    target_shift_id: shiftId,
    target_employee_id: employeeId,
  })

  if (error) throw new Error(error.message || 'Scheduled overtime could not be calculated.')
  return scheduledOvertimePreviewSchema.parse(data)
}

export async function getScheduledOvertimeUpdatePreview(
  shiftId: string,
  employeeId: string,
  shiftDate: string,
  startTime: string,
  endTime: string,
): Promise<ScheduledOvertimePreview> {
  const { data, error } = await getSupabaseClient().rpc('get_scheduled_overtime_update_preview', {
    target_shift_id: shiftId,
    target_employee_id: employeeId,
    shift_operational_date: shiftDate,
    shift_start_time: startTime,
    shift_end_time: endTime,
  })

  if (error) throw new Error(error.message || 'Scheduled overtime could not be calculated for this change.')
  return scheduledOvertimePreviewSchema.parse(data)
}

export async function getScheduledOvertimeCreatePreview(
  input: ScheduledOvertimeCreatePreviewInput,
): Promise<ScheduledOvertimeCreatePreview> {
  const { data, error } = await getSupabaseClient().rpc('get_scheduled_overtime_create_preview', {
    target_week_starts_on: input.weekStartsOn,
    target_employee_id: input.employeeId,
    target_post_id: input.postId || null,
    event_time_zone: input.eventTimeZone?.trim() || null,
    shift_operational_dates: input.shiftDates,
    shift_start_time: input.startTime,
    shift_end_time: input.endTime,
    use_employee_time_zone: input.useEmployeeTimeZone,
  })

  if (error) throw new Error(error.message || 'Scheduled overtime could not be calculated for this coverage plan.')
  return scheduledOvertimeCreatePreviewSchema.parse(data)
}

export async function removeScheduleDraftShift(input: RemoveDraftShiftInput): Promise<WeeklySchedule> {
  const { data, error } = await getSupabaseClient().rpc('remove_schedule_draft_shift', {
    target_shift_id: input.shiftId,
    removal_note: input.note?.trim() || null,
  })

  if (error) throw new Error(error.message || 'The shift could not be removed from the draft.')
  return scheduleSchema.parse(data)
}

export async function publishScheduleDraft(scheduleId: string): Promise<WeeklySchedule> {
  const { data, error } = await getSupabaseClient().rpc('publish_schedule_draft', {
    target_schedule_id: scheduleId,
  })

  if (error) throw new Error(error.message || 'The schedule draft could not be published.')
  return scheduleSchema.parse(data)
}

export async function publishEmployeeScheduleSlice(scheduleId: string, employeeId: string): Promise<WeeklySchedule> {
  const { data, error } = await getSupabaseClient().rpc('publish_employee_schedule_slice', {
    target_schedule_id: scheduleId,
    target_employee_id: employeeId,
  })

  if (error) throw new Error(error.message || 'The employee schedule could not be published.')
  return scheduleSchema.parse(data)
}

export async function queueSchedulePublishedNotification(scheduleId: string, note?: string | null): Promise<ScheduleNotificationResult> {
  const { data, error } = await getSupabaseClient().rpc('queue_schedule_published_notification', {
    target_schedule_id: scheduleId,
    notification_note: note?.trim() || null,
  })

  if (error) throw new Error(error.message || 'The schedule notification could not be queued.')
  return scheduleNotificationResultSchema.parse(data)
}

export async function copyScheduleWeekToDraft(input: {
  sourceScheduleId: string
  destinationWeekStartsOn: string
  includeAssignments: boolean
  includeEvents: boolean
}): Promise<CopyScheduleWeekResult> {
  const { data, error } = await getSupabaseClient().rpc('replace_schedule_week_draft_with_work_types', {
    source_schedule_id: input.sourceScheduleId,
    destination_week_starts_on: input.destinationWeekStartsOn,
    include_assignments: input.includeAssignments,
    include_events: input.includeEvents,
  })

  if (error) throw new Error(error.message || 'The schedule week could not be copied.')
  return copyScheduleWeekResultSchema.parse(data)
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
  credentialOverrideNote?: string | null
}): Promise<ResolveReviewShiftResult> {
  const { data, error } = await getSupabaseClient().rpc('scheduler_resolve_review_shift', {
    target_shift_id: input.shiftId,
    target_employee_id: input.employeeId,
    resolution_note: input.note?.trim() || null,
    target_credential_override_note: input.credentialOverrideNote?.trim() || null,
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
    const name = shift.contextLabel ?? 'Unlabeled schedule row'
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


export function shiftOperationalDate(shift: ScheduleShift, timeZone = shift.time_zone): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone,
  }).formatToParts(new Date(shift.starts_at))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function shiftTimeRange(shift: ScheduleShift, timeZone = shift.time_zone): string {
  return formatDualTimeRange(shift.starts_at, shift.ends_at, timeZone)
}

export function assignmentName(assignment: ScheduleShift['assignments'][number]): string {
  const employee = assignment.employee
  return scheduleEmployeeName(employee)
}

export function scheduleEmployeeName(employee: {
  first_name: string
  last_name: string
  preferred_name: string | null
}): string {
  return employeeScheduleDisplayName({
    firstName: employee.first_name,
    lastName: employee.last_name,
    preferredName: employee.preferred_name,
  })
}
