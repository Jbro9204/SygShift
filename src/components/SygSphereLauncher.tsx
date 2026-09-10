import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { sphereInbox, spherePath, sphereRequest, sphereUnread } from '../data/sygsphere'
import { getSupabaseClient } from '../lib/supabase'
import { getSoundPreferences } from '../lib/notificationSounds'
import '../styles/sygsphere.css'

class SphereBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? (
      <Link
        aria-label="Open SygSphere messages"
        className="syg-launcher syg-launcher--sphere sphere-launcher"
        title="SygSphere — Messages"
        to="/sygsphere"
      >
        <img alt="" aria-hidden="true" className="syg-launcher__emblem sphere-launcher__emblem" src="/branding/sygsphere-emblem.png" />
        <span aria-hidden="true" className="syg-launcher__brand sphere-launcher__brand">
          <img alt="" src="/branding/sygsphere-logo.png" />
          <small>MESSAGES</small>
        </span>
      </Link>
    ) : this.props.children
  }
}
export function SygSphereLauncher({ employeeId }: { employeeId: string }) { return <SphereBoundary><SphereLauncherContent key={employeeId} employeeId={employeeId} /></SphereBoundary> }

async function claimSphereAlert(employeeId: string, messageId: string) {
  const claim = () => {
    try {
      const key = `sygsphere.alerts.v1:${employeeId}`
      const parsed: unknown = JSON.parse(localStorage.getItem(key) || '[]')
      const seen: string[] = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
      if (seen.includes(messageId)) return false
      localStorage.setItem(key, JSON.stringify([...seen, messageId].slice(-200)))
    } catch { /* In-memory seen state still protects this tab. */ }
    return true
  }
  return navigator.locks ? navigator.locks.request(`sygsphere-alert:${employeeId}`, claim) : claim()
}

function SphereLauncherContent({ employeeId }: { employeeId: string }) {
  const location = useLocation()
  const queryClient = useQueryClient()
  const inbox = useQuery({ queryKey: ['sygsphere', employeeId, 'inbox'], queryFn: sphereInbox, refetchInterval: 30000, retry: 1 })
  const [toast, setToast] = useState<{ title: string; path: string; mentioned: boolean } | null>(null)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const seen = useRef<Set<string> | null>(null)
  const seenMentions = useRef<Set<string> | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const activeLocation = useRef(location)
  useEffect(() => { activeLocation.current = location }, [location])
  useEffect(() => {
    const sound = new Audio('/sounds/SygSphere_Notification_46421aca.mp3')
    sound.preload = 'auto'; audio.current = sound
    const unlock = () => { sound.muted = true; void sound.play().then(() => { sound.pause(); sound.currentTime = 0; sound.muted = false }).catch(() => { sound.muted = false }) }
    window.addEventListener('pointerdown', unlock, { once: true }); window.addEventListener('keydown', unlock, { once: true })
    return () => { sound.pause(); audio.current = null; window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
  }, [])
  const playAlertSound = useCallback(async () => {
    const prefs = getSoundPreferences()
    if (!inbox.data?.soundEnabled || prefs.muted || prefs.volume <= 0 || !audio.current) return true
    audio.current.volume = prefs.volume
    audio.current.currentTime = 0
    try {
      await audio.current.play()
      return true
    } catch {
      return false
    }
  }, [inbox.data?.soundEnabled])
  useEffect(() => {
    const client = getSupabaseClient()
    let disposed = false
    let channel: ReturnType<typeof client.channel> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (timer) return
      timer = setTimeout(() => { timer = undefined; if (!disposed) void queryClient.invalidateQueries({ queryKey: ['sygsphere', employeeId] }) }, 120)
    }
    const heartbeat = () => { if (document.visibilityState === 'visible') void sphereRequest('presence').catch(() => undefined) }
    void client.auth.getSession().then(async ({ data }) => {
      if (disposed || !data.session) return
      await client.realtime.setAuth(data.session.access_token)
      if (disposed) return
      channel = client.channel(`sygsphere:${data.session.user.id}`, { config: { private: true } })
        .on('broadcast', { event: 'changed' }, refresh).subscribe((status) => { if (status === 'SUBSCRIBED') refresh() })
    }).catch(() => undefined)
    const interval = setInterval(heartbeat, 30000); heartbeat()
    const focus = () => { refresh(); heartbeat() }
    window.addEventListener('focus', focus); window.addEventListener('online', focus)
    return () => { disposed = true; clearInterval(interval); if (timer) clearTimeout(timer); window.removeEventListener('focus', focus); window.removeEventListener('online', focus); if (channel) void client.removeChannel(channel) }
  }, [employeeId, queryClient])
  useEffect(() => {
    if (!inbox.data) return
    const data = inbox.data
    if (!seen.current || !seenMentions.current) {
      seen.current = new Set(data.conversations.flatMap((item) => item.latest ? [item.latest.id] : []))
      seenMentions.current = new Set(data.mentions.map((item) => item.messageId))
      return
    }
    let cancelled = false
    const active = activeLocation.current
    const activeConversation = document.visibilityState === 'visible' && active.pathname === '/sygsphere' ? new URLSearchParams(active.search).get('conversation') : null
    const mentionedMessageIds = new Set(data.mentions.map((item) => item.messageId))
    for (const mention of data.mentions) {
      if (seenMentions.current.has(mention.messageId)) continue
      seenMentions.current.add(mention.messageId)
      if (mention.authorId === employeeId || Date.now() - Date.parse(mention.createdAt) > 30000 || activeConversation === mention.conversationId) continue
      void claimSphereAlert(employeeId, mention.messageId).then((claimed) => {
        if (!claimed || cancelled) return
        setToast({ title: mention.conversationName, path: spherePath(mention.conversationId, mention.messageId, mention.parentId), mentioned: true })
        void playAlertSound().then((played) => { if (!cancelled) setAudioBlocked(!played) })
      })
    }
    for (const conversation of data.conversations) {
      const message = conversation.latest
      if (!message || seen.current.has(message.id)) continue
      seen.current.add(message.id)
      if (mentionedMessageIds.has(message.id) || conversation.muted || conversation.unread === 0 || message.authorId === employeeId || Date.now() - Date.parse(message.createdAt) > 30000) continue
      if (activeConversation === conversation.id) continue
      void claimSphereAlert(employeeId, message.id).then((claimed) => {
        if (!claimed || cancelled) return
        setToast({ title: conversation.name, path: spherePath(conversation.id, message.id, message.parentId), mentioned: false })
        void playAlertSound().then((played) => { if (!cancelled) setAudioBlocked(!played) })
      })
    }
    return () => { cancelled = true }
  }, [inbox.data, employeeId, playAlertSound])
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(null), 10000); return () => clearTimeout(timeout) }, [toast])
  const unread = sphereUnread(inbox.data)
  return <>
    <Link className="syg-launcher syg-launcher--sphere sphere-launcher" to="/sygsphere" title={`SygSphere — ${unread ? `${unread} unread conversations` : 'Messages'}`} aria-label={`Open SygSphere messages${unread ? `, ${unread} unread conversations` : ''}`}>
      <img aria-hidden="true" className="syg-launcher__emblem sphere-launcher__emblem" src="/branding/sygsphere-emblem.png" alt="" />
      <span aria-hidden="true" className="syg-launcher__brand sphere-launcher__brand"><img src="/branding/sygsphere-logo.png" alt="" /><small>MESSAGES</small></span>
      {unread > 0 ? <span className="syg-launcher__badge sphere-badge">{unread > 99 ? '99+' : unread}</span> : null}
    </Link>
    {createPortal(<Link className="sphere-mobile-launcher" to="/sygsphere" aria-label={`Open SygSphere${unread ? `, ${unread} unread conversations` : ''}`}><img src="/branding/sygsphere-emblem.png" alt="" />SygSphere{unread > 0 ? <span className="sphere-badge">{unread > 99 ? '99+' : unread}</span> : null}</Link>, document.body)}
    {toast ? createPortal(<aside className={`sphere-toast ${toast.mentioned ? 'sphere-toast--mention' : ''}`} role="status"><Link onClick={() => setToast(null)} to={toast.path}><strong>SygSphere · {toast.title}</strong><span>{toast.mentioned ? 'You were mentioned. Open the message.' : 'You have a new message. Open conversation.'}</span></Link>{audioBlocked ? <button type="button" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onClick={() => { void playAlertSound().then((played) => setAudioBlocked(!played)) }}>Enable SygSphere sounds</button> : null}<button type="button" aria-label="Dismiss message notification" onClick={() => setToast(null)}><X size={18} /></button></aside>, document.body) : null}
  </>
}
