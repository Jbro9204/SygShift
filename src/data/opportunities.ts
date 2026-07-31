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
  role: 'guard' | 'dispatcher' | 'scheduler' | 'recruiting_licensing' | 'supervisor' | 'admin'
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
    role: z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin']),
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

export function opportunityCoverageLabel(opportunity: Opportunity): string {
  return opportunity.post?.name ?? opportunity.event?.name ?? 'Open coverage'
}

export function opportunityDescription(opportunity: Opportunity): string | null {
  const text = opportunity.notes?.trim()
  if (!text) return null

  const cleanLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(Imported schedule|Bible source|Source sheet|Source time cell|Qualification source|Assignment status|Assignment import skipped)/i.test(line))
    .filter((line) => !/needs supervisor review|source row|source schedule/i.test(line))
    .filter((line) => !/^(pay|rate)\s*[:=-]/i.test(line))

  const cleaned = cleanLines.join(' ').trim()
  return cleaned || null
}

export function opportunityPayLabel(opportunity: Opportunity): string {
  const payLine = opportunity.notes
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(pay|rate)\s*[:=-]/i.test(line))
  const pay = payLine?.replace(/^(pay|rate)\s*[:=-]\s*/i, '').trim()
  return pay || 'Not entered yet'
}
