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
  it('uses the draft-2 schema revision for every defined command kind', () => {
    expect(SYGSPHERE_COMMS_CONTRACT_VERSION).toBe('1.0.0-draft.2')
    expect(Object.keys(SYGSPHERE_COMMS_COMMAND_PAYLOAD_SCHEMAS)).toHaveLength(20)
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
