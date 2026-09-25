import { describe, expect, it } from 'vitest'
import {
  opportunityAvailability,
  opportunityLocation,
  opportunityRequest,
  opportunityRequestError,
  opportunityTitle,
  type Opportunity,
} from './opportunities'

const opportunity: Opportunity = {
  id: '10000000-0000-0000-0000-000000000001',
  starts_at: '2099-07-07T14:00:00.000Z',
  ends_at: '2099-07-07T22:00:00.000Z',
  time_zone: 'America/Denver',
  headcount_required: 2,
  requires_armed: false,
  is_overtime: false,
  notes: null,
  post: null,
  event: {
    id: '20000000-0000-0000-0000-000000000001',
    name: 'Community event',
    location_name: 'Civic Center',
    site: null,
  },
  schedules: { status: 'published' },
  assignments: [],
  requests: [{
    id: '30000000-0000-0000-0000-000000000001',
    employee_id: '40000000-0000-0000-0000-000000000001',
    status: 'pending',
  }],
}

describe('open opportunity presentation', () => {
  it('uses an event name and standalone location when no permanent site exists', () => {
    expect(opportunityTitle(opportunity)).toBe('Community event')
    expect(opportunityLocation(opportunity)).toBe('Civic Center')
  })

  it('preserves the guard request state returned by row-level security', () => {
    expect(opportunityRequest(opportunity)?.status).toBe('pending')
  })

  it('does not treat a withdrawn request as a new unrequested opportunity', () => {
    const withdrawn = {
      ...opportunity,
      requests: [{ ...opportunity.requests[0], status: 'withdrawn' as const }],
    }
    expect(opportunityRequest(withdrawn)?.status).toBe('withdrawn')
  })

  it('does not offer a full or already-started shift as requestable', () => {
    const now = Date.parse('2099-07-07T13:00:00.000Z')
    expect(opportunityAvailability(opportunity, now)).toBe('open')
    expect(opportunityAvailability({ ...opportunity, headcount_required: 1, assignments: [{ id: opportunity.id, status: 'assigned' }] }, now)).toBe('full')
    expect(opportunityAvailability(opportunity, Date.parse(opportunity.starts_at))).toBe('started')
  })

  it('explains known request failures without exposing raw database errors', () => {
    expect(opportunityRequestError('All openings for this shift have been filled.')).toMatch(/filled/i)
    expect(opportunityRequestError('new row violates row-level security policy')).toMatch(/Contact Scheduling/i)
    expect(opportunityRequestError('duplicate key value violates unique constraint "shift_requests_unique"')).toMatch(/already requested/i)
  })
})
