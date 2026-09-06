import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('sound lifecycle', () => {
  const started = vi.fn()
  beforeEach(() => {
    vi.resetModules(); localStorage.clear(); started.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })))
    vi.stubGlobal('AudioContext', class {
      state = 'running'; destination = {}
      async resume() {}
      async decodeAudioData() { return {} }
      createBufferSource() { return { connect: (target: unknown) => target, start: started, stop() {}, disconnect() {}, buffer: null, onended: null } }
      createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} } }
    })
  })
  it('plays login once only after the matching manual login completes', async () => {
    const sound = await import('./notificationSounds')
    await sound.completeLoginSound('alex'); expect(started).not.toHaveBeenCalled()
    sound.beginLoginSound('alex'); expect(started).not.toHaveBeenCalled()
    await sound.completeLoginSound('alex'); expect(started).toHaveBeenCalledTimes(1)
    await sound.completeLoginSound('alex'); expect(started).toHaveBeenCalledTimes(1)
  })
  it('does not play on failed or mismatched sign-in', async () => {
    const sound = await import('./notificationSounds')
    sound.beginLoginSound('alex'); sound.cancelLoginSound(); await sound.completeLoginSound('alex')
    sound.beginLoginSound('alex'); await sound.completeLoginSound('someoneelse')
    expect(started).not.toHaveBeenCalled()
  })
  it('honors separate preferences and mute without affecting test playback', async () => {
    const sound = await import('./notificationSounds')
    await sound.enableAudio()
    sound.saveSoundPreferences({ login: false, notification: true, muted: true, volume: .5 })
    await sound.playSound('login'); await sound.playSound('notification'); expect(started).not.toHaveBeenCalled()
    await sound.playSound('notification', true); expect(started).toHaveBeenCalledTimes(1)
  })
  it('contains autoplay and audio-file failures', async () => {
    const sound = await import('./notificationSounds')
    expect(await sound.playSound('notification')).toBe(false)
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('blocked') } })
    expect(await sound.enableAudio()).toBe(false)
  })
  it('repairs invalid stored preferences and clamps volume', async () => {
    const sound = await import('./notificationSounds')
    localStorage.setItem('sygshift.sound-preferences.v1', '{"volume":3,"muted":"no"}')
    expect(sound.getSoundPreferences()).toEqual({ login: true, notification: true, muted: false, volume: 1 })
  })
})
