import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { AlarmClock, CheckCircle2, ExternalLink, Volume2, VolumeX } from 'lucide-react'
import {
  getMySygTasksAlarmState,
  manageMySygTasksAlarm,
  mutateSygTasks,
  sygTaskPath,
  type SygTasksAlarm,
} from '../data/sygtasks'
import { formatTaskDue } from '../lib/sygtasksPresentation'
import {
  enableAudio,
  getSoundPreferences,
  playAlarmSoundCycle,
  playSound,
  saveSoundPreferences,
  SOUND_PREFERENCES_EVENT,
  stopAlarmSound,
} from '../lib/notificationSounds'
import './SygTasksAlarmHost.css'

const alarmRepeatDelayMs = 3_000
const leaseDurationMs = 12_000
const snoozeOptions = [5, 10, 15, 30, 60] as const

function waitForAlarmInterval(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = window.setTimeout(finish, alarmRepeatDelayMs)
    function finish() {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The task alarm could not be updated.'
}

type AlarmLease = { owner: string; expiresAt: number }

function readLease(key: string): AlarmLease | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as AlarmLease | null
    return value && typeof value.owner === 'string' && typeof value.expiresAt === 'number' ? value : null
  } catch { return null }
}

async function runWithSingleTabLease(employeeId: string, signal: AbortSignal, work: () => Promise<void>) {
  const lockName = `sygshift:sygtasks-alarm:${employeeId}`
  if (navigator.locks) {
    await navigator.locks.request(lockName, { ifAvailable: true, signal }, async (lock) => {
      if (lock) await work()
    })
    return
  }

  const owner = crypto.randomUUID()
  const key = `${lockName}:lease`
  const current = readLease(key)
  if (current && current.expiresAt > Date.now()) return
  try { localStorage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + leaseDurationMs })) }
  catch { await work(); return }
  if (readLease(key)?.owner !== owner) return
  const refresh = window.setInterval(() => {
    if (!signal.aborted && readLease(key)?.owner === owner) {
      localStorage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + leaseDurationMs }))
    }
  }, leaseDurationMs / 3)
  try { await work() }
  finally {
    window.clearInterval(refresh)
    if (readLease(key)?.owner === owner) localStorage.removeItem(key)
  }
}

function AlarmDetails({ alarm }: { alarm: SygTasksAlarm }) {
  return <div className="sygtasks-alarm-host__details">
    <span><small>Alarm time</small><strong>{formatTaskDue(alarm.scheduledFor)}</strong></span>
    <span><small>Task due</small><strong>{formatTaskDue(alarm.dueAt)}</strong></span>
  </div>
}

export function SygTasksAlarmHost({ employeeId }: { employeeId: string }) {
  const queryClient = useQueryClient()
  const [snoozeMinutes, setSnoozeMinutes] = useState<(typeof snoozeOptions)[number]>(10)
  const [silenced, setSilenced] = useState<Set<string>>(() => new Set())
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [alarmVolume, setAlarmVolume] = useState(() => getSoundPreferences().alarmVolume)
  const [soundEnabled, setSoundEnabled] = useState(() => {
    const preferences = getSoundPreferences()
    return preferences.alarm && !preferences.muted && preferences.alarmVolume > 0
  })
  const alarms = useQuery({
    queryKey: ['sygtasks-alarms', employeeId],
    queryFn: getMySygTasksAlarmState,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  })
  const activeAlarm = alarms.data?.alarms[0] ?? null
  const activeAlarmId = activeAlarm?.occurrenceId ?? null

  useEffect(() => {
    const update = () => {
      const preferences = getSoundPreferences()
      setAlarmVolume(preferences.alarmVolume)
      setSoundEnabled(preferences.alarm && !preferences.muted && preferences.alarmVolume > 0)
    }
    window.addEventListener(SOUND_PREFERENCES_EVENT, update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener(SOUND_PREFERENCES_EVENT, update)
      window.removeEventListener('storage', update)
    }
  }, [])

  useEffect(() => {
    const activeIds = new Set(alarms.data?.alarms.map((alarm) => alarm.occurrenceId) ?? [])
    setSilenced((current) => {
      const next = new Set([...current].filter((id) => activeIds.has(id)))
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next
    })
  }, [alarms.data?.alarms])

  useEffect(() => {
    if (!activeAlarm || silenced.has(activeAlarm.occurrenceId) || !soundEnabled) {
      stopAlarmSound()
      return
    }
    const controller = new AbortController()
    void runWithSingleTabLease(employeeId, controller.signal, async () => {
      while (!controller.signal.aborted) {
        const played = await playAlarmSoundCycle()
        if (!controller.signal.aborted) setAudioBlocked(!played)
        await waitForAlarmInterval(controller.signal)
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && (error as { name?: string })?.name !== 'AbortError') setAudioBlocked(true)
    })
    return () => {
      controller.abort()
      stopAlarmSound()
    }
  }, [activeAlarm, employeeId, silenced, soundEnabled])

  useEffect(() => {
    if (!activeAlarmId) return
    const preferences = getSoundPreferences()
    const nextVolume = preferences.alarmVolume > 0 ? preferences.alarmVolume : 1
    if (!preferences.alarm || preferences.muted || preferences.alarmVolume === 0) {
      saveSoundPreferences({ ...preferences, alarm: true, muted: false, alarmVolume: nextVolume })
      setAlarmVolume(nextVolume)
      setSoundEnabled(true)
    }
    void enableAudio().then((enabled) => setAudioBlocked(!enabled))
  }, [activeAlarmId])

  const silenceLocally = (occurrenceId: string) => {
    stopAlarmSound()
    setSilenced((current) => new Set(current).add(occurrenceId))
  }
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['sygtasks'] }),
      queryClient.invalidateQueries({ queryKey: ['sygtasks-alarms'] }),
      queryClient.invalidateQueries({ queryKey: ['sygtasks-badge'] }),
      queryClient.invalidateQueries({ queryKey: ['my-notifications'] }),
    ])
  }
  const manage = useMutation({
    mutationFn: ({ action, alarm, minutes }: { action: 'acknowledge' | 'snooze'; alarm: SygTasksAlarm; minutes: (typeof snoozeOptions)[number] | null }) =>
      manageMySygTasksAlarm(action, alarm.occurrenceId, minutes),
    onMutate: ({ alarm }) => silenceLocally(alarm.occurrenceId),
    onSuccess: refresh,
  })
  const complete = useMutation({
    mutationFn: (alarm: SygTasksAlarm) => mutateSygTasks('update_task', { taskId: alarm.taskId, status: 'done' }, { expectedVersion: alarm.taskVersion }),
    onMutate: (alarm) => silenceLocally(alarm.occurrenceId),
    onSuccess: refresh,
  })
  const pending = manage.isPending || complete.isPending
  const mutationError = manage.error || complete.error
  const remainingCount = Math.max(0, (alarms.data?.alarms.length ?? 0) - 1)
  const locallySilenced = activeAlarm ? silenced.has(activeAlarm.occurrenceId) : false
  const soundStatus = useMemo(() => {
    if (!soundEnabled) return 'Alarm audio is off in this device’s sound settings.'
    if (locallySilenced) return 'Sound is silenced in this browser. Stop or snooze to update the alarm everywhere.'
    return 'Repeats three seconds after the sound finishes until stopped, snoozed, completed, or canceled.'
  }, [locallySilenced, soundEnabled])

  function changeAlarmVolume(value: number) {
    const preferences = getSoundPreferences()
    saveSoundPreferences({ ...preferences, alarm: true, muted: false, alarmVolume: value })
    setAlarmVolume(value)
    if (value > 0) void enableAudio().then((enabled) => setAudioBlocked(!enabled))
  }

  if (!activeAlarm) return null

  return <aside className="sygtasks-alarm-host" aria-label="Active task alarm" aria-live="assertive">
    <article className={`sygtasks-alarm-host__card sygtasks-alarm-host__card--${activeAlarm.priority}`}>
      <header>
        <span className="sygtasks-alarm-host__icon"><AlarmClock aria-hidden="true" /></span>
        <div><small>SygTasks alarm</small><h2>{activeAlarm.title}</h2></div>
        {remainingCount ? <span className="sygtasks-alarm-host__count">+{remainingCount}</span> : null}
      </header>
      <AlarmDetails alarm={activeAlarm} />
      <p className="sygtasks-alarm-host__sound">{soundEnabled && !locallySilenced ? <Volume2 aria-hidden="true" size={17} /> : <VolumeX aria-hidden="true" size={17} />}{soundStatus}</p>
      <label className="sygtasks-alarm-host__volume"><span>Alarm volume · {Math.round(alarmVolume * 100)}%</span><input aria-label="Task alarm volume" max="100" min="0" onChange={(event) => changeAlarmVolume(Number(event.target.value) / 100)} type="range" value={Math.round(alarmVolume * 100)} /></label>
      {audioBlocked && soundEnabled && !locallySilenced ? <button className="sygtasks-button sygtasks-button--secondary sygtasks-alarm-host__audio" type="button" onClick={() => void enableAudio().then((enabled) => { setAudioBlocked(!enabled); if (enabled) void playSound('alarm') })}>Enable alarm sound</button> : null}
      {mutationError ? <p className="sygtasks-notice sygtasks-notice--error" role="alert">{errorMessage(mutationError)}</p> : null}
      <div className="sygtasks-alarm-host__actions">
        <button className="sygtasks-button sygtasks-button--primary" disabled={pending} type="button" onClick={() => manage.mutate({ action: 'acknowledge', alarm: activeAlarm, minutes: null })}>Stop alarm</button>
        <span className="sygtasks-alarm-host__snooze"><select aria-label="Snooze duration" disabled={pending} value={snoozeMinutes} onChange={(event) => setSnoozeMinutes(Number(event.target.value) as typeof snoozeMinutes)}>{snoozeOptions.map((minutes) => <option value={minutes} key={minutes}>{minutes === 60 ? '1 hour' : `${minutes} minutes`}</option>)}</select><button className="sygtasks-button sygtasks-button--secondary" disabled={pending} type="button" onClick={() => manage.mutate({ action: 'snooze', alarm: activeAlarm, minutes: snoozeMinutes })}>Snooze</button></span>
        <Link className="sygtasks-button sygtasks-button--secondary" to={sygTaskPath(activeAlarm.boardId, activeAlarm.taskId)}>Open task <ExternalLink aria-hidden="true" size={15} /></Link>
        {activeAlarm.canComplete ? <button className="sygtasks-button sygtasks-button--secondary" disabled={pending} type="button" onClick={() => complete.mutate(activeAlarm)}><CheckCircle2 aria-hidden="true" size={16} />Mark complete</button> : null}
      </div>
    </article>
  </aside>
}
