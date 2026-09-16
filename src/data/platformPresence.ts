import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

export const platformPresenceStatusSchema = z.enum(['active', 'away', 'offline', 'never_active'])
export const platformApplicationSchema = z.enum(['sygshift', 'sygilant'])

const platformPresencePersonSchema = z.object({
  employeeId: z.string().uuid(),
  status: platformPresenceStatusSchema,
  lastActiveAt: z.string().nullable(),
  applications: z.array(platformApplicationSchema),
  accountEnabled: z.boolean(),
})

const platformPresenceDirectorySchema = z.object({
  serverTimestamp: z.string(),
  currentEmployeeId: z.string().uuid(),
  people: z.array(platformPresencePersonSchema),
})

const currentPresenceSchema = z.object({
  status: platformPresenceStatusSchema,
  lastActiveAt: z.string().nullable(),
  applications: z.array(platformApplicationSchema),
  accountEnabled: z.boolean(),
})

export type PlatformPresenceStatus = z.infer<typeof platformPresenceStatusSchema>
export type PlatformApplication = z.infer<typeof platformApplicationSchema>
export type PlatformPresencePerson = z.infer<typeof platformPresencePersonSchema>
export type PlatformPresenceDirectory = z.infer<typeof platformPresenceDirectorySchema>

export const platformPresenceLabels: Record<PlatformPresenceStatus, string> = {
  active: 'Active now',
  away: 'Away',
  offline: 'Offline',
  never_active: 'Never active',
}

export const platformApplicationLabels: Record<PlatformApplication, string> = {
  sygshift: 'SygShift',
  sygilant: 'Sygilant',
}

export async function recordPlatformPresence(
  clientInstanceId: string,
  application: PlatformApplication,
  state: 'active' | 'away',
) {
  const { data, error } = await getSupabaseClient().rpc('record_platform_presence', {
    target_application: application,
    target_client_instance_id: clientInstanceId,
    target_state: state,
  })
  if (error) throw new Error('Presence could not be refreshed.')
  return currentPresenceSchema.parse(data)
}

export async function getPlatformPresenceDirectory(): Promise<PlatformPresenceDirectory> {
  const { data, error } = await getSupabaseClient().rpc('get_platform_presence_directory')
  if (error) throw new Error('Live presence is temporarily unavailable.')
  return platformPresenceDirectorySchema.parse(data)
}
