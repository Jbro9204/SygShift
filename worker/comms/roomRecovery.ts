import { SYGSPHERE_COMMS_EVENT_KINDS, type SygSphereCommsEventKind } from '../../shared/sygsphere-communications/v1/contract'

export type CanonicalRoomEvent = Readonly<{
  correlationId: string
  eventId: string
  kind: SygSphereCommsEventKind
  payload: Readonly<Record<string, unknown>>
  roomEpoch: number
  roomId: string
  roomSeq: number
  serverTime: string
  tenantId: string
}>

export type CanonicalOutboxDelivery = Readonly<{
  attempts: number
  eventId: string
  leaseId: string | null
  leaseExpiresAtMs: number | null
  recipientConnectionId: string
  state: 'pending' | 'in_flight' | 'delivered' | 'expired'
}>

export type CanonicalRoomState = Readonly<{
  events: readonly CanonicalRoomEvent[]
  lastRoomSeq: number
  outbox: readonly CanonicalOutboxDelivery[]
  roomEpoch: number
  roomId: string
  tenantId: string
}>

export type CanonicalRoomRecovery =
  | Readonly<{ mode: 'snapshot'; state: CanonicalRoomState }>
  | Readonly<{ events: readonly CanonicalRoomEvent[]; mode: 'replay' }>
  | Readonly<{ mode: 'unavailable' }>

const maximumRetainedEvents = 256
const maximumOutboxDeliveryAttempts = 16
const forbiddenPayloadKeys = new Set(['actorid', 'employeeid', 'tenantid', 'permissioncodes', 'providersecret', 'providertrack', 'sdp', 'token'])

const isSafeFiniteInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

const hasForbiddenPayloadKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasForbiddenPayloadKey)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => forbiddenPayloadKeys.has(key.toLowerCase()) || hasForbiddenPayloadKey(child))
}

const isKnownEventKind = (kind: string): kind is SygSphereCommsEventKind =>
  (SYGSPHERE_COMMS_EVENT_KINDS as readonly string[]).includes(kind)

const sameRoom = (state: CanonicalRoomState, event: CanonicalRoomEvent): boolean =>
  state.tenantId === event.tenantId && state.roomId === event.roomId && state.roomEpoch === event.roomEpoch

export const createCanonicalRoomState = (input: Readonly<{
  roomEpoch: number
  roomId: string
  tenantId: string
}>): CanonicalRoomState => {
  if (!input.tenantId.trim() || !input.roomId.trim() || !isSafeFiniteInteger(input.roomEpoch)) {
    throw new Error('The canonical room identity is invalid.')
  }
  return { events: [], lastRoomSeq: 0, outbox: [], roomEpoch: input.roomEpoch, roomId: input.roomId, tenantId: input.tenantId }
}

/**
 * This accepts an event prepared by trusted server code. It assigns sequence
 * itself and rejects identity, permission, and provider-shaped payload data.
 */
export const appendCanonicalRoomEvent = (
  state: CanonicalRoomState,
  input: Readonly<{
    correlationId: string
    eventId: string
    kind: SygSphereCommsEventKind
    payload: Readonly<Record<string, unknown>>
    serverTime: string
  }>,
): Readonly<{ event: CanonicalRoomEvent; state: CanonicalRoomState }> => {
  if (!input.eventId.trim() || !input.correlationId.trim() || !isKnownEventKind(input.kind) || Number.isNaN(Date.parse(input.serverTime))) {
    throw new Error('The canonical room event is invalid.')
  }
  if (hasForbiddenPayloadKey(input.payload)) throw new Error('The canonical room event contains forbidden payload data.')
  if (state.events.some((event) => event.eventId === input.eventId)) throw new Error('The canonical room event has already been recorded.')
  const event: CanonicalRoomEvent = {
    correlationId: input.correlationId,
    eventId: input.eventId,
    kind: input.kind,
    payload: input.payload,
    roomEpoch: state.roomEpoch,
    roomId: state.roomId,
    roomSeq: state.lastRoomSeq + 1,
    serverTime: input.serverTime,
    tenantId: state.tenantId,
  }
  const events = [...state.events, event].slice(-maximumRetainedEvents)
  return { event, state: { ...state, events, lastRoomSeq: event.roomSeq } }
}

/** The coordinator returns only an internally consistent server snapshot or replay. */
export const recoverCanonicalRoom = (state: CanonicalRoomState, lastSeenRoomSeq: number | undefined): CanonicalRoomRecovery => {
  if (lastSeenRoomSeq === undefined) return { mode: 'snapshot', state }
  if (!isSafeFiniteInteger(lastSeenRoomSeq) || lastSeenRoomSeq > state.lastRoomSeq) return { mode: 'unavailable' }
  if (lastSeenRoomSeq === state.lastRoomSeq) return { events: [], mode: 'replay' }
  const oldestRetained = state.events[0]?.roomSeq
  if (oldestRetained === undefined || lastSeenRoomSeq < oldestRetained - 1) return { mode: 'snapshot', state }
  const events = state.events.filter((event) => event.roomSeq > lastSeenRoomSeq)
  if (events.some((event, index) => event.roomSeq !== lastSeenRoomSeq + index + 1 || !sameRoom(state, event))) {
    return { mode: 'unavailable' }
  }
  return { events, mode: 'replay' }
}

/** A recipient connection is server-issued; duplicate delivery rows are never created. */
export const enqueueCanonicalOutbox = (
  state: CanonicalRoomState,
  eventId: string,
  recipientConnectionIds: readonly string[],
): CanonicalRoomState => {
  if (!state.events.some((event) => event.eventId === eventId)) throw new Error('The outbox event is not part of this room.')
  const recipients = [...new Set(recipientConnectionIds.map((value) => value.trim()))]
  if (!recipients.length || recipients.length > 100 || recipients.some((value) => !value)) throw new Error('The outbox recipients are invalid.')
  const existing = new Set(state.outbox.map((item) => `${item.eventId}:${item.recipientConnectionId}`))
  const additions = recipients
    .filter((recipientConnectionId) => !existing.has(`${eventId}:${recipientConnectionId}`))
    .map((recipientConnectionId) => ({ attempts: 0, eventId, leaseId: null, leaseExpiresAtMs: null, recipientConnectionId, state: 'pending' as const }))
  return additions.length ? { ...state, outbox: [...state.outbox, ...additions] } : state
}

/** Claiming is lease-bound so a reconnect cannot complete another worker's delivery. */
export const claimCanonicalOutboxDelivery = (
  state: CanonicalRoomState,
  recipientConnectionId: string,
  leaseId: string,
  leaseExpiresAtMs = Number.MAX_SAFE_INTEGER,
): Readonly<{ delivery: CanonicalOutboxDelivery | null; state: CanonicalRoomState }> => {
  if (!leaseId.trim() || !Number.isSafeInteger(leaseExpiresAtMs) || leaseExpiresAtMs <= 0) throw new Error('The outbox lease is invalid.')
  const index = state.outbox.findIndex((item) => item.recipientConnectionId === recipientConnectionId && item.state === 'pending')
  if (index < 0) return { delivery: null, state }
  const current = state.outbox[index]
  if (current.attempts >= maximumOutboxDeliveryAttempts) {
    const outbox = [...state.outbox]
    outbox[index] = { ...current, leaseExpiresAtMs: null, state: 'expired' }
    return { delivery: null, state: { ...state, outbox } }
  }
  const delivery: CanonicalOutboxDelivery = {
    ...current,
    attempts: current.attempts + 1,
    leaseExpiresAtMs,
    leaseId,
    state: 'in_flight',
  }
  const outbox = [...state.outbox]
  outbox[index] = delivery
  return { delivery, state: { ...state, outbox } }
}

export const completeCanonicalOutboxDelivery = (
  state: CanonicalRoomState,
  eventId: string,
  recipientConnectionId: string,
  leaseId: string,
): CanonicalRoomState => {
  const index = state.outbox.findIndex((item) => item.eventId === eventId && item.recipientConnectionId === recipientConnectionId)
  if (index < 0) return state
  const current = state.outbox[index]
  if (current.state !== 'in_flight' || current.leaseId !== leaseId) return state
  const outbox = [...state.outbox]
  outbox[index] = { ...current, leaseExpiresAtMs: null, leaseId: null, state: 'delivered' }
  return { ...state, outbox }
}

/**
 * A retry may reclaim only an expired lease, and delivery stops permanently at
 * the same bounded attempt count enforced by the private persistence schema.
 */
export const reclaimExpiredCanonicalOutboxDeliveries = (
  state: CanonicalRoomState,
  nowMs: number,
): CanonicalRoomState => {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('The outbox recovery time is invalid.')
  let changed = false
  const outbox = state.outbox.map((item) => {
    if (item.state !== 'in_flight' || item.leaseExpiresAtMs === null || item.leaseExpiresAtMs > nowMs) return item
    changed = true
    return item.attempts >= maximumOutboxDeliveryAttempts
      ? { ...item, leaseExpiresAtMs: null, leaseId: null, state: 'expired' as const }
      : { ...item, leaseExpiresAtMs: null, leaseId: null, state: 'pending' as const }
  })
  return changed ? { ...state, outbox } : state
}

/** Lets the coordinator set a single Durable Object alarm for safe retries. */
export const nextCanonicalOutboxDeadline = (state: CanonicalRoomState): number | null => {
  const deadlines = state.outbox
    .filter((item) => item.state === 'in_flight' && item.leaseExpiresAtMs !== null)
    .map((item) => item.leaseExpiresAtMs as number)
    .filter((deadline) => Number.isSafeInteger(deadline) && deadline > 0)
  return deadlines.length ? Math.min(...deadlines) : null
}

/** A coordinator restart rebuilds only contiguous, tenant/room-matching events. */
export const rebuildCanonicalRoomState = (
  base: CanonicalRoomState,
  events: readonly CanonicalRoomEvent[],
): CanonicalRoomState | null => {
  const ordered = [...events].sort((left, right) => left.roomSeq - right.roomSeq)
  let lastRoomSeq = base.lastRoomSeq
  for (const event of ordered) {
    if (!sameRoom(base, event) || event.roomSeq !== lastRoomSeq + 1 || Number.isNaN(Date.parse(event.serverTime))) return null
    lastRoomSeq = event.roomSeq
  }
  const retained = ordered.slice(-maximumRetainedEvents)
  return { ...base, events: retained, lastRoomSeq }
}
