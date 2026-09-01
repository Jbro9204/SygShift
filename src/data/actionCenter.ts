import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import type { AppRole } from './session'

const actionStatusSchema = z.enum(['pending', 'viewed', 'acknowledged', 'assigned', 'in_progress', 'completed', 'overdue', 'superseded'])

const announcementActionSchema = z.object({
  id: z.string().uuid(),
  announcementId: z.string().uuid(),
  version: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  assignedAt: z.string(),
  dueAt: z.string().nullable(),
  viewedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  status: actionStatusSchema,
})

const trainingActionSchema = z.object({
  id: z.string().uuid(),
  courseId: z.string().uuid(),
  versionId: z.string().uuid(),
  version: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  contentType: z.enum(['document', 'video', 'external_link', 'written']),
  contentUrl: z.string().nullable(),
  instructions: z.string().nullable(),
  effectiveOn: z.string(),
  assignedAt: z.string(),
  dueAt: z.string().nullable(),
  viewedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  status: actionStatusSchema,
})

const scheduleShiftSnapshotSchema = z.object({
  shiftId: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  siteCode: z.string().nullable(),
  siteName: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
  requiresArmed: z.boolean(),
  isOvertime: z.boolean(),
})

const scheduleActionSchema = z.object({
  id: z.string().uuid(),
  scheduleId: z.string().uuid(),
  weekStartsOn: z.string(),
  scheduleRevision: z.number().int().positive(),
  shifts: z.array(scheduleShiftSnapshotSchema),
  publishedAt: z.string(),
  viewedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  status: actionStatusSchema,
})

const actionCenterSchema = z.object({
  serverTimestamp: z.string(),
  summary: z.object({
    announcementCount: z.number().int().nonnegative(),
    trainingCount: z.number().int().nonnegative(),
    scheduleCount: z.number().int().nonnegative(),
  }),
  announcements: z.array(announcementActionSchema),
  training: z.array(trainingActionSchema),
  schedules: z.array(scheduleActionSchema),
})

const actionHistoryTypeSchema = z.enum(['announcement', 'training', 'schedule', 'hr_task'])
const actionHistoryStatusSchema = z.enum(['acknowledged', 'completed', 'superseded', 'cancelled', 'expired'])
const actionHistoryItemSchema = z.object({
  id: z.string().uuid(),
  actionType: actionHistoryTypeSchema,
  employeeId: z.string().uuid().nullable(),
  employeeName: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: actionHistoryStatusSchema,
  assignedAt: z.string(),
  dueAt: z.string().nullable(),
  viewedAt: z.string().nullable(),
  resolvedAt: z.string(),
  resolvedById: z.string().uuid().nullable(),
  resolvedByName: z.string().nullable(),
  resolutionSource: z.enum(['employee', 'manager', 'system']),
  resolutionNote: z.string().nullable(),
  contextLabel: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
})

const actionHistorySchema = z.object({
  serverTimestamp: z.string(),
  scope: z.enum(['self', 'team']),
  canViewTeam: z.boolean(),
  page: z.object({
    number: z.number().int().positive(),
    size: z.union([z.literal(5), z.literal(10), z.literal(20)]),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
  items: z.array(actionHistoryItemSchema).max(20),
})

const reportRecordSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  title: z.string().optional(),
  version: z.number().int().positive().optional(),
  weekStartsOn: z.string().optional(),
  scheduleRevision: z.number().int().positive().optional(),
  assignedAt: z.string().optional(),
  dueAt: z.string().nullable().optional(),
  viewedAt: z.string().nullable().optional(),
  publishedAt: z.string().optional(),
  acknowledgedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  attestation: z.string().nullable().optional(),
  status: actionStatusSchema,
})

const complianceReportSchema = z.object({
  serverTimestamp: z.string(),
  announcements: z.array(reportRecordSchema),
  training: z.array(reportRecordSchema),
  schedules: z.array(reportRecordSchema),
})

const trainingPublishResultSchema = z.object({
  courseId: z.string().uuid(),
  versionId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  assignmentCount: z.number().int().nonnegative(),
})

const trainingCatalogItemSchema = z.object({
  courseId: z.string().uuid(),
  code: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  contentType: z.enum(['document', 'video', 'external_link', 'written']),
  contentUrl: z.string().nullable(),
  instructions: z.string().nullable(),
  effectiveOn: z.string(),
  currentVersionId: z.string().uuid(),
  currentVersion: z.number().int().positive(),
  active: z.boolean(),
  updatedAt: z.string(),
})

export type EmployeeActionCenter = z.infer<typeof actionCenterSchema>
export type EmployeeActionHistory = z.infer<typeof actionHistorySchema>
export type EmployeeActionHistoryItem = z.infer<typeof actionHistoryItemSchema>
export type EmployeeActionHistoryType = z.infer<typeof actionHistoryTypeSchema>
export type EmployeeActionHistoryStatus = z.infer<typeof actionHistoryStatusSchema>
export type AnnouncementAction = z.infer<typeof announcementActionSchema>
export type TrainingAction = z.infer<typeof trainingActionSchema>
export type ScheduleAction = z.infer<typeof scheduleActionSchema>
export type EmployeeActionComplianceReport = z.infer<typeof complianceReportSchema>
export type TrainingCatalogItem = z.infer<typeof trainingCatalogItemSchema>

export interface PublishTrainingInput {
  courseId?: string | null
  code: string
  title: string
  description?: string | null
  contentType: TrainingAction['contentType']
  contentUrl?: string | null
  instructions?: string | null
  effectiveOn: string
  dueAt?: string | null
  employeeIds?: string[]
  roles?: AppRole[]
  siteIds?: string[]
  states?: string[]
}

export interface EmployeeActionHistoryInput {
  page?: number
  pageSize?: 5 | 10 | 20
  search?: string
  actionType?: 'all' | EmployeeActionHistoryType
  status?: 'all' | EmployeeActionHistoryStatus
  fromDate?: string | null
  throughDate?: string | null
  scope?: 'self' | 'team'
}

export async function getEmployeeActionCenter(): Promise<EmployeeActionCenter> {
  const { data, error } = await getSupabaseClient().rpc('get_employee_action_center')
  if (error) throw new Error(error.message || 'Your employee actions could not be loaded.')
  return actionCenterSchema.parse(data)
}

export async function getEmployeeActionHistory(input: EmployeeActionHistoryInput = {}): Promise<EmployeeActionHistory> {
  const { data, error } = await getSupabaseClient().rpc('get_employee_action_history', {
    target_action_type: input.actionType ?? 'all',
    target_from_date: input.fromDate || null,
    target_page: Math.max(1, input.page ?? 1),
    target_page_size: input.pageSize ?? 10,
    target_scope: input.scope ?? 'self',
    target_search: input.search?.trim() || null,
    target_status: input.status ?? 'all',
    target_through_date: input.throughDate || null,
  })
  if (error) throw new Error(error.message || 'Action Center history could not be loaded.')
  return actionHistorySchema.parse(data)
}

export async function markEmployeeActionViewed(
  actionType: 'announcement' | 'training' | 'schedule',
  actionId: string,
): Promise<EmployeeActionCenter> {
  const { data, error } = await getSupabaseClient().rpc('mark_employee_action_viewed', {
    target_action_id: actionId,
    target_action_type: actionType,
  })
  if (error) throw new Error(error.message || 'This action could not be opened.')
  return actionCenterSchema.parse(data)
}

export async function completeEmployeeAction(
  actionType: 'announcement' | 'training' | 'schedule',
  actionId: string,
  attestation?: string | null,
): Promise<EmployeeActionCenter> {
  const { data, error } = await getSupabaseClient().rpc('complete_employee_action', {
    target_action_id: actionId,
    target_action_type: actionType,
    target_attestation: attestation?.trim() || null,
  })
  if (error) throw new Error(error.message || 'This action could not be completed.')
  return actionCenterSchema.parse(data)
}

export async function getEmployeeActionComplianceReport(): Promise<EmployeeActionComplianceReport> {
  const { data, error } = await getSupabaseClient().rpc('get_employee_action_compliance_report')
  if (error) throw new Error(error.message || 'Employee action reporting could not be loaded.')
  return complianceReportSchema.parse(data)
}

export async function publishTrainingVersion(input: PublishTrainingInput) {
  const { data, error } = await getSupabaseClient().rpc('publish_training_version', {
    target_code: input.code.trim(),
    target_content_type: input.contentType,
    target_content_url: input.contentUrl?.trim() || null,
    target_course_id: input.courseId ?? null,
    target_description: input.description?.trim() || null,
    target_due_at: input.dueAt || null,
    target_effective_on: input.effectiveOn,
    target_employee_ids: input.employeeIds ?? [],
    target_instructions: input.instructions?.trim() || null,
    target_roles: input.roles ?? [],
    target_site_ids: input.siteIds ?? [],
    target_states: input.states ?? [],
    target_title: input.title.trim(),
  })
  if (error) throw new Error(error.message || 'The training item could not be published.')
  return trainingPublishResultSchema.parse(data)
}

export async function getTrainingCatalog(): Promise<TrainingCatalogItem[]> {
  const { data, error } = await getSupabaseClient().rpc('get_training_catalog')
  if (error) throw new Error(error.message || 'The training catalog could not be loaded.')
  return z.array(trainingCatalogItemSchema).parse(data)
}

export async function setAnnouncementAcknowledgmentRequirement(
  announcementId: string,
  required: boolean,
  dueAt?: string | null,
) {
  const { data, error } = await getSupabaseClient().rpc('set_announcement_acknowledgment_requirement', {
    target_announcement_id: announcementId,
    target_due_at: dueAt || null,
    target_required: required,
  })
  if (error) throw new Error(error.message || 'The acknowledgment requirement could not be saved.')
  return z.object({
    announcementId: z.string().uuid(),
    mode: z.enum(['informational', 'required']),
    dueAt: z.string().nullable(),
    assignmentCount: z.number().int().nonnegative(),
  }).parse(data)
}

function csvValue(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function trainingComplianceCsv(report: EmployeeActionComplianceReport): string {
  const header = ['Employee', 'Training', 'Version', 'Assigned', 'Due', 'Completed', 'Status', 'Acknowledgment']
  const rows = report.training.map((record) => [
    record.employeeName,
    record.title,
    record.version,
    record.assignedAt,
    record.dueAt,
    record.completedAt,
    record.status,
    record.attestation,
  ])
  return [header, ...rows].map((row) => row.map(csvValue).join(',')).join('\n')
}
