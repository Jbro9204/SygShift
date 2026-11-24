import { useEffect, useMemo, useState } from 'react'
import type { PatrolWorkspace } from '../data/patrol'

export type PatrolMakeupQueueItem = PatrolWorkspace['makeupQueue'][number]

const recentWindowMs = 14 * 24 * 60 * 60 * 1000
const maximumClockCheckDelayMs = 60_000
export const emptyPatrolMakeupQueue: readonly PatrolMakeupQueueItem[] = []

function groupMakeupQueue(items: readonly PatrolMakeupQueueItem[], now: number) {
  const cutoff = now - recentWindowMs
  const recent: PatrolMakeupQueueItem[] = []
  const older: PatrolMakeupQueueItem[] = []
  let nextTransitionAt = Number.POSITIVE_INFINITY

  for (const item of items) {
    // The stored deadline is an instant. Do not interpret an unexpected
    // timezone-less or invalid value using the browser's local timezone.
    const dueEndAt = /(?:Z|[+-]\d{2}:\d{2})$/i.test(item.dueEndAt) ? Date.parse(item.dueEndAt) : NaN
    if (dueEndAt < cutoff) {
      older.push(item)
    } else {
      recent.push(item)
      if (Number.isFinite(dueEndAt)) nextTransitionAt = Math.min(nextTransitionAt, dueEndAt + recentWindowMs + 1)
    }
  }

  return { recent, older, nextTransitionAt }
}

export function usePatrolMakeupQueue(items: readonly PatrolMakeupQueueItem[]) {
  const [now, setNow] = useState(() => Date.now())
  const grouped = useMemo(() => groupMakeupQueue(items, now), [items, now])
  const { nextTransitionAt } = grouped

  useEffect(() => {
    if (!items.length) return
    const refreshClock = () => setNow(Date.now())
    const delay = Math.max(0, Math.min(maximumClockCheckDelayMs, nextTransitionAt - Date.now()))
    const timer = Number.isFinite(nextTransitionAt) ? window.setTimeout(refreshClock, delay) : null
    window.addEventListener('focus', refreshClock)
    document.addEventListener('visibilitychange', refreshClock)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('focus', refreshClock)
      document.removeEventListener('visibilitychange', refreshClock)
    }
  }, [items.length, nextTransitionAt, now])

  return grouped
}

export function formatMakeupServiceDate(serviceDate: string) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(serviceDate)
  return parts ? `${parts[2]}/${parts[3]}/${parts[1]}` : serviceDate
}

export function matchesOlderMakeupSearch(item: PatrolMakeupQueueItem, search: string) {
  const searchable = `${item.locationLabel} ${item.routeName} ${item.employeeName} ${item.serviceDate} ${formatMakeupServiceDate(item.serviceDate)}`.toLowerCase()
  return search.trim().toLowerCase().split(/\s+/).every((term) => searchable.includes(term))
}
