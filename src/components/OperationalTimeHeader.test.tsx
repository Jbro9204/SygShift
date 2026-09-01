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

  it('renders one accessible row with all four server-synchronized U.S. clocks', () => {
    render(<OperationalTimeHeader accountControls={<button type="button">My Account</button>} serverTimestamp="2026-07-03T18:45:00.000Z" />)

    const region = screen.getByRole('region', { name: 'United States operational time zones' })
    expect(region).not.toHaveAttribute('aria-live')
    expect(screen.getByLabelText(/Eastern time: 2:45 PM \(14:45\), EDT/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Central time: 1:45 PM \(13:45\), CDT/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Mountain time: 12:45 PM, MDT/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Pacific time: 11:45 AM, PDT/)).toBeInTheDocument()
    expect(screen.getByText('Mountain Time is the operational default')).toBeInTheDocument()
    expect(screen.getByText('Operational default')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'My Account' })).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('updates all analog clocks from one timer and clears it when unmounted', () => {
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const view = render(<OperationalTimeHeader accountControls={null} serverTimestamp="2026-07-03T18:45:00.000Z" />)
    const firstSecondHand = view.container.querySelector<SVGLineElement>('.operational-clock__hand--second')
    const initialTransform = firstSecondHand?.style.transform

    act(() => vi.advanceTimersByTime(1_000))

    expect(firstSecondHand?.style.transform).not.toBe(initialTransform)
    view.unmount()
    expect(clearInterval).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
