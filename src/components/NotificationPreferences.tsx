import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, Volume2 } from 'lucide-react'
import { getSessionContext } from '../data/auth'
import { disableDevicePush, enableDevicePush, getDevicePushEnabled, pushSupported } from '../data/pushNotifications'
import { enableAudio, getSoundPreferences, playSound, saveSoundPreferences, SOUND_PREFERENCES_EVENT, type SoundPreferences } from '../lib/notificationSounds'
import './NotificationPreferences.css'

export function NotificationPreferences() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [preferences, setPreferences] = useState(getSoundPreferences)
  const [soundMessage, setSoundMessage] = useState('')
  const [testing, setTesting] = useState(false)
  const session = useQuery({ queryKey: ['notification-device-session'], queryFn: getSessionContext, enabled: open })
  const push = useQuery({ queryKey: ['notification-device-push'], queryFn: getDevicePushEnabled, enabled: open })
  const device = useMutation({ mutationFn: (enabled: boolean) => enabled ? enableDevicePush(session.data!.employeeId) : disableDevicePush(session.data!.employeeId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notification-device-push'] }) })
  useEffect(() => {
    const update = () => setPreferences(getSoundPreferences())
    window.addEventListener('storage', update)
    window.addEventListener(SOUND_PREFERENCES_EVENT, update)
    return () => { window.removeEventListener('storage', update); window.removeEventListener(SOUND_PREFERENCES_EVENT, update) }
  }, [])
  function change(next: Partial<SoundPreferences>) {
    const value = { ...preferences, ...next }
    setPreferences(value)
    saveSoundPreferences(value)
    setSoundMessage('Sound settings saved on this device.')
    if (!value.muted) void enableAudio()
  }
  async function test(kind: 'login' | 'notification') {
    setTesting(true)
    const enabled = await enableAudio()
    const played = enabled && await playSound(kind, true)
    setSoundMessage(played ? 'Test sound played. If you did not hear it, check the device volume and browser mute setting.' : 'This browser blocked sound. Check this site’s sound permission and try again.')
    setTesting(false)
  }
  return <details className="notification-preferences operations-panel" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><Volume2 aria-hidden="true" size={20} /><span>Sounds &amp; device notifications</span><small>Settings for this device</small></summary>
    {open ? <div className="notification-preferences__body">
      <section aria-label="Sound preferences"><h2>Make SygShift sound like SygShift</h2><p>Your selected login and notification sounds play while SygShift is open. Login plays only after a successful manual sign-in and required verification.</p>
        <div className="notification-preferences__toggles">
          <label><input type="checkbox" checked={preferences.login} onChange={(event) => change({ login: event.target.checked })} /><span>Login sound</span></label>
          <label><input type="checkbox" checked={preferences.notification} onChange={(event) => change({ notification: event.target.checked })} /><span>Notification sound</span></label>
          <label><input type="checkbox" checked={preferences.muted} onChange={(event) => change({ muted: event.target.checked })} /><span>Mute all SygShift sounds</span></label>
        </div>
        <label className="notification-preferences__volume"><span>Volume · {Math.round(preferences.volume * 100)}%</span><input aria-label="Sound volume" type="range" min="0" max="100" value={Math.round(preferences.volume * 100)} onChange={(event) => change({ volume: Number(event.target.value) / 100 })} /></label>
        <div className="notification-preferences__actions"><button className="secondary-button" disabled={testing} onClick={() => void test('login')} type="button">Test login sound</button><button className="secondary-button" disabled={testing} onClick={() => void test('notification')} type="button">Test notification sound</button></div>
        {soundMessage ? <p role="status">{soundMessage}</p> : null}
      </section>
      <section aria-label="Device notifications"><h2><BellRing aria-hidden="true" size={20} />Updates when SygShift is closed</h2><p>Enable notifications separately on each device. Lock-screen alerts keep ticket details private. Background sounds follow your browser and device settings, not the custom in-app sound.</p>
        {!pushSupported() ? <p>This browser does not support device notifications. On iPhone or iPad, add SygShift to your Home Screen and open it there.</p> : <>
          <p role="status">{push.isPending ? 'Checking this device…' : push.data ? 'Device notifications are enabled.' : 'Device notifications are off.'}</p>
          <button className="primary-action" disabled={device.isPending || session.isPending || session.isError || push.isPending} onClick={() => device.mutate(!push.data)} type="button">{device.isPending ? 'Updating device…' : push.data ? 'Turn off device notifications' : 'Enable device notifications'}</button>
          <p className="form-note">Allow notifications when prompted. If blocked, change this site’s notification permission in browser settings. On iPhone or iPad, use the Home Screen app. Signing out stops notifications for that session.</p>
        </>}
        {device.isSuccess ? <p role="status">Device notification setting updated.</p> : null}
        {device.isError || push.isError || session.isError ? <p role="alert">{device.error?.message || push.error?.message || session.error?.message}</p> : null}
      </section>
    </div> : null}
  </details>
}
