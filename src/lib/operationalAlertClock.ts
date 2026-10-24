export function advanceServerTimestamp(
  serverTimestamp: string | undefined,
  monotonicAnchor: number,
  monotonicNow: number,
): string | undefined {
  if (!serverTimestamp) return undefined

  const serverTime = Date.parse(serverTimestamp)
  if (!Number.isFinite(serverTime)) return undefined
  if (!Number.isFinite(monotonicAnchor) || monotonicAnchor < 0 || !Number.isFinite(monotonicNow)) {
    return new Date(serverTime).toISOString()
  }

  // The elapsed duration must come from a monotonic clock (performance.now),
  // never Date.now. Correcting a device clock must not jump operational dates
  // or make alerts expire early.
  return new Date(serverTime + Math.max(0, monotonicNow - monotonicAnchor)).toISOString()
}
