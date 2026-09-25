import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { format, startOfWeek } from 'date-fns'
import { scheduleCalendarDateInTimeZone } from './timeBasis'

export interface PersonalScheduleDateBasis {
  currentWeek: Date | null
  isReady: boolean
  today: Date | null
}

export function usePersonalScheduleDateBasis({
  employeeId,
  enabled,
  onAnchorWeek,
  serverTime,
  timeZone,
}: {
  employeeId?: string | null
  enabled: boolean
  onAnchorWeek: Dispatch<SetStateAction<Date>>
  serverTime?: string | null
  timeZone: string
}): PersonalScheduleDateBasis {
  const [anchoredBasisKey, setAnchoredBasisKey] = useState<string | null>(null)
  const today = useMemo(() => {
    if (!serverTime) return null
    try {
      return scheduleCalendarDateInTimeZone(serverTime, timeZone)
    } catch {
      return null
    }
  }, [serverTime, timeZone])
  const currentWeek = useMemo(
    () => today ? startOfWeek(today, { weekStartsOn: 0 }) : null,
    [today],
  )
  const basisKey = employeeId && currentWeek
    ? `${employeeId}:${timeZone}:${format(currentWeek, 'yyyy-MM-dd')}`
    : null

  useEffect(() => {
    if (!enabled || !basisKey || !currentWeek) {
      setAnchoredBasisKey((current) => current === null ? current : null)
      return
    }
    if (anchoredBasisKey === basisKey) return

    onAnchorWeek(currentWeek)
    setAnchoredBasisKey(basisKey)
  }, [anchoredBasisKey, basisKey, currentWeek, enabled, onAnchorWeek])

  return {
    currentWeek,
    isReady: enabled && basisKey !== null && anchoredBasisKey === basisKey,
    today,
  }
}
