import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MaintenanceWindow } from '../data/maintenance'
import { MaintenanceNotice } from './MaintenanceNotice'

function maintenanceWindow(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    accessMode: 'notice',
    completionMessage: 'Automatic-expiration verification completed. Internal rehearsal passed.',
    endsAt: '2026-08-26T15:00:00.000Z',
    featureCodes: ['schedule'],
    id: '04b2df91-f8a1-46ae-a584-4133c4b081f8',
    message: 'SygShift maintenance is scheduled.',
    releaseKind: 'planned',
    releaseVersion: '2026.08.26.1',
    startsAt: '2026-08-26T14:00:00.000Z',
    status: 'completed',
    title: 'Scheduled maintenance',
    ...overrides,
  }
}

describe('MaintenanceNotice', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces internal completion wording with a calm employee message', () => {
    render(<MaintenanceNotice active={null} completed={maintenanceWindow()} upcoming={null} />)

    expect(screen.getByText('Maintenance complete. SygShift is available normally.')).toBeInTheDocument()
    expect(screen.getByText('No action is required.')).toBeInTheDocument()
    expect(screen.queryByText(/Automatic-expiration verification/i)).not.toBeInTheDocument()
  })

  it('automatically dismisses a completion notice after 15 seconds', () => {
    vi.useFakeTimers()
    render(<MaintenanceNotice active={null} completed={maintenanceWindow()} upcoming={null} />)

    act(() => vi.advanceTimersByTime(15_000))

    expect(screen.queryByRole('status', { name: 'SygShift maintenance notice' })).not.toBeInTheDocument()
  })

  it('persists manual dismissal for the same maintenance event', () => {
    const item = maintenanceWindow()
    const first = render(<MaintenanceNotice active={null} completed={item} upcoming={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss maintenance notice' }))
    first.unmount()

    render(<MaintenanceNotice active={null} completed={item} upcoming={null} />)

    expect(screen.queryByText('Maintenance complete. SygShift is available normally.')).not.toBeInTheDocument()
  })

  it('keeps active maintenance persistent and does not offer dismissal', () => {
    vi.useFakeTimers()
    render(<MaintenanceNotice active={maintenanceWindow({ status: 'active' })} completed={null} upcoming={null} />)

    act(() => vi.advanceTimersByTime(30_000))

    expect(screen.getByText('Scheduled maintenance is in progress')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss maintenance notice' })).not.toBeInTheDocument()
  })
})
