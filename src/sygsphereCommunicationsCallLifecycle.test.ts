import { describe, expect, it } from 'vitest'
import {
  acceptServerCall,
  cancelServerCall,
  createServerCall,
  declineServerCall,
  endServerCall,
} from '../worker/comms/callLifecycle'

const callId = '11111111-1111-4111-8111-111111111111'
const invitationId = '22222222-2222-4222-8222-222222222222'
const requester = '33333333-3333-4333-8333-333333333333'
const recipient = '44444444-4444-4444-8444-444444444444'

describe('SygSphere Communications direct-call lifecycle', () => {
  it('creates paired requested/ringing events without exposing participant identity', () => {
    const created = createServerCall({ callId, expiresAtMs: 20_000, invitationId, recipientConnectionId: recipient, requesterConnectionId: requester })
    expect(created.state).toMatchObject({ state: 'ringing' })
    expect(created.events).toEqual([
      { kind: 'call.requested', payload: { callId, expiresAt: '1970-01-01T00:00:20.000Z', invitationId } },
      { kind: 'call.ringing', payload: { callId, expiresAt: '1970-01-01T00:00:20.000Z', invitationId } },
    ])
    expect(JSON.stringify(created.events)).not.toContain(requester)
    expect(JSON.stringify(created.events)).not.toContain(recipient)
  })

  it('accepts only the invited recipient before expiry and requires an explicit end', () => {
    const created = createServerCall({ callId, expiresAtMs: 20_000, invitationId, recipientConnectionId: recipient, requesterConnectionId: requester })
    expect(acceptServerCall(created.state, { invitationId, nowMs: 10_000, recipientConnectionId: requester }).event).toBeNull()
    const accepted = acceptServerCall(created.state, { invitationId, nowMs: 10_000, recipientConnectionId: recipient })
    expect(accepted).toMatchObject({ event: { kind: 'call.accepted', payload: { callId, invitationId } }, state: { state: 'accepted' } })
    const ended = endServerCall(accepted.state, recipient)
    expect(ended).toMatchObject({ event: { kind: 'call.ended', payload: { callId, reason: 'ended' } }, state: { state: 'ended' } })
    expect(endServerCall(ended.state, requester).event).toBeNull()
  })

  it('records a missed outcome when a recipient declines, cancels, or reaches the invitation deadline', () => {
    const created = createServerCall({ callId, expiresAtMs: 20_000, invitationId, recipientConnectionId: recipient, requesterConnectionId: requester })
    expect(declineServerCall(created.state, { invitationId, nowMs: 10_000, recipientConnectionId: recipient }).event)
      .toEqual({ kind: 'call.missed', payload: { callId, reason: 'declined' } })
    expect(cancelServerCall(created.state, requester, 10_000).event)
      .toEqual({ kind: 'call.missed', payload: { callId, reason: 'cancelled' } })
    expect(acceptServerCall(created.state, { invitationId, nowMs: 20_000, recipientConnectionId: recipient }).event)
      .toEqual({ kind: 'call.missed', payload: { callId, reason: 'expired' } })
  })
})
