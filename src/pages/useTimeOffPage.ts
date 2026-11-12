import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getTimeOffRequestPage, type TimeOffPageBucket, type TimeOffPageCursor, type TimeOffPageStatus } from '../data/requests'

export function useTimeOffPage(input: {
  employeeId: string
  accessGeneration: number
  search: string
  status: TimeOffPageStatus
  bucket: TimeOffPageBucket
  refreshKey: number
}) {
  const scope = JSON.stringify(input)
  const [navigation, setNavigation] = useState<{ scope: string; index: number; cursors: (TimeOffPageCursor | null)[] }>({ scope, index: 0, cursors: [null] })
  const current = navigation.scope === scope ? navigation : { scope, index: 0, cursors: [null] }
  const cursor = current.cursors[current.index] ?? null
  const query = useQuery({
    queryKey: ['time-off-request-page', input.employeeId, input.accessGeneration, input.search, input.status, input.bucket, input.refreshKey, cursor],
    queryFn: ({ signal }) => getTimeOffRequestPage({ ...input, limit: 20, cursor, signal }),
    retry: false,
  })
  const page = query.data
  return {
    query,
    index: current.index,
    newer: () => setNavigation({ ...current, index: Math.max(0, current.index - 1) }),
    older: () => {
      if (!page?.page.hasMore || !page.page.nextCursor || query.isFetching || query.isError) return
      const cursors = current.cursors.slice(0, current.index + 1)
      cursors[current.index] = page.page.currentCursor
      cursors.push(page.page.nextCursor)
      setNavigation({ scope, index: current.index + 1, cursors })
    },
  }
}
