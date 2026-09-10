import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, BellRing, Download, Smartphone, Volume2 } from 'lucide-react'
import { getSessionContext } from '../data/auth'
import { disableDevicePush, enableDevicePush, getDevicePushEnabled, pushSupported } from '../data/pushNotifications'
import { enableAudio, getSoundPreferences, playSound, saveSoundPreferences, SOUND_PREFERENCES_EVENT, type SoundPreferences } from '../lib/notificationSounds'
import { getPwaInstallState, pwaInstallInstructions, requestPwaInstall, subscribePwaInstallState } from '../lib/pwaInstall'
import './NotificationPreferences.css'

export function NotificationPreferences() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [preferences, setPreferences] = useState(getSoundPreferences)
  const [soundMessage, setSoundMessage] = useState('')
  const [testing, setTesting] = useState(false)
  const [installState, setInstallState] = useState(getPwaInstallState)
  const [installMessage, setInstallMessage] = useState('')
  const session = useQuery({ queryKey: ['notification-device-session'], queryFn: getSessionContext, enabled: open })
  const push = useQuery({ queryKey: ['notification-device-push'], queryFn: getDevicePushEnabled, enabled: open })
  const pushPermission = pushSupported() ? Notification.permission : 'unsupported'
  const device = useMutation({ mutationFn: (enabled: boolean) => enabled ? enableDevicePush(session.data!.employeeId) : disableDevicePush(session.data!.employeeId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notification-device-push'] }) })
  useEffect(() => {
    const update = () => setPreferences(getSoundPreferences())
    window.addEventListener('storage', update)
    window.addEventListener(SOUND_PREFERENCES_EVENT, update)
    return () => { window.removeEventListener('storage', update); window.removeEventListener(SOUND_PREFERENCES_EVENT, update) }
  }, [])
  useEffect(() => subscribePwaInstallState(() => setInstallState(getPwaInstallState())), [])
  function change(next: Partial<SoundPreferences>) {
    const value = { ...preferences, ...next }
    setPreferences(value)
    saveSoundPreferences(value)
    setSoundMessage('Sound settings saved on this device.')
    if (!value.muted) void enableAudio()
  }
  async function test(kind: 'login' | 'notification' | 'alarm') {
    setTesting(true)
    const enabled = await enableAudio()
    const played = enabled && await playSound(kind, true)
    setSoundMessage(played ? 'Test sound played. If you did not hear it, check the device volume and browser mute setting.' : 'This browser blocked sound. Check this site’s sound permission and try again.')
    setTesting(false)
  }
  async function install() {
    const result = await requestPwaInstall()
    setInstallState(getPwaInstallState())
    setInstallMessage(result === 'installed'
      ? 'SygShift is installed on this device.'
      : result === 'dismissed'
        ? 'Installation was canceled. You can install SygShift later from this section.'
        : pwaInstallInstructions())
  }
  return <details className="notification-preferences operations-panel" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><Volume2 aria-hidden="true" size={20} /><span>Sounds &amp; device notifications</span><small>Settings and app install for this device</small></summary>
    {open ? <div className="notification-preferences__body">
      <section aria-label="Sound preferences"><h2>Make SygShift sound like SygShift</h2><p>Your selected login, notification, and task-alarm sounds play while SygShift is open. Login plays only after a successful manual sign-in and required verification.</p>
        <div className="notification-preferences__toggles">
          <label><input type="checkbox" checked={preferences.login} onChange={(event) => change({ login: event.target.checked })} /><span>Login sound</span></label>
          <label><input type="checkbox" checked={preferences.notification} onChange={(event) => change({ notification: event.target.checked })} /><span>Notification sound</span></label>
          <label><input type="checkbox" checked={preferences.alarm} onChange={(event) => change({ alarm: event.target.checked })} /><span><AlarmClock aria-hidden="true" size={17} />Repeating task-alarm sound</span></label>
          <label><input type="checkbox" checked={preferences.muted} onChange={(event) => change({ muted: event.target.checked })} /><span>Mute all SygShift sounds</span></label>
        </div>
        <label className="notification-preferences__volume"><span>Volume · {Math.round(preferences.volume * 100)}%</span><input aria-label="Sound volume" type="range" min="0" max="100" value={Math.round(preferences.volume * 100)} onChange={(event) => change({ volume: Number(event.target.value) / 100 })} /></label>
        <div className="notification-preferences__actions"><button className="secondary-button" disabled={testing} onClick={() => void test('login')} type="button">Test login sound</button><button className="secondary-button" disabled={testing} onClick={() => void test('notification')} type="button">Test notification sound</button><button className="secondary-button" disabled={testing} onClick={() => void test('alarm')} type="button">Test task alarm</button></div>
        {soundMessage ? <p role="status">{soundMessage}</p> : null}
      </section>
      <section aria-label="Device notifications"><h2><BellRing aria-hidden="true" size={20} />Updates when SygShift is closed</h2><p>Enable notifications separately on each device. Lock-screen alerts keep ticket details private. Background sounds follow your browser and device settings, not the custom in-app sound.</p>
        {!pushSupported() ? <p>This browser does not support device notifications. On iPhone or iPad, add SygShift to your Home Screen and open it there.</p> : <>
          <p role="status">{push.isPending ? 'Checking this device…' : push.data ? 'Device notifications are enabled for this signed-in account.' : pushPermission === 'denied' ? 'Device notifications are blocked in this browser.' : 'Device notifications are off on this device.'}</p>
          <button className="primary-action" disabled={device.isPending || session.isPending || session.isError || push.isPending} onClick={() => device.mutate(!push.data)} type="button">{device.isPending ? 'Updating device…' : push.data ? 'Turn off device notifications' : 'Enable device notifications'}</button>
          <p className="form-note">{pushPermission === 'denied' ? 'Open this site’s browser settings, change Notifications to Allow, then return here. ' : 'Allow notifications when prompted. '}On iPhone or iPad, install and open the Home Screen app first. Signing out removes this account from background delivery on this device.</p>
        </>}
        {device.isSuccess ? <p role="status">Device notification setting updated.</p> : null}
        {device.isError || push.isError || session.isError ? <p role="alert">{device.error?.message || push.error?.message || session.error?.message}</p> : null}
      </section>
      <section aria-label="Install SygShift" className="notification-preferences__install"><div className="notification-preferences__install-copy"><h2><Smartphone aria-hidden="true" size={20} />Install SygShift on this device</h2><p>Use SygShift like an app with its own icon and window. Installation does not create another account, bypass sign-in, or store protected records for offline use.</p></div>
        <div className="notification-preferences__install-action">
          {installState.installed ? <p className="notification-preferences__installed" role="status">SygShift is installed on this device.</p> : <button className="secondary-button" type="button" onClick={() => void install()}><Download aria-hidden="true" size={17} />{installState.canPrompt ? 'Install SygShift' : 'How to install'}</button>}
          {installMessage && !installState.installed ? <p className="form-note" role="status">{installMessage}</p> : null}
        </div>
      </section>
    </div> : null}
  </details>
}
