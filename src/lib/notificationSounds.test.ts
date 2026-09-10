import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

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
  it('uses the approved login, notification, and repeating task-alarm assets', async () => {
    const sound = await import('./notificationSounds')
    await sound.enableAudio()
    await sound.playSound('notification', true)
    expect(fetch).toHaveBeenLastCalledWith('/sounds/SygShift_Notification_53571d7e.mp3')
    await sound.playSound('login', true)
    expect(fetch).toHaveBeenLastCalledWith('/sounds/SygShift_Login.mp3')
    await sound.playSound('alarm', true)
    expect(fetch).toHaveBeenLastCalledWith('/sounds/SygTasks_Alarm_6aa3fd61.mp3')
    for (const [name, expected] of [
      ['SygShift_Notification_53571d7e.mp3', '53571d7efae8ce122d8059b3522a237a1a59e2bff2ba6011bf49193c09c0a215'],
      ['SygShift_Login.mp3', 'f39b512b6b8dbe498283853368513f11211e0a1a3fca38acdcea9de04caf9256'],
      ['SygTasks_Alarm_6aa3fd61.mp3', '6aa3fd616b52905480d596c7a747d7129687ab3845ccc307565b7aef16506198'],
    ]) {
      expect(createHash('sha256').update(readFileSync(`public/sounds/${name}`)).digest('hex')).toBe(expected)
    }
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
    sound.saveSoundPreferences({ login: false, notification: true, alarm: false, muted: true, volume: .5 })
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
    expect(sound.getSoundPreferences()).toEqual({ login: true, notification: true, alarm: true, muted: false, volume: 1 })
  })
})
