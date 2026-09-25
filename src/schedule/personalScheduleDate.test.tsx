import { useEffect, useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { format } from 'date-fns'
import { describe, expect, it, vi } from 'vitest'
import { usePersonalScheduleDateBasis } from './personalScheduleDate'

function PersonalScheduleHarness({
  onLoad,
  serverTime,
}: {
  onLoad: (weekKey: string) => void
  serverTime: string
}) {
  // This intentionally already equals the first server-derived week. The
  // readiness state must still advance even if React can skip the same week.
  const [weekStart, setWeekStart] = useState(() => new Date(2026, 8, 20, 12))
  const basis = usePersonalScheduleDateBasis({
    employeeId: '11111111-1111-4111-8111-111111111111',
    enabled: true,
    onAnchorWeek: setWeekStart,
    serverTime,
    timeZone: 'America/New_York',
  })

  useEffect(() => {
    if (basis.isReady) onLoad(format(weekStart, 'yyyy-MM-dd'))
  }, [basis.isReady, onLoad, weekStart])

  return <span>{basis.isReady ? format(weekStart, 'yyyy-MM-dd') : 'verifying'}</span>
}

describe('personal schedule trusted-date gate', () => {
  it('loads an already-matching first week and refreshes at employee-local Sunday midnight', async () => {
    const onLoad = vi.fn()
    const view = render(
      <PersonalScheduleHarness
        onLoad={onLoad}
        serverTime="2026-09-27T03:59:59.000Z"
      />,
    )

    await waitFor(() => expect(screen.getByText('2026-09-20')).toBeInTheDocument())
    expect(onLoad).toHaveBeenLastCalledWith('2026-09-20')

    view.rerender(
      <PersonalScheduleHarness
        onLoad={onLoad}
        serverTime="2026-09-27T04:00:00.000Z"
      />,
    )

    await waitFor(() => expect(screen.getByText('2026-09-27')).toBeInTheDocument())
    expect(onLoad).toHaveBeenLastCalledWith('2026-09-27')
  })
})
