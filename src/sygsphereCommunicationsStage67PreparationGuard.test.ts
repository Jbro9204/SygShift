import { describe, expect, it } from 'vitest'
import {
  SYGSPHERE_COMMS_PTT_SCOPES,
  SYGSPHERE_COMMS_SURFACE_STATES,
  resolveSygSphereCommsPttPresentation,
  resolveSygSphereCommsSurfacePresentation,
} from '../shared/sygsphere-communications/v1/presentation-policy'
import { closedCommunicationsRuntimeGate } from '../shared/sygsphere-communications/v1/integration-gates'

describe('SygSphere Communications Stage 6/7 preparation', () => {
  it('defines every employee-facing communications state with plain-language fallback', () => {
    expect(SYGSPHERE_COMMS_SURFACE_STATES).toEqual([
      'unavailable',
      'permission_needed',
      'ready',
      'ringing',
      'connecting',
      'active',
      'reconnecting',
      'denied',
      'failed',
      'ended',
    ])

    for (const state of SYGSPHERE_COMMS_SURFACE_STATES) {
      const presentation = resolveSygSphereCommsSurfacePresentation({
        databaseFoundationApplied: true,
        providerPhysicalDeviceEvidenceComplete: true,
        coordinatorDeploymentApproved: true,
        sharedCompatibilityVerified: true,
      }, state)
      expect(`${presentation.title} ${presentation.detail}`).not.toMatch(/provider|token|webrtc|sdp|error code/i)
    }
  })

  it('keeps the Stage 6 surface passive until every authoritative gate is open', () => {
    const presentation = resolveSygSphereCommsSurfacePresentation(closedCommunicationsRuntimeGate, 'active')
    expect(presentation.state).toBe('unavailable')
    expect(presentation.interactiveControlsEnabled).toBe(false)
    expect(presentation.microphoneRequest).toBe('never')
    expect(presentation.primaryActionLabel).toBe('Open SygSphere messages')
  })

  it('requires a deliberate hold-to-talk action and server authorization for every Stage 7 scope', () => {
    expect(SYGSPHERE_COMMS_PTT_SCOPES).toEqual(['assignment', 'shift', 'site', 'dispatch'])

    for (const scope of SYGSPHERE_COMMS_PTT_SCOPES) {
      const closed = resolveSygSphereCommsPttPresentation(closedCommunicationsRuntimeGate, scope, 'transmitting')
      expect(closed.state).toBe('unavailable')
      expect(closed.interactiveControlsEnabled).toBe(false)
      expect(closed.holdToTalkLabel).toBeNull()
      expect(closed.microphoneRequest).toBe('never')
      expect(closed.requiresForeground).toBe(true)
      expect(closed.serverAuthorizationRequired).toBe(true)
    }

    const ready = resolveSygSphereCommsPttPresentation({
      databaseFoundationApplied: true,
      providerPhysicalDeviceEvidenceComplete: true,
      coordinatorDeploymentApproved: true,
      sharedCompatibilityVerified: true,
    }, 'assignment')
    expect(ready.holdToTalkLabel).toBe('Hold to talk')
    expect(ready.releaseToStopLabel).toBe('Release to stop')
    expect(ready.microphoneRequest).toBe('only_after_explicit_action')
  })
})
