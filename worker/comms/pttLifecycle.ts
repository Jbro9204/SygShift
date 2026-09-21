/**
 * Server-owned PTT lifecycle. The microphone never becomes enabled merely
 * because a floor was requested: media negotiation starts while it is detached
 * or disabled, at least one authorized listener proves readiness, then the
 * coordinator grants the floor and begins the renewable transmission lease.
 * Other authorized listeners may finish subscribing while that lease is active.
 */
export type PttScope = 'assignment' | 'dispatch' | 'shift' | 'site'
export type PttLifecycleStage = 'awaiting_listeners' | 'ended' | 'floor_granted' | 'negotiating' | 'preparing' | 'transmitting'

export type ServerPttLifecycle = Readonly<{
  callId: string
  generation: number
  leaseExpiresAtMs: number | null
  negotiationId: string | null
  readyListeners: ReadonlySet<string>
  requiredListeners: ReadonlySet<string>
  scope: PttScope
  stage: PttLifecycleStage
  transmissionRequestId: string
}>

export type PttMediaStartDirective = Readonly<{
  callId: string
  generation: number
  microphone: 'detached'
  scope: PttScope
  transmissionRequestId: string
}>

export type PttFloorPreparation = Readonly<{
  event: Readonly<{
    kind: 'floor.preparing'
    payload: Readonly<{ scope: PttScope, transmissionRequestId: string }>
  }>
  mediaStart: PttMediaStartDirective
  state: ServerPttLifecycle
}>

export type PttFloorGrant = Readonly<{
  event: Readonly<{
    kind: 'floor.ready'
    payload: Readonly<{ expiresAt: string, scope: PttScope, transmissionRequestId: string }>
  }>
  state: ServerPttLifecycle
}>

export type PttFloorRenewal = Readonly<{
  event: Readonly<{
    kind: 'floor.renewed'
    payload: Readonly<{ commandId: string, generation: number, leaseExpiresAt: string, transmissionRequestId: string }>
  }>
  state: ServerPttLifecycle
}>

/**
 * A receiver that cannot finish setup must not consume the entire channel
 * floor when another selected receiver can still prove readiness. The
 * coordinator owns the durable rows; this pure policy keeps its per-listener
 * removal decision aligned with the lifecycle tests.
 */
export const isolateServerPttListenerFailure = (input: Readonly<{
  failedListenerConnectionId: string
  readyListenerConnectionIds: Iterable<string>
  requiredListenerConnectionIds: Iterable<string>
}>): Readonly<{
  remainingListenerConnectionIds: ReadonlySet<string>
  shouldClosePreparingFloor: boolean
}> | null => {
  if (!validUuid(input.failedListenerConnectionId)) return null
  const requiredListeners = immutableSet(input.requiredListenerConnectionIds)
  const readyListeners = immutableSet(input.readyListenerConnectionIds)
  // A ready receiver has already unlocked the floor. Its later media loss is
  // handled by normal transmission teardown, not setup-failure isolation.
  if (!requiredListeners.has(input.failedListenerConnectionId) || readyListeners.has(input.failedListenerConnectionId)) return null
  const remainingListenerConnectionIds = immutableSet(
    [...requiredListeners].filter((connectionId) => connectionId !== input.failedListenerConnectionId),
  )
  return {
    remainingListenerConnectionIds,
    shouldClosePreparingFloor: remainingListenerConnectionIds.size === 0,
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const maximumListeners = 100

const immutableSet = <T>(values: Iterable<T>): ReadonlySet<T> => new Set(values)

const isTimestamp = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const validUuid = (value: string): boolean => uuidPattern.test(value)
const stillLeased = (state: ServerPttLifecycle, nowMs: number): boolean =>
  state.leaseExpiresAtMs !== null && nowMs < state.leaseExpiresAtMs

const endIfExpired = (state: ServerPttLifecycle, nowMs: number): ServerPttLifecycle =>
  (state.stage === 'floor_granted' || state.stage === 'transmitting') && !stillLeased(state, nowMs)
    ? { ...state, leaseExpiresAtMs: null, stage: 'ended' }
    : state

export const prepareServerPttFloor = (input: Readonly<{
  callId: string
  generation: number
  requiredListenerConnectionIds: readonly string[]
  scope: PttScope
  transmissionRequestId: string
}>): PttFloorPreparation => {
  const requiredListeners = [...new Set(input.requiredListenerConnectionIds)]
  if (!validUuid(input.callId) || !validUuid(input.transmissionRequestId) || !Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error('The PTT floor preparation is invalid.')
  }
  if (!requiredListeners.length || requiredListeners.length > maximumListeners || requiredListeners.some((listener) => !validUuid(listener))) {
    throw new Error('The required PTT listeners are invalid.')
  }
  const state: ServerPttLifecycle = {
    callId: input.callId,
    generation: input.generation,
    leaseExpiresAtMs: null,
    negotiationId: null,
    readyListeners: immutableSet([]),
    requiredListeners: immutableSet(requiredListeners),
    scope: input.scope,
    stage: 'preparing',
    transmissionRequestId: input.transmissionRequestId,
  }
  return {
    event: { kind: 'floor.preparing', payload: { scope: state.scope, transmissionRequestId: state.transmissionRequestId } },
    mediaStart: {
      callId: state.callId,
      generation: state.generation,
      microphone: 'detached',
      scope: state.scope,
      transmissionRequestId: state.transmissionRequestId,
    },
    state,
  }
}

/** The coordinator issues negotiation before it can ever emit floor.ready. */
export const recordServerPttMediaNegotiation = (
  state: ServerPttLifecycle,
  input: Readonly<{ generation: number, negotiationId: string }>,
): ServerPttLifecycle => {
  if (state.stage !== 'preparing' || input.generation !== state.generation || !validUuid(input.negotiationId)) return state
  return { ...state, negotiationId: input.negotiationId, stage: 'negotiating' }
}

/** A listener only counts after the exact current media negotiation is ready. */
export const recordServerPttListenerReady = (
  state: ServerPttLifecycle,
  input: Readonly<{ generation: number, listenerConnectionId: string, negotiationId: string }>,
): ServerPttLifecycle => {
  if ((state.stage !== 'negotiating' && state.stage !== 'awaiting_listeners') || input.generation !== state.generation || state.negotiationId !== input.negotiationId || !state.requiredListeners.has(input.listenerConnectionId)) {
    return state
  }
  const readyListeners = immutableSet([...state.readyListeners, input.listenerConnectionId])
  return { ...state, readyListeners, stage: readyListeners.size > 0 ? 'awaiting_listeners' : 'negotiating' }
}

/**
 * Only after an authorized listener is media-ready may audio be enabled. A
 * stale or duplicate grant cannot revive a closed or expired transmission.
 */
export const grantServerPttFloor = (
  state: ServerPttLifecycle,
  input: Readonly<{ leaseDurationMs: number, nowMs: number }>,
): PttFloorGrant | null => {
  if (state.stage !== 'awaiting_listeners' || !isTimestamp(input.nowMs) || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 30_000) {
    return null
  }
  const leaseExpiresAtMs = input.nowMs + input.leaseDurationMs
  const granted: ServerPttLifecycle = { ...state, leaseExpiresAtMs, stage: 'floor_granted' }
  return {
    event: {
      kind: 'floor.ready',
      payload: {
        expiresAt: new Date(leaseExpiresAtMs).toISOString(),
        scope: granted.scope,
        transmissionRequestId: granted.transmissionRequestId,
      },
    },
    state: granted,
  }
}

/** Media is permitted only after the coordinator's floor-ready event. */
export const startServerPttTransmission = (state: ServerPttLifecycle, nowMs: number): ServerPttLifecycle => {
  const current = endIfExpired(state, nowMs)
  return current.stage === 'floor_granted' ? { ...current, stage: 'transmitting' } : current
}

/**
 * Renewal is a correlated server acknowledgement. The client must stop audio
 * when no acknowledgement arrives before its existing lease expires.
 */
export const renewServerPttFloor = (
  state: ServerPttLifecycle,
  input: Readonly<{ commandId: string, leaseDurationMs: number, nowMs: number, transmissionRequestId: string }>,
): PttFloorRenewal | null => {
  const current = endIfExpired(state, input.nowMs)
  if (current.stage !== 'transmitting' || current.transmissionRequestId !== input.transmissionRequestId || !validUuid(input.commandId) || !isTimestamp(input.nowMs) || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 30_000) {
    return null
  }
  const leaseExpiresAtMs = input.nowMs + input.leaseDurationMs
  const renewed: ServerPttLifecycle = { ...current, leaseExpiresAtMs }
  return {
    event: {
      kind: 'floor.renewed',
      payload: {
        commandId: input.commandId,
        generation: renewed.generation,
        leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
        transmissionRequestId: renewed.transmissionRequestId,
      },
    },
    state: renewed,
  }
}

export const endServerPttTransmission = (state: ServerPttLifecycle): ServerPttLifecycle =>
  state.stage === 'ended' ? state : { ...state, leaseExpiresAtMs: null, stage: 'ended' }
