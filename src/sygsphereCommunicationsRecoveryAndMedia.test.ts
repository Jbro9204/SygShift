import { describe, expect, it } from 'vitest'
import {
  acceptServerMediaAnswer,
  createServerMediaNegotiation,
  expireServerMediaNegotiation,
  forceCloseServerMediaNegotiation,
  markServerMediaReady,
} from '../worker/comms/mediaNegotiation'
import {
  appendCanonicalRoomEvent,
  claimCanonicalOutboxDelivery,
  completeCanonicalOutboxDelivery,
  createCanonicalRoomState,
  enqueueCanonicalOutbox,
  rebuildCanonicalRoomState,
  recoverCanonicalRoom,
} from '../worker/comms/roomRecovery'
import {
  reconcileVerifiedSygSphereUsage,
  unavailableSygSphereUsageReconciliation,
} from '../worker/comms/usageReconciliation'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const room = () => createCanonicalRoomState({ roomEpoch: 3, roomId: 'conversation:abc', tenantId: 'tenant-a' })
const event = (id: string, at = '2026-09-19T20:00:00.000Z') => ({
  correlationId: `correlation-${id}`,
  eventId: id,
  kind: 'call.ringing' as const,
  payload: { callId: 'call-a' },
  serverTime: at,
})

describe('SygSphere Communications recovery and media boundaries', () => {
  it('replays only contiguous server-owned events and falls back safely after a retention gap', () => {
    const first = appendCanonicalRoomEvent(room(), event('event-1'))
    const second = appendCanonicalRoomEvent(first.state, event('event-2', '2026-09-19T20:00:01.000Z'))

    expect(recoverCanonicalRoom(second.state, 1)).toEqual({ mode: 'replay', events: [second.event] })
    expect(recoverCanonicalRoom(second.state, 2)).toEqual({ mode: 'replay', events: [] })
    expect(recoverCanonicalRoom(second.state, 3)).toEqual({ mode: 'unavailable' })
    expect(recoverCanonicalRoom(second.state, undefined)).toEqual({ mode: 'snapshot', state: second.state })
  })

  it('refuses browser-shaped authority in canonical history and rejects restart replay gaps', () => {
    expect(() => appendCanonicalRoomEvent(room(), {
      ...event('event-1'),
      payload: { providerSecret: 'never-record-this' },
    })).toThrow('forbidden payload')

    const state = room()
    expect(rebuildCanonicalRoomState(state, [{
      ...event('event-2'), roomEpoch: state.roomEpoch, roomId: state.roomId, roomSeq: 2, tenantId: state.tenantId,
    }])).toBeNull()
  })

  it('uses a lease-bound outbox so a duplicate socket cannot complete another delivery', () => {
    const appended = appendCanonicalRoomEvent(room(), event('event-1'))
    const queued = enqueueCanonicalOutbox(appended.state, appended.event.eventId, ['connection-a', 'connection-a'])
    const claimed = claimCanonicalOutboxDelivery(queued, 'connection-a', 'lease-1')
    expect(claimed.delivery).toMatchObject({ attempts: 1, state: 'in_flight' })
    expect(claimCanonicalOutboxDelivery(claimed.state, 'connection-a', 'lease-2').delivery).toBeNull()
    expect(completeCanonicalOutboxDelivery(claimed.state, appended.event.eventId, 'connection-a', 'wrong-lease')).toEqual(claimed.state)
    expect(completeCanonicalOutboxDelivery(claimed.state, appended.event.eventId, 'connection-a', 'lease-1').outbox[0]).toMatchObject({ state: 'delivered', leaseId: null })
  })

  it('keeps negotiation opaque, expires stale answers, and force-closes every active media kind', () => {
    const negotiating = createServerMediaNegotiation({
      callId: 'call-a', expiresAtMs: 1_000, id: 'negotiation-a', requestedKinds: ['audio', 'screen'],
    })
    expect(acceptServerMediaAnswer(negotiating, 'answer', 1_000).state).toBe('expired')
    const accepted = acceptServerMediaAnswer(negotiating, 'answer', 999)
    const ready = markServerMediaReady(accepted, 'audio', 999)
    expect(ready).not.toHaveProperty('answer')
    expect(markServerMediaReady(ready, 'video', 999)).toEqual(ready)
    expect(forceCloseServerMediaNegotiation(ready)).toMatchObject({ state: 'closed' })
    expect(forceCloseServerMediaNegotiation(ready).activeKinds.size).toBe(0)
    expect(expireServerMediaNegotiation(negotiating, 1_000).state).toBe('expired')
  })

  it('never calls an empty observation zero usage and rejects replayed reconciliation evidence', () => {
    expect(unavailableSygSphereUsageReconciliation()).toMatchObject({ receivedBytes: null, telemetryStatus: 'unavailable' })
    expect(reconcileVerifiedSygSphereUsage([])).toMatchObject({ receivedBytes: null, telemetryStatus: 'unavailable' })
    const observation = {
      observedAt: '2026-09-19T20:00:00.000Z', receivedBytes: 1500,
      sourceDigest: 'a'.repeat(64), sourceReference: 'provider-export-2026-09-19',
    }
    expect(reconcileVerifiedSygSphereUsage([observation])).toEqual({
      receivedBytes: 1500, reconciliationAsOf: observation.observedAt, telemetryStatus: 'reconciled',
    })
    expect(() => reconcileVerifiedSygSphereUsage([observation, observation])).toThrow('cannot be replayed')
  })

  it('keeps recovery, outbox, and reconciliation persistence private, forced-RLS, and append-only', () => {
    const migration = readFileSync(resolve(import.meta.dirname, '..', 'supabase/migrations/20260919210000_sygsphere_communications_recovery_and_reconciliation_foundation.sql'), 'utf8')
    for (const table of [
      'private.sygsphere_communications_room_events',
      'private.sygsphere_communications_outbox_deliveries',
      'private.sygsphere_communications_usage_reconciliation_evidence',
    ]) {
      expect(migration).toContain(`alter table ${table} force row level security`)
      expect(migration).toContain(`revoke all on table ${table} from public, anon, authenticated`)
    }
    expect(migration).toContain('sygsphere_communications_room_events_append_only')
    expect(migration).toContain('sygsphere_communications_usage_reconciliation_append_only')
    expect(migration).toContain('record_sygsphere_communications_usage_reconciliation')
  })
})
