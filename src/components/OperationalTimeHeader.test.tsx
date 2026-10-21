import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserSystemTimeZone } from '../lib/systemTimeZone'
import { OperationalTimeHeader } from './OperationalTimeHeader'

vi.mock('../lib/systemTimeZone', () => ({ browserSystemTimeZone: vi.fn() }))

function mockSystemTimeZone(timeZone: string) {
  vi.mocked(browserSystemTimeZone).mockReturnValue(timeZone)
}

describe('OperationalTimeHeader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-03T18:45:00.000Z'))
    mockSystemTimeZone('America/New_York')
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders only the signed-in user system time without analog or alternate-zone clocks', () => {
    mockSystemTimeZone('America/New_York')
    const view = render(
      <OperationalTimeHeader
        accountControls={<button type="button">My Account</button>}
        fallbackTimeZone="America/Denver"
        serverTimestamp="2026-07-03T18:45:00.000Z"
      />,
    )

    const region = screen.getByRole('region', { name: /System time for Eastern: 2:45 PM \(14:45\), EDT/ })
    expect(region).not.toHaveAttribute('aria-live')
    expect(screen.getByText('Eastern · EDT')).toBeInTheDocument()
    expect(screen.getByText('Friday, 07/03/2026')).toBeInTheDocument()
    expect(screen.getByText('System time')).toBeInTheDocument()
    expect(view.container.querySelectorAll('.user-system-time')).toHaveLength(1)
    expect(view.container.querySelector('.operational-clock__face')).not.toBeInTheDocument()
    expect(screen.queryByText(/Pacific ·/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Mountain ·/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'My Account' })).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('updates the one server-synchronized digital time and clears its timer when unmounted', () => {
    mockSystemTimeZone('America/Denver')
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const view = render(
      <OperationalTimeHeader
        accountControls={null}
        serverTimestamp="2026-07-03T18:45:00.000Z"
      />,
    )
    expect(screen.getByText('12:45 PM')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(60_000))

    expect(screen.getByText('12:46 PM')).toBeInTheDocument()
    view.unmount()
    expect(clearInterval).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the system zone daylight-saving abbreviation for the synchronized instant', () => {
    mockSystemTimeZone('America/New_York')
    render(
      <OperationalTimeHeader
        accountControls={null}
        fallbackTimeZone="America/Denver"
        serverTimestamp="2026-01-15T18:45:00.000Z"
      />,
    )

    expect(screen.getByText('1:45 PM (13:45)')).toBeInTheDocument()
    expect(screen.getByText('Eastern · EST')).toBeInTheDocument()
  })

  it('refreshes the device zone when the browser tab becomes visible again', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    render(<OperationalTimeHeader accountControls={null} serverTimestamp="2026-07-03T18:45:00.000Z" />)

    expect(screen.getByText('Eastern · EDT')).toBeInTheDocument()
    mockSystemTimeZone('America/Denver')
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(screen.getByText('Mountain · MDT')).toBeInTheDocument()
    expect(screen.getByText('12:45 PM')).toBeInTheDocument()
  })
})
