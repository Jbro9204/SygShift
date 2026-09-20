/**
 * Server-owned direct-call state. It accepts only identifiers resolved by the
 * coordinator and emits the contract's deliberately minimal, employee-safe
 * event payloads. Media negotiation is a separate, generation-fenced step.
 */
export type ServerCallState = 'accepted' | 'cancelled' | 'declined' | 'ended' | 'expired' | 'ringing'

export type ServerCallLifecycle = Readonly<{
  callId: string
  expiresAtMs: number
  invitationId: string
  recipientConnectionId: string
  requesterConnectionId: string
  state: ServerCallState
}>

export type ServerCallEvent =
  | Readonly<{ kind: 'call.requested'; payload: Readonly<{ callId: string, expiresAt: string, invitationId: string }> }>
  | Readonly<{ kind: 'call.ringing'; payload: Readonly<{ callId: string, expiresAt: string, invitationId: string }> }>
  | Readonly<{ kind: 'call.accepted'; payload: Readonly<{ callId: string, invitationId: string }> }>
  | Readonly<{ kind: 'call.ended'; payload: Readonly<{ callId: string, reason: 'cancelled' | 'ended' | 'expired' | 'network_lost' | 'unavailable' }> }>
  | Readonly<{ kind: 'call.missed'; payload: Readonly<{ callId: string, reason: 'cancelled' | 'declined' | 'expired' }> }>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const validUuid = (value: string): boolean => uuidPattern.test(value)
const validTimestamp = (value: number): boolean => Number.isSafeInteger(value) && value > 0

const terminal = (state: ServerCallState): boolean =>
  state === 'cancelled' || state === 'declined' || state === 'ended' || state === 'expired'

const callEndedEvent = (
  call: ServerCallLifecycle,
  reason: 'cancelled' | 'ended' | 'expired' | 'network_lost' | 'unavailable',
): ServerCallEvent => ({ kind: 'call.ended', payload: { callId: call.callId, reason } })

/** The server creates a paired requested/ringing event from trusted routing. */
export const createServerCall = (input: Readonly<{
  callId: string
  expiresAtMs: number
  invitationId: string
  recipientConnectionId: string
  requesterConnectionId: string
}>): Readonly<{ events: readonly ServerCallEvent[], state: ServerCallLifecycle }> => {
  if (!validUuid(input.callId) || !validUuid(input.invitationId) || !validUuid(input.recipientConnectionId) || !validUuid(input.requesterConnectionId) || input.recipientConnectionId === input.requesterConnectionId || !validTimestamp(input.expiresAtMs)) {
    throw new Error('The server call request is invalid.')
  }
  const state: ServerCallLifecycle = { ...input, state: 'ringing' }
  const payload = {
    callId: state.callId,
    expiresAt: new Date(state.expiresAtMs).toISOString(),
    invitationId: state.invitationId,
  }
  return {
    events: [
      { kind: 'call.requested', payload },
      { kind: 'call.ringing', payload },
    ],
    state,
  }
}

const expireIfNecessary = (call: ServerCallLifecycle, nowMs: number): ServerCallLifecycle =>
  call.state === 'ringing' && nowMs >= call.expiresAtMs ? { ...call, state: 'expired' } : call

/** Only the exact recipient and invitation may accept a non-expired call. */
export const acceptServerCall = (
  call: ServerCallLifecycle,
  input: Readonly<{ invitationId: string, nowMs: number, recipientConnectionId: string }>,
): Readonly<{ event: ServerCallEvent | null, state: ServerCallLifecycle }> => {
  const current = expireIfNecessary(call, input.nowMs)
  if (current.state !== 'ringing' || current.invitationId !== input.invitationId || current.recipientConnectionId !== input.recipientConnectionId) {
    return {
      event: current.state === 'expired' ? { kind: 'call.missed', payload: { callId: current.callId, reason: 'expired' } } : null,
      state: current,
    }
  }
  const state: ServerCallLifecycle = { ...current, state: 'accepted' }
  return { event: { kind: 'call.accepted', payload: { callId: state.callId, invitationId: state.invitationId } }, state }
}

export const declineServerCall = (
  call: ServerCallLifecycle,
  input: Readonly<{ invitationId: string, nowMs: number, recipientConnectionId: string }>,
): Readonly<{ event: ServerCallEvent | null, state: ServerCallLifecycle }> => {
  const current = expireIfNecessary(call, input.nowMs)
  if (current.state === 'expired') return { event: { kind: 'call.missed', payload: { callId: current.callId, reason: 'expired' } }, state: current }
  if (current.state !== 'ringing' || current.invitationId !== input.invitationId || current.recipientConnectionId !== input.recipientConnectionId) return { event: null, state: current }
  const state: ServerCallLifecycle = { ...current, state: 'declined' }
  return { event: { kind: 'call.missed', payload: { callId: state.callId, reason: 'declined' } }, state }
}

/** The requester may cancel only while the call is still ringing. */
export const cancelServerCall = (
  call: ServerCallLifecycle,
  requesterConnectionId: string,
  nowMs: number,
): Readonly<{ event: ServerCallEvent | null, state: ServerCallLifecycle }> => {
  const current = expireIfNecessary(call, nowMs)
  if (current.state === 'expired') return { event: { kind: 'call.missed', payload: { callId: current.callId, reason: 'expired' } }, state: current }
  if (current.state !== 'ringing' || current.requesterConnectionId !== requesterConnectionId) return { event: null, state: current }
  const state: ServerCallLifecycle = { ...current, state: 'cancelled' }
  return { event: { kind: 'call.missed', payload: { callId: state.callId, reason: 'cancelled' } }, state }
}

/** Either participant may end only an accepted call; terminal calls cannot revive. */
export const endServerCall = (
  call: ServerCallLifecycle,
  connectionId: string,
  reason: 'ended' | 'network_lost' | 'unavailable' = 'ended',
): Readonly<{ event: ServerCallEvent | null, state: ServerCallLifecycle }> => {
  if (terminal(call.state) || call.state !== 'accepted' || (connectionId !== call.requesterConnectionId && connectionId !== call.recipientConnectionId)) {
    return { event: null, state: call }
  }
  const state: ServerCallLifecycle = { ...call, state: 'ended' }
  return { event: callEndedEvent(state, reason), state }
}
