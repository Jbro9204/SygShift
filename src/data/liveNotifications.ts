import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const liveNotification = z.object({
  id: z.string().uuid(), title: z.string(), priority: z.enum(['routine', 'important', 'urgent']),
  createdAt: z.string(), actionPath: z.string().nullable(), sourceType: z.string(), sourceId: z.string().nullable(),
})
const snapshot = z.object({ serverTime: z.string(), notifications: z.array(liveNotification) })
export type LiveNotification = z.infer<typeof liveNotification>
export async function getLiveNotifications(since: string | null) {
  const { data, error } = await getSupabaseClient().rpc('get_my_live_notifications', { target_since: since })
  if (error) throw new Error('Live notifications are reconnecting.')
  return snapshot.parse(data)
}

export function safeNotificationPath(path: string | null): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) return '/notifications'
  return path
}

// Web Locks serializes the check-and-record across tabs on this device.
export async function claimNotification(employeeId: string, id: string): Promise<boolean> {
  const key = `sygshift.notification-seen.v1:${employeeId}`
  const claim = () => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) || '[]')
      const seen: string[] = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(-250) : []
      if (seen.includes(id)) return false
      localStorage.setItem(key, JSON.stringify([...seen, id].slice(-250)))
      return true
    } catch { return false } // Never replay sounds when durable dedup storage is unavailable.
  }
  if (navigator.locks) return navigator.locks.request(key, claim)
  return claim()
}
