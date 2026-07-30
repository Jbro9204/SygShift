import type { QueryClient } from '@tanstack/react-query'
import {
  applyRecordedTimeEventToDashboard,
  type TimekeepingDashboard,
  type TimekeepingEvent,
} from '../data/timekeeping'

const dashboardQueryPrefixes = [
  ['timekeeping-dashboard'],
  ['my-time-dashboard'],
  ['time-command-dashboard'],
] as const

const dependentQueryPrefixes = [
  ['overview-metrics'],
  ['my-time-review'],
  ['my-timekeeping-review'],
  ['time-command-review'],
  ['timekeeping-review'],
  ['time-maintenance'],
] as const

export function applyTimeEventToCachedDashboards(
  queryClient: QueryClient,
  event: TimekeepingEvent,
): void {
  for (const queryKey of dashboardQueryPrefixes) {
    queryClient.setQueriesData<TimekeepingDashboard>({ queryKey }, (dashboard) => {
      if (!dashboard) return dashboard
      return applyRecordedTimeEventToDashboard(dashboard, event)
    })
  }
}

export async function refreshTimekeepingQueriesAfterPunch(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    ...dashboardQueryPrefixes.map((queryKey) => queryClient.invalidateQueries({ queryKey, refetchType: 'active' })),
    ...dependentQueryPrefixes.map((queryKey) => queryClient.invalidateQueries({ queryKey, refetchType: 'active' })),
  ])

  await Promise.all([
    ...dashboardQueryPrefixes.map((queryKey) => queryClient.refetchQueries({ queryKey, type: 'active' })),
    ...dependentQueryPrefixes.map((queryKey) => queryClient.refetchQueries({ queryKey, type: 'active' })),
  ])
}
