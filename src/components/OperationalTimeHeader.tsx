import { type ReactNode, useEffect, useRef, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { formatOperationalDate, formatTimeZoneClock } from '../lib/time'
import { continentalUsTimeZoneShortLabel } from '../lib/usTimeZones'
import { browserSystemTimeZone } from '../lib/systemTimeZone'

type ClockAnchor = {
  clientTime: number
  serverTime: number
}

function clockAnchor(serverTimestamp?: string | null): ClockAnchor {
  const clientTime = Date.now()
  const parsedServerTime = serverTimestamp ? Date.parse(serverTimestamp) : Number.NaN
  return {
    clientTime,
    serverTime: Number.isFinite(parsedServerTime) ? parsedServerTime : clientTime,
  }
}

function timeFromAnchor(anchor: ClockAnchor): Date {
  return new Date(anchor.serverTime + (Date.now() - anchor.clientTime))
}

export function OperationalTimeHeader({
  accountControls,
  fallbackTimeZone,
  serverTimestamp,
}: {
  accountControls: ReactNode
  fallbackTimeZone?: string | null
  serverTimestamp?: string | null
}) {
  const anchorRef = useRef(clockAnchor(serverTimestamp))
  const [now, setNow] = useState(() => timeFromAnchor(anchorRef.current))
  const [displayTimeZone, setDisplayTimeZone] = useState(() => browserSystemTimeZone(fallbackTimeZone))
  const display = formatTimeZoneClock(now, displayTimeZone)
  const timeZoneLabel = continentalUsTimeZoneShortLabel(displayTimeZone)

  useEffect(() => {
    anchorRef.current = clockAnchor(serverTimestamp)
    setNow(timeFromAnchor(anchorRef.current))
  }, [serverTimestamp])

  useEffect(() => {
    setDisplayTimeZone(browserSystemTimeZone(fallbackTimeZone))
  }, [fallbackTimeZone])

  useEffect(() => {
    const updateClock = () => setNow(timeFromAnchor(anchorRef.current))
    const interval = window.setInterval(updateClock, 1_000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setDisplayTimeZone(browserSystemTimeZone(fallbackTimeZone))
        updateClock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [fallbackTimeZone])

  return (
    <header className="topbar">
      <div className="topbar-date">
        <CalendarDays aria-hidden="true" size={20} strokeWidth={1.9} />
        <span>{formatOperationalDate(now, displayTimeZone)}</span>
      </div>
      <section
        aria-label={`System time for ${timeZoneLabel}: ${display.digitalTime}, ${display.abbreviation}, ${display.accessibleDate}`}
        className="user-system-time"
      >
        <strong className="user-system-time__time">{display.digitalTime}</strong>
        <span className="user-system-time__zone">{timeZoneLabel} · {display.abbreviation}</span>
        <em>System time</em>
      </section>
      {accountControls}
    </header>
  )
}
