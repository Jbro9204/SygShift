import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const patrolAssignmentSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['assigned', 'confirmed', 'completed', 'canceled']),
  employeeName: z.string().nullable(),
})

const patrolShiftSchema = z.object({
  id: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  requiresArmed: z.boolean(),
  isOpen: z.boolean(),
  notes: z.string().nullable(),
  postName: z.string(),
  siteName: z.string().nullable(),
  assignments: z.array(patrolAssignmentSchema),
})

const patrolRouteSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string().nullable(),
  requiresArmed: z.boolean(),
  patrolTagged: z.boolean(),
  upcomingShifts: z.array(patrolShiftSchema),
})

export type PatrolShift = z.infer<typeof patrolShiftSchema>
export type PatrolRouteGroup = z.infer<typeof patrolRouteSchema>

export function patrolAssignmentLabel(shift: PatrolShift): string {
  const active = shift.assignments.filter((assignment) => assignment.status !== 'canceled')
  if (active.length === 0) return 'Open patrol coverage'
  return active.map((assignment) => assignment.employeeName ?? 'Assigned guard').join(', ')
}

export function patrolShiftTime(shift: PatrolShift): string {
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: shift.timeZone,
  }).format(new Date(shift.startsAt))
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: shift.timeZone,
  })
  return `${day} · ${time.format(new Date(shift.startsAt))} – ${time.format(new Date(shift.endsAt))}`
}

export async function getPatrolRoutes(): Promise<PatrolRouteGroup[]> {
  const { data, error } = await getSupabaseClient().rpc('get_patrol_coverage')

  if (error) {
    throw new Error(error.message || 'Patrol coverage could not be loaded.')
  }

  return z.array(patrolRouteSchema).parse(data ?? [])
}
