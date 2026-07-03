import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const assignedEmployeeSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  preferred_name: z.string().nullable(),
})

const assignmentSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['assigned', 'confirmed', 'canceled', 'completed']),
  employee: assignedEmployeeSchema,
})

const postSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  site: z.object({
    id: z.string().uuid(),
    code: z.string().nullable(),
    name: z.string(),
  }),
})

const eventSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  location_name: z.string().nullable(),
  site: z.object({
    id: z.string().uuid(),
    code: z.string().nullable(),
    name: z.string(),
  }).nullable(),
})

const shiftSchema = z.object({
  id: z.string().uuid(),
  starts_at: z.string(),
  ends_at: z.string(),
  time_zone: z.string(),
  headcount_required: z.number().int().positive(),
  requires_armed: z.boolean(),
  is_open: z.boolean(),
  is_overtime: z.boolean(),
  notes: z.string().nullable(),
  post: postSchema.nullable(),
  event: eventSchema.nullable(),
  assignments: z.array(assignmentSchema),
})

const scheduleSchema = z.object({
  id: z.string().uuid(),
  week_starts_on: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(['draft', 'published', 'superseded', 'archived']),
  published_at: z.string().nullable(),
  shifts: z.array(shiftSchema),
})

export type WeeklySchedule = z.infer<typeof scheduleSchema>
export type ScheduleShift = z.infer<typeof shiftSchema>

export interface ScheduleRow {
  id: string
  code: string | null
  name: string
  type: 'site' | 'event'
  shifts: ScheduleShift[]
}

export async function getWeeklySchedule(weekStartsOn: string): Promise<WeeklySchedule | null> {
  const { data, error } = await getSupabaseClient()
    .from('schedules')
    .select(`
      id,
      week_starts_on,
      revision,
      status,
      published_at,
      shifts (
        id,
        starts_at,
        ends_at,
        time_zone,
        headcount_required,
        requires_armed,
        is_open,
        is_overtime,
        notes,
        post:posts (
          id,
          name,
          site:sites (id, code, name)
        ),
        event:events (
          id,
          name,
          location_name,
          site:sites (id, code, name)
        ),
        assignments:shift_assignments (
          id,
          status,
          employee:employees (id, first_name, last_name, preferred_name)
        )
      )
    `)
    .eq('week_starts_on', weekStartsOn)
    .order('revision', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error('The weekly schedule could not be loaded for this account.')
  if (!data) return null

  const schedule = scheduleSchema.parse(data)
  return {
    ...schedule,
    shifts: schedule.shifts.map((shift) => ({
      ...shift,
      assignments: shift.assignments.filter((assignment) => assignment.status !== 'canceled'),
    })),
  }
}

export function scheduleRows(schedule: WeeklySchedule): ScheduleRow[] {
  const rows = new Map<string, ScheduleRow>()

  for (const shift of schedule.shifts) {
    const site = shift.post?.site ?? shift.event?.site
    const id = site?.id ?? `event:${shift.event?.id ?? shift.id}`
    const row = rows.get(id) ?? {
      id,
      code: site?.code ?? null,
      name: site?.name ?? shift.event?.location_name ?? shift.event?.name ?? 'Event',
      type: site ? 'site' : 'event',
      shifts: [],
    }
    row.shifts.push(shift)
    rows.set(id, row)
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      shifts: [...row.shifts].sort((left, right) => left.starts_at.localeCompare(right.starts_at)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function shiftOperationalDate(shift: ScheduleShift): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: shift.time_zone,
  }).formatToParts(new Date(shift.starts_at))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function shiftTimeRange(shift: ScheduleShift): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: shift.time_zone,
  })
  return `${formatter.format(new Date(shift.starts_at))} – ${formatter.format(new Date(shift.ends_at))}`
}

export function assignmentName(assignment: ScheduleShift['assignments'][number]): string {
  const employee = assignment.employee
  return `${employee.preferred_name || employee.first_name} ${employee.last_name}`
}
