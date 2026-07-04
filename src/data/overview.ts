import { getSupabaseClient } from '../lib/supabase'

export interface OverviewMetrics {
  onDutyNow: number | null
  openShifts: number | null
  pendingRequests: number | null
  clockExceptions: number | null
}

async function safeCount(query: PromiseLike<{ count: number | null, error: unknown }>): Promise<number | null> {
  const result = await query
  return result.error ? null : result.count ?? 0
}

export async function getOverviewMetrics(now = new Date()): Promise<OverviewMetrics> {
  const client = getSupabaseClient()
  const nowIso = now.toISOString()

  const [
    onDutyNow,
    openShifts,
    timeOffRequests,
    shiftRequests,
    unresolvedCallOffs,
    clockExceptions,
  ] = await Promise.all([
    safeCount(
      client
        .from('shifts')
        .select('id, shift_assignments!inner(id)', { count: 'exact', head: true })
        .lte('starts_at', nowIso)
        .gt('ends_at', nowIso)
        .in('shift_assignments.status', ['assigned', 'confirmed']),
    ),
    safeCount(
      client
        .from('shifts')
        .select('id, schedules!inner(status)', { count: 'exact', head: true })
        .eq('is_open', true)
        .eq('schedules.status', 'published')
        .gte('starts_at', nowIso),
    ),
    safeCount(
      client
        .from('time_off_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
    ),
    safeCount(
      client
        .from('shift_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
    ),
    safeCount(
      client
        .from('call_off_reports')
        .select('id', { count: 'exact', head: true })
        .is('announcement_id', null)
        .is('resolved_at', null),
    ),
    safeCount(
      client
        .from('time_event_corrections')
        .select('id', { count: 'exact', head: true })
        .is('approved_at', null)
        .is('declined_at', null),
    ),
  ])

  const requestCounts = [timeOffRequests, shiftRequests, unresolvedCallOffs]
  const pendingRequests = requestCounts.some((count) => count === null)
    ? null
    : requestCounts.reduce<number>((total, count) => total + (count ?? 0), 0)

  return {
    onDutyNow,
    openShifts,
    pendingRequests,
    clockExceptions,
  }
}

export function overviewMetricNote(label: keyof OverviewMetrics, value: number | null): string {
  if (value === null) return 'Available after sign-in permissions allow it'
  if (label === 'onDutyNow') return value === 0 ? 'No active assigned shifts right now' : 'Assigned shifts currently in progress'
  if (label === 'openShifts') return value === 0 ? 'No published openings right now' : 'Published openings ready for review or request'
  if (label === 'pendingRequests') return value === 0 ? 'The action queue is clear' : 'Requests waiting for supervisor action'
  return value === 0 ? 'No unresolved clock exceptions' : 'Corrections waiting for review'
}
