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
  role: 'guard' | 'supervisor' | 'admin'
  opportunities: Opportunity[]
}

export async function getOpenOpportunities(): Promise<OpportunityContext> {
  const client = getSupabaseClient()
  const [employeeResult, roleResult, opportunitiesResult] = await Promise.all([
    client.rpc('current_employee_id'),
    client.rpc('current_app_role'),
    client
      .from('shifts')
      .select(`
        id,
        starts_at,
        ends_at,
        time_zone,
        headcount_required,
        requires_armed,
        is_overtime,
        notes,
        post:posts (id, name, site:sites (id, name, code)),
        event:events (id, name, location_name, site:sites (id, name, code)),
        schedules!inner (status),
        assignments:shift_assignments (id, status),
        requests:shift_requests (id, employee_id, status)
      `)
      .eq('is_open', true)
      .eq('schedules.status', 'published')
      .gt('ends_at', new Date().toISOString())
      .order('starts_at')
      .limit(100),
  ])

  if (employeeResult.error || !employeeResult.data) {
    throw new Error('An active employee account is required to view openings.')
  }
  if (roleResult.error || !roleResult.data) {
    throw new Error('Your application role could not be verified.')
  }
  if (opportunitiesResult.error) {
    throw new Error('Open shifts and events could not be loaded for this account.')
  }

  const role = z.enum(['guard', 'supervisor', 'admin']).parse(roleResult.data)
  const employeeId = z.string().uuid().parse(employeeResult.data)
  const opportunities = z.array(opportunitySchema).parse(opportunitiesResult.data).map((item) => ({
    ...item,
    assignments: item.assignments.filter((assignment) => assignment.status !== 'canceled'),
    requests: item.requests.filter((request) => request.employee_id === employeeId),
  }))

  return { employeeId, role, opportunities }
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
