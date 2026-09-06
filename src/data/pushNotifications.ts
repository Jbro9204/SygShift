import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { getSoundPreferences } from '../lib/notificationSounds'

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}
async function setOwner(employeeId: string | null): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration('/')
  if (!registration?.active) return
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => { channel.port1.close(); resolve() }, 1500)
    channel.port1.onmessage = () => { window.clearTimeout(timer); channel.port1.close(); resolve() }
    const sound = getSoundPreferences()
    registration.active!.postMessage({ type: 'sygshift:push-owner', employeeId, muted: sound.muted || !sound.notification || sound.volume === 0 }, [channel.port2])
  })
}
export async function getDevicePushEnabled(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false
  const subscription = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription()
  if (!subscription) return false
  const { data, error } = await getSupabaseClient().rpc('get_my_push_subscription', { target_endpoint: subscription.endpoint })
  if (error) throw new Error('Device notification status could not be checked.')
  return z.object({ enabled: z.boolean() }).parse(data).enabled
}
export async function enableDevicePush(employeeId: string): Promise<void> {
  if (!pushSupported()) throw new Error('This browser does not support device notifications. On iPhone or iPad, add SygShift to your Home Screen and open it there.')
  // Permission is requested directly from the employee's click, before network awaits.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow notifications in this site’s browser settings, then try again.')
  const response = await fetch('/api/v1/notifications/push/config')
  const config = z.object({ configured: z.boolean(), publicKey: z.string().nullable() }).parse(await response.json())
  if (!response.ok || !config.configured || !config.publicKey) throw new Error('Device notification delivery is not configured yet.')
  await navigator.serviceWorker.register('/notification-sw.js', { scope: '/', updateViaCache: 'none' })
  const registration = await navigator.serviceWorker.ready
  const key = Uint8Array.from(atob(config.publicKey.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0))
  const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  const { error } = await getSupabaseClient().rpc('set_my_push_subscription', { target_subscription: subscription.toJSON(), target_enabled: true })
  if (error) throw new Error(error.message || 'Device notifications could not be enabled.')
  await setOwner(employeeId)
  try { localStorage.setItem(`sygshift.push-enabled:${employeeId}`, 'true') } catch { /* Session delivery remains available. */ }
}
export async function disableDevicePush(employeeId: string): Promise<void> {
  if (!pushSupported()) return
  const subscription = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription()
  if (subscription) {
    const { error } = await getSupabaseClient().rpc('set_my_push_subscription', { target_subscription: { endpoint: subscription.endpoint }, target_enabled: false })
    if (error) throw new Error('Device notifications could not be disabled. Please try again.')
    await subscription.unsubscribe()
  }
  await setOwner(null)
  try { localStorage.removeItem(`sygshift.push-enabled:${employeeId}`) } catch { /* Server preference is already saved. */ }
}
export async function restorePushSession(employeeId: string): Promise<void> {
  if (!pushSupported()) return
  try {
    if (localStorage.getItem(`sygshift.push-enabled:${employeeId}`) !== 'true' || Notification.permission !== 'granted') { await setOwner(null); return }
    const subscription = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription()
    if (!subscription) return
    if (!await getDevicePushEnabled()) {
      const { error } = await getSupabaseClient().rpc('set_my_push_subscription', { target_subscription: subscription.toJSON(), target_enabled: true })
      if (error) return
    }
    await setOwner(employeeId)
  } catch { /* Push availability never blocks login or operational workflows. */ }
}
export async function clearPushSession(): Promise<void> {
  if (!pushSupported()) return
  await setOwner(null).catch(() => {})
}

export function markPushPresented(employeeId: string, id: string): void {
  navigator.serviceWorker?.controller?.postMessage({ type: 'sygshift:push-presented', employeeId, id })
}
