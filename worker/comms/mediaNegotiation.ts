/**
 * Server-owned media-negotiation state. This is deliberately provider-neutral:
 * it never calls a provider, parses SDP, stores an answer, or names a browser
 * device. The future coordinator can use it to make expiry, duplicate-answer,
 * and force-close behavior deterministic before it invokes a reviewed adapter.
 */
export type NegotiatedMediaKind = 'audio' | 'video' | 'screen'
export type MediaNegotiationState = 'awaiting_answer' | 'ready' | 'closed' | 'expired'

export type ServerMediaNegotiation = Readonly<{
  acceptedAnswerAtMs: number | null
  activeKinds: ReadonlySet<NegotiatedMediaKind>
  callId: string
  expiresAtMs: number
  id: string
  requestedKinds: ReadonlySet<NegotiatedMediaKind>
  state: MediaNegotiationState
}>

const maximumAnswerBytes = 65_536

const immutableSet = <T>(values: Iterable<T>): ReadonlySet<T> => new Set(values)

const mayAcceptAnswer = (negotiation: ServerMediaNegotiation, nowMs: number): boolean =>
  negotiation.state === 'awaiting_answer' && nowMs < negotiation.expiresAtMs

export const createServerMediaNegotiation = (input: Readonly<{
  callId: string
  expiresAtMs: number
  id: string
  requestedKinds: readonly NegotiatedMediaKind[]
}>): ServerMediaNegotiation => {
  if (!input.id.trim() || !input.callId.trim() || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= 0) {
    throw new Error('The server media negotiation input is invalid.')
  }
  if (input.requestedKinds.length === 0 || input.requestedKinds.length > 3) {
    throw new Error('A media negotiation must request one or more bounded media kinds.')
  }
  const requestedKinds = immutableSet(input.requestedKinds)
  if (requestedKinds.size !== input.requestedKinds.length) throw new Error('Duplicate media kinds are not allowed.')
  return {
    acceptedAnswerAtMs: null,
    activeKinds: immutableSet([]),
    callId: input.callId,
    expiresAtMs: input.expiresAtMs,
    id: input.id,
    requestedKinds,
    state: 'awaiting_answer',
  }
}

/** The answer is checked for a bounded request only. It is never retained. */
export const acceptServerMediaAnswer = (
  negotiation: ServerMediaNegotiation,
  answer: string,
  nowMs: number,
): ServerMediaNegotiation => {
  if (new TextEncoder().encode(answer).byteLength < 1 || new TextEncoder().encode(answer).byteLength > maximumAnswerBytes) {
    throw new Error('The media answer is outside the allowed size.')
  }
  if (negotiation.state === 'closed' || negotiation.state === 'expired') return negotiation
  if (!mayAcceptAnswer(negotiation, nowMs)) return { ...negotiation, state: 'expired' }
  return { ...negotiation, acceptedAnswerAtMs: nowMs }
}

/** A provider-confirmed readiness notice may activate only a requested kind. */
export const markServerMediaReady = (
  negotiation: ServerMediaNegotiation,
  kind: NegotiatedMediaKind,
  nowMs: number,
): ServerMediaNegotiation => {
  if (negotiation.state === 'closed' || negotiation.state === 'expired') return negotiation
  if (nowMs >= negotiation.expiresAtMs) return { ...negotiation, state: 'expired' }
  if (negotiation.acceptedAnswerAtMs === null || !negotiation.requestedKinds.has(kind)) return negotiation
  const activeKinds = immutableSet([...negotiation.activeKinds, kind])
  return { ...negotiation, activeKinds, state: 'ready' }
}

export const expireServerMediaNegotiation = (negotiation: ServerMediaNegotiation, nowMs: number): ServerMediaNegotiation =>
  negotiation.state === 'awaiting_answer' && nowMs >= negotiation.expiresAtMs
    ? { ...negotiation, state: 'expired' }
    : negotiation

/** Revocation, disconnect, moderation, and explicit end all use this path. */
export const forceCloseServerMediaNegotiation = (negotiation: ServerMediaNegotiation): ServerMediaNegotiation =>
  negotiation.state === 'closed'
    ? negotiation
    : { ...negotiation, activeKinds: immutableSet([]), state: 'closed' }
