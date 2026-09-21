import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  endServerPttTransmission,
  grantServerPttFloor,
  isolateServerPttListenerFailure,
  prepareServerPttFloor,
  recordServerPttListenerReady,
  recordServerPttMediaNegotiation,
  renewServerPttFloor,
  startServerPttTransmission,
} from '../worker/comms/pttLifecycle'
import {
  extendServerPttPreparationLease,
  nextServerPttLeaseGeneration,
  readSygSphereCommsSecret,
  sygsphereCommsSetupUnavailableDiagnostic,
} from '../worker/comms/tenantCommsDurableObject'

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

  it('isolates one failed listener while another can still unlock the floor, and closes only after the last listener fails', () => {
    const prepared = prepareServerPttFloor({
      callId, generation: 7, requiredListenerConnectionIds: [listenerOne, listenerTwo], scope: 'site', transmissionRequestId,
    })
    const firstFailure = isolateServerPttListenerFailure({
      failedListenerConnectionId: listenerOne,
      readyListenerConnectionIds: [],
      requiredListenerConnectionIds: prepared.state.requiredListeners,
    })
    expect(firstFailure).not.toBeNull()
    if (!firstFailure) throw new Error('First listener isolation unexpectedly failed.')
    expect([...firstFailure.remainingListenerConnectionIds]).toEqual([listenerTwo])
    expect(firstFailure.shouldClosePreparingFloor).toBe(false)

    const remaining = { ...prepared.state, requiredListeners: firstFailure.remainingListenerConnectionIds }
    const negotiating = recordServerPttMediaNegotiation(remaining, { generation: 7, negotiationId })
    const secondReady = recordServerPttListenerReady(negotiating, { generation: 7, listenerConnectionId: listenerTwo, negotiationId })
    expect(grantServerPttFloor(secondReady, { leaseDurationMs: 10_000, nowMs: 10_000 })).not.toBeNull()

    const lastFailure = isolateServerPttListenerFailure({
      failedListenerConnectionId: listenerTwo,
      readyListenerConnectionIds: [],
      requiredListenerConnectionIds: [listenerTwo],
    })
    expect(lastFailure).not.toBeNull()
    expect(lastFailure?.remainingListenerConnectionIds.size).toBe(0)
    expect(lastFailure?.shouldClosePreparingFloor).toBe(true)
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

  it('bounds server-owned setup extensions from the original reservation and never revives an expired preparation', () => {
    const lease = (nowMs: number, currentLeaseExpiresAtMs: number) => extendServerPttPreparationLease({
      createdAtMs: 10_000,
      currentLeaseExpiresAtMs,
      maximumPreparationLifetimeMs: 120_000,
      nowMs,
      setupExtensionMs: 30_000,
    })

    expect(lease(39_000, 40_000)).toBe(69_000)
    expect(lease(69_000, 70_000)).toBe(99_000)
    expect(lease(129_000, 130_000)).toBe(130_000)
    expect(lease(130_000, 130_000)).toBeNull()
    expect(lease(40_000, 40_000)).toBeNull()
  })

  it('assigns an increasing, server-owned generation to every accepted floor renewal', () => {
    expect(nextServerPttLeaseGeneration(0)).toBe(1)
    expect(nextServerPttLeaseGeneration(1)).toBe(2)
    expect(nextServerPttLeaseGeneration(99)).toBe(100)
    expect(nextServerPttLeaseGeneration(-1)).toBeNull()
    expect(nextServerPttLeaseGeneration(Number.MAX_SAFE_INTEGER)).toBeNull()
  })

  it('classifies protected setup failures without ever retaining or logging a secret value', async () => {
    await expect(readSygSphereCommsSecret('server-only-app-secret')).resolves.toEqual({
      outcome: 'available',
      value: 'server-only-app-secret',
    })
    await expect(readSygSphereCommsSecret('  server-only-app-secret\n')).resolves.toEqual({
      outcome: 'available',
      value: 'server-only-app-secret',
    })
    await expect(readSygSphereCommsSecret({
      get: async () => '  server-only-turn-token\r\n',
    })).resolves.toEqual({
      outcome: 'available',
      value: 'server-only-turn-token',
    })
    await expect(readSygSphereCommsSecret('   ')).resolves.toEqual({ outcome: 'missing' })
    await expect(readSygSphereCommsSecret(undefined)).resolves.toEqual({ outcome: 'missing' })
    await expect(readSygSphereCommsSecret({
      get: async () => { throw new Error('provider binding detail must stay private') },
    })).resolves.toEqual({ outcome: 'read_failed' })

    const diagnostic = sygsphereCommsSetupUnavailableDiagnostic('app_secret_read_failed', 'ptt_prepare_publisher')
    expect(diagnostic).toEqual({
      event: 'sygsphere_communications_setup_unavailable',
      operation: 'ptt_prepare_publisher',
      stage: 'app_secret_read_failed',
    })
    const serialized = JSON.stringify(diagnostic)
    expect(serialized).not.toContain('server-only-app-secret')
    expect(serialized).not.toContain('provider binding detail must stay private')
  })

  it('guards provider returns with exact publisher/listener revalidation and cleans stale tracks before they can be stored', () => {
    const coordinator = readFileSync(resolve(import.meta.dirname, '..', 'worker', 'comms', 'tenantCommsDurableObject.ts'), 'utf8')
    const publisher = coordinator.slice(coordinator.indexOf('async startPttAudio'), coordinator.indexOf('async preparePttAudio'))
    const listener = coordinator.slice(coordinator.indexOf('async startPttListen'), coordinator.indexOf('async preparePttListen'))
    const directRemoteSubscription = coordinator.slice(coordinator.indexOf('private async sendRemoteAudioSubscription'), coordinator.indexOf('/** The app shell uses this only to learn'))
    const listenerPreparation = coordinator.slice(coordinator.indexOf('async preparePttListen'), coordinator.indexOf('async acknowledgePttListenerReady'))
    const floorCommands = coordinator.slice(coordinator.indexOf('private async dispatchFloorCommand'), coordinator.indexOf('async startPttAudio'))
    const coordinatorDispatch = coordinator.slice(coordinator.indexOf('async dispatch'), coordinator.lastIndexOf('\n}'))
    const socketClose = coordinator.slice(coordinator.indexOf('async webSocketClose'), coordinator.indexOf('async alarm'))

    expect(publisher).toContain('this.extendPttPreparationLease(row, requestedAtMs)')
    expect(publisher.indexOf('this.extendPttPreparationLease(row, requestedAtMs)')).toBeLessThan(publisher.indexOf('await this.providerAdapter(parsed.release,'))
    expect(publisher).toContain('this.pttPublisherReservationIsCurrent')
    expect(publisher).toContain('await this.closeStalePttTrack')
    expect(publisher.lastIndexOf('this.pttPublisherReservationIsCurrent')).toBeLessThan(publisher.indexOf('this.claimPttMediaSession'))

    expect(listener).toContain('this.extendPttPreparationLease(row, requestedAtMs)')
    expect(listener.indexOf('this.extendPttPreparationLease(row, requestedAtMs)')).toBeLessThan(listener.indexOf('await this.providerAdapter(parsed.release,'))
    expect(listener).toContain('this.pttListenerReservationIsCurrent')
    expect(listener).toContain('await this.closeStalePttTrack')
    expect(listener.lastIndexOf('this.pttListenerReservationIsCurrent')).toBeLessThan(listener.indexOf('this.claimPttMediaSession'))
    // Remote subscriptions are provider-offer driven. A listener must not
    // supply a browser offer, and its exact provider offer/answer exchange is
    // persisted before listener-ready can ever unlock a floor.
    expect(listener).not.toContain('sessionDescription: { sdp: parsed.offer')
    // A remote subscription causes Cloudflare to generate the offer. Its
    // track kind is therefore mandatory and must be included in the exact
    // provider request for both PTT and direct voice.
    expect(listener).toContain("tracks: [{ kind: 'audio', location: 'remote', sessionId: sourceSession.id, trackName: source.track_id }]")
    expect(directRemoteSubscription).toContain("kind: 'audio'")
    expect(directRemoteSubscription).toContain("location: 'remote'")
    expect(listener).toContain("subscription.value.requiresImmediateRenegotiation !== true")
    expect(listener).toContain("subscription.value.sessionDescription?.type !== 'offer'")
    expect(listener).toContain('this.registerMediaNegotiation({')
    expect(listener).toContain('negotiationId: negotiation.negotiationId')
    expect(directRemoteSubscription).toContain('providerResult.value.requiresImmediateRenegotiation !== true')
    expect(directRemoteSubscription).toContain("providerResult.value.sessionDescription?.type !== 'offer'")
    const listenerReady = coordinator.slice(coordinator.indexOf('async acknowledgePttListenerReady'), coordinator.indexOf('async reportPttListenerFailure'))
    expect(listenerReady).toContain('completed_at_ms is not null')
    expect(listenerReady).toContain('listenerMedia.connection_id !== caller.connectionId')
    expect(coordinator).toContain('on conflict (call_id, employee_id) do nothing')

    // An alarm may arrive late. New protected commands, direct media setup,
    // and the owning socket's close path must all release stale floors before
    // they can block another authorized transmitter.
    expect(coordinator).toContain('lease_generation integer not null default 0')
    expect(coordinator).toContain("pragma table_info('coordinator_ptt_transmissions')")
    expect(coordinatorDispatch).toContain('await this.expirePttTransmissions(now, authorized.release)')
    expect(socketClose).toContain("await this.closePttTransmission(floor, attachment.release, 'network_lost')")
    expect(floorCommands).toContain('lease_generation = ?')
    expect(floorCommands).toContain('generation: renewed.lease_generation')
    expect(listenerPreparation).toContain('await this.expirePttTransmissions(Date.now(), parsed.release)')

    // A publisher failure closes the setup, while a server-side listener
    // failure has the same per-listener isolation behavior as a browser-side
    // receiver failure. One failed receiver cannot starve another selected
    // listener from reaching floor-ready.
    expect(publisher).toContain('this.closeFailedPttPublisherPreparation(row, parsed.release)')
    expect(listener).toContain('this.isolateFailedPttListener(row, caller, parsed.release)')
    expect(listenerPreparation).toContain('this.isolateFailedPttListener(row, caller, parsed.release)')
    expect(listenerReady).toContain('this.isolateFailedPttListener(row, caller, parsed.release)')
    expect(coordinator).toContain('private async isolateFailedPttListener(')
    expect(coordinator).toContain('isolateServerPttListenerFailure({')
    expect(coordinator).toContain('remainingListenerConnectionIds.length === 0')
    expect(coordinator).toContain("'app_secret_read_failed'")
    expect(coordinator).toContain("'turn_token_read_failed'")
    expect(coordinator).toContain("'ptt_prepare_publisher'")
    expect(coordinator).toContain("'ptt_start_listener'")
    expect(coordinator).toContain('async reportPttListenerFailure')
    expect(coordinator).toContain("row.state !== 'preparing'")
    expect(coordinator).toContain('delete from coordinator_ptt_listener_requirements')
    expect(coordinator).toContain("this.closePttTransmission(current, release, 'unavailable')")

    const worker = readFileSync(resolve(import.meta.dirname, '..', 'worker', 'index.ts'), 'utf8')
    const listenerStartRoute = worker.slice(worker.indexOf("'/api/comms/v1/ptt/audio'"), worker.indexOf("'/api/comms/v1/ptt/listener-ready'"))
    expect(listenerStartRoute).toContain('publisher && (!offer || !channelReference || !transceiverMid)')
    const listenerStartCall = listenerStartRoute.slice(listenerStartRoute.indexOf(': await coordinator.startPttListen'), listenerStartRoute.indexOf('return json({ outcome: started.outcome'))
    expect(listenerStartCall).not.toContain('offer,')
    const listenerFailureRoute = worker.slice(worker.indexOf("'/api/comms/v1/ptt/listener-failed'"), worker.indexOf("'/api/comms/v1/ptt/listener-failed'") + 4_500)
    expect(listenerFailureRoute).toContain("target_command_kind: 'ptt.listen'")
    expect(listenerFailureRoute).toContain('coordinator.reportPttListenerFailure')
    expect(listenerFailureRoute).not.toContain('reason: body')
  })

  it('requires a bounded browser transceiver MID and forwards it for every local SFU publication', () => {
    const coordinator = readFileSync(resolve(import.meta.dirname, '..', 'worker', 'comms', 'tenantCommsDurableObject.ts'), 'utf8')
    const directPublisher = coordinator.slice(coordinator.indexOf('async startDirectAudio'), coordinator.indexOf('private async closeDirectCallMedia'))
    const meetingPublisher = coordinator.slice(coordinator.indexOf('async startMeetingMedia'), coordinator.indexOf('async stopMeetingMedia'))
    const pttPublisher = coordinator.slice(coordinator.indexOf('async startPttAudio'), coordinator.indexOf('async preparePttAudio'))

    expect(coordinator).toContain("const transceiverMidSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/)")
    for (const publisher of [directPublisher, meetingPublisher, pttPublisher]) {
      expect(publisher).toContain('mid: parsed.transceiverMid')
    }

    const worker = readFileSync(resolve(import.meta.dirname, '..', 'worker', 'index.ts'), 'utf8')
    const pttStartRoute = worker.slice(worker.indexOf("'/api/comms/v1/ptt/audio'"), worker.indexOf("'/api/comms/v1/ptt/listener-ready'"))
    const meetingStartRoute = worker.slice(worker.indexOf('const meetingMediaMatch'), worker.indexOf('const directCallMatch'))
    const directStartRoute = worker.slice(worker.indexOf("'/api/comms/v1/media/direct-audio'"), worker.indexOf("'/api/comms/v1/usage'"))
    for (const route of [pttStartRoute, meetingStartRoute, directStartRoute]) {
      expect(route).toContain('const transceiverMid = validSygSphereTransceiverMid(body.transceiverMid) ? body.transceiverMid : null')
    }
    expect(pttStartRoute).toContain('publisher && (!offer || !channelReference || !transceiverMid)')
    expect(meetingStartRoute).toContain("operation === 'publish' && !transceiverMid")
    expect(directStartRoute).toContain('!offer || !transceiverMid')
  })
})
