import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const requestSchema = z.object({
  id: z.string().uuid(),
  employee_id: z.string().uuid(),
  status: z.enum(['pending', 'approved', 'declined', 'withdrawn', 'canceled']),
})

const opportunitySchema = z.object({
  id: z.string().uuid(),
  starts_at: z.string(),
  ends_at: z.string(),
  time_zone: z.string(),
  headcount_required: z.number().int().positive(),
  requires_armed: z.boolean(),
  is_overtime: z.boolean(),
  notes: z.string().nullable(),
  post: z.object({
    id: z.string().uuid(),
    name: z.string(),
    site: z.object({ id: z.string().uuid(), name: z.string(), code: z.string().nullable() }),
  }).nullable(),
  event: z.object({
    id: z.string().uuid(),
    name: z.string(),
    location_name: z.string().nullable(),
    site: z.object({ id: z.string().uuid(), name: z.string(), code: z.string().nullable() }).nullable(),
  }).nullable(),
  schedules: z.object({ status: z.literal('published') }),
  assignments: z.array(z.object({
    id: z.string().uuid(),
    status: z.enum(['assigned', 'confirmed', 'canceled', 'completed']),
  })),
  requests: z.array(requestSchema),
})

export type Opportunity = z.infer<typeof opportunitySchema>
export type OpportunityRequest = z.infer<typeof requestSchema>

export interface OpportunityContext {
  employeeId: string
  role: 'guard' | 'dispatcher' | 'scheduler' | 'supervisor' | 'admin'
  opportunities: Opportunity[]
}

export async function getOpenOpportunities(): Promise<OpportunityContext> {
  const client = getSupabaseClient()
  const { data, error } = await client.rpc('get_open_opportunities_payload')

  if (error) {
    throw new Error(error.message || 'Open shifts and events could not be loaded for this account.')
  }

  const payload = z.object({
    employeeId: z.string().uuid(),
    role: z.enum(['guard', 'dispatcher', 'scheduler', 'supervisor', 'admin']),
    opportunities: z.array(opportunitySchema),
  }).parse(data)
  const opportunities = payload.opportunities.map((item) => ({
    ...item,
    assignments: item.assignments.filter((assignment) => assignment.status !== 'canceled'),
    requests: item.requests.filter((request) => request.employee_id === payload.employeeId),
  }))

  return { employeeId: payload.employeeId, role: payload.role, opportunities }
}

export async function submitOpportunityRequest(shiftId: string): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('submit_shift_request', {
    target_shift_id: shiftId,
    request_note: null,
  })
  if (error) throw new Error('This shift could not be requested. Refresh and confirm it is still open.')
  return z.string().uuid().parse(data)
}

export async function withdrawOpportunityRequest(requestId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('withdraw_shift_request', {
    target_request_id: requestId,
  })
  if (error) throw new Error('This request could not be withdrawn. Refresh and check its current status.')
}

export function opportunityRequest(opportunity: Opportunity): OpportunityRequest | undefined {
  return opportunity.requests[0]
}

export function opportunityLocation(opportunity: Opportunity): string {
  return opportunity.post?.site.name
    ?? opportunity.event?.site?.name
    ?? opportunity.event?.location_name
    ?? 'Location pending'
}

export function opportunityTitle(opportunity: Opportunity): string {
  return opportunity.event?.name ?? opportunity.post?.name ?? 'Open shift'
}
