import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishSharedIdentityBrowserEvent, subscribeToSharedIdentityBrowserEvents } from './sharedIdentityBrowserSync'

afterEach(() => vi.unstubAllGlobals())

describe('shared identity browser coordination', () => {
  it('signals refresh and clearance without exposing bearer material', () => {
    const channels: FakeBroadcastChannel[] = []
    vi.stubGlobal('BroadcastChannel', class extends FakeBroadcastChannel {
      constructor(name: string) {
        super(name)
        channels.push(this)
      }
    })
    const listener = vi.fn()
    const unsubscribe = subscribeToSharedIdentityBrowserEvents(listener)

    channels[0].emit({ action: 'updated', type: 'wrong-type', version: 1 })
    channels[0].emit({ action: 'invalid', type: 'sygshift-shared-session', version: 1 })
    channels[0].emit({ action: 'updated', type: 'sygshift-shared-session', version: 1 })
    publishSharedIdentityBrowserEvent('cleared')

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith('updated')
    expect(channels[1].posted).toEqual([{ action: 'cleared', type: 'sygshift-shared-session', version: 1 }])
    expect(JSON.stringify(channels[1].posted)).not.toMatch(/token|bearer/i)
    unsubscribe()
    expect(channels[0].closed).toBe(true)
    expect(channels[1].closed).toBe(true)
  })
})

class FakeBroadcastChannel {
  readonly name: string
  readonly posted: unknown[] = []
  closed = false
  private listener: ((event: MessageEvent<unknown>) => void) | null = null

  constructor(name: string) { this.name = name }
  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void) { this.listener = listener }
  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void) {
    if (this.listener === listener) this.listener = null
  }
  postMessage(message: unknown) { this.posted.push(message) }
  close() { this.closed = true }
  emit(data: unknown) { this.listener?.(new MessageEvent('message', { data })) }
}
