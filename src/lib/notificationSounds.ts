export type SoundPreferences = { login: boolean; notification: boolean; muted: boolean; volume: number }
const KEY = 'sygshift.sound-preferences.v1'
export const SOUND_PREFERENCES_EVENT = 'sygshift:sound-preferences'
const defaults: SoundPreferences = { login: true, notification: true, muted: false, volume: 0.5 }
let context: AudioContext | undefined
const buffers = new Map<string, Promise<AudioBuffer>>()
let pendingLogin: { username: string; startedAt: number } | undefined
let lastNotificationSound = 0
let generation = 0
const sources = new Set<AudioBufferSourceNode>()

export function getSoundPreferences(): SoundPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}')
    return { login: typeof value.login === 'boolean' ? value.login : defaults.login,
      notification: typeof value.notification === 'boolean' ? value.notification : defaults.notification,
      muted: typeof value.muted === 'boolean' ? value.muted : defaults.muted,
      volume: typeof value.volume === 'number' && Number.isFinite(value.volume) ? Math.max(0, Math.min(1, value.volume)) : defaults.volume }
  } catch { return { ...defaults } }
}

export function saveSoundPreferences(value: SoundPreferences): void {
  if (value.muted || value.volume === 0) { generation += 1; sources.forEach((source) => { try { source.stop() } catch { /* Already stopped. */ } }); sources.clear() }
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

export async function playSound(kind: 'login' | 'notification', test = false): Promise<boolean> {
  const startedGeneration = generation
  const preferences = getSoundPreferences()
  if (!test && (preferences.muted || !preferences[kind] || preferences.volume === 0)) return true
  if (!context || context.state !== 'running') return false
  if (!test && kind === 'notification' && Date.now() - lastNotificationSound < 2500) return true
  try {
    const audio = context
    const path = kind === 'login' ? '/sounds/SygShift_Login.mp3' : '/sounds/SygShift_Notification_53571d7e.mp3'
    if (!buffers.has(path)) buffers.set(path, fetch(path).then((response) => {
      if (!response.ok) throw new Error('Sound unavailable')
      return response.arrayBuffer()
    }).then((data) => audio.decodeAudioData(data)))
    const buffer = await buffers.get(path)!
    // Recheck mute after loading; sound is never on the authentication critical path.
    const current = getSoundPreferences()
    if (startedGeneration !== generation) return true
    if (!test && kind === 'notification' && Date.now() - lastNotificationSound < 2500) return true
    if (!test && (current.muted || !current[kind])) return true
    const source = audio.createBufferSource()
    const gain = audio.createGain()
    source.buffer = buffer
    gain.gain.value = current.volume
    source.connect(gain).connect(audio.destination)
    source.start()
    sources.add(source)
    source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect() }
    if (kind === 'notification') lastNotificationSound = Date.now()
    return true
  } catch {
    buffers.clear()
    return false
  }
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
}
export async function completeLoginSound(username: string): Promise<void> {
  const pending = pendingLogin
  pendingLogin = undefined
  if (pending && pending.username === username.toLowerCase() && Date.now() - pending.startedAt < 15 * 60_000) {
    await playSound('login')
  }
}
