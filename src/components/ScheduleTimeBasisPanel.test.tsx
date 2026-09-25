import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScheduleTimeBasisPanel } from './ScheduleTimeBasisPanel'

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
})
