import { z } from 'zod'

const VIEW_DATE_SELECTION_STORAGE_KEY = 'sygshift:view-date-selections:v1'

const dateKeySchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  })

const myTimeSelectionSchema = z.object({
  fromDate: dateKeySchema,
  throughDate: dateKeySchema,
}).refine((value) => value.fromDate <= value.throughDate)

const scheduleSelectionSchema = z.object({
  range: z.enum(['1w', '2w', 'month']).optional(),
  weekStartsOn: dateKeySchema,
})

const storedSelectionsSchema = z.object({
  ownerId: z.string().min(1),
  selections: z.object({
    'my-time': myTimeSelectionSchema.optional(),
    schedule: scheduleSelectionSchema.optional(),
    scheduler: scheduleSelectionSchema.optional(),
  }),
})

export type MyTimeDateSelection = z.infer<typeof myTimeSelectionSchema>
export type ScheduleDateSelection = z.infer<typeof scheduleSelectionSchema>
export type ViewDateSelectionSurface = 'my-time' | 'schedule' | 'scheduler'

type ViewDateSelectionBySurface = {
  'my-time': MyTimeDateSelection
  schedule: ScheduleDateSelection
  scheduler: ScheduleDateSelection
}

function browserSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function readStoredSelections(): z.infer<typeof storedSelectionsSchema> | null {
  const storage = browserSessionStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(VIEW_DATE_SELECTION_STORAGE_KEY)
    if (!raw) return null
    const parsed = storedSelectionsSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
    storage.removeItem(VIEW_DATE_SELECTION_STORAGE_KEY)
  } catch {
    try { storage.removeItem(VIEW_DATE_SELECTION_STORAGE_KEY) } catch { /* Storage remains optional. */ }
  }
  return null
}

function writeStoredSelections(value: z.infer<typeof storedSelectionsSchema>): void {
  const storage = browserSessionStorage()
  if (!storage) return
  try {
    storage.setItem(VIEW_DATE_SELECTION_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Date retention is a convenience. The page remains usable when storage is disabled.
  }
}

export function bindViewDateSelectionOwner(ownerId: string): void {
  if (!ownerId) return
  const current = readStoredSelections()
  if (current?.ownerId === ownerId) return
  writeStoredSelections({ ownerId, selections: {} })
}

export function clearViewDateSelections(): void {
  const storage = browserSessionStorage()
  if (!storage) return
  try { storage.removeItem(VIEW_DATE_SELECTION_STORAGE_KEY) } catch { /* Storage remains optional. */ }
}

export function readViewDateSelection<Surface extends ViewDateSelectionSurface>(
  ownerId: string,
  surface: Surface,
): ViewDateSelectionBySurface[Surface] | null {
  const current = readStoredSelections()
  if (!current || current.ownerId !== ownerId) return null
  return (current.selections[surface] as ViewDateSelectionBySurface[Surface] | undefined) ?? null
}

export function saveViewDateSelection<Surface extends ViewDateSelectionSurface>(
  ownerId: string,
  surface: Surface,
  selection: ViewDateSelectionBySurface[Surface],
): void {
  if (!ownerId) return
  const current = readStoredSelections()
  const selections = current?.ownerId === ownerId ? current.selections : {}
  const candidate = storedSelectionsSchema.safeParse({
    ownerId,
    selections: { ...selections, [surface]: selection },
  })
  if (candidate.success) writeStoredSelections(candidate.data)
}

export function validViewDateKey(value: string | null | undefined): value is string {
  return dateKeySchema.safeParse(value).success
}

