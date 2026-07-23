import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const roleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'supervisor', 'admin'])
const requestStatusSchema = z.enum(['pending', 'approved', 'declined', 'withdrawn', 'canceled'])

const availabilityEmployeeSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: roleSchema,
  employmentType: z.enum(['hourly', 'salary', 'flex']),
  hasArmedCredential: z.boolean(),
})

const availabilityRecordSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  availabilityStatus: z.enum(['available', 'unavailable']),
  approvalStatus: requestStatusSchema,
  note: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
})

const availabilityWorkspaceSchema = z.object({
  role: roleSchema,
  hasMfa: z.boolean(),
  employees: z.array(availabilityEmployeeSchema),
  availability: z.array(availabilityRecordSchema),
})

export type AvailabilityWorkspace = z.infer<typeof availabilityWorkspaceSchema>
export type AvailabilityRecord = z.infer<typeof availabilityRecordSchema>
export type AvailabilityEmployee = z.infer<typeof availabilityEmployeeSchema>

export interface AvailabilityInput {
  employeeId?: string | null
  startsOn: string
  endsOn: string
  dayOfWeek?: number | null
  startTime?: string | null
  endTime?: string | null
  availabilityStatus: 'available' | 'unavailable'
  note?: string | null
}

export async function getAvailabilityWorkspace(fromDate: string, throughDate: string): Promise<AvailabilityWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_availability_workspace', {
    target_from_date: fromDate,
    target_through_date: throughDate,
  })
  if (error) throw new Error(error.message || 'Availability could not be loaded.')
  return availabilityWorkspaceSchema.parse(data)
}

export async function submitAvailability(input: AvailabilityInput): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('submit_availability_request', {
    target_employee_id: input.employeeId || null,
    target_starts_on: input.startsOn,
    target_ends_on: input.endsOn,
    target_day_of_week: input.dayOfWeek ?? null,
    target_start_time: input.startTime || null,
    target_end_time: input.endTime || null,
    target_availability_status: input.availabilityStatus,
    target_note: input.note?.trim() || null,
  })
  if (error) throw new Error(error.message || 'Availability could not be saved.')
  return z.string().uuid().parse(data)
}

export async function decideAvailability(requestId: string, decision: 'approved' | 'declined', note: string | null): Promise<void> {
  const { error } = await getSupabaseClient().rpc('decide_availability_request', {
    target_availability_id: requestId,
    target_decision: decision,
    target_note: note,
  })
  if (error) throw new Error(error.message || 'Availability decision could not be saved.')
}

export async function cancelAvailability(requestId: string, note: string | null): Promise<void> {
  const { error } = await getSupabaseClient().rpc('cancel_employee_availability', {
    target_availability_id: requestId,
    target_note: note?.trim() || null,
  })
  if (error) throw new Error(error.message || 'Availability rule could not be removed.')
}
