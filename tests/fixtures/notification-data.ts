// Browser-only transport fixture. All requests stay on the isolated local server.
import type { NotificationComposerOptions, NotificationInbox, sendEmployeeNotification as Send } from '../../src/data/notifications'
export const isSupabaseConfigured = true
// The fixture client is already isolated; shared-session switching is intentionally a no-op.
export async function activateSharedIdentitySupabaseSession(_accessToken: string, _refreshToken: string) {}
export function deactivateSharedIdentitySupabaseSession() {}
export function getSupabaseClient(): never { throw new Error('Unexpected data access in notification layout fixture.') }
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/fixture-notifications/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error('Unable to complete this request. Please try again.')
  return response.json()
}
export const getMyNotifications = () => request<NotificationInbox>('inbox')
export const getNotificationComposerOptions = (search = '') => request<NotificationComposerOptions>(`options?search=${encodeURIComponent(search)}`)
export const sendEmployeeNotification = (input: Parameters<typeof Send>[0]) => request<Awaited<ReturnType<typeof Send>>>('send', input)
export const markMyNotificationRead = () => request('read')
export const acknowledgeMyNotification = () => request('acknowledge')
export const dismissMyNotification = () => request('dismiss')
export const clearMyNotifications = async () => ({ markedRead: 0, dismissed: 0, remainingRequired: 0 })
