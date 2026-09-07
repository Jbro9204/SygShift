import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
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
  render() { return this.state.failed ? <Link className="sphere-launcher" to="/sygsphere">SygSphere</Link> : this.props.children }
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
  const [toast, setToast] = useState<{ title: string; path: string } | null>(null)
  const seen = useRef<Set<string> | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const activeLocation = useRef(location)
  useEffect(() => { activeLocation.current = location }, [location])
  useEffect(() => {
    const sound = new Audio('/sounds/SygShift_Notification_53571d7e.mp3')
    sound.preload = 'auto'; audio.current = sound
    const unlock = () => { sound.muted = true; void sound.play().then(() => { sound.pause(); sound.currentTime = 0; sound.muted = false }).catch(() => { sound.muted = false }) }
    window.addEventListener('pointerdown', unlock, { once: true }); window.addEventListener('keydown', unlock, { once: true })
    return () => { sound.pause(); audio.current = null; window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
  }, [])
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
    void client.auth.getSession().then(({ data }) => {
      if (disposed || !data.session) return
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
    if (!seen.current) { seen.current = new Set(data.conversations.flatMap((item) => item.latest ? [item.latest.id] : [])); return }
    let cancelled = false
    for (const conversation of data.conversations) {
      const message = conversation.latest
      if (!message || seen.current.has(message.id)) continue
      seen.current.add(message.id)
      if (conversation.muted || conversation.unread === 0 || message.authorId === employeeId || Date.now() - Date.parse(message.createdAt) > 30000) continue
      const active = activeLocation.current
      if (document.visibilityState === 'visible' && active.pathname === '/sygsphere' && new URLSearchParams(active.search).get('conversation') === conversation.id) continue
      void claimSphereAlert(employeeId, message.id).then((claimed) => {
        if (!claimed || cancelled) return
        setToast({ title: conversation.name, path: spherePath(conversation.id, message.id, message.parentId) })
        const prefs = getSoundPreferences()
        if (data.soundEnabled && !prefs.muted && prefs.volume > 0 && audio.current) { audio.current.volume = prefs.volume; audio.current.currentTime = 0; void audio.current.play().catch(() => undefined) }
      })
    }
    return () => { cancelled = true }
  }, [inbox.data, employeeId])
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(null), 10000); return () => clearTimeout(timeout) }, [toast])
  const unread = sphereUnread(inbox.data)
  return <>
    <Link className="sphere-launcher" to="/sygsphere" title={`SygSphere${unread ? ` · ${unread} unread conversations` : ' · Messages'}`} aria-label={`SygSphere messages${unread ? `, ${unread} unread conversations` : ''}`}>
      <img className="sphere-launcher__emblem" src="/branding/sygsphere-emblem.png" alt="" />
      <span className="sphere-launcher__brand"><img src="/branding/sygsphere-logo.png" alt="SygSphere" /><small>MESSAGES</small></span>
      {unread > 0 ? <span className="sphere-badge">{unread > 99 ? '99+' : unread}</span> : null}
    </Link>
    {createPortal(<Link className="sphere-mobile-launcher" to="/sygsphere" aria-label={`Open SygSphere${unread ? `, ${unread} unread conversations` : ''}`}><img src="/branding/sygsphere-emblem.png" alt="" />SygSphere{unread > 0 ? <span className="sphere-badge">{unread > 99 ? '99+' : unread}</span> : null}</Link>, document.body)}
    {toast ? createPortal(<aside className="sphere-toast" role="status"><Link onClick={() => setToast(null)} to={toast.path}><strong>SygSphere · {toast.title}</strong><span>You have a new message. Open conversation.</span></Link><button type="button" aria-label="Dismiss message notification" onClick={() => setToast(null)}><X size={18} /></button></aside>, document.body) : null}
  </>
}
