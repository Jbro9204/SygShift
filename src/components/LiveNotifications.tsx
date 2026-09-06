import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { BellRing, X } from 'lucide-react'
import { claimNotification, getLiveNotifications, safeNotificationPath, type LiveNotification } from '../data/liveNotifications'
import { getSupabaseClient } from '../lib/supabase'
import { completeLoginSound, enableAudio, playSound } from '../lib/notificationSounds'
import './LiveNotifications.css'
import { markPushPresented, restorePushSession } from '../data/pushNotifications'

export function LiveNotifications({ employeeId, username }: { employeeId: string; username: string }) {
  const queryClient = useQueryClient()
  const [toasts, setToasts] = useState<LiveNotification[]>([])
  const [audioBlocked, setAudioBlocked] = useState(false)
  useEffect(() => { void completeLoginSound(username) }, [username])
  useEffect(() => { void restorePushSession(employeeId) }, [employeeId])
  useEffect(() => {
    const unlock = () => { void enableAudio() }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
  }, [])

  useEffect(() => {
    const client = getSupabaseClient()
    let active = true
    let baseline: string | null = null
    let busy = false
    let rerun = false
    let channel: ReturnType<typeof client.channel> | undefined
    let refreshTimer: number | undefined
    const localSeen = new Set<string>()
    const timers = new Set<number>()
    const invalidate = () => {
      if (refreshTimer) return
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        if (!active) return
        void queryClient.invalidateQueries({ queryKey: ['my-notifications'] })
        void queryClient.invalidateQueries({ queryKey: ['support'] })
      }, 150)
    }
    const sync = async (alert: boolean) => {
      if (!active) return
      if (busy) { rerun = true; return }
      busy = true
      try {
        const data = await getLiveNotifications(baseline)
        if (!active) return
        const first = baseline === null
        baseline ??= data.serverTime
        for (const notification of data.notifications) {
          if (localSeen.has(notification.id)) continue
          localSeen.add(notification.id)
          if (localSeen.size > 500) localSeen.delete(localSeen.values().next().value!)
          if (!alert || first || document.visibilityState !== 'visible') continue
          if (Date.parse(data.serverTime) - Date.parse(notification.createdAt) > 30_000) continue
          if (!await claimNotification(employeeId, notification.id) || !active) continue
          markPushPresented(employeeId, notification.id)
          const currentTicket = new URLSearchParams(location.search).get('ticket')
          if (location.pathname === '/support' && notification.sourceType === 'support_ticket' && notification.sourceId === currentTicket) continue
          setToasts((current) => [...current, notification].slice(-3))
          if (!await playSound('notification') && active) setAudioBlocked(true)
          const timer = window.setTimeout(() => {
            timers.delete(timer)
            if (active) setToasts((current) => current.filter((item) => item.id !== notification.id))
          }, 12_000)
          timers.add(timer)
        }
      } catch { /* Inbox and ticket polling remain available during transport failures. */ }
      finally {
        busy = false
        if (rerun && active) { rerun = false; void sync(alert) }
      }
    }
    const catchUp = () => { if (document.visibilityState === 'visible') { invalidate(); void sync(false) } }
    const pushMessage = (event: MessageEvent) => {
      if (event.data?.type === 'sygshift:notification') { invalidate(); void sync(true) }
    }
    const connect = async () => {
      const { data } = await client.auth.getSession()
      if (!active || !data.session) return
      await client.realtime.setAuth(data.session.access_token)
      if (!active) return
      channel = client.channel(`employee:${data.session.user.id}`, { config: { private: true } })
        .on('broadcast', { event: 'changed' }, (event) => {
          invalidate()
          if (event.payload?.kind === 'notification' && event.payload?.isNew === true) void sync(true)
        })
        .subscribe((status) => { if (status === 'SUBSCRIBED') { invalidate(); void sync(false) } })
      await sync(false)
    }
    void connect().catch(() => { /* Periodic catch-up is independent of the live channel. */ })
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') { invalidate(); void sync(true) } }, 30_000)
    window.addEventListener('online', catchUp)
    window.addEventListener('focus', catchUp)
    document.addEventListener('visibilitychange', catchUp)
    navigator.serviceWorker?.addEventListener('message', pushMessage)
    return () => {
      active = false
      if (channel) void client.removeChannel(channel)
      window.clearInterval(poll)
      window.clearTimeout(refreshTimer)
      timers.forEach((timer) => window.clearTimeout(timer))
      window.removeEventListener('online', catchUp)
      window.removeEventListener('focus', catchUp)
      document.removeEventListener('visibilitychange', catchUp)
      navigator.serviceWorker?.removeEventListener('message', pushMessage)
    }
  }, [employeeId, queryClient])

  return <aside className="live-notifications" aria-label="New notifications" aria-live="polite">
    {toasts.map((notification) => <article className={`live-notification live-notification--${notification.priority}`} key={notification.id}>
      <BellRing aria-hidden="true" size={22} />
      <Link to={safeNotificationPath(notification.actionPath)} onClick={() => setToasts((current) => current.filter((item) => item.id !== notification.id))}>
        <small>New SygShift update</small><strong>{notification.title}</strong><span>Open update</span>
      </Link>
      <button aria-label="Hide popup" onClick={() => setToasts((current) => current.filter((item) => item.id !== notification.id))} type="button"><X size={18} /></button>
    </article>)}
    {audioBlocked && toasts.length > 0 ? <button className="secondary-button" onClick={() => { void enableAudio().then((enabled) => setAudioBlocked(!enabled)) }} type="button">Enable notification sounds</button> : null}
  </aside>
}
