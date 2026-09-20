import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  resolveSygSphereCommsDirectAvailabilityReason,
  resolveSygSphereCommsPttAvailabilityReason,
  sygsphereCommsAvailabilityDiagnostic,
} from '../worker/comms/tenantCommsDurableObject'

const worker = readFileSync(resolve(process.cwd(), 'worker/comms/tenantCommsDurableObject.ts'), 'utf8')

describe('SygSphere Communications availability guardrails', () => {
  it('distinguishes safe direct-call and PTT unavailability reasons without recipient details', () => {
    expect(resolveSygSphereCommsDirectAvailabilityReason(false, false)).toBe('recipient_not_connected')
    expect(resolveSygSphereCommsDirectAvailabilityReason(true, false)).toBe('recipient_not_eligible')
    expect(resolveSygSphereCommsDirectAvailabilityReason(true, true)).toBeNull()

    expect(resolveSygSphereCommsPttAvailabilityReason(false, false)).toBe('no_listener_connected')
    expect(resolveSygSphereCommsPttAvailabilityReason(true, false)).toBe('no_listener_eligible')
    expect(resolveSygSphereCommsPttAvailabilityReason(true, true)).toBeNull()
  })

  it('emits fixed, sanitized availability diagnostics only', () => {
    const direct = sygsphereCommsAvailabilityDiagnostic('direct_call_request', 'recipient_not_eligible')
    const ptt = sygsphereCommsAvailabilityDiagnostic('ptt_floor_request', 'channel_busy')

    expect(direct).toEqual({
      event: 'sygsphere_communications_availability_unavailable',
      operation: 'direct_call_request',
      reason: 'recipient_not_eligible',
    })
    expect(ptt).toEqual({
      event: 'sygsphere_communications_availability_unavailable',
      operation: 'ptt_floor_request',
      reason: 'channel_busy',
    })
    expect(JSON.stringify(direct)).not.toMatch(/employee|tenant|socket|permission|connection|credential|secret/i)
  })

  it('requires a same-tenant, call-receiving socket before ringing a direct recipient', () => {
    const method = worker.slice(
      worker.indexOf('private directRecipientAvailability('),
      worker.indexOf('private nextRoomSequence('),
    )

    expect(method).toContain('attachment.authorization.tenantId !== caller.authorization.tenantId')
    expect(method).toContain("attachment.authorization.permissions.includes('sygsphere.comms.call.receive')")
    expect(method).toContain('attachment.connectionId === caller.connectionId')
    expect(worker).toContain("reportSygSphereCommsAvailability(\n          'direct_call_request'")
  })

  it('keeps PTT listener eligibility tenant-bound and returns channel_busy for both busy paths', () => {
    const listenerMethod = worker.slice(
      worker.indexOf('private activePttListeners('),
      worker.indexOf('private sendPttConnectionEvent('),
    )
    const floorRequest = worker.slice(
      worker.indexOf('private async dispatchFloorCommand('),
      worker.indexOf('async startPttAudio('),
    )

    expect(listenerMethod).toContain('attachment.authorization.tenantId !== caller.authorization.tenantId')
    expect(listenerMethod).toContain("attachment.authorization.permissions.includes('sygsphere.comms.ptt.listen')")
    expect(floorRequest).toContain("reportSygSphereCommsAvailability(\n          'ptt_floor_request'")
    expect(floorRequest.match(/return 'channel_busy'/g)).toHaveLength(2)
    expect(worker).toContain("['accepted', 'channel_busy', 'invalid_state'")
  })
})
