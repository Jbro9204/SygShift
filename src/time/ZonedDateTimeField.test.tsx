import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { resolveZonedFormDateTime } from '../data/timeOperations'
import { ZonedDateTimeField, ZonedTimeOccurrenceChoice } from './ZonedDateTimeField'

describe('manual datetime occurrence choice', () => {
  it('requires an explicit choice for new repeated-hour input and clears it when the minute changes', () => {
    render(<ZonedDateTimeField label="Clock-in" name="clockInAt" required timeZone="America/Denver" />)
    fireEvent.change(screen.getByLabelText('Clock-in', { exact: true }), { target: { value: '2026-11-01T01:30' } })
    const choice = screen.getByRole('combobox', { name: 'Clock-in clock occurrence' })
    expect(choice).toBeRequired()
    expect(choice).toHaveValue('')
    fireEvent.change(choice, { target: { value: '2026-11-01T08:30:00.000Z' } })
    expect(choice).toHaveValue('2026-11-01T08:30:00.000Z')
    fireEvent.change(screen.getByLabelText('Clock-in', { exact: true }), { target: { value: '2026-11-01T01:31' } })
    expect(screen.getByRole('combobox')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('Clock-in', { exact: true }), { target: { value: '2026-11-01T01:30' } })
    expect(screen.getByRole('combobox')).toHaveValue('')
  })

  it('keeps the second stored occurrence and its original seconds on an unchanged edit', () => {
    const originalInstant = '2026-11-01T08:30:47.125Z'
    const saved = vi.fn()
    render(<form onSubmit={(event) => {
      event.preventDefault()
      saved(resolveZonedFormDateTime(new FormData(event.currentTarget), 'clockInAt', 'America/Denver', originalInstant, 'America/Denver'))
    }}><ZonedDateTimeField label="Clock-in" name="clockInAt" originalInstant={originalInstant} originalTimeZone="America/Denver" required timeZone="America/Denver" /><button type="submit">Save</button></form>)
    expect(screen.getByLabelText('Clock-in', { exact: true })).toHaveValue('2026-11-01T01:30')
    expect(screen.getByRole('combobox')).toHaveValue('2026-11-01T08:30:00.000Z')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saved).toHaveBeenCalledWith(originalInstant)
  })

  it('surfaces the spring gap and does not invent an occurrence choice', () => {
    render(<ZonedDateTimeField defaultValue="2026-03-08T02:30" label="Clock-in" name="clockInAt" timeZone="America/Denver" />)
    expect(screen.getByRole('alert')).toHaveTextContent('does not exist')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('does not offer a fold choice for Arizona or reuse a choice after the zone changes', () => {
    const { rerender } = render(<ZonedTimeOccurrenceChoice label="Clock-in" name="clockInAt" timeZone="America/Denver" value="2026-11-01T01:30" />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2026-11-01T08:30:00.000Z' } })
    rerender(<ZonedTimeOccurrenceChoice label="Clock-in" name="clockInAt" timeZone="America/New_York" value="2026-11-01T01:30" />)
    expect(screen.getByRole('combobox')).toHaveValue('')
    rerender(<ZonedTimeOccurrenceChoice label="Clock-in" name="clockInAt" timeZone="America/Denver" value="2026-11-01T01:30" />)
    expect(screen.getByRole('combobox')).toHaveValue('')
    rerender(<ZonedTimeOccurrenceChoice label="Clock-in" name="clockInAt" timeZone="America/Phoenix" value="2026-11-01T01:30" />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
