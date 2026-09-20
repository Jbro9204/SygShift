import { describe, expect, it } from 'vitest'
import {
  endServerPttTransmission,
  grantServerPttFloor,
  prepareServerPttFloor,
  recordServerPttListenerReady,
  recordServerPttMediaNegotiation,
  renewServerPttFloor,
  startServerPttTransmission,
} from '../worker/comms/pttLifecycle'

const callId = '11111111-1111-4111-8111-111111111111'
const transmissionRequestId = '22222222-2222-4222-8222-222222222222'
const negotiationId = '33333333-3333-4333-8333-333333333333'
const listenerOne = '44444444-4444-4444-8444-444444444444'
const listenerTwo = '55555555-5555-4555-8555-555555555555'
const renewCommandId = '66666666-6666-4666-8666-666666666666'

describe('SygSphere Communications PTT lifecycle', () => {
  it('negotiates detached media before granting a floor to the first authorized ready listener', () => {
    const prepared = prepareServerPttFloor({
      callId, generation: 7, requiredListenerConnectionIds: [listenerOne, listenerTwo], scope: 'site', transmissionRequestId,
    })
    expect(prepared.event).toEqual({ kind: 'floor.preparing', payload: { scope: 'site', transmissionRequestId } })
    expect(prepared.mediaStart).toMatchObject({ generation: 7, microphone: 'detached', transmissionRequestId })
    expect(grantServerPttFloor(prepared.state, { leaseDurationMs: 10_000, nowMs: 10_000 })).toBeNull()

    const negotiating = recordServerPttMediaNegotiation(prepared.state, { generation: 7, negotiationId })
    expect(recordServerPttListenerReady(negotiating, { generation: 6, listenerConnectionId: listenerOne, negotiationId })).toEqual(negotiating)
    const firstListener = recordServerPttListenerReady(negotiating, { generation: 7, listenerConnectionId: listenerOne, negotiationId })
    const firstGrant = grantServerPttFloor(firstListener, { leaseDurationMs: 10_000, nowMs: 10_000 })
    expect(firstGrant).toMatchObject({ state: { stage: 'floor_granted' } })
    const listenersReady = recordServerPttListenerReady(firstListener, { generation: 7, listenerConnectionId: listenerTwo, negotiationId })
    expect(listenersReady.readyListeners).toEqual(new Set([listenerOne, listenerTwo]))
    const grant = grantServerPttFloor(listenersReady, { leaseDurationMs: 10_000, nowMs: 10_000 })
    expect(grant).toMatchObject({
      event: { kind: 'floor.ready', payload: { scope: 'site', transmissionRequestId } },
      state: { stage: 'floor_granted' },
    })
  })

  it('allows transmission and renewal only after a correlated ready grant, and expires safely without an acknowledgement', () => {
    const prepared = prepareServerPttFloor({
      callId, generation: 7, requiredListenerConnectionIds: [listenerOne], scope: 'dispatch', transmissionRequestId,
    })
    const negotiating = recordServerPttMediaNegotiation(prepared.state, { generation: 7, negotiationId })
    const listenersReady = recordServerPttListenerReady(negotiating, { generation: 7, listenerConnectionId: listenerOne, negotiationId })
    const granted = grantServerPttFloor(listenersReady, { leaseDurationMs: 5_000, nowMs: 10_000 })
    expect(granted).not.toBeNull()
    if (!granted) throw new Error('PTT test grant unexpectedly unavailable.')

    const active = startServerPttTransmission(granted.state, 10_001)
    expect(active.stage).toBe('transmitting')
    expect(renewServerPttFloor(active, {
      commandId: renewCommandId, leaseDurationMs: 5_000, nowMs: 10_002, transmissionRequestId: '77777777-7777-4777-8777-777777777777',
    })).toBeNull()
    const renewed = renewServerPttFloor(active, {
      commandId: renewCommandId, leaseDurationMs: 5_000, nowMs: 10_002, transmissionRequestId,
    })
    expect(renewed).toMatchObject({
      event: { kind: 'floor.renewed', payload: { commandId: renewCommandId, generation: 7, transmissionRequestId } },
      state: { stage: 'transmitting' },
    })
    expect(startServerPttTransmission(active, 15_000).stage).toBe('ended')
    expect(endServerPttTransmission(active).stage).toBe('ended')
  })
})
