import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const patrolShiftSchema = z.object({
  id: z.string().uuid(),
  starts_at: z.string(),
  ends_at: z.string(),
  time_zone: z.string(),
  requires_armed: z.boolean(),
  is_open: z.boolean(),
  notes: z.string().nullable(),
  post: z.object({
    id: z.string().uuid(),
    name: z.string(),
    site: z.object({
      id: z.string().uuid(),
      code: z.string().nullable(),
      name: z.string(),
    }),
  }).nullable(),
  assignments: z.array(z.object({
    id: z.string().uuid(),
    status: z.enum(['assigned', 'confirmed', 'canceled', 'completed']),
    employee: z.object({
      id: z.string().uuid(),
      first_name: z.string(),
      last_name: z.string(),
      preferred_name: z.string().nullable(),
    }),
  })),
  schedules: z.object({
    status: z.literal('published'),
  }),
})

export type PatrolShift = z.infer<typeof patrolShiftSchema>

export interface PatrolRouteGroup {
  id: string
  name: string
  code: string | null
  requiresArmed: boolean
  upcomingShifts: PatrolShift[]
}

function guardName(assignment: PatrolShift['assignments'][number]): string {
  return `${assignment.employee.preferred_name || assignment.employee.first_name} ${assignment.employee.last_name}`
}

export function patrolAssignmentLabel(shift: PatrolShift): string {
  const active = shift.assignments.filter((assignment) => assignment.status !== 'canceled')
  if (active.length === 0) return 'Open patrol coverage'
  return active.map(guardName).join(', ')
}

export function patrolShiftTime(shift: PatrolShift): string {
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: shift.time_zone,
  }).format(new Date(shift.starts_at))
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: shift.time_zone,
  })
  return `${day} · ${time.format(new Date(shift.starts_at))} – ${time.format(new Date(shift.ends_at))}`
}

export async function getPatrolRoutes(): Promise<PatrolRouteGroup[]> {
  const { data, error } = await getSupabaseClient()
    .from('shifts')
    .select(`
      id,
      starts_at,
      ends_at,
      time_zone,
      requires_armed,
      is_open,
      notes,
      post:posts (
        id,
        name,
        site:sites (id, code, name)
      ),
      assignments:shift_assignments (
        id,
        status,
        employee:employees (id, first_name, last_name, preferred_name)
      ),
      schedules!inner (status)
    `)
    .eq('schedules.status', 'published')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at')
    .limit(500)

  if (error) throw new Error('Patrol coverage could not be loaded.')

  const shifts = z.array(patrolShiftSchema).parse(data)
    .map((shift) => ({
      ...shift,
      assignments: shift.assignments.filter((assignment) => assignment.status !== 'canceled'),
    }))
    .filter((shift) => {
      const siteName = shift.post?.site.name.toLocaleLowerCase() ?? ''
      const postName = shift.post?.name.toLocaleLowerCase() ?? ''
      const notes = shift.notes?.toLocaleLowerCase() ?? ''
      return siteName.includes('patrol') || postName.includes('patrol') || notes.includes('patrol')
    })

  const groups = new Map<string, PatrolRouteGroup>()
  for (const shift of shifts) {
    const site = shift.post?.site
    const id = site?.id ?? shift.id
    const group = groups.get(id) ?? {
      id,
      code: site?.code ?? null,
      name: site?.name ?? shift.post?.name ?? 'Patrol coverage',
      requiresArmed: false,
      upcomingShifts: [],
    }
    group.requiresArmed ||= shift.requires_armed
    group.upcomingShifts.push(shift)
    groups.set(id, group)
  }

  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name))
}
