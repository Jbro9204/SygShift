import { type ReactNode, useEffect, useRef, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { formatOperationalDate, formatTimeZoneClock } from '../lib/time'

const OPERATIONAL_TIME_ZONES = [
  { name: 'Pacific', operationalDefault: false, timeZone: 'America/Los_Angeles' },
  { name: 'Mountain', timeZone: 'America/Denver', operationalDefault: true },
  { name: 'Central', operationalDefault: false, timeZone: 'America/Chicago' },
  { name: 'Eastern', operationalDefault: false, timeZone: 'America/New_York' },
] as const

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

function AnalogClock({ hour24, minute, second }: { hour24: number; minute: number; second: number }) {
  const hourAngle = ((hour24 % 12) + minute / 60 + second / 3600) * 30
  const minuteAngle = (minute + second / 60) * 6
  const secondAngle = second * 6

  return (
    <svg aria-hidden="true" className="operational-clock__face" focusable="false" viewBox="0 0 64 64">
      <circle className="operational-clock__dial" cx="32" cy="32" r="29" />
      {Array.from({ length: 12 }, (_, index) => (
        <line className="operational-clock__marker" key={index} x1="32" x2="32" y1="6" y2={index % 3 === 0 ? '11' : '9'} style={{ transform: `rotate(${index * 30}deg)` }} />
      ))}
      <line className="operational-clock__hand operational-clock__hand--hour" x1="32" x2="32" y1="32" y2="18" style={{ transform: `rotate(${hourAngle}deg)` }} />
      <line className="operational-clock__hand operational-clock__hand--minute" x1="32" x2="32" y1="34" y2="12" style={{ transform: `rotate(${minuteAngle}deg)` }} />
      <line className="operational-clock__hand operational-clock__hand--second" x1="32" x2="32" y1="36" y2="10" style={{ transform: `rotate(${secondAngle}deg)` }} />
      <circle className="operational-clock__pin" cx="32" cy="32" r="2.5" />
    </svg>
  )
}

export function OperationalTimeHeader({
  accountControls,
  serverTimestamp,
}: {
  accountControls: ReactNode
  serverTimestamp?: string | null
}) {
  const anchorRef = useRef(clockAnchor(serverTimestamp))
  const [now, setNow] = useState(() => timeFromAnchor(anchorRef.current))

  useEffect(() => {
    anchorRef.current = clockAnchor(serverTimestamp)
    setNow(timeFromAnchor(anchorRef.current))
  }, [serverTimestamp])

  useEffect(() => {
    const updateClock = () => setNow(timeFromAnchor(anchorRef.current))
    const interval = window.setInterval(updateClock, 1_000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') updateClock()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  return (
    <header className="topbar">
      <div className="topbar-date">
        <CalendarDays aria-hidden="true" size={19} strokeWidth={1.9} />
        <span>{formatOperationalDate(now)}</span>
      </div>
      <section aria-label="United States operational time zones" className="operational-time-zone-strip">
        <div className="operational-time-zone-grid">
          {OPERATIONAL_TIME_ZONES.map((zone) => {
            const display = formatTimeZoneClock(now, zone.timeZone)
            const accessibleLabel = `${zone.name} time: ${display.digitalTime}, ${display.abbreviation}, ${display.accessibleDate}${zone.operationalDefault ? ', SygShift system time' : ''}`
            return (
              <article aria-label={accessibleLabel} className={zone.operationalDefault ? 'operational-clock operational-clock--default' : 'operational-clock'} key={zone.timeZone}>
                <AnalogClock hour24={display.hour24} minute={display.minute} second={display.second} />
                <span className="operational-clock__details">
                  <strong className="operational-clock__digital">{display.digitalTime}</strong>
                  <span className="operational-clock__zone">{zone.name} · {display.abbreviation}</span>
                  {zone.operationalDefault ? <em>System time</em> : null}
                </span>
              </article>
            )
          })}
        </div>
      </section>
      {accountControls}
    </header>
  )
}
