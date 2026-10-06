import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import {
  workforceActivityOutcomeValues,
  type WorkforceActivityOutcome,
  type WorkforceActivityRow,
} from '../reports/workforceActivityTypes'

export const workforceActivityViewSchema = z.enum(['all', 'scheduled', 'worked', 'exceptions'])
export const workforceActivityGroupSchema = z.enum(['day', 'employee', 'location'])
export const workforceActivityOutcomeSchema = z.enum(workforceActivityOutcomeValues)

const labeledOptionSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1),
})

const workforceActivityEmployeeOptionSchema = labeledOptionSchema.extend({
  employeeNumber: z.string().nullable(),
})

const workforceActivityRowSchema: z.ZodType<WorkforceActivityRow> = z.object({
  id: z.string().min(1),
  operationalDate: z.string(),
  employeeId: z.string().uuid().nullable(),
  employeeName: z.string().nullable(),
  employeeNumber: z.string().nullable(),
  employmentType: z.string().nullable(),
  shiftId: z.string().uuid().nullable(),
  assignmentId: z.string().uuid().nullable(),
  clientId: z.string().uuid().nullable(),
  clientName: z.string().nullable(),
  eventId: z.string().uuid().nullable(),
  eventName: z.string().nullable(),
  siteId: z.string().uuid().nullable(),
  siteCode: z.string().nullable(),
  siteName: z.string().nullable(),
  postId: z.string().uuid().nullable(),
  postName: z.string().nullable(),
  locationLabel: z.string().min(1),
  locationDetail: z.string().nullable(),
  timeZone: z.string().min(1),
  scheduledStartAt: z.string().nullable(),
  scheduledEndAt: z.string().nullable(),
  scheduledMinutes: z.number().int().nonnegative().nullable(),
  actualStartAt: z.string().nullable(),
  actualEndAt: z.string().nullable(),
  workedMinutes: z.number().int().nonnegative().nullable(),
  unpaidBreakMinutes: z.number().int().nonnegative().nullable(),
  outcome: workforceActivityOutcomeSchema,
  payrollReady: z.boolean(),
  notes: z.array(z.string()),
})

const workforceActivityReportPageSchema = z.object({
  reportKey: z.literal('workforceActivity'),
  generatedAt: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  view: workforceActivityViewSchema,
  groupBy: workforceActivityGroupSchema,
  page: z.number().int().positive(),
  pageSize: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  summary: z.object({
    scheduledAssignments: z.number().int().nonnegative(),
    actualWorkers: z.number().int().nonnegative(),
    scheduledMinutes: z.number().int().nonnegative(),
    workedMinutes: z.number().int().nonnegative(),
    callOffs: z.number().int().nonnegative(),
    replacements: z.number().int().nonnegative(),
    openPositions: z.number().int().nonnegative(),
    salaryConfirmed: z.number().int().nonnegative(),
    needsReview: z.number().int().nonnegative(),
  }),
  filterOptions: z.object({
    views: z.array(z.object({ value: workforceActivityViewSchema, label: z.string().min(1) })),
    groupings: z.array(z.object({ value: workforceActivityGroupSchema, label: z.string().min(1) })),
    employees: z.array(workforceActivityEmployeeOptionSchema),
    clients: z.array(labeledOptionSchema),
    sites: z.array(labeledOptionSchema),
    events: z.array(labeledOptionSchema),
    outcomes: z.array(z.object({
      value: workforceActivityOutcomeSchema,
      label: z.string().min(1),
      count: z.number().int().nonnegative(),
    })),
  }),
  rows: z.array(workforceActivityRowSchema),
})

export type WorkforceActivityView = z.infer<typeof workforceActivityViewSchema>
export type WorkforceActivityGroup = z.infer<typeof workforceActivityGroupSchema>
export type WorkforceActivityReportPage = z.infer<typeof workforceActivityReportPageSchema>
export type WorkforceActivityEmployeeOption = z.infer<typeof workforceActivityEmployeeOptionSchema>
export type { WorkforceActivityOutcome, WorkforceActivityRow }

export type WorkforceActivityReportExport = WorkforceActivityReportPage & {
  exportId: string
  mode: 'export'
}

export interface WorkforceActivityReportPageInput {
  fromDate: string
  throughDate: string
  view: WorkforceActivityView
  groupBy: WorkforceActivityGroup
  employeeId?: string
  clientId?: string
  siteId?: string
  eventId?: string
  outcome?: WorkforceActivityOutcome
  search?: string
  page: number
  pageSize: 10 | 25 | 50
}

export async function getWorkforceActivityReportPage(
  input: WorkforceActivityReportPageInput,
): Promise<WorkforceActivityReportPage> {
  const { data, error } = await getSupabaseClient().rpc('get_workforce_activity_report_page', {
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
    target_view: input.view,
    target_group_by: input.groupBy,
    target_employee_id: input.employeeId || null,
    target_client_id: input.clientId || null,
    target_site_id: input.siteId || null,
    target_event_id: input.eventId || null,
    target_outcome: input.outcome || null,
    target_search: input.search?.trim() || null,
    target_page: input.page,
    target_page_size: input.pageSize,
  })
  if (error) throw new Error(error.message || 'Workforce activity could not be loaded.')
  return workforceActivityReportPageSchema.parse(data)
}

export async function getWorkforceActivityReportEmployeeOptions(): Promise<WorkforceActivityEmployeeOption[]> {
  const { data, error } = await getSupabaseClient().rpc('get_workforce_activity_report_employee_options')
  if (error) throw new Error(error.message || 'Employee choices could not be loaded for this report.')
  return z.array(workforceActivityEmployeeOptionSchema).parse(data)
}

export async function exportWorkforceActivityReport(
  input: Omit<WorkforceActivityReportPageInput, 'page' | 'pageSize'>,
): Promise<WorkforceActivityReportExport> {
  const { data, error } = await getSupabaseClient().rpc('export_workforce_activity_report', {
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
    target_view: input.view,
    target_group_by: input.groupBy,
    target_employee_id: input.employeeId || null,
    target_client_id: input.clientId || null,
    target_site_id: input.siteId || null,
    target_event_id: input.eventId || null,
    target_outcome: input.outcome || null,
    target_search: input.search?.trim() || null,
  })
  if (error) throw new Error(error.message || 'Workforce activity export could not be prepared.')
  return workforceActivityReportPageSchema.extend({
    exportId: z.string().uuid(),
    mode: z.literal('export'),
  }).parse(data)
}
