import { describe, expect, it } from 'vitest'
import {
  parseSygSphereCommsCommand,
  SYGSPHERE_COMMS_COMMAND_PAYLOAD_SCHEMAS,
  SYGSPHERE_COMMS_CONTRACT_VERSION,
} from '../shared/sygsphere-communications/v1/contract'
import {
  authorizeCoordinatorCommand,
  coordinatorRuntimeMayDispatch,
} from '../worker/comms/tenantCoordinatorCore'
import {
  closedProviderOutcome,
  closedSygSphereCommsProviderRegistry,
} from '../worker/comms/providerRegistry'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const command = {
  protocolVersion: 1,
  commandId: '00000000-0000-4000-8000-000000000001',
  roomId: 'assignment:00000000-0000-4000-8000-000000000002',
  connectionEpoch: 0,
  kind: 'floor.request',
  payload: {
    channelReference: 'assignment:00000000-0000-4000-8000-000000000002',
    clientIntentId: '00000000-0000-4000-8000-000000000003',
  },
} as const

describe('SygSphere Communications Stage 1/2 command contract', () => {
  it('uses the draft-3 schema revision for every defined command kind', () => {
    expect(SYGSPHERE_COMMS_CONTRACT_VERSION).toBe('1.0.0-draft.3')
    expect(Object.keys(SYGSPHERE_COMMS_COMMAND_PAYLOAD_SCHEMAS)).toHaveLength(29)
    expect(parseSygSphereCommsCommand(command)).toEqual(command)
  })

  it('rejects malformed identifiers and unknown payload fields before authorization', () => {
    expect(() => parseSygSphereCommsCommand({ ...command, commandId: 'not-a-uuid' })).toThrow()
    expect(() => parseSygSphereCommsCommand({
      ...command,
      payload: { ...command.payload, tenantId: '00000000-0000-4000-8000-000000000004' },
    })).toThrow()
  })

  it('does not permit browser-supplied identity, permission, or provider authority in a command payload', () => {
    for (const forbiddenField of ['actorId', 'employeeId', 'tenantId', 'permissionCodes', 'providerSessionId', 'providerSecret']) {
      expect(() => parseSygSphereCommsCommand({
        ...command,
        payload: { ...command.payload, [forbiddenField]: 'browser-value' },
      })).toThrow()
    }
  })

  it('uses opaque conversation and server-issued connection references for calls and meetings', () => {
    expect(parseSygSphereCommsCommand({
      ...command,
      kind: 'call.request',
      payload: {
        clientIntentId: '00000000-0000-4000-8000-000000000004',
        conversationReference: 'conversation:00000000-0000-4000-8000-000000000005',
      },
    }).kind).toBe('call.request')
    expect(parseSygSphereCommsCommand({
      ...command,
      kind: 'participant.remove',
      payload: {
        meetingId: '00000000-0000-4000-8000-000000000006',
        participantConnectionId: '00000000-0000-4000-8000-000000000007',
      },
    }).kind).toBe('participant.remove')
    expect(() => parseSygSphereCommsCommand({
      ...command,
      kind: 'call.request',
      payload: {
        clientIntentId: '00000000-0000-4000-8000-000000000004',
        conversationReference: 'conversation:00000000-0000-4000-8000-000000000005',
        employeeId: '00000000-0000-4000-8000-000000000008',
      },
    })).toThrow()
  })

  it('keeps the draft-3 server permission map additive and scope-gated', () => {
    const migration = readFileSync(resolve(import.meta.dirname, '..', 'supabase/migrations/20260919203000_sygsphere_communications_draft3_command_contract.sql'), 'utf8')
    for (const value of ['call.request', 'meeting.create', 'participant.remove', 'participant.mute', 'camera.request']) {
      expect(migration).toContain(`'${value}'`)
    }
    expect(migration).toContain("'call.request' then 'sygsphere.comms.call.start'")
    expect(migration).toContain("'participant.remove' then 'sygsphere.comms.moderate'")
    expect(migration).toContain("'camera.request' then 'sygsphere.comms.video.publish'")
    expect(migration).toContain("('1.0.0-draft.2', '1.0.0-draft.3')")
  })

  it('derives command authority on the server and keeps the coordinator closed without every release proof', () => {
    const authorized = authorizeCoordinatorCommand({
      authorization: {
        tenantId: '00000000-0000-4000-8000-000000000010',
        employeeId: '00000000-0000-4000-8000-000000000011',
        authUserId: '00000000-0000-4000-8000-000000000012',
        permissions: ['sygsphere.comms.use', 'sygsphere.comms.ptt.transmit'],
        canUseCommunications: true,
      },
      command,
      release: {
        databaseFoundationApplied: true,
        commandSchemasVerified: true,
        providerPhysicalDeviceEvidenceComplete: false,
        coordinatorDeploymentApproved: false,
        sharedCompatibilityVerified: false,
        runtimeEnabled: false,
      },
      requestId: '00000000-0000-4000-8000-000000000013',
    })

    expect(authorized.requiredPermission).toBe('sygsphere.comms.ptt.transmit')
    expect(coordinatorRuntimeMayDispatch(authorized.release)).toBe(false)
    expect(() => authorizeCoordinatorCommand({
      authorization: {
        ...authorized.authorization,
        permissions: ['sygsphere.comms.use'],
      },
      command,
      release: authorized.release,
      requestId: '00000000-0000-4000-8000-000000000014',
    })).toThrow('Communications are not available for this account.')
  })

  it('has an explicit provider-unavailable outcome while the provider boundary is closed', () => {
    expect(closedProviderOutcome(closedSygSphereCommsProviderRegistry)).toBe('provider_unavailable')
  })
})
