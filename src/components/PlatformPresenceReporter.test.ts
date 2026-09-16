import { describe, expect, it } from 'vitest'
import { PLATFORM_PRESENCE_IDLE_MS, platformPresenceState } from '../lib/platformPresenceState'

describe('platform presence state', () => {
  it('is active only while the app is visible and interaction is recent', () => {
    expect(platformPresenceState('visible', 1_000, 1_000 + PLATFORM_PRESENCE_IDLE_MS - 1)).toBe('active')
    expect(platformPresenceState('visible', 1_000, 1_000 + PLATFORM_PRESENCE_IDLE_MS)).toBe('away')
    expect(platformPresenceState('hidden', 10_000, 10_001)).toBe('away')
  })
})
