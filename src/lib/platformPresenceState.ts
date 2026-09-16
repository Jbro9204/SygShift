export const PLATFORM_PRESENCE_HEARTBEAT_MS = 45_000
export const PLATFORM_PRESENCE_IDLE_MS = 5 * 60_000
export const PLATFORM_PRESENCE_THROTTLE_MS = 15_000

export function platformPresenceState(
  visibility: DocumentVisibilityState,
  lastInteractionAt: number,
  now = Date.now(),
): 'active' | 'away' {
  return visibility === 'visible' && now - lastInteractionAt < PLATFORM_PRESENCE_IDLE_MS ? 'active' : 'away'
}
