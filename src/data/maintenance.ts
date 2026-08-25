import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

export const maintenanceReleaseKindSchema = z.enum(['routine', 'planned', 'major', 'emergency'])
export const maintenanceAccessModeSchema = z.enum(['notice', 'read_only', 'unavailable'])
export const maintenanceFeatureCodeSchema = z.enum([
  'schedule',
  'events_openings',
  'time_clock',
  'time_attendance',
  'payroll',
  'directory',
  'licensing',
  'availability',
  'sites_posts',
  'patrol',
  'requests',
  'communications',
  'user_accounts',
  'roles_permissions',
  'training',
])

const maintenanceWindowSchema = z.object({
  id: z.string().uuid(),
  releaseKind: maintenanceReleaseKindSchema,
  accessMode: maintenanceAccessModeSchema,
  title: z.string(),
  message: z.string(),
  completionMessage: z.string().nullable(),
  releaseVersion: z.string().nullable(),
  featureCodes: z.array(maintenanceFeatureCodeSchema),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(['scheduled', 'active', 'expired', 'completed', 'canceled']),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  closedAt: z.string().nullable().optional(),
})

const maintenanceStatusSchema = z.object({
  serverTime: z.string(),
  active: z.array(maintenanceWindowSchema),
  upcoming: z.array(maintenanceWindowSchema),
  recentlyCompleted: z.array(maintenanceWindowSchema),
})

const maintenanceAdminWorkspaceSchema = z.object({
  generatedAt: z.string(),
  windows: z.array(maintenanceWindowSchema),
})

export type MaintenanceReleaseKind = z.infer<typeof maintenanceReleaseKindSchema>
export type MaintenanceAccessMode = z.infer<typeof maintenanceAccessModeSchema>
export type MaintenanceFeatureCode = z.infer<typeof maintenanceFeatureCodeSchema>
export type MaintenanceWindow = z.infer<typeof maintenanceWindowSchema>
export type MaintenanceStatus = z.infer<typeof maintenanceStatusSchema>
export type MaintenanceAdminWorkspace = z.infer<typeof maintenanceAdminWorkspaceSchema>

export type MaintenanceWindowInput = {
  id?: string | null
  releaseKind: MaintenanceReleaseKind
  accessMode: MaintenanceAccessMode
  title: string
  message: string
  completionMessage?: string | null
  releaseVersion?: string | null
  featureCodes: MaintenanceFeatureCode[]
  startsAt: string
  endsAt: string
}

export const MAINTENANCE_FEATURES: ReadonlyArray<{
  code: MaintenanceFeatureCode
  label: string
  description: string
  group: string
}> = [
  { code: 'schedule', label: 'Schedule and Scheduler', description: 'Published schedules, drafts, assignments, and coverage changes.', group: 'Operations' },
  { code: 'events_openings', label: 'Events and Openings', description: 'Events, open shifts, and shift-pool requests.', group: 'Operations' },
  { code: 'time_clock', label: 'Employee Time Clock', description: 'Clock in, clock out, and break punches. Keep available whenever safely possible.', group: 'Timekeeping' },
  { code: 'time_attendance', label: 'Time Maintenance', description: 'Punch corrections, exceptions, accountability, and attendance review.', group: 'Timekeeping' },
  { code: 'payroll', label: 'Payroll Export', description: 'Payroll review, locks, and official exports.', group: 'Timekeeping' },
  { code: 'directory', label: 'Directory', description: 'Employee profile and workforce record changes.', group: 'Workforce' },
  { code: 'licensing', label: 'Licensing Center', description: 'Credentials, documents, eligibility, and licensing communication.', group: 'Workforce' },
  { code: 'availability', label: 'Availability', description: 'Availability and unavailability records.', group: 'Workforce' },
  { code: 'sites_posts', label: 'Sites and Posts', description: 'Site, post, and coverage requirement configuration.', group: 'Workforce' },
  { code: 'patrol', label: 'Patrol', description: 'Patrol assignments and operational configuration.', group: 'Workforce' },
  { code: 'requests', label: 'Time-Off Requests', description: 'Employee requests and management decisions.', group: 'Workforce' },
  { code: 'communications', label: 'Communications', description: 'Announcements, banners, and employee notifications.', group: 'Communication' },
  { code: 'user_accounts', label: 'User Accounts', description: 'Employee accounts, login access, and account administration.', group: 'Administration' },
  { code: 'roles_permissions', label: 'Roles and Permissions', description: 'Role definitions, memberships, and individual overrides.', group: 'Administration' },
  { code: 'training', label: 'Training', description: 'Training courses, versions, and assignments.', group: 'Administration' },
]

const routeFeatureMap: ReadonlyArray<[string, MaintenanceFeatureCode]> = [
  ['/time/payroll', 'payroll'],
  ['/time', 'time_attendance'],
  ['/scheduler', 'schedule'],
  ['/schedule', 'schedule'],
  ['/events', 'events_openings'],
  ['/people', 'directory'],
  ['/licensing', 'licensing'],
  ['/availability', 'availability'],
  ['/sites', 'sites_posts'],
  ['/patrol', 'patrol'],
  ['/requests', 'requests'],
  ['/announcements', 'communications'],
  ['/notifications', 'communications'],
  ['/users', 'user_accounts'],
  ['/access-control', 'roles_permissions'],
]

export function maintenanceFeatureForPath(pathname: string): MaintenanceFeatureCode | null {
  return routeFeatureMap.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1] ?? null
}

export function maintenanceFeatureLabel(code: MaintenanceFeatureCode): string {
  return MAINTENANCE_FEATURES.find((feature) => feature.code === code)?.label ?? code
}

export async function getMaintenanceStatus(): Promise<MaintenanceStatus> {
  const { data, error } = await getSupabaseClient().rpc('get_maintenance_status')
  if (error) throw new Error(error.message || 'Maintenance status could not be loaded.')
  return maintenanceStatusSchema.parse(data)
}

export async function getMaintenanceAdminWorkspace(): Promise<MaintenanceAdminWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_maintenance_admin_workspace')
  if (error) throw new Error(error.message || 'System Operations could not be loaded.')
  return maintenanceAdminWorkspaceSchema.parse(data)
}

export async function saveMaintenanceWindow(input: MaintenanceWindowInput): Promise<MaintenanceAdminWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('save_maintenance_window', {
    target_access_mode: input.accessMode,
    target_completion_message: input.completionMessage ?? null,
    target_ends_at: input.endsAt,
    target_feature_codes: input.featureCodes,
    target_id: input.id ?? null,
    target_message: input.message,
    target_release_kind: input.releaseKind,
    target_release_version: input.releaseVersion ?? null,
    target_starts_at: input.startsAt,
    target_title: input.title,
  })
  if (error) throw new Error(error.message || 'The maintenance window could not be saved.')
  return maintenanceAdminWorkspaceSchema.parse(data)
}

export async function closeMaintenanceWindow(
  id: string,
  action: 'complete' | 'cancel',
  completionMessage?: string | null,
): Promise<MaintenanceAdminWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('close_maintenance_window', {
    target_action: action,
    target_completion_message: completionMessage ?? null,
    target_id: id,
  })
  if (error) throw new Error(error.message || 'The maintenance window could not be closed.')
  return maintenanceAdminWorkspaceSchema.parse(data)
}
