import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EarlyClockInBlockedDetails } from '../data/timekeeping'
import { EarlyClockInWarningDialog } from './EarlyClockInWarningDialog'

const details: EarlyClockInBlockedDetails = {
  status: 'blocked',
  code: 'EARLY_CLOCK_IN_BLOCKED',
  trustedServerTime: '2026-09-02T23:42:00.000Z',
  scheduledShiftStart: '2026-09-03T00:00:00.000Z',
  scheduledShiftEnd: '2026-09-03T06:00:00.000Z',
  clockInEligibleAt: '2026-09-02T23:55:00.000Z',
  shiftDate: '2026-09-02',
  shiftDisplayName: 'MG Properties Patrol–Unarmed',
  siteCode: 'MPP',
  siteName: 'MG Properties',
  postName: 'Patrol–Unarmed',
  locationName: 'MG Properties',
  coverageType: 'Unarmed coverage',
  timeZone: 'America/Denver',
  clockInWindowMinutes: 5,
}

describe('EarlyClockInWarningDialog', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
  })

  it('renders trusted timing and scheduled-shift details in the required alert dialog', () => {
    render(<EarlyClockInWarningDialog details={details} onAcknowledge={vi.fn()} />)

    expect(screen.getByRole('alertdialog', { name: 'Your shift hasn’t started yet' })).toBeInTheDocument()
    expect(screen.getByText('Your scheduled shift starts in 18 minutes.')).toBeInTheDocument()
    expect(screen.getAllByText('5:55 PM (17:55)').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('In 13 minutes')).toBeInTheDocument()
    expect(screen.getByText('MG Properties Patrol–Unarmed')).toBeInTheDocument()
    expect(screen.getByText('MPP · MG Properties · Unarmed coverage')).toBeInTheDocument()
    expect(screen.getByText('Timing is based on trusted SygShift server time.')).toBeInTheDocument()
    expect(screen.getByText('Acknowledging this notice will not clock you in.')).toBeInTheDocument()
  })

  it('has no alternate dismissal and ignores the native Escape cancel event', () => {
    const acknowledge = vi.fn()
    render(<EarlyClockInWarningDialog details={details} onAcknowledge={acknowledge} />)
    const dialogElement = screen.getByRole('alertdialog')

    expect(screen.queryByRole('button', { name: /close dialog/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()
    const cancelEvent = new Event('cancel', { bubbles: false, cancelable: true })
    fireEvent(dialogElement, cancelEvent)
    fireEvent.click(dialogElement)

    expect(cancelEvent.defaultPrevented).toBe(true)
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('only acknowledges when the single required action is activated', () => {
    const acknowledge = vi.fn()
    render(<EarlyClockInWarningDialog details={details} onAcknowledge={acknowledge} />)
    const button = screen.getByRole('button', { name: 'Acknowledge & close' })

    fireEvent.click(button)
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })
})
