import { describe, expect, it } from 'vitest'
import { closedCommunicationsRuntimeGate } from '../../shared/sygsphere-communications/v1/integration-gates'
import {
  SYGSPHERE_COMMS_CLIENT_RUNTIME_RELEASED,
  createSygSphereCommunicationsRuntimeState,
  effectiveSygSphereCommunicationsClientGate,
  mayRunSygSphereCommunicationsClient,
  reduceSygSphereCommunicationsRuntime,
} from './sygsphereCommunicationsRuntimeLifecycle'
import {
  createSygSphereCommunicationsPttViewModel,
  createSygSphereCommunicationsSurfaceViewModel,
} from './sygsphereCommunicationsSurfaceViewModel'

const otherwiseOpenGate = {
  databaseFoundationApplied: true,
  providerPhysicalDeviceEvidenceComplete: true,
  coordinatorDeploymentApproved: true,
  sharedCompatibilityVerified: true,
} as const

describe('SygSphere Communications Stage 5/6 source-only readiness', () => {
  it('keeps the browser runtime closed even if a future server gate is supplied', () => {
    expect(SYGSPHERE_COMMS_CLIENT_RUNTIME_RELEASED).toBe(false)
    expect(mayRunSygSphereCommunicationsClient(otherwiseOpenGate)).toBe(false)
    expect(effectiveSygSphereCommunicationsClientGate(otherwiseOpenGate)).toBe(closedCommunicationsRuntimeGate)
  })

  it('clears all transient communications state on account change, authorization loss, and sign-out', () => {
    const initial = createSygSphereCommunicationsRuntimeState('account-a')
    const accountChanged = reduceSygSphereCommunicationsRuntime(initial, {
      type: 'account.changed',
      accountKey: 'account-b',
    }, otherwiseOpenGate)
    expect(accountChanged).toEqual({
      accountKey: 'account-b',
      surfaceState: 'unavailable',
      sessionGeneration: 1,
    })

    const authorizationLost = reduceSygSphereCommunicationsRuntime(accountChanged, {
      type: 'authorization.lost',
    }, otherwiseOpenGate)
    expect(authorizationLost).toEqual({
      accountKey: null,
      surfaceState: 'unavailable',
      sessionGeneration: 2,
    })

    const signedOut = reduceSygSphereCommunicationsRuntime(authorizationLost, {
      type: 'session.ended',
    }, otherwiseOpenGate)
    expect(signedOut).toEqual({
      accountKey: null,
      surfaceState: 'unavailable',
      sessionGeneration: 3,
    })
  })

  it('rejects a requested interactive state while the browser release remains closed', () => {
    const initial = createSygSphereCommunicationsRuntimeState('account-a')
    const requested = reduceSygSphereCommunicationsRuntime(initial, {
      type: 'surface.requested',
      surfaceState: 'active',
    }, otherwiseOpenGate)

    expect(requested).toEqual(initial)
  })

  it('offers only the normal messages and Dispatch fallback without a device request', () => {
    const runtime = createSygSphereCommunicationsRuntimeState('account-a')
    const surface = createSygSphereCommunicationsSurfaceViewModel(runtime, otherwiseOpenGate)
    expect(surface.presentation.state).toBe('unavailable')
    expect(surface.primaryIntent).toBe('open_messages')
    expect(surface.secondaryIntent).toBe('use_dispatch')
    expect(surface.requestsDevicePermission).toBe(false)
    expect(surface.isInteractive).toBe(false)

    const ptt = createSygSphereCommunicationsPttViewModel('assignment', otherwiseOpenGate)
    expect(ptt.title).toBe('Push-to-talk is not available yet')
    expect(ptt.holdToTalkLabel).toBeNull()
    expect(ptt.requestsDevicePermission).toBe(false)
    expect(ptt.isInteractive).toBe(false)
  })
})
