import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const shortNoticeCallOutRowSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  employeeNumber: z.string().nullable(),
  jobTitle: z.string().nullable(),
  employmentType: z.string(),
  operationalDate: z.string(),
  scheduledStartAt: z.string(),
  scheduledEndAt: z.string(),
  timeZone: z.string(),
  callReceivedAt: z.string(),
  noticeMinutes: z.number().int(),
  noticeBucket: z.enum(['after_start', 'under_1_hour', '1_to_2_hours', '2_to_3_hours', '3_to_4_hours']),
  occurrenceType: z.enum(['called_in_sick', 'call_off', 'no_call_no_show']),
  reason: z.string().nullable(),
  operationalDetails: z.string().nullable(),
  replacementNeeded: z.boolean(),
  recordStatus: z.enum(['recorded', 'canceled']),
  canceledAt: z.string().nullable(),
  reviewOutcome: z.enum(['pending_hr_review', 'confirmed', 'unexcused', 'excused_protected', 'corrected', 'dismissed']),
  reviewedAt: z.string().nullable(),
  reviewedByName: z.string().nullable(),
  decisionNote: z.string().nullable(),
  clientName: z.string().nullable(),
  siteName: z.string().nullable(),
  siteCode: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
  locationName: z.string(),
  submissionSource: z.enum(['employee_self_service', 'management_entry', 'legacy_record']),
  receivedByName: z.string().nullable(),
  reportedByName: z.string().nullable(),
  coverageStatus: z.enum(['covered', 'not_required', 'no_replacement', 'patrol_review', 'open_pool', 'pending', 'canceled']),
  replacementEmployeeName: z.string().nullable(),
  overtimeCreated: z.boolean(),
  attendanceEventId: z.string().uuid().nullable(),
  actionPath: z.string(),
})

const shortNoticeCallOutReportSchema = z.object({
  serverTimestamp: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  noticeThresholdMinutes: z.literal(240),
  countingRule: z.string(),
  summary: z.object({
    shortNoticeCount: z.number().int().nonnegative(),
    afterStartCount: z.number().int().nonnegative(),
    noShowCount: z.number().int().nonnegative(),
    uncoveredCount: z.number().int().nonnegative(),
    repeatEmployeeCount: z.number().int().nonnegative(),
  }),
  rows: z.array(shortNoticeCallOutRowSchema),
})

export type ShortNoticeCallOutReport = z.infer<typeof shortNoticeCallOutReportSchema>
export type ShortNoticeCallOutRow = z.infer<typeof shortNoticeCallOutRowSchema>

export async function getShortNoticeCallOutReport(input: {
  fromDate: string
  throughDate: string
  export?: boolean
}): Promise<ShortNoticeCallOutReport> {
  const { data, error } = await getSupabaseClient().rpc('get_hr_short_notice_call_out_report', {
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
    target_export: input.export ?? false,
  })
  if (error) {
    throw new Error('The short-notice call-out report could not be loaded. Verify HR reporting access and try again.')
  }
  const result = shortNoticeCallOutReportSchema.safeParse(data)
  if (!result.success) {
    throw new Error('The short-notice call-out report returned incomplete information. Refresh and try again.')
  }
  return result.data
}
