import { useCallback, useState } from 'react'
import {
  isEarlyClockInBlockedError,
  type EarlyClockInBlockedDetails,
} from '../data/timekeeping'

export function useEarlyClockInRestriction() {
  const [restriction, setRestriction] = useState<EarlyClockInBlockedDetails | null>(null)
  const [acknowledged, setAcknowledged] = useState<EarlyClockInBlockedDetails | null>(null)

  const handleMutationError = useCallback((error: unknown) => {
    if (!isEarlyClockInBlockedError(error)) return false
    setAcknowledged(null)
    setRestriction(error.details)
    return true
  }, [])

  const clearForRecordedPunch = useCallback(() => {
    setRestriction(null)
    setAcknowledged(null)
  }, [])

  const acknowledge = useCallback(() => {
    setRestriction((current) => {
      if (current) setAcknowledged(current)
      return null
    })
  }, [])

  return {
    acknowledge,
    acknowledged,
    clearForRecordedPunch,
    handleMutationError,
    restriction,
  }
}
