import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

export interface OverviewMetrics {
  onDutyNow: number | null
  openShifts: number | null
  pendingRequests: number | null
  clockExceptions: number | null
}

const overviewMetricsSchema = z.object({
  onDutyNow: z.number().int().nonnegative().nullable(),
  openShifts: z.number().int().nonnegative().nullable(),
  pendingRequests: z.number().int().nonnegative().nullable(),
  clockExceptions: z.number().int().nonnegative().nullable(),
})

export async function getOverviewMetrics(_now = new Date()): Promise<OverviewMetrics> {
  const client = getSupabaseClient()
  const { data, error } = await client.rpc('get_overview_metrics_payload')
  if (error) return { onDutyNow: null, openShifts: null, pendingRequests: null, clockExceptions: null }
  return overviewMetricsSchema.parse(data)
}

export function overviewMetricNote(label: keyof OverviewMetrics, value: number | null): string {
  if (value === null) return 'Available after sign-in permissions allow it'
  if (label === 'onDutyNow') return value === 0 ? 'No active clocked-in employees right now' : 'Employees currently clocked in'
  if (label === 'openShifts') return value === 0 ? 'No published openings right now' : 'Published openings ready for review or request'
  if (label === 'pendingRequests') return value === 0 ? 'The action queue is clear' : 'Requests waiting for supervisor action'
  return value === 0 ? 'No unresolved clock exceptions' : 'Corrections waiting for review'
}
