import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const scheduledOvertimeShiftSchema = z.object({
  approvalNote: z.string().nullable(),
  date: z.string(),
  endsAt: z.string(),
  requiresArmed: z.boolean(),
  scheduledMinutes: z.number().int().nonnegative(),
  shiftId: z.string().uuid(),
  sitePost: z.string(),
  startsAt: z.string(),
  timeZone: z.string(),
})

const scheduledOvertimeEmployeeSchema = z.object({
  approvalNotes: z.string().nullable(),
  armedMinutes: z.number().int().nonnegative(),
  armedShiftCount: z.number().int().nonnegative(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  employeeNumber: z.string().nullable(),
  employmentType: z.string(),
  jobTitle: z.string().nullable(),
  overtimeMinutes: z.number().int().positive(),
  scheduledMinutes: z.number().int().positive(),
  shiftCount: z.number().int().positive(),
  shifts: z.array(scheduledOvertimeShiftSchema),
  sites: z.string(),
  unarmedMinutes: z.number().int().nonnegative(),
  workClassification: z.string().nullable(),
})

const armedFlexCandidateSchema = z.object({
  availabilityRequiresReview: z.literal(true),
  credentialValidThrough: z.string(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  employeeNumber: z.string().nullable(),
  employmentType: z.literal('flex'),
  jobTitle: z.string().nullable(),
  remainingMinutesBeforeOvertime: z.number().int().nonnegative(),
  scheduledMinutes: z.number().int().nonnegative(),
})

const scheduledOvertimeForecastSchema = z.object({
  armedFlexCandidates: z.array(armedFlexCandidateSchema),
  employees: z.array(scheduledOvertimeEmployeeSchema),
  generatedAt: z.string(),
  schedule: z.object({
    id: z.string().uuid(),
    publishedAt: z.string().nullable(),
    revision: z.number().int().positive(),
    status: z.string(),
  }).nullable(),
  summary: z.object({
    armedOvertimeEmployees: z.number().int().nonnegative(),
    overtimeEmployees: z.number().int().nonnegative(),
    totalOvertimeMinutes: z.number().int().nonnegative(),
  }),
  weekEndsOn: z.string(),
  weekStartsOn: z.string(),
})

const scheduledOvertimeExportAuthorizationSchema = z.object({
  authorizedAt: z.string(),
  exportId: z.string().uuid(),
})

export type ScheduledOvertimeShift = z.infer<typeof scheduledOvertimeShiftSchema>
export type ScheduledOvertimeEmployee = z.infer<typeof scheduledOvertimeEmployeeSchema>
export type ArmedFlexCandidate = z.infer<typeof armedFlexCandidateSchema>
export type ScheduledOvertimeForecast = z.infer<typeof scheduledOvertimeForecastSchema>

export async function getScheduledOvertimeForecast(weekStartsOn: string): Promise<ScheduledOvertimeForecast> {
  const { data, error } = await getSupabaseClient().rpc('get_scheduled_overtime_forecast', {
    target_week_starts_on: weekStartsOn,
  })
  if (error) throw new Error(error.message || 'The scheduled overtime forecast could not be loaded.')
  return scheduledOvertimeForecastSchema.parse(data)
}

export async function authorizeScheduledOvertimeForecastExport(input: {
  employeeCount: number
  scheduleId: string
  weekStartsOn: string
}) {
  const { data, error } = await getSupabaseClient().rpc('authorize_scheduled_overtime_forecast_export', {
    target_employee_count: input.employeeCount,
    target_schedule_id: input.scheduleId,
    target_week_starts_on: input.weekStartsOn,
  })
  if (error) throw new Error(error.message || 'The scheduled overtime forecast export could not be authorized.')
  return scheduledOvertimeExportAuthorizationSchema.parse(data)
}
