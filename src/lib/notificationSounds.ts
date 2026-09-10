export type SoundPreferences = { login: boolean; notification: boolean; alarm: boolean; muted: boolean; volume: number; alarmVolume: number }
export type SygShiftSoundKind = 'login' | 'notification' | 'alarm'
const KEY = 'sygshift.sound-preferences.v1'
export const SOUND_PREFERENCES_EVENT = 'sygshift:sound-preferences'
const defaults: SoundPreferences = { login: true, notification: true, alarm: true, muted: false, volume: 0.5, alarmVolume: 1 }
let context: AudioContext | undefined
const buffers = new Map<string, Promise<AudioBuffer>>()
let pendingLogin: { username: string; startedAt: number } | undefined
let lastNotificationSound = 0
let generation = 0
const sources = new Set<AudioBufferSourceNode>()
const alarmSources = new Set<AudioBufferSourceNode>()
const regularSources = new Set<AudioBufferSourceNode>()
const alarmCompletions = new Map<AudioBufferSourceNode, () => void>()

export function getSoundPreferences(): SoundPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}')
    return { login: typeof value.login === 'boolean' ? value.login : defaults.login,
      notification: typeof value.notification === 'boolean' ? value.notification : defaults.notification,
      alarm: typeof value.alarm === 'boolean' ? value.alarm : defaults.alarm,
      muted: typeof value.muted === 'boolean' ? value.muted : defaults.muted,
      volume: typeof value.volume === 'number' && Number.isFinite(value.volume) ? Math.max(0, Math.min(1, value.volume)) : defaults.volume,
      alarmVolume: typeof value.alarmVolume === 'number' && Number.isFinite(value.alarmVolume) ? Math.max(0, Math.min(1, value.alarmVolume)) : defaults.alarmVolume }
  } catch { return { ...defaults } }
}

export function saveSoundPreferences(value: SoundPreferences): void {
  if (value.muted) {
    generation += 1
    sources.forEach((source) => { try { source.stop() } catch { /* Already stopped. */ } })
    sources.clear(); regularSources.clear(); alarmSources.clear()
    alarmCompletions.forEach((finish) => finish()); alarmCompletions.clear()
  } else {
    if (value.volume === 0) {
      regularSources.forEach((source) => { try { source.stop() } catch { /* Already stopped. */ } })
      regularSources.clear()
    }
    if (!value.alarm || value.alarmVolume === 0) stopAlarmSound()
  }
  try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* Device storage can be unavailable. */ }
  navigator.serviceWorker?.controller?.postMessage({ type: 'sygshift:push-sound', muted: value.muted || !value.notification || value.volume === 0 })
  window.dispatchEvent(new Event(SOUND_PREFERENCES_EVENT))
}

// Must be invoked synchronously by a click/keyboard handler, before awaiting sign-in.
export async function enableAudio(): Promise<boolean> {
  try {
    context ??= new AudioContext()
    if (context.state !== 'running') await context.resume()
    return context.state === 'running'
  } catch { return false }
}

export async function playSound(kind: SygShiftSoundKind, test = false): Promise<boolean> {
  return startSound(kind, test, false)
}

export async function playAlarmSoundCycle(): Promise<boolean> {
  if (context?.state === 'suspended') {
    try { await context.resume() } catch { return false }
  }
  return startSound('alarm', false, true)
}

async function startSound(kind: SygShiftSoundKind, test: boolean, waitForCompletion: boolean): Promise<boolean> {
  const startedGeneration = generation
  const preferences = getSoundPreferences()
  const selectedVolume = kind === 'alarm' ? preferences.alarmVolume : preferences.volume
  if (!test && (preferences.muted || !preferences[kind] || selectedVolume === 0)) return true
  if (!context || context.state !== 'running') return false
  if (!test && kind === 'notification' && Date.now() - lastNotificationSound < 2500) return true
  try {
    const audio = context
    const path = kind === 'login'
      ? '/sounds/SygShift_Login.mp3'
      : kind === 'alarm'
        ? '/sounds/SygTasks_Alarm_6aa3fd61.mp3'
        : '/sounds/SygShift_Notification_53571d7e.mp3'
    if (!buffers.has(path)) buffers.set(path, fetch(path).then((response) => {
      if (!response.ok) throw new Error('Sound unavailable')
      return response.arrayBuffer()
    }).then((data) => audio.decodeAudioData(data)))
    const buffer = await buffers.get(path)!
    // Recheck mute after loading; sound is never on the authentication critical path.
    const current = getSoundPreferences()
    if (startedGeneration !== generation) return true
    if (!test && kind === 'notification' && Date.now() - lastNotificationSound < 2500) return true
    const currentVolume = kind === 'alarm' ? current.alarmVolume : current.volume
    if (!test && (current.muted || !current[kind] || currentVolume === 0)) return true
    const source = audio.createBufferSource()
    const gain = audio.createGain()
    source.buffer = buffer
    gain.gain.value = currentVolume
    source.connect(gain).connect(audio.destination)
    sources.add(source)
    if (kind === 'alarm') alarmSources.add(source); else regularSources.add(source)
    const completed = waitForCompletion ? new Promise<void>((resolve) => alarmCompletions.set(source, resolve)) : null
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      sources.delete(source); regularSources.delete(source); alarmSources.delete(source)
      const finish = alarmCompletions.get(source)
      alarmCompletions.delete(source)
      try { source.disconnect(); gain.disconnect() } catch { /* The source may already be disconnected. */ }
      finish?.()
    }
    source.onended = cleanup
    source.start()
    if (kind === 'notification') lastNotificationSound = Date.now()
    if (completed) await completed
    return true
  } catch {
    buffers.clear()
    return false
  }
}

export function stopAlarmSound(): void {
  alarmSources.forEach((source) => {
    try { source.stop() } catch { /* Already stopped. */ }
    alarmCompletions.get(source)?.()
    alarmCompletions.delete(source)
    sources.delete(source)
  })
  alarmSources.clear()
}

export function beginLoginSound(username: string): void {
  pendingLogin = { username: username.trim().toLowerCase(), startedAt: Date.now() }
  void enableAudio()
}
export function cancelLoginSound(): void {
  pendingLogin = undefined
  generation += 1
  sources.forEach((source) => { try { source.stop() } catch { /* Already stopped. */ } })
  sources.clear()
  regularSources.clear()
  alarmSources.clear()
  alarmCompletions.forEach((finish) => finish())
  alarmCompletions.clear()
}
export async function completeLoginSound(username: string): Promise<void> {
  const pending = pendingLogin
  pendingLogin = undefined
  if (pending && pending.username === username.toLowerCase() && Date.now() - pending.startedAt < 15 * 60_000) {
    await playSound('login')
  }
}
