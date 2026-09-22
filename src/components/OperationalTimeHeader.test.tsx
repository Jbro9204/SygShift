import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationalTimeHeader } from './OperationalTimeHeader'

describe('OperationalTimeHeader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-03T18:45:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders only the signed-in user system time without analog or alternate-zone clocks', () => {
    const view = render(
      <OperationalTimeHeader
        accountControls={<button type="button">My Account</button>}
        serverTimestamp="2026-07-03T18:45:00.000Z"
        timeZone="America/Chicago"
      />,
    )

    const region = screen.getByRole('region', { name: /System time for Central: 1:45 PM \(13:45\), CDT/ })
    expect(region).not.toHaveAttribute('aria-live')
    expect(screen.getByText('Central · CDT')).toBeInTheDocument()
    expect(screen.getByText('System time')).toBeInTheDocument()
    expect(view.container.querySelectorAll('.user-system-time')).toHaveLength(1)
    expect(view.container.querySelector('.operational-clock__face')).not.toBeInTheDocument()
    expect(screen.queryByText(/Pacific ·/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Mountain ·/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Eastern ·/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'My Account' })).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('updates the one server-synchronized digital time and clears its timer when unmounted', () => {
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const view = render(
      <OperationalTimeHeader
        accountControls={null}
        serverTimestamp="2026-07-03T18:45:00.000Z"
        timeZone="America/Denver"
      />,
    )
    expect(screen.getByText('12:45 PM')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(60_000))

    expect(screen.getByText('12:46 PM')).toBeInTheDocument()
    view.unmount()
    expect(clearInterval).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
