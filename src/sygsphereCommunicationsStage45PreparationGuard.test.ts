import { describe, expect, it } from 'vitest'
import {
  authorizeCoordinatorSession,
  runtimeGateMessage,
  tenantCoordinatorObjectName,
} from '../worker/comms/tenantCoordinatorCore'
import { closedCommunicationsRuntimeGate, communicationsRuntimeMayMount } from '../shared/sygsphere-communications/v1/integration-gates'

describe('SygSphere Communications Stage 4/5 preparation', () => {
  it('derives a deterministic tenant coordinator name and rejects malformed server context', () => {
    expect(tenantCoordinatorObjectName('00000000-0000-4000-8000-000000000001')).toBe('sygsphere-comms:00000000-0000-4000-8000-000000000001')
    expect(() => tenantCoordinatorObjectName('browser-selected-tenant')).toThrow('communications tenant context is unavailable')
    expect(() => authorizeCoordinatorSession({})).toThrow('Communications are not available')
  })

  it('requires the authoritative use permission and keeps the runtime closed by default', () => {
    expect(() => authorizeCoordinatorSession({
      tenantId: '00000000-0000-4000-8000-000000000001',
      employeeId: '00000000-0000-4000-8000-000000000002',
      authUserId: '00000000-0000-4000-8000-000000000003',
      permissions: [],
      canUseCommunications: true,
    })).toThrow('Communications are not available')
    expect(communicationsRuntimeMayMount(closedCommunicationsRuntimeGate)).toBe(false)
    expect(runtimeGateMessage()).not.toMatch(/provider|token|\d{3}/i)
  })
})
