import { describe, expect, it } from 'vitest'
import { possibleZonedLocalDateTimeInstants, resolveZonedFormDateTime, zonedLocalDateTimeToUtc } from './timeOperations'

describe('manual operational datetime conversion', () => {
  it.each([
    { zone: 'America/New_York', first: '2026-11-01T05:30:00.000Z', second: '2026-11-01T06:30:00.000Z' },
    { zone: 'America/Chicago', first: '2026-11-01T06:30:00.000Z', second: '2026-11-01T07:30:00.000Z' },
    { zone: 'America/Denver', first: '2026-11-01T07:30:00.000Z', second: '2026-11-01T08:30:00.000Z' },
    { zone: 'America/Los_Angeles', first: '2026-11-01T08:30:00.000Z', second: '2026-11-01T09:30:00.000Z' },
  ])('requires an explicit repeated-hour choice in $zone', ({ zone, first, second }) => {
    const value = '2026-11-01T01:30'
    expect(possibleZonedLocalDateTimeInstants(value, zone)).toEqual([first, second])
    expect(() => zonedLocalDateTimeToUtc(value, zone)).toThrow('Choose the first or second occurrence')
    expect(zonedLocalDateTimeToUtc(value, zone, { occurrenceInstant: first })).toBe(first)
    expect(zonedLocalDateTimeToUtc(value, zone, { occurrenceInstant: second })).toBe(second)
  })

  it('does not introduce a repeated hour in non-DST Arizona', () => {
    expect(possibleZonedLocalDateTimeInstants('2026-11-01T01:30', 'America/Phoenix'))
      .toEqual(['2026-11-01T08:30:00.000Z'])
    expect(zonedLocalDateTimeToUtc('2026-11-01T01:30', 'America/Phoenix')).toBe('2026-11-01T08:30:00.000Z')
  })

  it.each(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'])(
    'rejects nonexistent spring time in %s before any mutation', (zone) => {
      expect(() => zonedLocalDateTimeToUtc('2026-03-08T02:30', zone)).toThrow('does not exist')
    },
  )

  it.each(['2026-11-01T07:30:47.125Z', '2026-11-01T08:30:47.125Z'])(
    'preserves the exact stored timestamp %s when the minute field is unchanged', (originalInstant) => {
      const occurrenceInstant = originalInstant.replace(':47.125Z', ':00.000Z')
      expect(zonedLocalDateTimeToUtc('2026-11-01T01:30', 'America/Denver', { originalInstant })).toBe(originalInstant)
      expect(zonedLocalDateTimeToUtc('2026-11-01T01:30', 'America/Denver', { originalInstant, occurrenceInstant })).toBe(originalInstant)
    },
  )

  it('permits an intentional first-hour correction but never guesses one from unchanged text', () => {
    const originalInstant = '2026-11-01T08:30:47.125Z'
    expect(zonedLocalDateTimeToUtc('2026-11-01T01:30', 'America/Denver', {
      originalInstant, occurrenceInstant: '2026-11-01T07:30:00.000Z',
    })).toBe('2026-11-01T07:30:00.000Z')
    expect(originalInstant).toBe('2026-11-01T08:30:47.125Z')
  })

  it('does not reuse a stored occurrence after its local date, minute, or zone changed', () => {
    expect(() => zonedLocalDateTimeToUtc('2026-11-01T01:31', 'America/Denver', {
      occurrenceInstant: '2026-11-01T08:30:00.000Z',
    })).toThrow('no longer matches')
    expect(() => zonedLocalDateTimeToUtc('2026-11-01T01:30', 'America/New_York', {
      originalInstant: '2026-11-01T08:30:47.125Z', originalTimeZone: 'America/Denver',
    })).toThrow('Choose the first or second occurrence')
  })

  it('reads explicit occurrence evidence from the submitted form without changing an original instant', () => {
    const data = new FormData()
    data.set('clockInAt', '2026-11-01T01:30')
    data.set('clockInAtOccurrence', '2026-11-01T08:30:00.000Z')
    expect(resolveZonedFormDateTime(data, 'clockInAt', 'America/Denver')).toBe('2026-11-01T08:30:00.000Z')
    expect(resolveZonedFormDateTime(data, 'clockInAt', 'America/Denver', '2026-11-01T08:30:47.125Z', 'America/Denver'))
      .toBe('2026-11-01T08:30:47.125Z')
  })
})
