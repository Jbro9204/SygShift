import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ScheduleTimeBasisPanel } from './ScheduleTimeBasisPanel'
import { inspectScheduleWallClockRange } from '../schedule/timeBasis'

describe('ScheduleTimeBasisPanel', () => {
  it('shows the entered basis and the employee/site conversion together', () => {
    render(
      <ScheduleTimeBasisPanel
        basisLabel="Employee Time — Eastern"
        description="Enter the shift in the employee time zone."
        endsAt="2026-09-25T21:00:00.000Z"
        previewRows={[
          { label: 'Misty Kimbal · Employee Time', timeZone: 'America/New_York' },
          { label: 'Administrative · Site Time', timeZone: 'America/Denver' },
        ]}
        startsAt="2026-09-25T13:00:00.000Z"
      />,
    )

    const panel = screen.getByRole('region', { name: 'Schedule time basis' })
    expect(within(panel).getByText('Employee Time — Eastern')).toBeInTheDocument()
    expect(within(panel).getByText('Misty Kimbal · Employee Time')).toBeInTheDocument()
    expect(within(panel).getByText('Administrative · Site Time')).toBeInTheDocument()
    expect(within(panel).getByText('09/25/2026 · 9:00 AM (09:00)–5:00 PM (17:00)')).toBeInTheDocument()
    expect(within(panel).getByText('09/25/2026 · 7:00 AM (07:00)–3:00 PM (15:00)')).toBeInTheDocument()
  })

  it('deduplicates matching employee and site zones', () => {
    render(
      <ScheduleTimeBasisPanel
        basisLabel="Site Time — Eastern"
        description="Open coverage uses the site time zone."
        endsAt="2026-09-25T21:00:00.000Z"
        previewRows={[
          { label: 'Site Time — Eastern', timeZone: 'America/New_York' },
          { label: 'Employee Time', timeZone: 'America/New_York' },
        ]}
        startsAt="2026-09-25T13:00:00.000Z"
      />,
    )

    expect(screen.getAllByText('09/25/2026 · 9:00 AM (09:00)–5:00 PM (17:00)')).toHaveLength(1)
  })

  it('shows exact offsets and elapsed duration rather than labeling a fall-back shift eight hours', () => {
    render(<ScheduleTimeBasisPanel basisLabel="Site Time — Mountain" description="Site time" startsAt="2026-11-01T04:00:00.000Z" endsAt="2026-11-01T13:00:00.000Z" previewRows={[{ label: 'Mountain site', timeZone: 'America/Denver' }]} />)
    expect(screen.getByText('Start: MDT (UTC-06:00) · End: MST (UTC-07:00) · 9h elapsed before breaks')).toBeInTheDocument()
  })

  it('truthfully offers only second-occurrence confirmation and reports changes to its owner', () => {
    const range = inspectScheduleWallClockRange('2026-11-01', '01:30', '03:00', 'America/New_York')
    const onChange = vi.fn()
    render(<ScheduleTimeBasisPanel basisLabel="Site Time — Eastern" description="Site time" startsAt={range.startsAt} endsAt={range.endsAt} previewRows={[{ label: 'Eastern site', timeZone: 'America/New_York' }]} repeatedTimes={range.repeatedTimes} repeatedTimeConfirmation={{ checked: false, onChange }} />)
    expect(screen.getByText(/first occurrence is not selectable/)).toBeInTheDocument()
    expect(screen.getByText(/Start · 11\/01\/2026 · 1:30 AM \(01:30\) · EST \(UTC-05:00\)/)).toBeInTheDocument()
    const checkbox = screen.getByRole('checkbox', { name: 'Use the second (standard-time) occurrence shown above.' })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
